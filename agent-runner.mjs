import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
// Streaming mantém limites independentes para o volume cumulativo, cada
// linha JSONL e o texto público retido.
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_RESULT_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_TRACKED_ITEMS = 4_096;
const MAX_NATIVE_KEY_PART_BYTES = 4_096;
const MAX_NATIVE_PATH_COMPONENTS = 256;
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
  'APPDATA',
  'CI',
  'ComSpec',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'LOGNAME',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
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

function canonicalizePath(value) {
  const suffix = [];
  for (let current = value; ;) {
    try {
      return path.join(realpathSync(current), ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return value;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root, candidate) {
  const relative = path.relative(canonicalizePath(root), canonicalizePath(candidate));
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

export function autoIncludePremiumModels(env) {
  return String(env.VERBOO_AUTO_INCLUDE_PREMIUM_MODELS ?? '').trim() === '1';
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
  const includePremiumModels = autoIncludePremiumModels(env);
  const route = selectModelForTask({
    prompt: request.routePrompt ?? request.prompt,
    mode: request.mode,
    availableModels: policy.availableModels,
    allowTiers: policy.allowTiers,
    includePremiumModels,
    runtimeState: modelRuntimeState,
  });
  return { strategy: 'auto', autoIncludePremiumModels: includePremiumModels, ...route };
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

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

function isBacktickedTag(input, index, tag) {
  return index > 0
    && input[index - 1] === '`'
    && input[index + tag.length] === '`';
}

function trailingTagPrefix(text, tag) {
  for (let length = Math.min(text.length, tag.length - 1); length > 0; length--) {
    if (tag.startsWith(text.slice(-length).toLowerCase())) {
      return text.slice(-length);
    }
  }
  return '';
}

function consumeInsideThink(input, position) {
  const closeIndex = input.toLowerCase().indexOf(THINK_CLOSE, position);
  if (closeIndex === -1) {
    return {
      position: input.length,
      inThink: true,
      buffer: trailingTagPrefix(input.slice(position), THINK_CLOSE),
      visible: '',
    };
  }
  return {
    position: closeIndex + THINK_CLOSE.length,
    inThink: isBacktickedTag(input, closeIndex, THINK_CLOSE),
    buffer: '',
    visible: '',
  };
}

function consumeVisibleText(input, position) {
  const openIndex = input.toLowerCase().indexOf(THINK_OPEN, position);
  if (openIndex === -1) {
    const remaining = input.slice(position);
    const buffer = trailingTagPrefix(remaining, THINK_OPEN);
    return {
      position: input.length,
      inThink: false,
      buffer,
      visible: remaining.slice(0, remaining.length - buffer.length),
    };
  }
  if (isBacktickedTag(input, openIndex, THINK_OPEN)) {
    return {
      position: openIndex + THINK_OPEN.length,
      inThink: false,
      buffer: '',
      visible: input.slice(position, openIndex + THINK_OPEN.length),
    };
  }
  return {
    position: openIndex + THINK_OPEN.length,
    inThink: true,
    buffer: '',
    visible: input.slice(position, openIndex),
  };
}

function consumeThinkStream(input, startsInThink) {
  let position = 0;
  let inThink = startsInThink;
  let buffer = '';
  let visible = '';
  while (position < input.length) {
    const consumed = inThink
      ? consumeInsideThink(input, position)
      : consumeVisibleText(input, position);
    position = consumed.position;
    inThink = consumed.inThink;
    buffer = consumed.buffer;
    visible += consumed.visible;
  }
  return { inThink, buffer, visible };
}

function createThinkFilter() {
  let inThink = false;
  let thinkBuffer = '';

  const filter = (text) => {
    if (!text) return '';
    const consumed = consumeThinkStream(thinkBuffer + text, inThink);
    inThink = consumed.inThink;
    thinkBuffer = consumed.buffer;
    return consumed.visible;
  };

  filter.flush = () => {
    const visible = inThink ? '' : thinkBuffer;
    thinkBuffer = '';
    return visible;
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

function toolCategories(names) {
  return sortedStrings(new Set(names.map(categorizeTool)));
}

function addBounded(set, value, label) {
  if (set.has(value)) return;
  if (set.size >= MAX_TRACKED_ITEMS) {
    throw agentError(
      'OUTPUT_LIMIT',
      `${label} excedeu o limite de ${MAX_TRACKED_ITEMS} itens.`,
    );
  }
  set.add(value);
}

function setBounded(map, key, value, label) {
  if (!map.has(key) && map.size >= MAX_TRACKED_ITEMS) {
    throw agentError(
      'OUTPUT_LIMIT',
      `${label} excedeu o limite de ${MAX_TRACKED_ITEMS} itens.`,
    );
  }
  map.set(key, value);
}

function rememberRecent(set, value) {
  if (set.has(value)) return;
  // ponytail: dedupe guarda só IDs recentes; aumente o teto se duplicatas
  // puderem reaparecer depois de mais de MAX_TRACKED_ITEMS ferramentas.
  if (set.size >= MAX_TRACKED_ITEMS) set.delete(set.values().next().value);
  set.add(value);
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
  const toolAliases = new Map();
  const pendingContentToolsBySession = new Map();
  let pendingContentToolCount = 0;
  let anonymousSequence = 0;
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
        anonymousSequence += 1;
        key = `${baseKey}:${anonymousSequence}`;
        if (!sessionContext.forceNewAnonymous) {
          setBounded(anonymousActiveKeys, baseKey, key, 'Ferramentas anônimas ativas');
          setBounded(
            anonymousActiveKeysByFullKey,
            key,
            baseKey,
            'Ferramentas anônimas ativas',
          );
        }
      }
    }

    if (pendingTools.has(key) || completedTools.has(key)) return key;
    const category = categorizeTool(name);
    setBounded(pendingTools, key, category, 'Ferramentas pendentes');
    if (!hasSeenToolUse) {
      hasSeenToolUse = true;
      phase = 'executing_tool';
    } else if (phase === 'waiting_model') {
      phase = 'executing_tool';
    }
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
    rememberRecent(completedTools, key);
    if (anonymousActiveKeysByFullKey.has(key)) {
      const baseKey = anonymousActiveKeysByFullKey.get(key);
      anonymousActiveKeys.delete(baseKey);
      anonymousActiveKeysByFullKey.delete(key);
    }
    for (const [alias, mappedKey] of toolAliases) {
      if (mappedKey === key) toolAliases.delete(alias);
    }
    // tool_result devolve o turno ao modelo: a fase só vira
    // processing_result quando o subprocesso fecha (executeAgentAttempt).
    phase = 'waiting_model';
    pending = true;
  };

  const takePendingContentTool = (sessionId) => {
    const sessionKey = String(sessionId ?? 'global');
    const queue = pendingContentToolsBySession.get(sessionKey);
    while (queue?.size > 0) {
      const key = queue.values().next().value;
      queue.delete(key);
      pendingContentToolCount -= 1;
      if (queue.size === 0) pendingContentToolsBySession.delete(sessionKey);
      if (pendingTools.has(key)) return key;
    }
    pendingContentToolsBySession.delete(sessionKey);
    return null;
  };

  const emitIfReady = () => {
    if (pending && now() - lastEmitAt >= minIntervalMs) emit();
  };

  const handleStreamToolStart = (event) => {
    const streamEvent = event.type === 'stream_event' ? event.event : null;
    if (
      streamEvent?.type !== 'content_block_start'
      || streamEvent.content_block?.type !== 'tool_use'
    ) {
      return false;
    }
    const block = streamEvent.content_block;
    startTool(block.name, block.id, {
      sessionId: event.session_id,
      context: block.input,
    });
    return true;
  };

  const registerContentToolCall = (event, sessionId) => {
    const id = event.id ?? event.call_id ?? event.tool_use_id;
    if (!id && pendingContentToolCount >= MAX_TRACKED_ITEMS) {
      throw agentError(
        'OUTPUT_LIMIT',
        `Ferramentas content pendentes excederam ${MAX_TRACKED_ITEMS} itens.`,
      );
    }
    const key = startTool(event.name, id, {
      sessionId,
      forceNewAnonymous: !id,
    });
    if (id) {
      setBounded(toolAliases, String(id), key, 'Aliases de ferramentas');
      return;
    }
    const sessionKey = String(sessionId ?? 'global');
    let queue = pendingContentToolsBySession.get(sessionKey);
    if (!queue) {
      queue = new Set();
      setBounded(
        pendingContentToolsBySession,
        sessionKey,
        queue,
        'Sessões com ferramentas pendentes',
      );
    }
    queue.add(key);
    pendingContentToolCount += 1;
  };

  const handleOpenCodeToolUse = (event, sessionId) => {
    if (event.type === 'tool_use' && typeof event.part?.tool === 'string') {
      const id = event.part.id
        ?? event.part.callID
        ?? event.part.callId
        ?? event.part.toolCallID;
      const context = event.part.state?.input ?? event.part.input;
      const key = startTool(event.part.tool, id, { sessionId, context });
      const status = String(event.part.state?.status ?? '').toLowerCase();
      if (['completed', 'failed', 'error'].includes(status)) {
        finishTool(key, status !== 'completed' || Boolean(event.part.state?.error));
      }
      return;
    }
    if (
      event.type === 'content'
      && event.content_type === 'tool_call'
      && typeof event.name === 'string'
    ) {
      registerContentToolCall(event, sessionId);
    }
  };

  const handleNativeBlocks = (event, sessionId) => {
    for (const block of nativeEventBlocks(event)) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        startTool(block.name, block.id, { sessionId, context: block.input });
      } else if (block.type === 'tool_result') {
        finishTool(block.tool_use_id, block.is_error === true);
      }
    }
  };

  const handleToolResult = (event, sessionId) => {
    if (event.type !== 'tool_result') return;
    const id = event.tool_use_id ?? event.call_id ?? event.part?.tool_use_id;
    const directKey = id && pendingTools.has(String(id)) ? String(id) : null;
    const aliasedKey = id ? toolAliases.get(String(id)) : null;
    finishTool(
      directKey
        ?? aliasedKey
        ?? takePendingContentTool(sessionId),
      event.is_error === true || event.part?.is_error === true,
    );
  };

  const onLine = (line) => {
    if (closed) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    pending = true;
    const sessionId = event.sessionID
      ?? event.part?.sessionID
      ?? event.session_id
      ?? event.sessionId;
    if (handleStreamToolStart(event)) {
      emitIfReady();
      return;
    }
    handleOpenCodeToolUse(event, sessionId);
    handleNativeBlocks(event, sessionId);
    handleToolResult(event, sessionId);
    emitIfReady();
  };
  onLine.flush = emit;
  onLine.close = () => {
    emit();
    closed = true;
  };
  return onLine;
}


function openCodeEventSessionId(event) {
  return event.sessionID
    ?? event.part?.sessionID
    ?? event.session_id
    ?? event.sessionId
    ?? null;
}

function registerOpenCodeContentTool(pendingState, event) {
  if (
    event.type !== 'content'
    || event.content_type !== 'tool_call'
    || typeof event.name !== 'string'
  ) {
    return null;
  }
  const sessionKey = String(openCodeEventSessionId(event) ?? 'global');
  const queue = pendingState.bySession.get(sessionKey) ?? [];
  const id = event.id ?? event.call_id ?? event.tool_use_id;
  if (pendingState.size >= MAX_TRACKED_ITEMS) {
    throw agentError(
      'OUTPUT_LIMIT',
      `Ferramentas OpenCode pendentes excederam ${MAX_TRACKED_ITEMS} itens.`,
    );
  }
  queue.push({ id: id == null ? null : String(id), tool: event.name });
  pendingState.size += 1;
  setBounded(
    pendingState.bySession,
    sessionKey,
    queue,
    'Sessões OpenCode pendentes',
  );
  return event.name;
}

function takeSuccessfulOpenCodeContentTool(pendingState, event) {
  if (event.type !== 'tool_result') return null;
  const sessionKey = String(openCodeEventSessionId(event) ?? 'global');
  const queue = pendingState.bySession.get(sessionKey) ?? [];
  if (queue.length === 0) return null;
  const id = event.tool_use_id ?? event.call_id ?? event.part?.tool_use_id;
  let matchedIndex = id == null
    ? -1
    : queue.findIndex((pending) => pending.id === String(id));
  if (id != null && matchedIndex < 0) {
    matchedIndex = queue.findIndex((pending) => pending.id == null);
    if (matchedIndex < 0) return null;
  }
  const [completed] = queue.splice(id == null ? 0 : matchedIndex, 1);
  pendingState.size -= 1;
  if (queue.length === 0) pendingState.bySession.delete(sessionKey);
  if (event.is_error === true || event.part?.is_error === true) return null;
  return completed.tool;
}

function createEventParserState(cwd) {
  return {
    cwd,
    sessionId: null,
    resultText: '',
    resultBytes: 0,
    canonicalResult: null,
    artifacts: new Set(),
    toolsUsed: new Set(),
    successfulTools: new Set(),
    filter: createThinkFilter(),
  };
}

function pushResultPart(state, text) {
  const bytes = Buffer.byteLength(text);
  if (state.resultBytes + bytes > MAX_RESULT_TEXT_BYTES) {
    throw agentError(
      'OUTPUT_LIMIT',
      `Texto público do agente excedeu o limite de ${MAX_RESULT_TEXT_BYTES} bytes.`,
    );
  }
  state.resultText += text;
  state.resultBytes += bytes;
}

function standaloneVisibleText(text) {
  const filter = createThinkFilter();
  return `${filter(text)}${filter.flush()}`;
}

function setCanonicalResult(state, text) {
  const visible = standaloneVisibleText(text);
  if (Buffer.byteLength(visible) > MAX_RESULT_TEXT_BYTES) {
    throw agentError(
      'OUTPUT_LIMIT',
      `Texto público do agente excedeu ${MAX_RESULT_TEXT_BYTES} bytes e foi interrompido.`,
    );
  }
  state.canonicalResult = visible;
  state.resultText = '';
  state.resultBytes = 0;
}

function appendVisibleText(state, text) {
  if (text) pushResultPart(state, text);
}

function finishEventParser(state) {
  if (state.canonicalResult == null) appendVisibleText(state, state.filter.flush());
  const artifacts = sortedStrings(state.artifacts);
  const successfulTools = sortedStrings(state.successfulTools);
  return {
    sessionId: state.sessionId,
    result: successfulResultText({
      result: (state.canonicalResult ?? state.resultText).trim(),
      artifacts,
      successfulTools,
    }),
    artifacts,
    toolsUsed: sortedStrings(state.toolsUsed),
    successfulTools,
  };
}

function validateArtifactPath(value, componentErrorCode = 'INVALID_EVENT') {
  if (typeof value !== 'string') {
    throw agentError('INVALID_EVENT', 'Caminho de artefato deve ser uma string.');
  }
  if (Buffer.byteLength(value) > MAX_NATIVE_KEY_PART_BYTES) {
    throw agentError(
      'OUTPUT_LIMIT',
      `Caminho de artefato excedeu o limite de ${MAX_NATIVE_KEY_PART_BYTES} bytes.`,
    );
  }
  if (value.split(/[\\/]+/u).filter(Boolean).length > MAX_NATIVE_PATH_COMPONENTS) {
    throw agentError(
      componentErrorCode,
      `Caminho de artefato excedeu ${MAX_NATIVE_PATH_COMPONENTS} componentes.`,
    );
  }
  return value;
}

export function createOpenCodeEventParser(cwd) {
  const state = createEventParserState(cwd);
  const pendingContentTools = { bySession: new Map(), size: 0 };

  return {
    feed(line) {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      state.sessionId ||= openCodeEventSessionId(event);
      if (event.type === 'text') {
        appendVisibleText(state, state.filter(event.part?.text ?? ''));
      }

      if (event.type === 'tool_use') {
        if (event.part?.tool) addBounded(state.toolsUsed, event.part.tool, 'Ferramentas usadas');
        if (event.part?.state?.status === 'completed') {
          if (event.part?.tool) {
            addBounded(
              state.successfulTools,
              event.part.tool,
              'Ferramentas concluídas',
            );
          }
          const input = event.part?.state?.input ?? {};
          for (const value of [input.file_path, input.filePath, input.path]) {
            if (value === undefined) continue;
            const candidate = path.resolve(
              state.cwd,
              validateArtifactPath(value, 'OUTPUT_LIMIT'),
            );
            if (isInside(state.cwd, candidate)) {
              addBounded(state.artifacts, candidate, 'Artefatos');
            }
          }
        }
      }
      const contentTool = registerOpenCodeContentTool(
        pendingContentTools,
        event,
      );
      if (contentTool) addBounded(state.toolsUsed, contentTool, 'Ferramentas usadas');
      const completedContentTool = takeSuccessfulOpenCodeContentTool(
        pendingContentTools,
        event,
      );
      if (completedContentTool) {
        addBounded(
          state.successfulTools,
          completedContentTool,
          'Ferramentas concluídas',
        );
      }
    },
    finish() {
      return finishEventParser(state);
    },
  };
}

export function parseOpenCodeEvents(raw, cwd) {
  const parser = createOpenCodeEventParser(cwd);
  for (const line of raw.split('\n')) parser.feed(line);
  return parser.finish();
}

function nativeEventBlocks(event) {
  const content = event.message?.content ?? event.content;
  return Array.isArray(content) ? content : [];
}

export function createNativeEventParser(cwd, allowedToolNames = null) {
  const state = createEventParserState(cwd);
  const pendingTools = new Map();
  const seenToolUseIds = new Set();
  const toolAttempts = new Map();
  let permissionDenials = [];
  let terminalSeen = false;

  const boundedKeyPart = (value, label) => {
    if (typeof value !== 'string') {
      throw agentError('INVALID_EVENT', `${label} deve ser uma string.`);
    }
    if (Buffer.byteLength(value) > MAX_NATIVE_KEY_PART_BYTES) {
      throw agentError(
        'OUTPUT_LIMIT',
        `${label} excedeu o limite de ${MAX_NATIVE_KEY_PART_BYTES} bytes.`,
      );
    }
    return value;
  };
  const sessionFor = (event) => {
    const id = event.session_id ?? event.sessionId;
    return {
      key: boundedKeyPart(id ?? 'global', 'session_id'),
      reliable: id != null,
    };
  };
  const attemptKeyFor = (sessionKey, id) => (
    id == null
      ? null
      : JSON.stringify([sessionKey, boundedKeyPart(id, 'tool_use_id')])
  );
  const denialKeyFor = (sessionId, toolUseId, tool) => (
    JSON.stringify([sessionId, toolUseId, tool])
  );
  const capturePermissionDenials = (event, session) => {
    permissionDenials = [];
    if (!Object.hasOwn(event, 'permission_denials')) return;
    if (!Array.isArray(event.permission_denials)) {
      throw agentError('INVALID_EVENT', 'permission_denials deve ser uma lista.');
    }
    if (!session.reliable) {
      throw agentError('INVALID_EVENT', 'permission_denials exige session_id string.');
    }
    if (event.permission_denials.length > MAX_TRACKED_ITEMS) {
      throw agentError(
        'OUTPUT_LIMIT',
        `permission_denials excedeu o limite de ${MAX_TRACKED_ITEMS} itens.`,
      );
    }
    permissionDenials = event.permission_denials.map((denial) => {
      if (!denial || Array.isArray(denial) || typeof denial !== 'object') {
        throw agentError('INVALID_EVENT', 'permission_denials contém item inválido.');
      }
      if (typeof denial.tool_name !== 'string') {
        throw agentError('INVALID_EVENT', 'permission_denials.tool_name deve ser uma string.');
      }
      return {
        sessionId: session.key,
        toolUseId: boundedKeyPart(
          denial.tool_use_id,
          'permission_denials.tool_use_id',
        ),
        tool: denial.tool_name,
      };
    });
  };

  return {
    feed(line) {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      const blocks = nativeEventBlocks(event);
      const substantive = event.type === 'result' || blocks.some((block) => (
        ['text', 'tool_use', 'tool_result'].includes(block.type)
      ));
      if (terminalSeen) {
        if (substantive) {
          throw agentError('INVALID_EVENT', 'Evento substantivo recebido após result terminal.');
        }
        return;
      }
      state.sessionId ||= event.session_id ?? event.sessionId ?? null;
      const session = sessionFor(event);
      if (event.type === 'result') {
        if (typeof event.result === 'string') setCanonicalResult(state, event.result);
        capturePermissionDenials(event, session);
        terminalSeen = true;
      }

      for (const block of blocks) {
        if (block.type === 'text') {
          if (state.canonicalResult == null) {
            appendVisibleText(state, state.filter(block.text ?? ''));
          }
          continue;
        }
        if (block.type === 'tool_use') {
          if (typeof block.name !== 'string') {
            throw agentError('INVALID_EVENT', 'tool_use.name deve ser uma string.');
          }
          const tool = block.name;
          const tracked = allowedToolNames != null && !allowedToolNames.has(policyToolName(tool));
          if (tool) addBounded(state.toolsUsed, tool, 'Ferramentas usadas');
          const paths = [];
          for (const value of [
            block.input?.file_path,
            block.input?.filePath,
            block.input?.path,
          ]) {
            if (value === undefined) continue;
            const validatedPath = validateArtifactPath(value);
            const candidate = path.resolve(state.cwd, validatedPath);
            if (isInside(state.cwd, candidate)) paths.push(validatedPath);
          }
          const key = attemptKeyFor(session.key, block.id);
          if (!key) {
            if (tracked) {
              setBounded(toolAttempts, `ambiguous:${toolAttempts.size}`, {
                tool,
                outcome: 'pending',
                sessionId: session.key,
                toolUseId: null,
                ambiguous: true,
              }, 'Tentativas proibidas de ferramentas nativas');
            }
            continue;
          }
          const repeated = allowedToolNames == null
            ? pendingTools.has(key)
            : seenToolUseIds.has(key);
          if (repeated) {
            const existingAttempt = toolAttempts.get(key);
            if (existingAttempt) {
              existingAttempt.ambiguous = true;
            } else if (tracked) {
              setBounded(toolAttempts, `reuse:${toolAttempts.size}`, {
                tool,
                outcome: 'pending',
                sessionId: session.key,
                toolUseId: block.id,
                ambiguous: true,
              }, 'Tentativas proibidas de ferramentas nativas');
            }
            continue;
          }
          if (allowedToolNames != null) {
            addBounded(seenToolUseIds, key, 'IDs de ferramentas nativas');
          }
          const attempt = {
            tool,
            paths,
            outcome: 'pending',
            tracked,
            sessionId: session.key,
            toolUseId: block.id,
            ambiguous: !session.reliable,
          };
          setBounded(pendingTools, key, attempt, 'Ferramentas nativas pendentes');
          if (tracked) {
            setBounded(toolAttempts, key, attempt, 'Tentativas proibidas de ferramentas nativas');
          }
          continue;
        }
        if (block.type !== 'tool_result') continue;
        const key = attemptKeyFor(session.key, block.tool_use_id);
        if (event.type !== 'user') {
          const trackedAttempt = key && toolAttempts.get(key);
          if (trackedAttempt) trackedAttempt.ambiguous = true;
          continue;
        }
        const attempt = key && pendingTools.get(key);
        if (!attempt || attempt.outcome !== 'pending') {
          const trackedAttempt = key && toolAttempts.get(key);
          if (trackedAttempt) trackedAttempt.ambiguous = true;
          continue;
        }
        pendingTools.delete(key);
        if (attempt.tracked && !session.reliable) attempt.ambiguous = true;
        attempt.outcome = block.is_error === true ? 'rejected' : 'succeeded';
        if (attempt.outcome === 'rejected') continue;
        if (attempt.tool) addBounded(state.successfulTools, attempt.tool, 'Ferramentas concluídas');
        for (const artifactPath of attempt.paths) {
          const candidate = path.resolve(
            state.cwd,
            validateArtifactPath(artifactPath),
          );
          const artifact = canonicalizePath(candidate);
          if (!isInside(state.cwd, artifact)) {
            throw agentError(
              'ARTIFACT_OUTSIDE_CWD',
              'Artefato resolveu fora do diretório autorizado.',
            );
          }
          addBounded(state.artifacts, artifact, 'Artefatos');
        }
      }
    },
    finish() {
      const parsed = finishEventParser(state);
      const nativeToolAttempts = [...toolAttempts.values()].map((attempt) => ({
        tool: attempt.tool,
        outcome: attempt.outcome,
        ambiguous: attempt.ambiguous,
        denialKey: attempt.toolUseId == null
          ? null
          : denialKeyFor(attempt.sessionId, attempt.toolUseId, attempt.tool),
      }));
      Object.defineProperties(parsed, {
        nativeToolAttempts: { value: nativeToolAttempts },
        nativeToolAttemptsAmbiguous: {
          value: nativeToolAttempts.some(({ ambiguous }) => ambiguous),
        },
        nativePermissionDenialKeys: {
          value: new Set(permissionDenials.map(({ sessionId, toolUseId, tool }) => (
            denialKeyFor(sessionId, toolUseId, tool)
          ))),
        },
      });
      return parsed;
    },
  };
}

export function parseVerbooCodeEvents(raw, cwd) {
  const parser = createNativeEventParser(cwd);
  for (const line of raw.split('\n')) parser.feed(line);
  return parser.finish();
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

export function buildTaskkillInvocation(
  pid,
  {
    env = process.env,
    realpathImpl = realpathSync,
  } = {},
) {
  const systemRoot = realpathImpl(env.SystemRoot || String.raw`C:\Windows`);
  const command = realpathImpl(path.join(systemRoot, 'System32', 'taskkill.exe'));
  const systemRootPrefix = `${systemRoot.toLowerCase()}${path.sep}`;
  if (!command.toLowerCase().startsWith(systemRootPrefix)) {
    throw agentError('TASKKILL_INVALID', 'taskkill.exe fora de SystemRoot.');
  }
  return {
    command,
    args: ['/pid', String(pid), '/t', '/f'],
    options: {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    },
  };
}

function killWindowsTree(pid) {
  const invocation = buildTaskkillInvocation(pid);
  return spawn(invocation.command, invocation.args, invocation.options);
}

function execute(invocation, options) {
  const {
    cwd,
    timeoutSeconds,
    env,
    spawnImpl = spawn,
    killImpl = process.kill,
    killTreeImpl = killWindowsTree,
    killGraceMs = KILL_GRACE_MS,
    platform = process.platform,
    timeoutMs = timeoutSeconds * 1000,
    signal,
    onLine,
    retainStdout = true,
    maxLineBytes = MAX_LINE_BYTES,
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
    let windowsTreeKillRequested = false;
    let windowsRootForceKillRequested = false;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const child = spawnImpl(invocation.command, invocation.args, {
      cwd,
      env: buildChildEnv(env, invocation),
      detached: platform !== 'win32',
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

    const forceKillWindowsRoot = () => {
      if (settled || windowsRootForceKillRequested) return;
      windowsRootForceKillRequested = true;
      child.kill('SIGKILL');
    };

    const signalTree = (signal) => {
      if (platform === 'win32' && child.pid) {
        if (windowsTreeKillRequested) {
          if (signal === 'SIGKILL') forceKillWindowsRoot();
          return;
        }
        windowsTreeKillRequested = true;
        try {
          const treeKill = killTreeImpl(child.pid);
          treeKill?.once?.('error', forceKillWindowsRoot);
          treeKill?.once?.('close', (code) => {
            if (code !== 0) forceKillWindowsRoot();
          });
          return;
        } catch {
          // Se taskkill nem iniciar, ainda encerramos pelo menos o processo raiz.
          windowsTreeKillRequested = false;
        }
      } else if (child.pid) {
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

    // Um consumer de linha que lança (ex.: texto público além do limite)
    // encerra o subprocesso de forma bounded, como qualquer outro OUTPUT_LIMIT.
    const deliverLine = (line) => {
      if (!onLine) return;
      try {
        onLine(line);
      } catch (error) {
        terminate(
          error?.code
            ? error
            : agentError(
                'OUTPUT_LIMIT',
                `Falha ao processar evento do ${invocation.label}: ${error?.message ?? error}`,
              ),
        );
      }
    };

    const consumeStdoutText = (text) => {
      if (!text || terminationError) return;
      if (retainStdout) stdout += text;
      if (!onLine) return;
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      // O teto é por linha/evento individual: um buffer com muitas linhas
      // válidas não dispara, mas uma única linha excessiva (completa ou
      // ainda sem '\n') falha bounded.
      if (Buffer.byteLength(lineBuffer) > maxLineBytes) {
        terminate(
          agentError(
            'OUTPUT_LIMIT',
            `Evento do ${invocation.label} excedeu ${maxLineBytes} bytes em uma única linha e foi interrompido.`,
          ),
        );
        return;
      }
      for (const line of lines) {
        if (Buffer.byteLength(line) > maxLineBytes) {
          terminate(
            agentError(
              'OUTPUT_LIMIT',
              `Evento do ${invocation.label} excedeu ${maxLineBytes} bytes em uma única linha e foi interrompido.`,
            ),
          );
          return;
        }
        deliverLine(line);
        if (terminationError) return;
      }
    };

    child.stdout?.on('data', (chunk) => {
      if (terminationError) return;
      stdoutBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      const stdoutLimit = retainStdout ? MAX_STDOUT_BYTES : MAX_STREAM_BYTES;
      if (stdoutBytes > stdoutLimit) {
        terminate(
          agentError(
            'OUTPUT_LIMIT',
            `Saída do ${invocation.label} excedeu ${stdoutLimit / 1024 / 1024} MiB e foi interrompida.`,
          ),
        );
        return;
      }
      consumeStdoutText(stdoutDecoder.write(chunk));
    });

    child.stderr?.on('data', (chunk) => {
      if (terminationError) return;
      stderrBytes += chunk.length;
      const text = stderrDecoder.write(chunk);
      if (stderrBytes <= MAX_STDERR_BYTES) stderr += text;
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
      consumeStdoutText(stdoutDecoder.end());
      if (stderrBytes <= MAX_STDERR_BYTES) stderr += stderrDecoder.end();
      if (terminationError) {
        const processGroupMayRemain = platform !== 'win32' && child.pid;
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
      if (lineBuffer.trim()) deliverLine(lineBuffer);
      if (terminationError) {
        const processGroupMayRemain = platform !== 'win32' && child.pid;
        finish(reject, terminationError, !processGroupMayRemain);
        return;
      }
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
  const allowedTools = new Set(
    allowedToolsForMode(request.mode, executor).map(policyToolName),
  );
  // Parsing incremental: o stdout bruto não é retido; só o estado sanitizado
  // (texto público, artefatos internos e ferramentas) sobrevive ao stream.
  const parser = executor === 'native'
    ? createNativeEventParser(request.cwd, allowedTools)
    : createOpenCodeEventParser(request.cwd);
  const progressOnLine = options.onProgress
    ? buildProgressOnLine(options.onProgress, { mode: request.mode, executor })
    : undefined;
  const onLine = (line) => {
    progressOnLine?.(line);
    parser.feed(line);
  };
  if (progressOnLine) {
    onLine.flush = progressOnLine.flush;
    onLine.close = progressOnLine.close;
  }
  let timeoutError = null;
  try {
    await execute(invocation, {
      cwd: request.cwd,
      timeoutSeconds,
      env: options.env,
      spawnImpl: options.spawnImpl,
      killImpl: options.killImpl,
      killTreeImpl: options.killTreeImpl,
      killGraceMs: options.killGraceMs,
      platform: options.platform,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onLine,
      retainStdout: false,
    });
  } catch (error) {
    if (error.code !== 'TIMEOUT') throw error;
    timeoutError = error;
  }
  if (!timeoutError && options.onProgress) {
    options.onProgress({ phase: 'processing_result' });
  }
  const parsed = parser.finish();
  if (timeoutError) {
    // ponytail: descarta texto livre até existir um redator auditado para parciais.
    parsed.result = '';
    const hasPartialResult = parsed.successfulTools.length > 0;
    if (!hasPartialResult) throw timeoutError;
  }
  const forbiddenUsed = parsed.toolsUsed.filter(
    (tool) => !allowedTools.has(policyToolName(tool)),
  );
  if (timeoutError) {
    // Progresso de stream é não confiável: só categorias concluídas são públicas.
    parsed.toolsUsed = toolCategories(parsed.successfulTools);
    parsed.successfulTools = parsed.toolsUsed;
    parsed.artifacts = [];
    parsed.sessionId = null;
  }
  if (forbiddenUsed.length > 0) {
    const forbiddenAttempts = (parsed.nativeToolAttempts ?? []).filter(
      ({ tool }) => !allowedTools.has(policyToolName(tool)),
    );
    const permissionDenialKeys = parsed.nativePermissionDenialKeys ?? new Set();
    const allForbiddenAttemptsRejected = executor === 'native'
      && forbiddenAttempts.length > 0
      && forbiddenAttempts.every((attempt) => (
        !attempt.ambiguous
        && attempt.outcome === 'rejected'
        && attempt.denialKey != null
        && permissionDenialKeys.has(attempt.denialKey)
      ));
    if (allForbiddenAttemptsRejected) {
      parsed.toolsUsed = toolCategories(parsed.toolsUsed);
      if (!timeoutError) {
        return { parsed, status: 'warning', warningReason: 'forbidden_tools_rejected' };
      }
    } else {
      throw agentError(
        'FORBIDDEN_TOOL_USED',
        `${invocation.label} executou ${forbiddenUsed.length} ferramenta(s) proibida(s) pela política (categorias: ${toolCategories(forbiddenUsed).join(', ')}).`,
      );
    }
  }
  const hasWriteExecution = parsed.successfulTools.some((tool) => (
    ['apply_patch', 'edit', 'write'].includes(tool.toLowerCase())
  ));
  return {
    parsed,
    status: timeoutError || (request.mode === 'write' && !hasWriteExecution)
      ? 'warning'
      : 'success',
    warningReason: timeoutError ? 'timeout_partial' : undefined,
  };
}

function routingResult(route, initialRoute, model, attempts) {
  const fallbackCount = attempts.length - 1;
  return {
    strategy: route.strategy,
    auto_include_premium_models: initialRoute.autoIncludePremiumModels ?? false,
    selected_model: model,
    reason: fallbackCount > 0
      ? `Fallback após ${fallbackCount} falha(s): ${route.reason}`
      : route.reason,
    task_profile: route.profile,
    ranking: initialRoute.ranking,
    attempts,
  };
}

function successfulResultText({ result, successfulTools, artifacts }) {
  if (result) return result;
  if (successfulTools.length === 0) return '';
  const names = sortedStrings(successfulTools);
  const prefix = 'Ferramentas concluídas: ';
  const suffix = `. Artefatos registrados: ${artifacts.length}.`;
  let bytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  for (const [index, name] of names.entries()) {
    bytes += Buffer.byteLength(name) + (index === 0 ? 0 : Buffer.byteLength(', '));
    if (bytes > MAX_RESULT_TEXT_BYTES) {
      throw agentError(
        'OUTPUT_LIMIT',
        `Resultado factual excedeu o limite de ${MAX_RESULT_TEXT_BYTES} bytes.`,
      );
    }
  }
  return `${prefix}${names.join(', ')}${suffix}`;
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
  warningReason,
}) {
  const memory = extractMemoryNote(parsed.result);
  const result = successfulResultText({ ...parsed, result: memory.result });
  const hasConfirmedWrite = request.mode === 'write'
    && parsed.successfulTools.some((tool) => (
      ['apply_patch', 'edit', 'write'].includes(tool.toLowerCase())
    ));
  let summary = `Agente Verboo concluiu a tarefa em modo ${request.mode}.`;
  if (status === 'warning') {
    summary = 'O agente encerrou sem executar ferramenta de edição; nenhuma mudança foi confirmada.';
    if (warningReason === 'timeout_partial') {
      summary = 'O agente não concluiu antes do timeout; há resultado parcial para revisão. Nenhuma mudança foi confirmada.';
      if (hasConfirmedWrite) {
        summary = 'O agente não concluiu antes do timeout; há resultado parcial para revisão e uma alteração foi confirmada.';
      }
    } else if (warningReason === 'forbidden_tools_rejected') {
      summary = 'O agente solicitou ferramentas proibidas, mas elas foram negadas pela política.';
      if (request.mode === 'write') {
        summary = 'As ferramentas proibidas solicitadas foram negadas; nenhuma mudança foi confirmada.';
      }
      if (hasConfirmedWrite) {
        summary = 'As ferramentas proibidas solicitadas foram negadas; uma alteração foi confirmada. Revise os artefatos.';
      }
    }
  }
  let nextActions = [
    'Revise a análise e delegue escrita somente se a mudança estiver autorizada.',
  ];
  if (status === 'warning') {
    nextActions = [
      'Não trate a tarefa como concluída.',
      'Revise a instrução ou escolha manualmente outro modelo.',
    ];
  } else if (request.mode === 'write') {
    nextActions = [
      'Revise o diff e os artefatos no orquestrador.',
      'Rode as validações do projeto no orquestrador antes de commit ou deploy.',
    ];
  }
  return {
    status,
    summary,
    result: result || 'Execução concluída sem mensagem final.',
    next_actions: nextActions,
    artifacts: parsed.artifacts,
    tools_used: parsed.toolsUsed,
    ...(warningReason === 'timeout_partial'
      ? { warnings: [{ code: 'TIMEOUT', message: 'O agente excedeu o tempo limite; o resultado parcial está disponível para revisão.' }] }
      : {}),
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
      const { parsed, status, warningReason } = await executeAgentAttempt(
        attemptRequest,
        executor,
        options,
        remainingSeconds,
      );
      attempts.push({ model, status });
      markModelFinished(
        model,
        warningReason === 'timeout_partial' ? { code: 'TIMEOUT' } : null,
        options.env,
      );
      return successfulAgentResult({
        request,
        executor,
        route,
        initialRoute,
        model,
        attempts,
        parsed,
        status,
        warningReason,
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
