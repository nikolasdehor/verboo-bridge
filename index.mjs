#!/usr/bin/env node

import { spawn, execFile } from 'node:child_process';
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AGENT_EXECUTORS,
  assertGlobalModelAllowed,
  configuredModelPolicy,
  executorAvailableModels,
  formatAgentFailure,
  globallyAllowedModels,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  normalizeAgentRequest,
  resolveAllowedCwd,
  resolveAgentExecutor,
  runVerbooAgent,
  waitForAgentSlot,
} from './agent-runner.mjs';
import {
  MODEL_CATALOG,
  selectModelForTask,
} from './model-router.mjs';
import {
  memoryStatus,
  readProjectMemory,
  rememberProjectNote,
} from './memory-store.mjs';
import { JobQueue } from './job-queue.mjs';
const require = createRequire(import.meta.url);
const { version: VERSION } = require('./package.json');
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ── Models ──────────────────────────────────────────────────────────────

const MODELS = MODEL_CATALOG;

// ── Config ──────────────────────────────────────────────────────────────

const API_KEY = process.env.VERBOO_API_KEY;
const BASE_URL = process.env.VERBOO_BASE_URL || 'https://code.verboo.ai/router/v1';
const LOG_LEVEL = (process.env.VERBOO_LOG_LEVEL || 'info').toLowerCase();
const DEFAULT_AGENT_EXECUTOR = resolveAgentExecutor(undefined, process.env);

if (!API_KEY) {
  console.error(
    'AVISO: VERBOO_API_KEY nao definida; tools de prompt direto e executor OpenCode podem ficar indisponiveis.',
  );
}

function log(level, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] >= (levels[LOG_LEVEL] ?? 1)) {
    console.error(`[verboo] ${level}:`, ...args);
  }
}

function pickContent(choice) {
  const m = choice?.message;
  const d = choice?.delta;
  return m?.content || m?.reasoning_content || d?.content || d?.reasoning_content || '';
}

function parseSSE(raw) {
  let full = ''; let usage = {};
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const parsed = JSON.parse(line.slice(6));
    full += pickContent(parsed.choices?.[0]);
    if (parsed.usage) usage = parsed.usage;
  }
  return { full, usage };
}

// ── API Client ──────────────────────────────────────────────────────────

async function callVerboo(model, messages, opts = {}) {
  if (!API_KEY) {
    throw new Error(
      'VERBOO_API_KEY não definida; use verboo_agent com executor nativo ou configure a chave.',
    );
  }
  const info = MODELS[model];
  if (!info) {
    const available = Object.keys(MODELS).join(', ');
    throw new Error(`Modelo desconhecido: "${model}". Disponiveis: ${available}`);
  }
  assertGlobalModelAllowed(model, process.env);

  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? info.out,
  };

  log('debug', `POST ${BASE_URL}/chat/completions model=${model} tokens=${body.max_tokens}`);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail;
    try { detail = await res.text(); } catch { detail = res.statusText; }
    throw new Error(`API ${res.status}: ${detail}`);
  }

  const raw = await res.text();

  // SSE streaming format — router pode retornar data: lines mesmo com stream:false
  if (raw.startsWith('data:') || raw.includes('\ndata:')) {
    const { full, usage } = parseSSE(raw);
    if (!full) throw new Error('Resposta vazia da API');
    return { content: full, model, usage };
  }

  // JSON format
  const data = JSON.parse(raw);
  const content = pickContent(data.choices?.[0]);
  if (!content) throw new Error('Resposta vazia da API');
  return { content, model: data.model || model, usage: data.usage || {} };
}

// ── Safe Validation (verboo_validate) ────────────────────────────────────
// Validação de repositório SEM iniciar agente/job, em dois perfis: estático
// (node --check, git read-only) sob VERBOO_AGENT_VERIFY_ENABLED=1 e
// project-code (npm test/npm run allowlistado) que exige ADICIONALMENTE
// VERBOO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1 por executar código do projeto
// (escrita, caches, rede). Execução só pelo binário absoluto resolvido na
// validação, argv estrito com shell:false, cwd realpath, HOME isolado e
// timeouts por comando e total. Não é read-only; não há isolamento de rede.

const VERIFY_ENABLED = process.env.VERBOO_AGENT_VERIFY_ENABLED === '1';
const VERIFY_PROJECT_CODE_ENABLED = process.env.VERBOO_AGENT_VERIFY_PROJECT_CODE_ENABLED === '1';
const VERIFY_MAX_COMMANDS = 10;
const VERIFY_MAX_ARGS = 20;
const VERIFY_MAX_ARG_LEN = 200;
const VERIFY_OUTPUT_LIMIT = 8 * 1024;
const VERIFY_MAX_TIMEOUT_SECONDS = 600;
const VERIFY_DEFAULT_TIMEOUT_SECONDS = 120;
const VERIFY_TOTAL_MAX_SECONDS = 600;
const VERIFY_KILL_GRACE_MS = 1500;
const VERIFY_HARD_SETTLE_MS = 2000;

function verifyAllowlist(envVar) {
  return new Set(
    String(process.env[envVar] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function verifyChildEnv(homeDir, cmd) {
  const env = {
    PATH: process.env.PATH,
    HOME: homeDir,
    TMPDIR: homeDir,
    CI: 'true',
    NO_COLOR: '1',
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot;
    env.USERPROFILE = homeDir;
  }
  if (cmd === 'git') {
    // `status` pode chamar o fsmonitor configurado pelo próprio repositório.
    // Config de escopo command vence a local; locks opcionais evitam refresh do index.
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: path.join(homeDir, 'git-hooks-disabled'),
      GIT_OPTIONAL_LOCKS: '0',
    });
  }
  return env;
}

function redactVerifyOutput(text) {
  let out = text;
  if (API_KEY) out = out.split(API_KEY).join('<redacted>');
  return out.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
}

// Resolve o binário no MESMO PATH entregue ao processo filho e devolve o
// caminho absoluto realpath que será executado - o PATH do filho nunca pode
// selecionar outro executável depois da validação.
function resolveVerifyBinary(cmd, pathEnv) {
  if (!/^[A-Za-z0-9._-]+$/.test(cmd)) {
    throw new Error('nome de binário inválido');
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const resolved = realpathSync(path.join(dir, cmd + ext));
        accessSync(resolved, constants.X_OK);
        return resolved;
      } catch { /* próximo candidato */ }
    }
  }
  throw new Error(`binário de validação não encontrado: ${cmd}`);
}

function resolveVerifyExecutable(cmd, pathEnv) {
  const bin = resolveVerifyBinary(cmd, pathEnv);
  if (cmd !== 'npm') {
    return { bin, prefixArgs: [], supportFiles: [] };
  }

  // npm é um script. Execute-o sempre com o mesmo node absoluto resolvido
  // agora, sem deixar "#!/usr/bin/env node" consultar o PATH no spawn.
  let npmCli = bin;
  try {
    if (process.platform === 'win32' && bin.toLowerCase().endsWith('.cmd')) {
      npmCli = realpathSync(
        path.join(path.dirname(bin), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      );
    }
  } catch {
    throw new Error('npm.cmd sem npm-cli.js verificável');
  }
  return {
    bin: resolveVerifyBinary('node', pathEnv),
    prefixArgs: [npmCli],
    supportFiles: [npmCli],
  };
}

function validateVerifyArgs(args) {
  if (args.length > VERIFY_MAX_ARGS) {
    throw new Error(`muitos argumentos (max ${VERIFY_MAX_ARGS})`);
  }
  for (const arg of args) {
    if (arg.length > VERIFY_MAX_ARG_LEN) {
      throw new Error(`argumento excede ${VERIFY_MAX_ARG_LEN} caracteres`);
    }
    if (/[;&|<>$`]/.test(arg)) {
      throw new Error('argumento com metacaractere proibido');
    }
  }
}

function validateNpmVerifyArgs(args) {
  if (args.length === 1 && args[0] === 'test') return;
  if (
    args.length === 2
    && args[0] === 'run'
    && /^[A-Za-z0-9:_-]+$/.test(args[1])
  ) {
    if (verifyAllowlist('VERBOO_AGENT_VERIFY_NPM_SCRIPTS').has(args[1])) return;
    throw new Error('script npm fora da allowlist administrativa');
  }
  throw new Error('comando npm fora da política de validação');
}

function resolveNodeCheckFile(args, cwd) {
  if (args.length !== 2 || args[0] !== '--check') {
    throw new Error('comando node fora da política de validação');
  }
  let file;
  try {
    file = realpathSync(path.resolve(cwd, args[1]));
  } catch {
    throw new Error('arquivo de verificação inexistente');
  }
  if (file === cwd || !file.startsWith(cwd + path.sep)) {
    throw new Error('arquivo de verificação fora do diretório autorizado');
  }
  return file;
}

function validateGitVerifyArgs(args) {
  // Allowlist positiva exata: qualquer flag/pathspec/config não modelada
  // (-c, --git-dir, --work-tree, pager, pathspec magic) é rejeitada.
  const allowed = [
    ['diff', '--check'],
    ['diff', '--cached', '--check'],
    ['status', '--porcelain=v1'],
    ['log', '--oneline'],
  ];
  const exactMatch = allowed.some(
    (spec) => spec.length === args.length
      && spec.every((value, index) => value === args[index]),
  );
  const boundedLog = args.length === 4
    && args[0] === 'log'
    && args[1] === '--oneline'
    && args[2] === '-n'
    && /^\d{1,3}$/.test(args[3])
    && Number(args[3]) <= 100;
  if (!exactMatch && !boundedLog) {
    throw new Error('comando git fora da política de validação');
  }
}

function normalizeVerifyCommand(command, cwd, pathEnv) {
  const cmd = String(command?.cmd ?? '');
  const args = Array.isArray(command?.args) ? command.args.map(String) : [];
  validateVerifyArgs(args);
  let file = null;
  switch (cmd) {
    case 'npm':
      validateNpmVerifyArgs(args);
      break;
    case 'node':
      file = resolveNodeCheckFile(args, cwd);
      break;
    case 'git':
      validateGitVerifyArgs(args);
      break;
    default:
      throw new Error(`comando fora da política de validação: ${cmd}`);
  }
  const executable = resolveVerifyExecutable(cmd, pathEnv);
  const normalizedArgs = file ? ['--check', file] : args;
  return {
    cmd,
    args: normalizedArgs,
    execArgs: [...executable.prefixArgs, ...normalizedArgs],
    bin: executable.bin,
    file,
    supportFiles: executable.supportFiles,
  };
}

// Revalida imediatamente antes do spawn: o binário/arquivo resolvido não pode
// ter sido trocado (ex.: symlink re-apontado) entre a validação e a execução.
function recheckVerifyTarget(command) {
  try {
    if (realpathSync(command.bin) !== command.bin) {
      return 'binário de validação alterado após a política';
    }
    accessSync(command.bin, constants.X_OK);
    if (command.file && realpathSync(command.file) !== command.file) {
      return 'arquivo de verificação alterado após a política';
    }
    for (const supportFile of command.supportFiles) {
      if (realpathSync(supportFile) !== supportFile) {
        return 'suporte do executável alterado após a política';
      }
    }
    return null;
  } catch {
    return 'alvo de validação indisponível na revalidação';
  }
}

function killWindowsVerifyTree(child, signal) {
  if (process.platform !== 'win32' || !child.pid) return false;
  try {
    const systemRoot = realpathSync(
      process.env.SystemRoot || String.raw`C:\Windows`,
    );
    const taskkill = realpathSync(path.join(systemRoot, 'System32', 'taskkill.exe'));
    if (!taskkill.toLowerCase().startsWith(systemRoot.toLowerCase() + path.sep)) {
      throw new Error('taskkill fora de SystemRoot');
    }
    execFile(
      taskkill,
      ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
      { shell: false, windowsHide: true },
      () => {},
    );
    return true;
  } catch {
    return false;
  }
}

function killUnixVerifyGroup(child, signal) {
  if (process.platform === 'win32' || !child.pid) return false;
  try {
    process.kill(-child.pid, signal); // grupo de processo (detached)
    return true;
  } catch {
    return false;
  }
}

function killVerifyChild(child, signal) {
  if (killWindowsVerifyTree(child, signal)) return;
  if (killUnixVerifyGroup(child, signal)) return;
  try { child.kill(signal); } catch { /* processo já encerrado */ }
}

function emptyVerifyResult() {
  return {
    exit_code: null,
    signal: null,
    timed_out: false,
    hard_settled: false,
    duration_ms: 0,
    stdout: '',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
  };
}

function runVerifyCommand(command, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command.bin, command.execArgs, {
        cwd,
        shell: false,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({
        ...emptyVerifyResult(),
        duration_ms: Date.now() - startedAt,
        error: 'falha ao iniciar o processo de validação',
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let finished = false;
    let timedOut = false;

    const collect = (current, chunk) => {
      const text = chunk.toString('utf8');
      if (current.length + text.length > VERIFY_OUTPUT_LIMIT) {
        return { text: current + text.slice(0, Math.max(0, VERIFY_OUTPUT_LIMIT - current.length)), truncated: true };
      }
      return { text: current + text, truncated: false };
    };
    child.stdout.on('data', (chunk) => {
      const next = collect(stdout, chunk);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on('data', (chunk) => {
      const next = collect(stderr, chunk);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });

    function finish(extra) {
      if (finished) return;
      finished = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      resolve({
        ...emptyVerifyResult(),
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout: redactVerifyOutput(stdout),
        stderr: redactVerifyOutput(stderr),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        ...extra,
      });
    }

    // SIGTERM → SIGKILL → hard-settle: resolve mesmo que `close` nunca chegue.
    const termTimer = setTimeout(() => {
      timedOut = true;
      killVerifyChild(child, 'SIGTERM');
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      if (timedOut) killVerifyChild(child, 'SIGKILL');
    }, timeoutMs + VERIFY_KILL_GRACE_MS);
    const settleTimer = setTimeout(() => {
      if (timedOut) finish({ signal: 'SIGKILL', hard_settled: true });
    }, timeoutMs + VERIFY_KILL_GRACE_MS + VERIFY_HARD_SETTLE_MS);

    child.on('error', () => finish({ error: 'processo de validação falhou ao iniciar' }));
    child.on('close', (code, signal) => finish({ exit_code: code, signal }));
  });
}

function verifyCommandFailed(result) {
  return Boolean(result.error) || result.timed_out || result.exit_code !== 0;
}

async function executeVerifyBatch({
  normalized,
  cwd,
  isolatedHome,
  perCommandMs,
  stopOnFailure,
}) {
  const deadline = Date.now()
    + Math.min(perCommandMs * normalized.length, VERIFY_TOTAL_MAX_SECONDS * 1000);
  const results = [];
  let stoppedEarly = false;
  let stopReason = null;
  for (const command of normalized) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      stoppedEarly = true;
      stopReason = 'total_timeout';
      break;
    }
    const recheckError = recheckVerifyTarget(command);
    const result = recheckError
      ? { ...emptyVerifyResult(), error: recheckError }
      : await runVerifyCommand(
        command,
        cwd,
        verifyChildEnv(isolatedHome, command.cmd),
        Math.min(perCommandMs, remainingMs),
      );
    results.push({ cmd: command.cmd, args: command.args, ...result });
    if (verifyCommandFailed(result) && stopOnFailure && results.length < normalized.length) {
      stoppedEarly = true;
      stopReason = 'failure';
      break;
    }
  }
  return {
    stoppedEarly,
    stopReason,
    results,
    anyFailure: stoppedEarly || results.some(verifyCommandFailed),
  };
}

async function runVerbooValidate(args) {
  if (!VERIFY_ENABLED) {
    return {
      status: 'error',
      error: 'verboo_validate desabilitado; exige opt-in administrativo VERBOO_AGENT_VERIFY_ENABLED=1.',
    };
  }
  let cwd;
  try {
    cwd = realpathSync(await resolveAllowedCwd(
      String(args.cwd ?? ''),
      process.env.VERBOO_AGENT_ALLOWED_ROOTS,
    ));
  } catch {
    return { status: 'error', error: 'cwd fora das raízes autorizadas ou inexistente.' };
  }
  const commands = Array.isArray(args.commands) ? args.commands : [];
  if (commands.length < 1 || commands.length > VERIFY_MAX_COMMANDS) {
    return {
      status: 'error',
      error: `commands deve ter entre 1 e ${VERIFY_MAX_COMMANDS} itens.`,
    };
  }
  if (
    commands.some((command) => String(command?.cmd ?? '') === 'npm')
    && !VERIFY_PROJECT_CODE_ENABLED
  ) {
    return {
      status: 'error',
      error: 'perfil project-code (npm) exige opt-in adicional VERBOO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1.',
      executed: [],
    };
  }
  const timeoutSeconds = Number.isInteger(args.timeout_seconds)
    ? Math.min(Math.max(args.timeout_seconds, 1), VERIFY_MAX_TIMEOUT_SECONDS)
    : VERIFY_DEFAULT_TIMEOUT_SECONDS;
  const stopOnFailure = args.stop_on_failure !== false;

  const isolatedHome = mkdtempSync(path.join(tmpdir(), 'verboo-verify-home-'));
  try {
    // Valida TODA a sequência antes de executar qualquer comando: violação de
    // política falha fechado, sem efeito parcial no repositório.
    let normalized;
    try {
      normalized = commands.map((command) => normalizeVerifyCommand(
        command,
        cwd,
        verifyChildEnv(isolatedHome).PATH,
      ));
    } catch (err) {
      return { status: 'error', error: err.message, executed: [] };
    }
    const perCommandMs = timeoutSeconds * 1000;
    const {
      stoppedEarly,
      stopReason,
      results,
      anyFailure,
    } = await executeVerifyBatch({
      normalized,
      cwd,
      isolatedHome,
      perCommandMs,
      stopOnFailure,
    });
    return {
      status: anyFailure ? 'failed' : 'ok',
      cwd,
      timeout_seconds: timeoutSeconds,
      stopped_early: stoppedEarly,
      stop_reason: stopReason,
      results,
    };
  } finally {
    try {
      rmSync(isolatedHome, { recursive: true, force: true });
    } catch { /* limpeza do HOME isolado é best-effort */ }
  }
}

// ── MCP Server ──────────────────────────────────────────────────────────

// ── Async Job Queue ────────────────────────────────────────────────────

const MAX_CONCURRENCY_USER = Number(process.env.VERBOO_AGENT_MAX_CONCURRENCY ?? 4);
const jobQueue = new JobQueue({
  concurrency: Number.isInteger(MAX_CONCURRENCY_USER) && MAX_CONCURRENCY_USER >= 1 && MAX_CONCURRENCY_USER <= 8
    ? MAX_CONCURRENCY_USER : 4,
});

if (process.platform === 'win32' && process.env.VERBOO_JOB_PERSIST_RESULTS === '1') {
  log('warn', 'Persistência de resultados de jobs desabilitada no Windows.');
}

// Wire runner — runnerData contém agentArgs reais, nunca persistidos
// Usa waitForAgentSlot para que jobs assíncronos aguardem o slot global
// em vez de falhar com AGENT_BUSY quando chamadas síncronas ocuparem.
jobQueue.setRunner(async (job, signal, runnerData) => {
  const slotRelease = await waitForAgentSlot(process.env, signal);
  const options = {
    availableModels: Object.keys(MODELS),
    env: process.env,
    signal,
    slotRelease,
  };
  return runVerbooAgent(runnerData, options);
});

// Initialise store from env (initStore agora é await antes de start)
let storeReady = true;
if (
  process.env.VERBOO_JOB_PERSIST_RESULTS === '1'
  && process.platform !== 'win32'
  && !process.env.VERBOO_JOB_STORE_DIR
) {
  log('error', 'VERBOO_JOB_PERSIST_RESULTS=1 exige VERBOO_JOB_STORE_DIR.');
  storeReady = false;
} else if (process.env.VERBOO_JOB_STORE_DIR) {
  try {
    await jobQueue.initStore(process.env.VERBOO_JOB_STORE_DIR);
    log('info', `Job store inicializado: ${process.env.VERBOO_JOB_STORE_DIR}`);
  } catch (err) {
    log('error', `Falha ao inicializar job store: ${err.message}`);
    storeReady = false;
  }
}

const server = new Server(
  { name: 'verboo-bridge', version: VERSION },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
    instructions: 'Delegue à Verboo somente pelas ferramentas MCP; nunca execute a CLI no shell. Cada execução é um subagente externo. Use verboo_agent_start por padrão em App/IDE ou tarefa não trivial, longa, paralela ou de duração incerta: mostre o job_id, continue trabalhando e consulte verboo_job status/result sem reenviar após timeout. Reserve verboo_agent síncrono para tarefa curta. Prefira executor=native, model=auto e read_only; write exige autorização e opt-in. Se o MCP faltar, reporte erro de configuração. O orquestrador revisa e roda testes, Git e deploy.',
  },
);

// ── Tools ───────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const codec = { type: 'object', properties: { prompt: { type: 'string' }, system: { type: 'string' }, temperature: { type: 'number', default: 0.3 }, max_tokens: { type: 'number', default: 65536 } }, required: ['prompt'] };
  const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);

  const tools = [];

  if (allowedModels.length > 0) {
    const defaultDirectModel = allowedModels.includes('deepseek-v4-flash')
      ? 'deepseek-v4-flash'
      : allowedModels[0];

    tools.push(
      ...Object.entries(MODELS)
        .filter(([id]) => allowedModels.includes(id))
        .map(([id, info]) => ({
        name: `verboo_${id.replace(/[.-]/g, '_')}`,
        description: `${info.name} — ${info.note}. ${(info.ctx / 1024).toFixed(0)}K ctx, ${info.out} max output. Plano: ${info.tier}.`,
        inputSchema: { ...codec, properties: { ...codec.properties, max_tokens: { type: 'number', description: `Max tokens (max ${info.out})`, default: Math.min(info.out, 8192) } } },
        })),
      {
        name: 'verboo_code',
        description: 'Executa tarefa de codificação com um modelo permitido pela política administrativa.',
        inputSchema: { ...codec, properties: { ...codec.properties, model: { type: 'string', enum: allowedModels, default: defaultDirectModel } } },
      },
      {
        name: 'verboo_review',
        description: 'Revisa codigo buscando bugs, vulnerabilidades e problemas de performance',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Codigo a ser revisado' },
            context: { type: 'string', description: 'Contexto adicional (ex: linguagem, framework)' },
            model: { type: 'string', enum: allowedModels, default: defaultDirectModel },
            temperature: { type: 'number', default: 0.2 },
          },
          required: ['code'],
        },
      },
      {
        name: 'verboo_route',
        description: 'Classifica uma tarefa e explica o ranking dos modelos Verboo sem executar nenhum agente.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Tarefa que será classificada',
            },
            mode: {
              type: 'string',
              enum: ['read_only', 'write'],
              default: 'read_only',
            },
            tiers: {
              type: 'array',
              items: { type: 'string', enum: ['pro', 'max', 'ultra'] },
              default: ['pro', 'max', 'ultra'],
            },
            exclude_models: {
              type: 'array',
              items: { type: 'string', enum: allowedModels },
              default: [],
            },
            executor: {
              type: 'string',
              enum: AGENT_EXECUTORS,
              default: DEFAULT_AGENT_EXECUTOR,
              description: 'Aplica à prévia a mesma disponibilidade de modelos do executor que executará a tarefa',
            },
          },
          required: ['prompt'],
        },
      },
    );
  }

  tools.push(
    {
      name: 'verboo_agent',
      description: 'Executa um subagente Verboo repo-aware de forma síncrona e bloqueia até concluir; use apenas para tarefa curta. Para App/IDE ou tarefa não trivial, longa, paralela ou de duração incerta, use verboo_agent_start. Nunca chame a CLI diretamente. model=auto classifica a tarefa e tenta fallback recuperável. read_only apenas inspeciona; write exige VERBOO_AGENT_WRITE_ENABLED=1. O orquestrador executa testes e outros comandos.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Tarefa concreta e delimitada para o agente' },
          cwd: { type: 'string', description: 'Diretório do projeto, dentro de VERBOO_AGENT_ALLOWED_ROOTS' },
          executor: {
            type: 'string',
            enum: AGENT_EXECUTORS,
            default: DEFAULT_AGENT_EXECUTOR,
            description: 'native usa o harness Verboo Code com OAuth; opencode usa o provider Verboo dentro do OpenCode',
          },
          mode: {
            type: 'string',
            enum: ['read_only', 'write'],
            default: 'read_only',
            description: 'read_only para análise; write somente para edição autorizada, sem shell',
          },
          model: {
            type: 'string',
            enum: ['auto', ...allowedModels],
            default: 'auto',
          },
          timeout_seconds: {
            type: 'integer',
            minimum: MIN_TIMEOUT_SECONDS,
            maximum: MAX_TIMEOUT_SECONDS,
            default: 600,
          },
        },
        required: ['prompt', 'cwd'],
      },
    },
    {
      name: 'verboo_agent_start',
      description: 'Inicia um subagente Verboo de forma assíncrona e retorna job_id imediatamente. É o padrão para App/IDE ou tarefa não trivial, longa, paralela ou de duração incerta. Mostre o job_id, continue trabalhando e consulte verboo_job status/result; não reenvie a mesma tarefa após timeout.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Tarefa concreta e delimitada para o agente' },
          cwd: { type: 'string', description: 'Diretorio do projeto, dentro de VERBOO_AGENT_ALLOWED_ROOTS' },
          executor: { type: 'string', enum: AGENT_EXECUTORS, default: DEFAULT_AGENT_EXECUTOR },
          mode: { type: 'string', enum: ['read_only', 'write'], default: 'read_only' },
          model: { type: 'string', enum: ['auto', ...allowedModels], default: 'auto' },
          timeout_seconds: { type: 'integer', minimum: MIN_TIMEOUT_SECONDS, maximum: MAX_TIMEOUT_SECONDS, default: 600 },
        },
        required: ['prompt', 'cwd'],
      },
    },
    {
      name: 'verboo_job',
      description: 'Gerencia jobs assíncronos iniciados por verboo_agent_start. Use status sem bloquear enquanto trabalha e result após estado terminal; list lista jobs e cancel cancela. Nunca reenvie a tarefa apenas porque uma consulta expirou.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'result', 'list', 'cancel'], default: 'status' },
          job_id: { type: 'string', description: 'Obrigatorio para actions status, result e cancel' },
        },
        required: ['action'],
      },
    },
    {
      name: 'verboo_memory',
      description: 'Consulta ou registra memória técnica persistente de um projeto autorizado.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'read', 'remember'],
            default: 'status',
          },
          cwd: {
            type: 'string',
            description: 'Diretório do projeto, dentro de VERBOO_AGENT_ALLOWED_ROOTS',
          },
          note: {
            type: 'string',
            description: 'Nota técnica curta, sem segredos ou dados pessoais',
            maxLength: 2000,
          },
        },
        required: ['action', 'cwd'],
      },
    },
    {
      name: 'verboo_validate',
      description:
        'Executa validação do repositório como sequência de argv estrito com shell:false, binário absoluto resolvido/validado na política, cwd realpath e HOME isolado, sem iniciar agente ou job. Dois perfis: ESTÁTICO (node --check <arquivo no cwd>; git diff --check, diff --cached --check, status --porcelain=v1, log --oneline limitado) sob VERBOO_AGENT_VERIFY_ENABLED=1 (default falha fechado); PROJECT-CODE (npm test; npm run <script> só com VERBOO_AGENT_VERIFY_NPM_SCRIPTS) — ação importante que executa código confiável do repositório com o mesmo usuário do bridge e pode escrever arquivos, ler qualquer caminho acessível ao usuário, ler configurações e acessar rede, exigindo ADICIONALMENTE VERBOO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1 e aprovação explícita do host. Não é read-only nem sandbox. Sem isolamento de filesystem ou rede. Nunca oferece comandos de commit, push, publish ou deploy.',
      annotations: {
        title: 'Validação segura do repositório',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Diretório do projeto, dentro de VERBOO_AGENT_ALLOWED_ROOTS' },
          commands: {
            type: 'array',
            description: 'Sequência de comandos argv (sem shell). Ex.: {"cmd":"npm","args":["test"]}',
            items: {
              type: 'object',
              properties: {
                cmd: { type: 'string', enum: ['npm', 'node', 'git'] },
                args: { type: 'array', items: { type: 'string' }, default: [] },
              },
              required: ['cmd'],
            },
            minItems: 1,
            maxItems: 10,
          },
          stop_on_failure: { type: 'boolean', default: true },
          timeout_seconds: {
            type: 'integer',
            minimum: 1,
            maximum: 600,
            default: 120,
            description: 'Timeout por comando, em segundos (há também teto total)',
          },
        },
        required: ['cwd', 'commands'],
      },
    },
  );

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = rawArgs ?? {};
  const match = name.match(/^verboo_(.+)$/);

  if (!match) {
    return { content: [{ type: 'text', text: `Tool desconhecida: ${name}` }], isError: true };
  }

  try {
    let model, messages;

    if (name === 'verboo_route') {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) throw new Error('prompt é obrigatório.');
      if (prompt.length > 100_000) {
        throw new Error('prompt excede o limite de 100000 caracteres.');
      }
      const executor = resolveAgentExecutor(args.executor, process.env);
      const executorModels = executorAvailableModels(
        executor,
        Object.keys(MODELS),
        process.env,
      );
      const policy = configuredModelPolicy(executorModels, process.env);
      const requestedTiers = args.tiers ?? policy.allowTiers;
      const route = selectModelForTask({
        prompt,
        mode: args.mode ?? 'read_only',
        availableModels: policy.availableModels,
        allowTiers: requestedTiers.filter(
          (tier) => policy.allowTiers.includes(tier),
        ),
        excludeModels: args.exclude_models ?? [],
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            executor,
            selected_model: route.model,
            reason: route.reason,
            task_profile: route.profile,
            ranking: route.ranking,
          }, null, 2),
        }],
      };
    } else if (name === 'verboo_agent') {
      const result = await runVerbooAgent(args, {
        availableModels: Object.keys(MODELS),
        env: process.env,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } else if (name === 'verboo_agent_start') {
      let request;
      try {
        request = normalizeAgentRequest(args, Object.keys(MODELS));
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify(formatAgentFailure(err), null, 2) }], isError: true };
      }
      const cwd = await resolveAllowedCwd(
        request.cwd,
        process.env.VERBOO_AGENT_ALLOWED_ROOTS,
      );
      const executor = resolveAgentExecutor(args.executor, process.env);
      const executorModels = executorAvailableModels(
        executor,
        Object.keys(MODELS),
        process.env,
      );
      if (request.model !== 'auto') {
        assertGlobalModelAllowed(request.model, process.env);
        if (!executorModels.includes(request.model)) {
          const error = new Error(
            `Modelo ${request.model} indisponível para o executor ${executor}.`,
          );
          error.code = 'MODEL_NOT_ALLOWED';
          error.executor = executor;
          throw error;
        }
      } else if (globallyAllowedModels(executorModels, process.env).length === 0) {
        const error = new Error(
          `Nenhum modelo disponível para o executor ${executor}.`,
        );
        error.code = 'MODEL_ROUTE_EMPTY';
        error.executor = executor;
        throw error;
      }
      const agentArgs = {
        prompt: request.prompt,
        cwd,
        mode: request.mode,
        model: request.model,
        executor,
        timeout_seconds: request.timeoutSeconds,
      };
      const result = await jobQueue.enqueuePersisted({
        cwd,
        model: request.model,
        executor,
        runnerData: agentArgs,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: Boolean(result.error),
      };
    } else if (name === 'verboo_job') {
      const action = String(args.action ?? 'status');
      const jobId = String(args.job_id ?? '');
      switch (action) {
        case 'list':
          return { content: [{ type: 'text', text: JSON.stringify({ jobs: jobQueue.listJobs() }, null, 2) }] };
        case 'status':
          if (!jobId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'job_id obrigatorio' }) }], isError: true };
          {
            const payload = jobQueue.getJob(jobId) ?? { error: 'NOT_FOUND' };
            return {
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              isError: Boolean(payload.error),
            };
          }
        case 'result':
          if (!jobId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'job_id obrigatorio' }) }], isError: true };
          {
            const payload = jobQueue.getJobResult(jobId) ?? { error: 'NOT_FOUND' };
            return {
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              isError: Boolean(payload.error),
            };
          }
        case 'cancel':
          if (!jobId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'job_id obrigatorio' }) }], isError: true };
          {
            const payload = await jobQueue.cancel(jobId);
            return {
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              isError: Boolean(payload.error),
            };
          }
        default:
          return { content: [{ type: 'text', text: JSON.stringify({ error: `Action desconhecida: ${action}` }) }], isError: true };
      }
    } else if (name === 'verboo_memory') {
      const action = String(args.action ?? 'status');
      if (!['status', 'read', 'remember'].includes(action)) {
        throw new Error(`Action desconhecida: ${action}`);
      }
      const cwd = await resolveAllowedCwd(
        String(args.cwd ?? ''),
        process.env.VERBOO_AGENT_ALLOWED_ROOTS,
      );
      if (action === 'remember') {
        const note = String(args.note ?? '').trim();
        if (!note) throw new Error('note é obrigatória para action=remember.');
        const persisted = await rememberProjectNote(
          cwd,
          note,
          { executor: 'orchestrator', status: 'curated' },
          process.env,
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ...memoryStatus(process.env), persisted }, null, 2),
          }],
        };
      }
      const entries = action === 'read'
        ? await readProjectMemory(cwd, process.env)
        : [];
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...memoryStatus(process.env),
            entries,
          }, null, 2),
        }],
      };
    } else if (name === 'verboo_validate') {
      const payload = await runVerbooValidate(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: payload.status !== 'ok',
      };
    } else if (name === 'verboo_code') {
      const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
      if (allowedModels.length === 0) {
        throw Object.assign(new Error('MODEL_POLICY_EMPTY: política de modelos vazia — nenhum modelo disponível.'), { code: 'MODEL_POLICY_EMPTY' });
      }
      model = args.model ?? (
        allowedModels.includes('deepseek-v4-flash')
          ? 'deepseek-v4-flash'
          : allowedModels[0]
      );
      messages = [];
      if (args.system) messages.push({ role: 'system', content: args.system });
      messages.push({ role: 'user', content: args.prompt });
    } else if (name === 'verboo_review') {
      const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
      if (allowedModels.length === 0) {
        throw Object.assign(new Error('MODEL_POLICY_EMPTY: política de modelos vazia — nenhum modelo disponível.'), { code: 'MODEL_POLICY_EMPTY' });
      }
      model = args.model ?? (
        allowedModels.includes('deepseek-v4-flash')
          ? 'deepseek-v4-flash'
          : allowedModels[0]
      );
        let contextPrefix = '';
        if (args.context) contextPrefix = `Contexto: ${args.context}\n\n`;
        messages = [
          { role: 'system', content: 'Voce e um revisor de codigo especialista. Analise o codigo abaixo e aponte: bugs, vulnerabilidades de seguranca, problemas de performance, code smells, e sugestoes de melhoria. Seja direto e especifico.' },
          { role: 'user', content: `${contextPrefix}\`\`\`\n${args.code}\n\`\`\`` },
        ];
    } else {
      model = Object.keys(MODELS).find(m => m.replace(/[.-]/g, '_') === match[1]);
      if (!model) {
        const known = Object.keys(MODELS).map(m => `verboo_${m.replace(/[.-]/g, '_')}`).join(', ');
        throw new Error(`Tool desconhecida: ${name}. Tools disponiveis: verboo_code, verboo_review, ${known}`);
      }
      messages = [];
      if (args.system) messages.push({ role: 'system', content: args.system });
      messages.push({ role: 'user', content: args.prompt });
    }

    const result = await callVerboo(model, messages, {
      temperature: args.temperature,
      max_tokens: args.max_tokens,
    });

    const info = MODELS[model];
    const header = `## ${info?.name || model}`;
    const footer = `\n---\n*Modelo: ${result.model} | Tokens: ${result.usage?.total_tokens ?? '?'} (${result.usage?.prompt_tokens ?? '?'} in + ${result.usage?.completion_tokens ?? '?'} out)*`;

    return {
      content: [{ type: 'text', text: `${header}\n\n${result.content}${footer}` }],
    };
  } catch (err) {
    log('error', err.message);
    if (['verboo_agent', 'verboo_agent_start', 'verboo_job'].includes(name)) {
      return {
        content: [{ type: 'text', text: JSON.stringify(formatAgentFailure(err), null, 2) }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Erro: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Prompts ─────────────────────────────────────────────────────────────

const PROMPTS = {
  'revisar-codigo': {
    name: 'Revisar codigo',
    description: 'Template para revisao de codigo usando modelo Verboo',
    arguments: [
      { name: 'codigo', description: 'Codigo fonte a ser revisado', required: true },
      { name: 'contexto', description: 'Contexto do projeto', required: false },
      { name: 'modelo', description: 'Modelo Verboo permitido pela política administrativa', required: false },
    ],
  },
  'refatorar': {
    name: 'Refatorar codigo',
    description: 'Template para refatoracao de codigo',
    arguments: [
      { name: 'codigo', description: 'Codigo a refatorar', required: true },
      { name: 'instrucoes', description: 'O que melhorar', required: false },
      { name: 'modelo', description: 'Modelo Verboo', required: false },
    ],
  },
  'explicar': {
    name: 'Explicar codigo',
    description: 'Explica um trecho de codigo em detalhe',
    arguments: [
      { name: 'codigo', description: 'Codigo a explicar', required: true },
      { name: 'modelo', description: 'Modelo Verboo', required: false },
    ],
  },
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.entries(PROMPTS).map(([id, p]) => ({
    name: id,
    description: p.description,
    arguments: p.arguments,
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const prompt = PROMPTS[req.params.name];
  if (!prompt) throw new Error(`Prompt desconhecido: ${req.params.name}`);

  const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
  if (allowedModels.length === 0) {
    throw Object.assign(new Error('MODEL_POLICY_EMPTY: política de modelos vazia — nenhum modelo disponível.'), { code: 'MODEL_POLICY_EMPTY' });
  }
  const modelo = req.params.arguments?.modelo || (
    allowedModels.includes('deepseek-v4-flash')
      ? 'deepseek-v4-flash'
      : allowedModels[0]
  );
  assertGlobalModelAllowed(modelo, process.env);

  if (req.params.name === 'revisar-codigo') {
    const ctx = req.params.arguments?.contexto || '';
    return {
      messages: [
        { role: 'system', content: { type: 'text', text: `Voce é um revisor de codigo usando ${MODELS[modelo]?.name || modelo}. Seja critico e direto.` } },
        { role: 'user', content: { type: 'text', text: `${ctx}\n\`\`\`\n${req.params.arguments?.codigo}\n\`\`\`` } },
      ],
    };
  }

  if (req.params.name === 'refatorar') {
    const inst = req.params.arguments?.instrucoes || 'Melhore a qualidade, legibilidade e performance';
    return {
      messages: [
        { role: 'user', content: { type: 'text', text: `Refatore o codigo abaixo.\nInstrucoes: ${inst}\n\`\`\`\n${req.params.arguments?.codigo}\n\`\`\`` } },
      ],
    };
  }

  if (req.params.name === 'explicar') {
    return {
      messages: [
        { role: 'user', content: { type: 'text', text: `Explique este codigo em detalhe:\n\`\`\`\n${req.params.arguments?.codigo}\n\`\`\`` } },
      ],
    };
  }

  throw new Error(`Prompt nao implementado: ${req.params.name}`);
});

// ── Resources ───────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'verboo://models',
      name: 'Modelos disponiveis',
      description: 'Lista de modelos Verboo permitidos pela política administrativa',
      mimeType: 'application/json',
    },
    {
      uri: 'verboo://status',
      name: 'Status da bridge',
      description: 'Informacoes sobre a conexao e configuracao',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === 'verboo://models') {
    const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
    if (allowedModels.length === 0) {
      return {
        contents: [{
          uri: 'verboo://models',
          mimeType: 'application/json',
          text: JSON.stringify({ error: 'MODEL_POLICY_EMPTY', message: 'Política de modelos vazia — nenhum modelo disponível.' }, null, 2),
        }],
      };
    }
    return {
      contents: [{
        uri: 'verboo://models',
        mimeType: 'application/json',
        text: JSON.stringify(Object.entries(MODELS)
          .filter(([id]) => allowedModels.includes(id))
          .map(([id, m]) => ({
          id,
          name: m.name,
          context_window: m.ctx,
          max_output: m.out,
          tier: m.tier,
          note: m.note,
          })), null, 2),
      }],
    };
  }

  if (req.params.uri === 'verboo://status') {
    const queueStatus = jobQueue.status;
    const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
    return {
      contents: [{
        uri: 'verboo://status',
        mimeType: 'application/json',
        text: JSON.stringify({
          version: VERSION,
          base_url: BASE_URL,
          models_count: allowedModels.length,
          log_level: LOG_LEVEL,
          api_key_configured: Boolean(API_KEY),
          agent_allowed_roots_configured: Boolean(process.env.VERBOO_AGENT_ALLOWED_ROOTS),
          agent_executor: DEFAULT_AGENT_EXECUTOR,
          agent_default_executor: DEFAULT_AGENT_EXECUTOR,
          agent_executors: AGENT_EXECUTORS,
          memory: memoryStatus(process.env),
          job_queue: {
            concurrency: jobQueue.capacity,
            queued: queueStatus.queued,
            running: queueStatus.running,
            total: queueStatus.total,
          },
        }, null, 2),
      }],
    };
  }

  throw new Error(`Resource desconhecido: ${req.params.uri}`);
});

// ── Start / Shutdown ───────────────────────────────────────────────────

let shutdownPromise = null;
let forcedExitTimer = null;
function scheduleForcedExit() {
  if (forcedExitTimer) return;
  forcedExitTimer = setTimeout(() => process.exit(1), 2_500);
  forcedExitTimer.unref?.();
}

function shutdown(reason) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.resolve().then(async () => {
    log('info', `Encerrando bridge (${reason}).`);
    let serverCloseTimer;
    const closeServer = Promise.race([
      Promise.resolve().then(() => server.close()),
      new Promise((_, reject) => {
        serverCloseTimer = setTimeout(() => reject(Object.assign(
          new Error('Fechamento do servidor excedeu o tempo limite.'),
          { code: 'SERVER_CLOSE_TIMEOUT' },
        )), 2_500);
      }),
    ]).finally(() => clearTimeout(serverCloseTimer));
    const results = await Promise.allSettled([
      jobQueue.shutdown(),
      closeServer,
    ]);
    let failure = null;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log('error', `Falha durante shutdown: ${result.reason?.message ?? result.reason}`);
        process.exitCode = 1;
        scheduleForcedExit();
        failure ??= result.reason instanceof Error
          ? result.reason
          : new Error('Falha durante shutdown.');
      }
      if (index === 0 && result.status === 'fulfilled' && result.value?.timed_out) {
        log('error', 'Shutdown da fila excedeu o tempo limite.');
        process.exitCode = 1;
        scheduleForcedExit();
        failure ??= Object.assign(
          new Error('Shutdown da fila excedeu o tempo limite.'),
          { code: 'SHUTDOWN_TIMEOUT' },
        );
      }
    });
    process.stdin.destroy();
    if (failure) throw failure;
  }).catch((err) => {
    process.exitCode = 1;
    process.stdin.destroy();
    throw err;
  });
  return shutdownPromise;
}

const onSignal = (signal) => { void shutdown(signal).catch(() => {}); };
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
process.stdin.once('end', () => { void shutdown('stdin_eof').catch(() => {}); });
server.onclose = () => { void shutdown('server_close').catch(() => {}); };

if (!storeReady) {
  console.error('FATAL: Job store configurado mas nao inicializou. Abortando.');
  process.exitCode = 1;
  await shutdown('store_init_failed').catch(() => {});
} else {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('info', `verboo-bridge ready | ${Object.keys(MODELS).length} models | ${BASE_URL}`);
  } catch (err) {
    console.error('FATAL:', err.message);
    process.exitCode = 1;
    await shutdown('server_start_failed').catch(() => {});
  }
}
