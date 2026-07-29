import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { MODEL_CATALOG, selectModelForTask } from './model-router.mjs';
import {
  extractMemoryNote,
  loadMemoryContext,
  promptWithMemory,
  rememberProjectNote,
} from './memory-store.mjs';

export const AGENT_MODES = ['read_only', 'write'];
export const AGENT_EXECUTORS = ['opencode', 'native'];
export const DEFAULT_AGENT_MODEL = 'auto';
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 1800;

const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_AGENT_CONCURRENCY = 4;
const MAX_AGENT_CONCURRENCY = 8;
const KILL_GRACE_MS = 2_000;
const AGENT_NAME = 'verboo-bridge-agent';
const NATIVE_ALWAYS_DISALLOWED_TOOLS = [
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'MultiEdit',
  'NotebookEdit',
  'TodoWrite',
  'Skill',
  'ToolSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'LSP',
];
let activeAgentRuns = 0;
let slotWaiters = [];

export function resetAgentSlots() {
  for (const waiter of slotWaiters) {
    waiter.cleanup?.();
    waiter.reject(agentError('CANCELLED', 'Fila de slots reiniciada.'));
  }
  activeAgentRuns = 0;
  slotWaiters = [];
}

function createModelRuntimeState() {
  return Object.fromEntries(Object.keys(MODEL_CATALOG).map((model) => [
    model,
    {
      inFlight: 0,
      lastSelectedAt: 0,
      failures: 0,
      cooldownUntil: 0,
    },
  ]));
}

let modelRuntimeState = createModelRuntimeState();

export function resetModelRuntimeState() {
  modelRuntimeState = createModelRuntimeState();
}
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
  const value = Number(env.VERBOO_AGENT_MAX_CONCURRENCY ?? DEFAULT_AGENT_CONCURRENCY);
  return Number.isInteger(value) && value >= 1 && value <= MAX_AGENT_CONCURRENCY
    ? value
    : DEFAULT_AGENT_CONCURRENCY;
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
  return createSlotRelease();
}

function releaseAgentSlot() {
  if (activeAgentRuns > 0) activeAgentRuns -= 1;
  notifySlotWaiters();
}

function createSlotRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseAgentSlot();
  };
}

function notifySlotWaiters() {
  while (slotWaiters.length > 0) {
    const waiter = slotWaiters[0];
    const limit = configuredConcurrency(waiter.env);
    if (activeAgentRuns >= limit) break;
    slotWaiters.shift();
    if (waiter.signal?.aborted) {
      waiter.reject(agentError('CANCELLED', 'Cancelado enquanto aguardava slot de agente.'));
      continue;
    }
    if (waiter.cleanup) waiter.cleanup();
    activeAgentRuns += 1;
    waiter.resolve(createSlotRelease());
  }
}

export function waitForAgentSlot(env, signal) {
  if (signal?.aborted) {
    return Promise.reject(agentError('CANCELLED', 'Cancelado enquanto aguardava slot de agente.'));
  }
  const limit = configuredConcurrency(env);
  if (activeAgentRuns < limit) {
    activeAgentRuns += 1;
    return Promise.resolve(createSlotRelease());
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal: signal ?? null, env };
    let onAbort;
    if (signal) {
      onAbort = () => {
        const idx = slotWaiters.indexOf(waiter);
        if (idx >= 0) slotWaiters.splice(idx, 1);
        waiter.cleanup?.();
        reject(agentError('CANCELLED', 'Cancelado enquanto aguardava slot de agente.'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    waiter.cleanup = onAbort ? () => signal.removeEventListener('abort', onAbort) : undefined;
    slotWaiters.push(waiter);
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sortedStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
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
  if (model !== 'auto' && !availableModels.includes(model)) {
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

function configuredModelAttempts(env) {
  const value = Number(env.VERBOO_AGENT_MAX_MODEL_ATTEMPTS ?? 2);
  return Number.isInteger(value) && value >= 1 && value <= 3 ? value : 2;
}

function configuredCooldownMs(env) {
  const value = Number(env.VERBOO_MODEL_COOLDOWN_SECONDS ?? 60);
  return Number.isFinite(value) && value >= 0 && value <= 3600
    ? value * 1000
    : 60_000;
}

function envList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateConfiguredModels(variable, models) {
  const unknown = models.filter((model) => !(model in MODEL_CATALOG));
  if (unknown.length) {
    throw agentError(
      'MODEL_POLICY_INVALID',
      `${variable} contém modelos desconhecidos: ${unknown.join(', ')}.`,
    );
  }
}

function executorAllowlistVariable(executor) {
  return executor === 'native'
    ? 'VERBOO_NATIVE_MODEL_ALLOWLIST'
    : 'VERBOO_OPENCODE_MODEL_ALLOWLIST';
}

function availableModelsForAuto(availableModels, env) {
  const allowlist = envList(env.VERBOO_MODEL_ALLOWLIST);
  const deniedModels = envList(env.VERBOO_MODEL_DENYLIST);
  validateConfiguredModels('VERBOO_MODEL_ALLOWLIST', allowlist);
  validateConfiguredModels('VERBOO_MODEL_DENYLIST', deniedModels);
  const denylist = new Set(deniedModels);
  return availableModels.filter((model) => (
    (!allowlist.length || allowlist.includes(model)) && !denylist.has(model)
  ));
}

function allowedTiers(env) {
  const configured = envList(env.VERBOO_MODEL_TIERS);
  if (!configured.length) return ['pro', 'max', 'ultra'];
  const knownTiers = new Set(
    Object.values(MODEL_CATALOG).map((model) => model.tier),
  );
  const unknown = configured.filter((tier) => !knownTiers.has(tier));
  if (unknown.length) {
    throw agentError(
      'MODEL_POLICY_INVALID',
      `VERBOO_MODEL_TIERS contém tiers desconhecidos: ${unknown.join(', ')}.`,
    );
  }
  return configured;
}

export function configuredModelPolicy(availableModels, env) {
  return {
    availableModels: availableModelsForAuto(availableModels, env),
    allowTiers: allowedTiers(env),
  };
}

export function assertGlobalModelAllowed(model, env) {
  const allowlist = envList(env.VERBOO_MODEL_ALLOWLIST);
  const denylist = new Set(envList(env.VERBOO_MODEL_DENYLIST));
  validateConfiguredModels('VERBOO_MODEL_ALLOWLIST', allowlist);
  validateConfiguredModels('VERBOO_MODEL_DENYLIST', [...denylist]);
  const tiers = allowedTiers(env);
  const tier = MODEL_CATALOG[model]?.tier;
  if (allowlist.length && !allowlist.includes(model)) {
    throw agentError(
      'MODEL_NOT_ALLOWED',
      `Modelo fora de VERBOO_MODEL_ALLOWLIST: ${model}.`,
    );
  }
  if (denylist.has(model)) {
    throw agentError(
      'MODEL_NOT_ALLOWED',
      `Modelo bloqueado por VERBOO_MODEL_DENYLIST: ${model}.`,
    );
  }
  if (!tier || !tiers.includes(tier)) {
    throw agentError(
      'MODEL_NOT_ALLOWED',
      `Tier do modelo bloqueado por VERBOO_MODEL_TIERS: ${model} (${tier ?? 'unknown'}).`,
    );
  }
}

export function globallyAllowedModels(availableModels, env) {
  const policy = configuredModelPolicy(availableModels, env);
  return policy.availableModels.filter(
    (model) => policy.allowTiers.includes(MODEL_CATALOG[model]?.tier),
  );
}

function markModelStarted(model) {
  const state = modelRuntimeState[model];
  state.inFlight += 1;
  state.lastSelectedAt = Date.now();
}

function markModelFinished(model, error, env) {
  const state = modelRuntimeState[model];
  state.inFlight = Math.max(0, state.inFlight - 1);
  if (error) {
    if (recoverableModelFailure(error)) {
      state.failures += 1;
      state.cooldownUntil = Date.now() + configuredCooldownMs(env);
    }
    return;
  }
  state.failures = 0;
  state.cooldownUntil = 0;
}

function recoverableModelFailure(error) {
  return ['EXIT_ERROR', 'TIMEOUT', 'MODEL_AT_CAPACITY'].includes(error.code);
}

function modelRouteFor(request, availableModels, env) {
  if (request.model !== 'auto') {
    assertGlobalModelAllowed(request.model, env);
    return {
      strategy: 'manual',
      model: request.model,
      profile: null,
      reason: 'Modelo definido explicitamente pelo orquestrador.',
      ranking: [{
        model: request.model,
        name: MODEL_CATALOG[request.model]?.name ?? request.model,
        tier: MODEL_CATALOG[request.model]?.tier ?? 'unknown',
        score: null,
        reasons: ['seleção manual'],
        penalties: [],
      }],
    };
  }

  const policy = configuredModelPolicy(availableModels, env);
  const route = selectModelForTask({
    prompt: request.routePrompt ?? request.prompt,
    mode: request.mode,
    availableModels: policy.availableModels,
    allowTiers: policy.allowTiers,
    runtimeState: modelRuntimeState,
  });
  return { strategy: 'auto', ...route };
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
    executor: 'opencode',
    label: 'OpenCode',
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

function nativePathPattern(cwd, suffix = '**') {
  const normalized = cwd.split(path.sep).join(path.posix.sep);
  const escaped = normalized.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  return `${escaped.replace(/\/+$/, '')}/${suffix}`;
}

function nativeDisallowedToolsForMode(mode) {
  return [
    ...(mode === 'read_only' ? ['Edit', 'Write'] : []),
    ...NATIVE_ALWAYS_DISALLOWED_TOOLS,
  ];
}

function nativePermissionSettings(request) {
  const write = request.mode === 'write';
  const projectFiles = nativePathPattern(request.cwd);
  const secretFiles = [
    nativePathPattern(request.cwd, '**/.env'),
    nativePathPattern(request.cwd, '**/.env.*'),
  ];
  const allow = [
    `Read(${projectFiles})`,
    `Glob(${projectFiles})`,
    'Grep',
  ];
  if (write) {
    allow.push(`Edit(${projectFiles})`, `Write(${projectFiles})`);
  }
  const deny = [
    ...secretFiles.map((pattern) => `Read(${pattern})`),
    ...secretFiles.map((pattern) => `Edit(${pattern})`),
    ...secretFiles.map((pattern) => `Write(${pattern})`),
    ...nativeDisallowedToolsForMode(request.mode),
  ];
  return JSON.stringify({
    disableAllHooks: true,
    permissions: {
      defaultMode: 'bypassPermissions',
      allow,
      deny,
    },
  });
}

export function allowedToolsForMode(mode, executor = 'native') {
  const write = mode === 'write';
  if (executor === 'opencode') {
    return write ? ['Read', 'Glob', 'List', 'Edit'] : ['Read', 'Glob', 'List'];
  }
  return write ? ['Read', 'Glob', 'Grep', 'Edit', 'Write'] : ['Read', 'Glob', 'Grep'];
}

export function buildVerbooCodeInvocation(
  request,
  verbooCodeBin = 'verboo',
  entrypoint = '',
) {
  const allowedTools = allowedToolsForMode(request.mode, 'native');
  const tools = allowedTools.join(',');
  const disallowedTools = nativeDisallowedToolsForMode(request.mode).join(',');
  const args = [];
  if (entrypoint) args.push(entrypoint);
  args.push(
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    request.model,
    '--permission-mode',
    'bypassPermissions',
    '--tools',
    tools,
    '--disallowed-tools',
    disallowedTools,
    '--include-partial-messages',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-chrome',
    '--settings',
    nativePermissionSettings(request),
    '--',
    request.prompt,
  );
  return {
    executor: 'native',
    label: 'Verboo Code',
    command: verbooCodeBin,
    args,
  };
}

export function buildChildEnv(sourceEnv, invocation) {
  const childEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (sourceEnv[key] !== undefined) childEnv[key] = sourceEnv[key];
  }
  if (invocation.executor === 'opencode') {
    for (const key of ['VERBOO_API_KEY', 'VERBOO_BASE_URL']) {
      if (sourceEnv[key] !== undefined) childEnv[key] = sourceEnv[key];
    }
    childEnv.OPENCODE_CONFIG_CONTENT = invocation.inlineConfig;
    childEnv.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  } else {
    childEnv.VERBOO_DISABLE_EARLY_INPUT = '1';
  }
  return childEnv;
}

function createThinkFilter() {
  let inThink = false;
  let thinkBuffer = '';

  const filter = (text) => {
    if (!text) return '';
    let result = '';
    let pos = 0;
    const input = thinkBuffer + text;
    thinkBuffer = '';

    while (pos < input.length) {
      if (inThink) {
        const closeIdx = input.toLowerCase().indexOf('</think>', pos);
        if (closeIdx !== -1) {
          if (
            closeIdx > 0
            && input[closeIdx - 1] === '`'
            && input[closeIdx + 8] === '`'
          ) {
            // Literal </think> em backticks — pula sem sair do think
            pos = closeIdx + 8;
          } else {
            inThink = false;
            pos = closeIdx + 8;
          }
        } else {
          const remaining = input.slice(pos);
          let partialMatchLength = 0;
          for (let len = Math.min(remaining.length, 7); len > 0; len--) {
            if ('</think>'.startsWith(remaining.slice(-len).toLowerCase())) {
              partialMatchLength = len;
              break;
            }
          }
          if (partialMatchLength > 0) {
            thinkBuffer = remaining.slice(-partialMatchLength);
          }
          break;
        }
      } else {
        const openIdx = input.toLowerCase().indexOf('<think>', pos);
        if (openIdx !== -1) {
          if (
            openIdx > 0
            && input[openIdx - 1] === '`'
            && input[openIdx + 7] === '`'
          ) {
            // Literal <think> em backticks — emite e continua
            result += input.slice(pos, openIdx + 7);
            pos = openIdx + 7;
            continue;
          }
          result += input.slice(pos, openIdx);
          inThink = true;
          pos = openIdx + 7;
        } else {
          const remaining = input.slice(pos);
          let partialMatchLength = 0;
          for (let len = Math.min(remaining.length, 6); len > 0; len--) {
            if ('<think>'.startsWith(remaining.slice(-len).toLowerCase())) {
              partialMatchLength = len;
              break;
            }
          }
          if (partialMatchLength > 0) {
            result += remaining.slice(0, remaining.length - partialMatchLength);
            thinkBuffer = remaining.slice(-partialMatchLength);
          } else {
            result += remaining;
          }
          break;
        }
      }
    }
    return result.trim();
  };

  filter.flush = () => {
    if (!inThink && thinkBuffer) {
      const buf = thinkBuffer.trim();
      thinkBuffer = '';
      return buf;
    }
    thinkBuffer = '';
    return '';
  };

  return filter;
}

function categorizeTool(name) {
  const n = (name ?? '').toLowerCase();
  if (n === 'read') return 'Read';
  if (n === 'glob' || n === 'list' || n === 'search') return 'Glob';
  if (n === 'grep') return 'Grep';
  if (n === 'edit' || n === 'apply_diff' || n === 'apply_patch') return 'Edit';
  if (n === 'write' || n === 'create' || n === 'delete') return 'Write';
  if (n === 'bash' || n === 'shell' || n === 'execute_command') return 'Bash';
  return 'Other';
}

function policyToolName(name) {
  const normalized = String(name ?? '').toLowerCase();
  if (normalized === 'apply_diff' || normalized === 'apply_patch') return 'edit';
  return normalized;
}

export function buildProgressOnLine(
  onProgress,
  {
    minIntervalMs = 100,
    now = Date.now,
    mode = 'read_only',
    executor = 'native',
  } = {},
) {
  const categories = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'Other'];
  const counts = Object.fromEntries(
    categories.map((category) => [
      category,
      { total: 0, succeeded: 0, failed: 0 },
    ]),
  );
  const allowedTools = allowedToolsForMode(mode, executor);
  const pendingTools = new Map();
  const completedTools = new Set();
  const anonymousActiveKeys = new Map();
  const anonymousActiveKeysByFullKey = new Map();
  const anonymousCounts = new Map();
  const toolAliases = new Map();
  const pendingContentToolsBySession = new Map();
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let pending = false;
  let closed = false;
  let phase = 'waiting_model';
  let hasSeenToolUse = false;

  const emit = () => {
    if (!pending || closed) return;
    pending = false;
    lastEmitAt = now();
    const toolCounts = Object.fromEntries(
      Object.entries(counts).map(([category, value]) => [
        category,
        { ...value },
      ]),
    );
    const total = Object.values(counts).reduce(
      (sum, value) => ({
        total: sum.total + value.total,
        succeeded: sum.succeeded + value.succeeded,
        failed: sum.failed + value.failed,
      }),
      { total: 0, succeeded: 0, failed: 0 },
    );
    onProgress({
      phase,
      allowed_tools: allowedTools,
      tool_counts: {
        ...toolCounts,
        total,
      },
    });
  };

  const startTool = (name, id, sessionContext = {}) => {
    let key;
    if (id) {
      key = String(id);
    } else {
      const sessionId = String(sessionContext.sessionId ?? 'global');
      const baseKey = `anon:${sessionId}:${name}`;
      if (!sessionContext.forceNewAnonymous && anonymousActiveKeys.has(baseKey)) {
        key = anonymousActiveKeys.get(baseKey);
      } else {
        const count = (anonymousCounts.get(baseKey) ?? 0) + 1;
        anonymousCounts.set(baseKey, count);
        key = `${baseKey}:${count}`;
        if (!sessionContext.forceNewAnonymous) {
          anonymousActiveKeys.set(baseKey, key);
          anonymousActiveKeysByFullKey.set(key, baseKey);
        }
      }
    }

    if (pendingTools.has(key) || completedTools.has(key)) return key;
    if (!hasSeenToolUse) {
      hasSeenToolUse = true;
      phase = 'executing_tool';
    } else if (phase === 'processing_result') {
      phase = 'executing_tool';
    }
    const category = categorizeTool(name);
    pendingTools.set(key, category);
    counts[category].total += 1;
    pending = true;
    return key;
  };

  const finishTool = (id, failed) => {
    if (!id) return;
    const key = String(id);
    const category = pendingTools.get(key);
    if (!category || completedTools.has(key)) return;
    counts[category][failed ? 'failed' : 'succeeded'] += 1;
    pendingTools.delete(key);
    completedTools.add(key);
    if (anonymousActiveKeysByFullKey.has(key)) {
      const baseKey = anonymousActiveKeysByFullKey.get(key);
      anonymousActiveKeys.delete(baseKey);
      anonymousActiveKeysByFullKey.delete(key);
    }
    for (const [alias, mappedKey] of toolAliases) {
      if (mappedKey === key) toolAliases.delete(alias);
    }
    phase = 'processing_result';
    pending = true;
  };

  const takePendingContentTool = (sessionId) => {
    const sessionKey = String(sessionId ?? 'global');
    const queue = pendingContentToolsBySession.get(sessionKey) ?? [];
    while (queue.length > 0) {
      const key = queue.shift();
      if (pendingTools.has(key)) return key;
    }
    pendingContentToolsBySession.delete(sessionKey);
    return null;
  };

  const onLine = (line) => {
    if (closed) return;
    try {
      const event = JSON.parse(line);
      const sessionID = event.sessionID ?? event.part?.sessionID ?? event.session_id ?? event.sessionId;

      // Partial messages wrap the Anthropic event under `event`.
      const streamEvent = event.type === 'stream_event' ? event.event : null;
      if (
        streamEvent?.type === 'content_block_start'
        && streamEvent.content_block?.type === 'tool_use'
      ) {
        const cb = streamEvent.content_block;
        startTool(cb.name, cb.id, { sessionId: event.session_id, context: cb.input });
        if (pending && now() - lastEmitAt >= minIntervalMs) emit();
        return;
      }

      if (event.type === 'tool_use' && typeof event.part?.tool === 'string') {
        const id = event.part.id
          ?? event.part.callID
          ?? event.part.callId
          ?? event.part.toolCallID;
        const context = event.part.state?.input ?? event.part.input;
        const key = startTool(event.part.tool, id, { sessionId: sessionID, context });
        const status = String(event.part.state?.status ?? '').toLowerCase();
        if (['completed', 'failed', 'error'].includes(status)) {
          finishTool(key, status !== 'completed' || Boolean(event.part.state?.error));
        }
      } else if (event.type === 'content' && event.content_type === 'tool_call' && typeof event.name === 'string') {
        const id = event.id ?? event.call_id ?? event.tool_use_id;
        const key = startTool(event.name, id, {
          sessionId: sessionID,
          forceNewAnonymous: !id,
        });
        if (id) toolAliases.set(String(id), key);
        const sessionKey = String(sessionID ?? 'global');
        const queue = pendingContentToolsBySession.get(sessionKey) ?? [];
        if (!queue.includes(key)) queue.push(key);
        pendingContentToolsBySession.set(sessionKey, queue);
      }

      for (const block of nativeEventBlocks(event)) {
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          startTool(block.name, block.id, { sessionId: sessionID, context: block.input });
        } else if (block.type === 'tool_result') {
          finishTool(block.tool_use_id, block.is_error === true);
        }
      }
      if (event.type === 'tool_result') {
        const id = event.tool_use_id ?? event.call_id ?? event.part?.tool_use_id;
        const directKey = id && pendingTools.has(String(id)) ? String(id) : null;
        const aliasedKey = id ? toolAliases.get(String(id)) : null;
        finishTool(
          directKey
            ?? aliasedKey
            ?? takePendingContentTool(sessionID),
          event.is_error === true || event.part?.is_error === true,
        );
      }
      if (pending && now() - lastEmitAt >= minIntervalMs) emit();
    } catch {}
  };
  onLine.flush = emit;
  onLine.close = () => {
    emit();
    closed = true;
  };
  return onLine;
}


export function parseOpenCodeEvents(raw, cwd) {
  let sessionId = null;
  const resultParts = [];
  const artifacts = new Set();
  const toolsUsed = new Set();
  const successfulTools = new Set();
  const filter = createThinkFilter();

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
      const candidate = filter(event.part?.text ?? '');
      if (candidate) resultParts.push(candidate);
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
    if (
      event.type === 'content'
      && event.content_type === 'tool_call'
      && typeof event.name === 'string'
    ) {
      toolsUsed.add(event.name);
    }
  }

  const remaining = filter.flush();
  if (remaining) resultParts.push(remaining);

  return {
    sessionId,
    result: resultParts.join('\n'),
    artifacts: sortedStrings(artifacts),
    toolsUsed: sortedStrings(toolsUsed),
    successfulTools: sortedStrings(successfulTools),
  };
}

function nativeEventBlocks(event) {
  const content = event.message?.content ?? event.content;
  return Array.isArray(content) ? content : [];
}

export function parseVerbooCodeEvents(raw, cwd) {
  let sessionId = null;
  const resultParts = [];
  const artifacts = new Set();
  const toolsUsed = new Set();
  const successfulTools = new Set();
  const pendingTools = new Map();
  const filter = createThinkFilter();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    sessionId ||= event.session_id ?? event.sessionId ?? null;
    if (event.type === 'result' && typeof event.result === 'string') {
      const candidate = filter(event.result);
      if (candidate) resultParts.push(candidate);
    }

    for (const block of nativeEventBlocks(event)) {
      if (block.type === 'text') {
        const candidate = filter(block.text ?? '');
        if (candidate) resultParts.push(candidate);
        continue;
      }
      if (block.type === 'tool_use') {
        const tool = String(block.name ?? '');
        if (tool) toolsUsed.add(tool);
        const paths = [];
        for (const value of [
          block.input?.file_path,
          block.input?.filePath,
          block.input?.path,
        ]) {
          if (typeof value !== 'string') continue;
          const candidate = path.resolve(cwd, value);
          if (isInside(cwd, candidate)) paths.push(candidate);
        }
        if (block.id) pendingTools.set(block.id, { tool, paths });
        continue;
      }
      if (block.type === 'tool_result') {
        const pending = pendingTools.get(block.tool_use_id);
        if (!pending || block.is_error === true) continue;
        if (pending.tool) successfulTools.add(pending.tool);
        for (const artifact of pending.paths) artifacts.add(artifact);
      }
    }
  }

  const remaining = filter.flush();
  if (remaining) resultParts.push(remaining);

  return {
    sessionId,
    result: resultParts.join('\n'),
    artifacts: sortedStrings(artifacts),
    toolsUsed: sortedStrings(toolsUsed),
    successfulTools: sortedStrings(successfulTools),
  };
}

export function resolveAgentExecutor(requestedExecutor, env) {
  const executor = String(
    requestedExecutor ?? env.VERBOO_AGENT_EXECUTOR ?? 'native',
  ).toLowerCase();
  if (!AGENT_EXECUTORS.includes(executor)) {
    throw agentError(
      'EXECUTOR_INVALID',
      `executor deve ser um de: ${AGENT_EXECUTORS.join(', ')}.`,
    );
  }
  return executor;
}

function recoveryFor(error) {
  const executorAllowlist = error.executor
    ? ` e ${executorAllowlistVariable(error.executor)}`
    : '';
  const recovery = {
    PROMPT_REQUIRED: ['Informe um prompt não vazio e tente novamente.'],
    PROMPT_TOO_LARGE: ['Reduza o prompt para o limite informado e tente novamente.'],
    MODE_INVALID: ['Escolha mode como read_only ou write.'],
    MODEL_INVALID: ['Escolha auto ou um modelo exposto pelo contrato MCP.'],
    TIMEOUT_INVALID: [
      `Escolha timeout_seconds entre ${MIN_TIMEOUT_SECONDS} e ${MAX_TIMEOUT_SECONDS}.`,
    ],
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
    VERBOO_API_KEY_REQUIRED: [
      'Configure VERBOO_API_KEY no servidor MCP ou escolha executor native com OAuth.',
    ],
    VERBOO_CODE_NOT_FOUND: [
      'Instale @verboo/code ou configure VERBOO_CODE_BIN e VERBOO_CODE_ENTRYPOINT.',
    ],
    VERBOO_AUTH_REQUIRED: [
      'Execute a CLI oficial com `verboo auth login` ou `verboo auth login --headless`.',
      'Depois reinicie o cliente MCP para que o executor herde a sessão OAuth.',
    ],
    EXECUTOR_INVALID: [
      `Escolha executor como ${AGENT_EXECUTORS.join(' ou ')} na chamada, ou configure VERBOO_AGENT_EXECUTOR.`,
    ],
    MODEL_NOT_ALLOWED: [
      `Escolha outro modelo ou revise VERBOO_MODEL_ALLOWLIST, VERBOO_MODEL_DENYLIST, VERBOO_MODEL_TIERS${executorAllowlist} no servidor MCP.`,
    ],
    MODEL_ROUTE_EMPTY: [
      `Revise VERBOO_MODEL_ALLOWLIST, VERBOO_MODEL_DENYLIST, VERBOO_MODEL_TIERS${executorAllowlist}.`,
    ],
    MODEL_POLICY_INVALID: [
      'Corrija os modelos ou tiers desconhecidos nas políticas VERBOO_MODEL_* e reinicie o servidor MCP.',
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
    MODEL_AT_CAPACITY: [
      'O modelo ficou temporariamente lotado; em leitura o bridge tenta outro modelo elegível automaticamente.',
      'Se todos os modelos falharem, aguarde a capacidade normalizar e tente novamente.',
    ],
    OUTPUT_LIMIT: ['Reduza o escopo; a execução excedeu o limite de saída do bridge.'],
    EXIT_ERROR: [
      'Confirme a autenticação e a configuração do executor antes de tentar novamente.',
    ],
  };
  return recovery[error.code] ?? ['Corrija a entrada ou configuração indicada e tente novamente.'];
}

export function formatAgentFailure(error) {
  const failure = {
    status: 'error',
    summary: error.message,
    result: '',
    next_actions: recoveryFor(error),
    artifacts: [],
    session_id: null,
  };
  if (error.routing) failure.routing = error.routing;
  return failure;
}

function execute(invocation, options) {
  const {
    cwd,
    timeoutSeconds,
    env,
    spawnImpl = spawn,
    killImpl = process.kill,
    killGraceMs = KILL_GRACE_MS,
    timeoutMs = timeoutSeconds * 1000,
    signal,
    onLine,
  } = options;

  return new Promise((resolve, reject) => {
    // Reject immediately if signal already aborted
    if (signal?.aborted) {
      reject(agentError('CANCELLED', 'Job cancelado antes de iniciar o subprocesso.'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationError = null;
    let forceKillTimer;
    let timer;
    let lineBuffer = '';

    const child = spawnImpl(invocation.command, invocation.args, {
      cwd,
      env: buildChildEnv(env, invocation),
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onSignalAbort = () => terminate(
      agentError('CANCELLED', 'Job cancelado pelo usuário.'),
    );

    // Connect external AbortSignal (from job queue) to child process
    if (signal) {
      signal.addEventListener('abort', onSignalAbort, { once: true });
    }

    const finish = (callback, value, clearForceKill = true) => {
      if (settled) return;
      settled = true;
      onLine?.close?.();
      clearTimeout(timer);
      if (clearForceKill) clearTimeout(forceKillTimer);
      if (signal) {
        signal.removeEventListener('abort', onSignalAbort);
      }
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
      forceKillTimer = setTimeout(() => {
        signalTree('SIGKILL');
        finish(reject, terminationError);
      }, killGraceMs);
      signalTree('SIGTERM');
    };

    timer = setTimeout(() => {
      terminate(agentError(
        'TIMEOUT',
        `${invocation.label} excedeu o timeout de ${timeoutSeconds}s e foi interrompido.`,
      ));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (terminationError) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate(
          agentError(
            'OUTPUT_LIMIT',
            `Saída do ${invocation.label} excedeu 4 MiB e foi interrompida.`,
          ),
        );
        return;
      }
      const text = chunk.toString();
      stdout += text;
      if (onLine) {
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      }
    });

    child.stderr?.on('data', (chunk) => {
      if (terminationError) return;
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr += chunk.toString();
    });

    child.on('error', (error) => {
      const wrapped = agentError(
        error.code === 'ENOENT'
          ? invocation.executor === 'native'
            ? 'VERBOO_CODE_NOT_FOUND'
            : 'OPENCODE_NOT_FOUND'
          : 'EXIT_ERROR',
        error.code === 'ENOENT'
          ? `${invocation.label} não encontrado: ${invocation.command}`
          : `Falha ao iniciar ${invocation.label}: ${error.message}`,
      );
      finish(reject, wrapped);
    });

    child.on('close', (code) => {
      if (terminationError) {
        const processGroupMayRemain = process.platform !== 'win32' && child.pid;
        finish(reject, terminationError, !processGroupMayRemain);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').at(-1);
        const suffix = detail ? ` (${detail.slice(0, 300)})` : '';
        if (
          invocation.executor === 'native'
          && /não autenticado no verboo|not authenticated.*verboo/i.test(stderr)
        ) {
          finish(
            reject,
            agentError(
              'VERBOO_AUTH_REQUIRED',
              'Sessão OAuth do Verboo Code não encontrada.',
            ),
          );
          return;
        }
        if (
          /selected model is at capacity|model(?:o)? (?:is |está )?(?:at )?capacity|rate.?limit/i
            .test(stderr)
        ) {
          finish(
            reject,
            agentError(
              'MODEL_AT_CAPACITY',
              `${invocation.label} encontrou o modelo temporariamente sem capacidade${suffix}.`,
            ),
          );
          return;
        }
        finish(
          reject,
          agentError(
            'EXIT_ERROR',
            `${invocation.label} encerrou com código ${code}${suffix}.`,
          ),
        );
        return;
      }
      if (lineBuffer.trim() && onLine) onLine(lineBuffer);
      finish(resolve, stdout);
    });
  });
}

function buildAgentInvocation(request, executor, env) {
  if (executor === 'native') {
    return buildVerbooCodeInvocation(
      request,
      env.VERBOO_CODE_BIN || 'verboo',
      env.VERBOO_CODE_ENTRYPOINT || '',
    );
  }
  return buildOpenCodeInvocation(
    request,
    env.VERBOO_OPENCODE_BIN || 'opencode',
  );
}

async function executeAgentAttempt(
  request,
  executor,
  options,
  timeoutSeconds = request.timeoutSeconds,
) {
  if (options.onProgress) {
    options.onProgress({
      phase: 'waiting_model',
      allowed_tools: allowedToolsForMode(request.mode, executor),
    });
  }
  const invocation = buildAgentInvocation(request, executor, options.env);
  const onLine = options.onProgress
    ? buildProgressOnLine(options.onProgress, { mode: request.mode, executor })
    : undefined;
  const raw = await execute(invocation, {
    cwd: request.cwd,
    timeoutSeconds,
    env: options.env,
    spawnImpl: options.spawnImpl,
    killImpl: options.killImpl,
    killGraceMs: options.killGraceMs,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onLine,
  });
  if (options.onProgress) options.onProgress({ phase: 'processing_result' });
  const parsed = executor === 'native'
    ? parseVerbooCodeEvents(raw, request.cwd)
    : parseOpenCodeEvents(raw, request.cwd);
  const allowedTools = new Set(
    allowedToolsForMode(request.mode, executor).map(policyToolName),
  );
  const forbiddenUsed = parsed.toolsUsed.filter(
    (tool) => !allowedTools.has(policyToolName(tool)),
  );
  if (forbiddenUsed.length > 0) {
    throw agentError(
      'FORBIDDEN_TOOL_USED',
      `${invocation.label} executou ferramenta proibida pela política: ${forbiddenUsed.join(', ')}.`,
    );
  }
  const hasWriteExecution = parsed.successfulTools.some((tool) => (
    ['apply_patch', 'edit', 'write'].includes(tool.toLowerCase())
  ));
  return {
    parsed,
    status: request.mode === 'write' && !hasWriteExecution
      ? 'warning'
      : 'success',
  };
}

function routingResult(route, initialRoute, model, attempts) {
  const fallbackCount = attempts.length - 1;
  return {
    strategy: route.strategy,
    selected_model: model,
    reason: fallbackCount > 0
      ? `Fallback após ${fallbackCount} falha(s): ${route.reason}`
      : route.reason,
    task_profile: route.profile,
    ranking: initialRoute.ranking,
    attempts,
  };
}

function successfulAgentResult({
  request,
  executor,
  route,
  initialRoute,
  model,
  attempts,
  parsed,
  status,
}) {
  const memory = extractMemoryNote(parsed.result);
  return {
    status,
    summary: status === 'warning'
      ? 'O agente encerrou sem executar ferramenta de edição; nenhuma mudança foi confirmada.'
      : `Agente Verboo concluiu a tarefa em modo ${request.mode}.`,
    result: memory.result || 'Execução concluída sem mensagem final.',
    next_actions: status === 'warning'
      ? [
          'Não trate a tarefa como concluída.',
          'Revise a instrução ou escolha manualmente outro modelo.',
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
    model,
    mode: request.mode,
    cwd: request.cwd,
    executor,
    routing: routingResult(route, initialRoute, model, attempts),
    memory_note: memory.note || null,
  };
}

function maxAttemptsFor(request, route, env, availableModelCount) {
  if (request.mode !== 'read_only') return 1;
  if (route.strategy === 'auto') {
    return Math.min(configuredModelAttempts(env), route.ranking.length);
  }
  return Math.min(configuredModelAttempts(env), availableModelCount);
}

function canRetryAttempt(request, route, error, attempts, maxAttempts) {
  return (
    request.mode === 'read_only'
    && recoverableModelFailure(error)
    && (
      route.strategy === 'auto'
      || error.code === 'MODEL_AT_CAPACITY'
    )
    && attempts.length < maxAttempts
  );
}

function rerouteAfterFailure(request, options, attempts) {
  const attemptedModels = new Set(attempts.map((attempt) => attempt.model));
  const remainingModels = options.availableModels.filter(
    (model) => !attemptedModels.has(model),
  );
  return modelRouteFor(
    { ...request, model: 'auto' },
    remainingModels,
    options.env,
  );
}

async function runRoutedAgent(request, executor, options) {
  const initialRoute = modelRouteFor(
    request,
    options.availableModels,
    options.env,
  );
  const maxAttempts = maxAttemptsFor(
    request,
    initialRoute,
    options.env,
    options.availableModels.length,
  );
  const attempts = [];
  const now = options.now ?? Date.now;
  const deadline = now() + request.timeoutSeconds * 1000;
  let route = initialRoute;

  while (attempts.length < maxAttempts) {
    const remainingSeconds = (deadline - now()) / 1000;
    if (remainingSeconds <= 0) {
      const error = agentError(
        'TIMEOUT',
        `Agente excedeu o orçamento total de ${request.timeoutSeconds}s.`,
      );
      error.routing = routingResult(
        route,
        initialRoute,
        attempts.at(-1)?.model ?? route.ranking[0].model,
        attempts,
      );
      throw error;
    }
    const model = route.ranking[0].model;
    const attemptRequest = { ...request, model };
    if (options.onProgress) {
      options.onProgress({
        phase: 'generating',
        model,
        attempts: { current: attempts.length + 1, total: maxAttempts },
      });
    }
    markModelStarted(model);
    try {
      const { parsed, status } = await executeAgentAttempt(
        attemptRequest,
        executor,
        options,
        remainingSeconds,
      );
      attempts.push({ model, status });
      markModelFinished(model, null, options.env);
      return successfulAgentResult({
        request,
        executor,
        route,
        initialRoute,
        model,
        attempts,
        parsed,
        status,
      });
    } catch (error) {
      attempts.push({
        model,
        status: 'error',
        code: error.code ?? 'UNKNOWN',
        summary: error.message,
      });
      markModelFinished(model, error, options.env);
      if (!canRetryAttempt(request, route, error, attempts, maxAttempts)) {
        error.routing = routingResult(
          route,
          initialRoute,
          model,
          attempts,
        );
        throw error;
      }
      route = rerouteAfterFailure(request, options, attempts);
      if (options.onProgress) {
        options.onProgress({
          phase: 'routing',
          attempts: { current: attempts.length + 1, total: maxAttempts },
        });
      }
    }
  }

  throw agentError('MODEL_ROUTE_EMPTY', 'Nenhum modelo pôde executar a tarefa.');
}

function validateExecutorCredentials(executor, env) {
  if (executor === 'opencode' && !env.VERBOO_API_KEY) {
    throw agentError(
      'VERBOO_API_KEY_REQUIRED',
      'executor opencode requer VERBOO_API_KEY no servidor MCP.',
    );
  }
}

export function executorAvailableModels(executor, availableModels, env) {
  const variable = executorAllowlistVariable(executor);
  const configured = envList(env[variable]);
  validateConfiguredModels(variable, configured);
  if (configured.length === 0) return availableModels;
  const allowed = new Set(configured);
  return availableModels.filter((model) => allowed.has(model));
}

export async function runVerbooAgent(args, options) {
  let releaseAgentSlot = options.slotRelease;
  try {
    const progressCallback = typeof args?.__onProgress === 'function'
      ? args.__onProgress : null;
    if (progressCallback) {
      options = { ...options, onProgress: progressCallback };
      progressCallback({ phase: 'routing' });
    }
    const request = normalizeAgentRequest(args, options.availableModels);
    if (request.mode === 'write' && options.env.VERBOO_AGENT_WRITE_ENABLED !== '1') {
      throw agentError(
        'WRITE_DISABLED',
        'Modo write desabilitado no servidor MCP.',
      );
    }
    releaseAgentSlot ??= acquireAgentSlot(options.env);

    request.cwd = await resolveAllowedCwd(
      request.cwd,
      options.env.VERBOO_AGENT_ALLOWED_ROOTS,
    );
    const originalPrompt = request.prompt;
    const memoryContext = await loadMemoryContext(request.cwd, options.env);
    request.routePrompt = originalPrompt;
    request.prompt = promptWithMemory(originalPrompt, memoryContext);
    const executor = resolveAgentExecutor(args.executor, options.env);
    validateExecutorCredentials(executor, options.env);
    const executorModels = executorAvailableModels(
      executor,
      options.availableModels,
      options.env,
    );
    if (request.model !== 'auto') {
      assertGlobalModelAllowed(request.model, options.env);
    }
    const availableModels = globallyAllowedModels(executorModels, options.env);
    if (availableModels.length === 0) {
      const error = agentError(
        'MODEL_ROUTE_EMPTY',
        `Nenhum modelo disponível para o executor ${executor}.`,
      );
      error.executor = executor;
      throw error;
    }
    if (request.model !== 'auto' && !executorModels.includes(request.model)) {
      const error = agentError(
        'MODEL_NOT_ALLOWED',
        `Modelo ${request.model} indisponível para o executor ${executor}.`,
      );
      error.executor = executor;
      throw error;
    }
    const result = await runRoutedAgent(request, executor, {
      ...options,
      availableModels,
    });
    let persisted = false;
    let persistenceWarning = null;
    try {
      persisted = await rememberProjectNote(
        request.cwd,
        result.memory_note,
        result,
        options.env,
      );
    } catch {
      persistenceWarning = {
        code: 'MEMORY_PERSIST_FAILED',
        message: 'O agente concluiu, mas a memória opcional não pôde ser persistida.',
      };
    }
    result.memory = {
      injected_project_entries: memoryContext.projectEntries,
      injected_shared_files: memoryContext.sharedFiles,
      persisted,
    };
    if (persistenceWarning) {
      result.memory.warning = persistenceWarning;
      result.warnings = [...(result.warnings ?? []), persistenceWarning];
    }
    delete result.memory_note;
    return result;
  } finally {
    releaseAgentSlot?.();
  }
}
