import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const AGENT_MODES = ['read_only', 'write'];
export const DEFAULT_AGENT_MODEL = 'deepseek-v4-flash';
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 1800;

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_AGENT_CONCURRENCY = 8;
const KILL_GRACE_MS = 2_000;
const AGENT_NAME = 'verboo-bridge-agent';
let activeAgentRuns = 0;
const CHILD_ENV_ALLOWLIST = [
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'USER',
  'VERBOO_API_KEY',
  'VERBOO_BASE_URL',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
];

function agentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function configuredConcurrency(env) {
  const value = Number(env.VERBOO_AGENT_MAX_CONCURRENCY ?? 1);
  return Number.isInteger(value) && value >= 1 && value <= MAX_AGENT_CONCURRENCY
    ? value
    : 1;
}

function acquireAgentSlot(env) {
  const limit = configuredConcurrency(env);
  if (activeAgentRuns >= limit) {
    throw agentError(
      'AGENT_BUSY',
      `Limite de ${limit} execução(ões) simultânea(s) do agente atingido.`,
    );
  }
  activeAgentRuns += 1;
  return () => {
    activeAgentRuns -= 1;
  };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function resolveAllowedCwd(cwd, allowedRootsValue) {
  if (!allowedRootsValue?.trim()) {
    throw agentError(
      'ALLOWED_ROOTS_MISSING',
      'VERBOO_AGENT_ALLOWED_ROOTS não foi configurada; execução repo-aware bloqueada.',
    );
  }

  let resolvedCwd;
  try {
    resolvedCwd = await realpath(cwd);
  } catch {
    throw agentError('CWD_INVALID', `Diretório não encontrado: ${cwd}`);
  }

  const configuredRoots = allowedRootsValue
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  const resolvedRoots = [];
  for (const root of configuredRoots) {
    try {
      resolvedRoots.push(await realpath(root));
    } catch {
      // Uma raiz removida não amplia acesso; as demais continuam válidas.
    }
  }

  if (!resolvedRoots.some((root) => isInside(root, resolvedCwd))) {
    throw agentError(
      'CWD_NOT_ALLOWED',
      `Diretório fora das raízes autorizadas: ${resolvedCwd}`,
    );
  }
  return resolvedCwd;
}

export function normalizeAgentRequest(args, availableModels) {
  const prompt = String(args.prompt ?? '').trim();
  if (!prompt) throw agentError('PROMPT_REQUIRED', 'prompt é obrigatório.');
  if (prompt.length > 100_000) {
    throw agentError('PROMPT_TOO_LARGE', 'prompt excede o limite de 100000 caracteres.');
  }

  const mode = args.mode ?? 'read_only';
  if (!AGENT_MODES.includes(mode)) {
    throw agentError('MODE_INVALID', `mode deve ser um de: ${AGENT_MODES.join(', ')}.`);
  }

  const model = args.model ?? DEFAULT_AGENT_MODEL;
  if (!availableModels.includes(model)) {
    throw agentError(
      'MODEL_INVALID',
      `Modelo desconhecido: ${model}. Disponíveis: ${availableModels.join(', ')}.`,
    );
  }

  const timeoutSeconds = Number(args.timeout_seconds ?? 600);
  if (
    !Number.isInteger(timeoutSeconds)
    || timeoutSeconds < MIN_TIMEOUT_SECONDS
    || timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw agentError(
      'TIMEOUT_INVALID',
      `timeout_seconds deve ser inteiro entre ${MIN_TIMEOUT_SECONDS} e ${MAX_TIMEOUT_SECONDS}.`,
    );
  }

  return { prompt, cwd: String(args.cwd ?? ''), mode, model, timeoutSeconds };
}

function inlineConfig(mode) {
  const readOnly = mode === 'read_only';
  const filePermission = {
    '*': 'allow',
    '*.env': 'deny',
    '*.env.*': 'deny',
    '**/*.env': 'deny',
    '**/*.env.*': 'deny',
    '*.env.example': 'allow',
    '**/*.env.example': 'allow',
  };
  const permission = {
    '*': 'deny',
    read: filePermission,
    glob: 'allow',
    grep: 'deny',
    list: 'allow',
    lsp: 'deny',
    edit: readOnly ? 'deny' : filePermission,
    bash: 'deny',
    task: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    external_directory: 'deny',
  };

  return JSON.stringify({
    agent: {
      [AGENT_NAME]: {
        description: 'Agente Verboo isolado e orquestrado pelo verboo-bridge.',
        mode: 'primary',
        permission,
      },
    },
  });
}

export function buildOpenCodeInvocation(request, opencodeBin = 'opencode') {
  return {
    command: opencodeBin,
    args: [
      'run',
      '--pure',
      '--format',
      'json',
      '--model',
      `verboo/${request.model}`,
      '--agent',
      AGENT_NAME,
      '--dir',
      request.cwd,
      '--',
      request.prompt,
    ],
    inlineConfig: inlineConfig(request.mode),
  };
}

export function buildChildEnv(sourceEnv, opencodeConfigContent) {
  const childEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (sourceEnv[key] !== undefined) childEnv[key] = sourceEnv[key];
  }
  childEnv.OPENCODE_CONFIG_CONTENT = opencodeConfigContent;
  childEnv.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  return childEnv;
}

function stripReasoning(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function parseOpenCodeEvents(raw, cwd) {
  let sessionId = null;
  let result = '';
  const artifacts = new Set();
  const toolsUsed = new Set();
  const successfulTools = new Set();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    sessionId ||= event.sessionID ?? event.part?.sessionID ?? null;
    if (event.type === 'text') {
      const candidate = stripReasoning(event.part?.text ?? '');
      if (candidate) result = candidate;
    }

    if (event.type === 'tool_use') {
      if (event.part?.tool) toolsUsed.add(event.part.tool);
      if (event.part?.state?.status !== 'completed') continue;
      if (event.part?.tool) successfulTools.add(event.part.tool);
      const input = event.part?.state?.input ?? {};
      for (const value of [input.filePath, input.path]) {
        if (typeof value !== 'string') continue;
        const candidate = path.resolve(cwd, value);
        if (isInside(cwd, candidate)) artifacts.add(candidate);
      }
    }
  }

  return {
    sessionId,
    result,
    artifacts: [...artifacts].sort(),
    toolsUsed: [...toolsUsed].sort(),
    successfulTools: [...successfulTools].sort(),
  };
}

function recoveryFor(error) {
  const recovery = {
    ALLOWED_ROOTS_MISSING: [
      'Configure VERBOO_AGENT_ALLOWED_ROOTS com raízes explícitas e reinicie o cliente MCP.',
    ],
    CWD_INVALID: ['Corrija cwd para um diretório existente e tente novamente.'],
    CWD_NOT_ALLOWED: [
      'Use um cwd dentro de VERBOO_AGENT_ALLOWED_ROOTS ou amplie a allowlist conscientemente.',
    ],
    OPENCODE_NOT_FOUND: [
      'Instale o OpenCode ou configure VERBOO_OPENCODE_BIN com o caminho absoluto.',
    ],
    WRITE_DISABLED: [
      'Configure VERBOO_AGENT_WRITE_ENABLED=1 no servidor MCP somente se edição remota estiver autorizada.',
    ],
    AGENT_BUSY: [
      'Aguarde a execução atual terminar e tente novamente.',
    ],
    TIMEOUT: [
      'Reduza o escopo da tarefa ou aumente timeout_seconds até o máximo permitido.',
    ],
    OUTPUT_LIMIT: ['Reduza o escopo; a execução excedeu o limite de saída do bridge.'],
    EXIT_ERROR: [
      'Execute opencode models verboo e confirme credenciais/configuração antes de tentar novamente.',
    ],
  };
  return recovery[error.code] ?? ['Corrija a entrada ou configuração indicada e tente novamente.'];
}

export function formatAgentFailure(error) {
  return {
    status: 'error',
    summary: error.message,
    result: '',
    next_actions: recoveryFor(error),
    artifacts: [],
    session_id: null,
  };
}

function execute(invocation, options) {
  const {
    cwd,
    timeoutSeconds,
    env,
    spawnImpl = spawn,
    killImpl = process.kill,
    killGraceMs = KILL_GRACE_MS,
  } = options;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationError = null;
    let childClosed = false;
    let forceKillSent = false;
    let forceKillTimer;
    let timer;

    const child = spawnImpl(invocation.command, invocation.args, {
      cwd,
      env: buildChildEnv(env, invocation.inlineConfig),
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      callback(value);
    };

    const signalTree = (signal) => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          killImpl(-child.pid, signal);
          return;
        } catch {
          // O processo pode ter encerrado entre a checagem e o sinal.
        }
      }
      child.kill(signal);
    };

    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      signalTree('SIGTERM');
      forceKillTimer = setTimeout(() => {
        forceKillSent = true;
        signalTree('SIGKILL');
        if (childClosed) finish(reject, terminationError);
      }, killGraceMs);
    };

    timer = setTimeout(() => {
      terminate(agentError(
        'TIMEOUT',
        `OpenCode excedeu o timeout de ${timeoutSeconds}s e foi interrompido.`,
      ));
    }, timeoutSeconds * 1000);

    child.stdout?.on('data', (chunk) => {
      if (terminationError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate(
          agentError('OUTPUT_LIMIT', 'Saída do OpenCode excedeu 4 MiB e foi interrompida.'),
        );
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      if (terminationError) return;
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr += chunk.toString();
    });

    child.on('error', (error) => {
      const wrapped = agentError(
        error.code === 'ENOENT' ? 'OPENCODE_NOT_FOUND' : 'EXIT_ERROR',
        error.code === 'ENOENT'
          ? `OpenCode não encontrado: ${invocation.command}`
          : `Falha ao iniciar OpenCode: ${error.message}`,
      );
      finish(reject, wrapped);
    });

    child.on('close', (code) => {
      childClosed = true;
      if (terminationError) {
        if (forceKillSent) finish(reject, terminationError);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').at(-1);
        const suffix = detail ? ` (${detail.slice(0, 300)})` : '';
        finish(
          reject,
          agentError('EXIT_ERROR', `OpenCode encerrou com código ${code}${suffix}.`),
        );
        return;
      }
      finish(resolve, stdout);
    });
  });
}

export async function runVerbooAgent(args, options) {
  const request = normalizeAgentRequest(args, options.availableModels);
  if (request.mode === 'write' && options.env.VERBOO_AGENT_WRITE_ENABLED !== '1') {
    throw agentError(
      'WRITE_DISABLED',
      'Modo write desabilitado no servidor MCP.',
    );
  }

  const releaseAgentSlot = acquireAgentSlot(options.env);
  try {
    request.cwd = await resolveAllowedCwd(
      request.cwd,
      options.env.VERBOO_AGENT_ALLOWED_ROOTS,
    );
    const invocation = buildOpenCodeInvocation(
      request,
      options.env.VERBOO_OPENCODE_BIN || 'opencode',
    );
    const raw = await execute(invocation, {
      cwd: request.cwd,
      timeoutSeconds: request.timeoutSeconds,
      env: options.env,
      spawnImpl: options.spawnImpl,
      killImpl: options.killImpl,
      killGraceMs: options.killGraceMs,
    });
    const parsed = parseOpenCodeEvents(raw, request.cwd);
    const hasWriteExecution = parsed.successfulTools.some((tool) => (
      ['apply_patch', 'edit', 'write'].includes(tool)
    ));
    const status = request.mode === 'write' && !hasWriteExecution ? 'warning' : 'success';

    return {
      status,
      summary: status === 'warning'
        ? 'O agente encerrou sem executar ferramenta de edição; nenhuma mudança foi confirmada.'
        : `Agente Verboo concluiu a tarefa em modo ${request.mode}.`,
      result: parsed.result || 'Execução concluída sem mensagem final.',
      next_actions: status === 'warning'
        ? [
            'Não trate a tarefa como concluída.',
            'Tente novamente com DeepSeek V4 Flash ou GLM 5.2 e uma instrução mais explícita.',
          ]
        : request.mode === 'write'
        ? [
            'Revise o diff e os artefatos no orquestrador.',
            'Rode as validações do projeto no orquestrador antes de commit ou deploy.',
          ]
        : ['Revise a análise e delegue escrita somente se a mudança estiver autorizada.'],
      artifacts: parsed.artifacts,
      tools_used: parsed.toolsUsed,
      session_id: parsed.sessionId,
      model: request.model,
      mode: request.mode,
      cwd: request.cwd,
    };
  } finally {
    releaseAgentSlot();
  }
}
