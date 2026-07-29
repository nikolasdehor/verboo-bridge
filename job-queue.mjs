#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY_HARD = 8;
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RESULT_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS_HARD = 500;
const MAX_QUEUED_HARD = 500;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;
const STORE_MARKER = 'verboo-bridge-job-v1';
const STORE_SCHEMA_VERSION = 2;
const VALID_STATUSES = new Set([
  'queued', 'running', 'succeeded', 'warning', 'failed', 'cancelled',
]);
const TERMINAL_STATUSES = new Set([
  'succeeded', 'warning', 'failed', 'cancelled',
]);

const PROGRESS_PHASES = new Set([
  'queued', 'routing', 'generating', 'executing_tool', 'processing_result', 'waiting_model', 'idle',
]);
const HEARTBEAT_MS = 5000;
const PROGRESS_SUMMARY_MAX = 200;
const TOOL_CATEGORIES = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'Other'];

function createToolCounts() {
  const cats = {};
  for (const cat of TOOL_CATEGORIES) {
    cats[cat] = { total: 0, succeeded: 0, failed: 0 };
  }
  cats.total = { total: 0, succeeded: 0, failed: 0 };
  return cats;
}

function mergeToolCounts(target, update) {
  for (const cat of [...TOOL_CATEGORIES, 'total']) {
    for (const key of ['total', 'succeeded', 'failed']) {
      if (update[cat]?.[key] !== undefined) {
        target[cat][key] = update[cat][key];
      }
    }
  }
}

function generateSummary(progress) {
  const parts = [];
  switch (progress.phase) {
    case 'queued': parts.push('Aguardando na fila.'); break;
    case 'routing': parts.push('Selecionando modelo.'); break;
    case 'generating': parts.push('Gerando resposta.'); break;
    case 'executing_tool': parts.push('Executando ferramentas.'); break;
    case 'processing_result': parts.push('Processando resultado.'); break;
    case 'idle': parts.push('Sem atividade.'); break;
    default: parts.push(`Fase: ${progress.phase}.`);
  }
  if (progress.model) parts.push(`Modelo: ${progress.model}.`);
  if (progress.attempts?.total > 0) {
    parts.push(`Tentativa ${progress.attempts.current}/${progress.attempts.total}.`);
  }
  const tc = progress.tool_counts.total;
  if (tc.total > 0) parts.push(`Ferramentas: ${tc.succeeded}/${tc.total} sucesso.`);
  const summary = parts.join(' ');
  return summary.length <= PROGRESS_SUMMARY_MAX ? summary : summary.slice(0, PROGRESS_SUMMARY_MAX - 3) + '...';
}

function nowISO() { return new Date().toISOString(); }

function validTimestamp(value, fallback) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : fallback;
}

function configuredMax(envVar, fallback, hard) {
  const v = Number(process.env[envVar] ?? fallback);
  return Number.isInteger(v) && v >= 1 && v <= hard ? v : fallback;
}

function configuredTTL(envVar, fallback) {
  const v = Number(process.env[envVar] ?? fallback);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function safeJSON(val, fallback) {
  try { return JSON.parse(val); } catch { return fallback; }
}

async function enforcePrivateMode(target, mode) {
  if (process.platform !== 'win32') await chmod(target, mode);
}

function safeError(error) {
  if (!error || typeof error !== 'object') return null;
  return {
    code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
  };
}

function safeStringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string')
    : [];
}

function safeTerminalResult(result) {
  if (!result || typeof result !== 'object') return null;
  const memory = result.memory && typeof result.memory === 'object'
    ? {
        injected_project_entries: Number(result.memory.injected_project_entries) || 0,
        injected_shared_files: Number(result.memory.injected_shared_files) || 0,
        persisted: result.memory.persisted === true,
        ...(result.memory.warning
          ? { warning: safeError(result.memory.warning) }
          : {}),
      }
    : null;
  return {
    summary: typeof result.summary === 'string' ? result.summary : '',
    output: typeof result.output === 'string' ? result.output : '',
    next_actions: safeStringList(result.next_actions),
    artifacts: safeStringList(result.artifacts).map(
      // Paths absolutos vazam estrutura do repositório —
      // reduz ao filename para manter privacidade.
      (a) => path.isAbsolute(a) ? path.basename(a) : a
    ),
    tools_used: safeStringList(result.tools_used),
    session_id: typeof result.session_id === 'string' ? result.session_id : null,
    memory,
    warnings: Array.isArray(result.warnings)
      ? result.warnings
          .map((warning) => safeError(warning))
          .filter(Boolean)
      : [],
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function loadStoredRecord(storeDir, file) {
  if (!file.endsWith('.json')) return null;

  const filePath = path.join(storeDir, file);
  const basename = path.basename(file, '.json');
  const content = await readFile(filePath, 'utf-8').catch(() => null);
  if (!content) return null;

  const record = safeJSON(content, null);
  if (!record) return null;

  const validIdentity = (
    UUID_RE.test(basename)
    && UUID_RE.test(record.job_id)
    && record.job_id === basename
  );
  if (!validIdentity) {
    // Nunca remove JSON alheio de um diretório configurado por engano.
    if (record.app === STORE_MARKER) {
      await unlink(filePath).catch(() => {});
    }
    return null;
  }
  if (!VALID_STATUSES.has(record.status)) return null;
  if (
    record.schema_version !== undefined
    && (
      record.schema_version !== STORE_SCHEMA_VERSION
      || record.app !== STORE_MARKER
    )
  ) {
    return null;
  }
  return record;
}

function recoverStoredRecord(record, persistResults) {
  const timestamp = nowISO();
  const isPending = record.status === 'queued' || record.status === 'running';
  const canRecoverTerminal = (
    persistResults
    && record.schema_version === STORE_SCHEMA_VERSION
    && record.app === STORE_MARKER
    && !isPending
  );
  const error = isPending
    ? { code: 'RESTART' }
    : safeError(record.error);

  return {
    job_id: record.job_id,
    status: isPending ? 'failed' : record.status,
    created_at: validTimestamp(record.created_at, timestamp),
    updated_at: timestamp,
    started_at: null,
    finished_at: isPending
      ? timestamp
      : validTimestamp(record.finished_at, timestamp),
    model: record.model ?? null,
    executor: record.executor ?? null,
    result: canRecoverTerminal ? safeTerminalResult(record.result) : null,
    error,
  };
}

export function createJobRecord({ cwd, model, executor }) {
  return {
    job_id: randomUUID(),
    status: 'queued',
    created_at: nowISO(),
    updated_at: nowISO(),
    started_at: null,
    finished_at: null,
    model: model ?? null,
    executor: executor ?? null,
    cwd: cwd ?? null,
    result: null,
    error: null,
  };
}

export class JobQueue extends EventEmitter {
  #queue = [];
  #jobs = new Map();
  #running = new Map();
  #concurrency;
  #ttl;
  #resultTtl;
  #maxResults;
  #maxQueued;
  #storeDir;
  #persistResults;
  #runnerData = new Map();
  #storeTails = new Map();
  #pruneTimer;
  #disposed = false;
  #progress = new Map();
  #heartbeats = new Map();
  #heartbeatMs;

  constructor(options = {}) {
    super();
    this.#concurrency = configuredMax(
      'VERBOO_AGENT_MAX_CONCURRENCY',
      options.concurrency ?? DEFAULT_MAX_CONCURRENCY,
      options.hardConcurrency ?? MAX_CONCURRENCY_HARD,
    );
    this.#ttl = options.ttl ?? configuredTTL('VERBOO_JOB_TTL_MS', DEFAULT_JOB_TTL_MS);
    this.#resultTtl = options.resultTtl ?? configuredTTL('VERBOO_JOB_RESULT_TTL_MS', DEFAULT_RESULT_TTL_MS);
    this.#maxResults = options.maxResults ?? configuredMax('VERBOO_JOB_MAX_RESULTS', 100, MAX_RESULTS_HARD);
    this.#maxQueued = options.maxQueued ?? configuredMax('VERBOO_JOB_MAX_QUEUED', 50, MAX_QUEUED_HARD);
    this.#persistResults = options.persistResults
      ?? process.env.VERBOO_JOB_PERSIST_RESULTS === '1';
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.#startPruneTimer(options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS);
  }

  #startPruneTimer(intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.#pruneTimer = setInterval(() => this.#prune(), intervalMs);
    this.#pruneTimer.unref();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    clearInterval(this.#pruneTimer);
    this.#pruneTimer = null;

    const timestamp = nowISO();
    for (const [jobId, entry] of this.#running) {
      const job = this.#jobs.get(jobId);
      if (job && !TERMINAL_STATUSES.has(job.status)) {
        job.status = 'cancelled';
        job.updated_at = timestamp;
        job.finished_at = timestamp;
        this.#persistJob(job).catch(() => {});
      }
      entry.controller.abort();
    }
    for (const jobId of this.#queue) {
      const job = this.#jobs.get(jobId);
      if (job?.status !== 'queued') continue;
      job.status = 'cancelled';
      job.updated_at = timestamp;
      job.finished_at = timestamp;
      this.#persistJob(job).catch(() => {});
    }
    this.#running.clear();
    this.#queue = [];
    this.#runnerData.clear();
    for (const jobId of this.#progress.keys()) this.#clearProgress(jobId);
  }

  get capacity() {
    return this.#concurrency;
  }

  get status() {
    const byStatus = {};
    for (const job of this.#jobs.values()) {
      const s = job.status;
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    return {
      concurrency: this.#concurrency,
      queued: this.#queue.length,
      running: this.#running.size,
      total: this.#jobs.size,
      by_status: byStatus,
      max_queued: this.#maxQueued,
      max_results: this.#maxResults,
      ttl_ms: this.#ttl,
      result_ttl_ms: this.#resultTtl,
      store_dir: this.#storeDir ?? false,
      persist_results: Boolean(this.#storeDir && this.#persistResults),
      runner_data_retained: this.#runnerData.size,
      disposed: this.#disposed,
    };
  }

  listJobs() {
    this.#prune();
    const jobs = [];
    for (const job of this.#jobs.values()) {
      jobs.push({
        job_id: job.job_id,
        status: job.status,
        created_at: job.created_at,
        updated_at: job.updated_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        model: job.model,
        executor: job.executor,
      });
    }
    jobs.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return jobs;
  }

  getJob(jobId) {
    this.#prune();
    const job = this.#jobs.get(jobId);
    if (!job) return null;
    const terminal = TERMINAL_STATUSES.has(job.status);
    return {
      job_id: job.job_id,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      model: job.model,
      executor: job.executor,
      ...this.#progressFields(jobId),
      ...(terminal ? { queue_position: null } : {}),
    };
  }

  getJobResult(jobId) {
    this.#prune();
    const job = this.#jobs.get(jobId);
    if (!job) return null;
    const terminal = TERMINAL_STATUSES.has(job.status);
    return {
      job_id: job.job_id,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      model: job.model,
      executor: job.executor,
      result: job.result,
      error: job.error,
      ...this.#progressFields(jobId),
      ...(terminal ? { queue_position: null } : {}),
    };
  }

  enqueue({ cwd, model, executor, runnerData } = {}) {
    if (this.#disposed) {
      return { error: 'QUEUE_DISPOSED', message: 'Fila encerrada.' };
    }
    const pending = this.#queue.length;
    if (pending >= this.#maxQueued) {
      return { error: 'QUEUE_FULL', message: `Fila cheia (max ${this.#maxQueued} aguardando).` };
    }

    const job = createJobRecord({ cwd, model, executor });
    this.#jobs.set(job.job_id, job);
    this.#queue.push(job.job_id);
    if (runnerData) this.#runnerData.set(job.job_id, runnerData);
    this.#initProgress(job.job_id, { queuePosition: this.#queue.length, model: job.model });
    this.emit('enqueued', job.job_id);

    const persistence = this.#persistJob(job);
    persistence
      .then(() => setImmediate(() => this.#drain()))
      .catch(() => {
        if (job.status !== 'queued') return;
        const timestamp = nowISO();
        job.status = 'failed';
        job.updated_at = timestamp;
        job.finished_at = timestamp;
        job.error = {
          code: 'JOB_STORE_WRITE_FAILED',
          message: 'Não foi possível persistir o job antes da execução.',
        };
        this.#queue = this.#queue.filter((id) => id !== job.job_id);
        this.#runnerData.delete(job.job_id);
        this.#clearProgress(job.job_id);
        this.emit('completed', job.job_id);
      });

    return { job_id: job.job_id };
  }

  async enqueuePersisted(args = {}) {
    const result = this.enqueue(args);
    if (result.error) return result;
    try {
      await this.waitForPersistence(result.job_id);
      return result;
    } catch {
      return {
        job_id: result.job_id,
        error: 'JOB_STORE_WRITE_FAILED',
        message: 'Não foi possível persistir o job antes da execução.',
      };
    }
  }

  async waitForPersistence(jobId) {
    await (this.#storeTails.get(jobId) ?? Promise.resolve());
  }

  async cancel(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) return { error: 'NOT_FOUND', message: 'Job não encontrado.' };
    if (job.status === 'cancelled' || job.status === 'failed' || job.status === 'succeeded' || job.status === 'warning') {
      return { error: 'ALREADY_FINISHED', message: `Job já está ${job.status}.` };
    }

    job.status = 'cancelled';
    job.updated_at = nowISO();
    job.finished_at = nowISO();
    this.#runnerData.delete(jobId);

    const entry = this.#running.get(jobId);
    if (entry) {
      entry.controller.abort();
    } else {
      this.#queue = this.#queue.filter((id) => id !== jobId);
    }

    this.#clearProgress(jobId);
    try {
      // Só confirma cancelamento ao chamador depois do rename atômico. Assim,
      // um crash nunca recupera sucesso após um cancelamento já confirmado.
      await this.#persistJob(job);
    } catch {
      return {
        job_id: jobId,
        error: 'JOB_STORE_WRITE_FAILED',
        message: 'Cancelado em memória, mas o estado não pôde ser persistido.',
      };
    }
    this.emit('cancelled', jobId);
    return { job_id: jobId, status: 'cancelled' };
  }

  async #drain() {
    if (this.#disposed) return;
    while (!this.#disposed && this.#running.size < this.#concurrency && this.#queue.length > 0) {
      const jobId = this.#queue.shift();
      const job = this.#jobs.get(jobId);
      if (!job || job.status === 'cancelled') continue;

      job.status = 'running';
      job.started_at = nowISO();
      job.updated_at = nowISO();

      const controller = new AbortController();
      this.#running.set(jobId, { controller });

      this.#persistJob(job).catch(() => {});
      this.#updateProgress(jobId, { phase: 'routing' });
      this.#startHeartbeat(jobId);

      this.emit('started', jobId);

      this.#executeJob(job, controller.signal).then(async (result) => {
        this.#running.delete(jobId);

        // Late-result guard: cancel() externo já marcou cancelled —
        // não sobrescreve status/timestamps com resultado tardio.
        if (job.status === 'cancelled') {
          if (!this.#disposed) this.#drain();
          return;
        }

        this.#runnerData.delete(jobId);

        this.#updateProgress(jobId, {
          phase: 'processing_result',
          model: result.model ?? job.model,
          queue_position: null,
        });
        this.#stopHeartbeat(jobId);

        const completed = { ...job, ...result, updated_at: nowISO() };
        try {
          // Com resultados duráveis, o job continua "running" e não emite
          // completed até o rename atômico confirmar o estado terminal.
          await this.#persistJob(completed);
        } catch {
          if (this.#storeDir && this.#persistResults && job.status !== 'cancelled') {
            Object.assign(completed, {
              status: 'failed',
              result: null,
              finished_at: nowISO(),
              updated_at: nowISO(),
              error: {
                code: 'RESULT_STORE_WRITE_FAILED',
                message: 'O resultado terminal não pôde ser persistido.',
              },
            });
            await this.#persistJob(completed).catch(() => {});
          }
        }

        // cancel() pode vencer a corrida enquanto o resultado era persistido.
        if (job.status === 'cancelled') {
          if (!this.#disposed) this.#drain();
          return;
        }
        Object.assign(job, completed);
        this.#clearProgress(jobId);
        try { this.emit('completed', jobId); } catch { /* listener error — job ainda completou */ }
        if (!this.#disposed) this.#drain();
      }).catch((err) => {
        // Rejeição inesperada do handler/listener: limpa running, progresso, heartbeat,
        // marca como failed, drena a fila — sem unhandled rejection.
        this.#running.delete(jobId);
        this.#stopHeartbeat(jobId);
        this.#clearProgress(jobId);
        this.#runnerData.delete(jobId);
        const safeJob = this.#jobs.get(jobId);
        if (safeJob && !TERMINAL_STATUSES.has(safeJob.status)) {
          safeJob.status = 'failed';
          safeJob.updated_at = nowISO();
          safeJob.finished_at = nowISO();
          safeJob.error = {
            code: err?.code ?? 'EXECUTION_FAILED',
            message: err?.message ?? 'Erro inesperado na execução do job.',
          };
          this.#persistJob(safeJob).catch(() => {});
        }
        try { this.emit('completed', jobId); } catch { /* suppress */ }
        if (!this.#disposed) this.#drain();
      });
    }
  }

  async #executeJob(job, signal) {
    const runnerData = this.#runnerData.get(job.job_id) ?? {};
    const onProgress = (update) => this.#updateProgress(job.job_id, update);
    const progressRunnerData = (typeof runnerData === 'object' && runnerData !== null)
      ? { ...runnerData, __onProgress: onProgress }
      : runnerData;
    try {
      const result = await this.#runFn(job, signal, progressRunnerData, onProgress);
      if (signal.aborted) {
        throw Object.assign(new Error('Job cancelado.'), { code: 'CANCELLED' });
      }

      const status = result.status === 'warning' ? 'warning' : 'succeeded';
      return {
        status,
        finished_at: nowISO(),
        result: {
          summary: result.summary,
          output: result.result,
          next_actions: result.next_actions,
          artifacts: result.artifacts,
          tools_used: result.tools_used,
          session_id: result.session_id,
          memory: result.memory ?? null,
          warnings: result.warnings ?? [],
        },
        model: result.model ?? job.model,
        executor: result.executor ?? job.executor,
      };
    } catch (err) {
      const isCancelled = signal.aborted || err.code === 'CANCELLED';
      return {
        status: isCancelled ? 'cancelled' : 'failed',
        finished_at: nowISO(),
        error: {
          code: err.code ?? 'UNKNOWN',
          message: err.message,
        },
      };
    }
  }

  async initStore(storeDir) {
    if (!storeDir) return;
    this.#storeDir = storeDir;
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    await enforcePrivateMode(storeDir, 0o700);

    const files = await readdir(storeDir).catch(() => []);
    for (const file of files) {
      const record = await loadStoredRecord(storeDir, file);
      if (!record) continue;

      const safe = recoverStoredRecord(record, this.#persistResults);
      this.#jobs.set(safe.job_id, safe);
      // Reescreve no schema atual; com opt-in desligado, remove qualquer resultado.
      await this.#persistJob(safe);
    }
  }

  async #persistJob(job) {
    if (!this.#storeDir) return;
    const safe = {
      app: STORE_MARKER,
      schema_version: STORE_SCHEMA_VERSION,
      job_id: job.job_id,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      model: job.model,
      executor: job.executor,
      error: safeError(job.error),
      ...(
        this.#persistResults && TERMINAL_STATUSES.has(job.status)
          ? { result: safeTerminalResult(job.result) }
          : {}
      ),
    };
    await this.#serializeStore(job.job_id, async () => {
      const filePath = path.join(this.#storeDir, `${job.job_id}.json`);
      const temporaryPath = path.join(
        this.#storeDir,
        `.${job.job_id}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporaryPath, JSON.stringify(safe), { mode: 0o600 });
        await enforcePrivateMode(temporaryPath, 0o600);
        await rename(temporaryPath, filePath);
      } finally {
        await unlink(temporaryPath).catch(() => {});
      }
    });
  }

  #serializeStore(jobId, operation) {
    const previous = this.#storeTails.get(jobId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#storeTails.set(jobId, current);
    return current.finally(() => {
      if (this.#storeTails.get(jobId) === current) {
        this.#storeTails.delete(jobId);
      }
    });
  }

  #prune() {
    const now = Date.now();
    const finished = [...this.#jobs.values()]
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((a, b) => (a.finished_at ?? a.updated_at).localeCompare(b.finished_at ?? b.updated_at));

    for (const job of finished) {
      const t = job.finished_at ?? job.updated_at;
      if (!t) continue;
      const age = now - new Date(t).getTime();
      const ttl = job.result ? this.#resultTtl : this.#ttl;
      if (age > ttl) this.#deleteJob(job.job_id);
    }

    const remaining = [...this.#jobs.values()]
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((a, b) => (b.finished_at ?? b.updated_at).localeCompare(a.finished_at ?? a.updated_at));
    if (remaining.length > this.#maxResults) {
      for (const job of remaining.slice(this.#maxResults)) {
        this.#deleteJob(job.job_id);
      }
    }

    if (this.#queue.length > this.#maxQueued) {
      const excess = this.#queue.splice(this.#maxQueued);
      for (const id of excess) {
        this.#deleteJob(id);
      }
    }
  }

  #deleteJob(jobId) {
    this.#jobs.delete(jobId);
    this.#runnerData.delete(jobId);
    this.#clearProgress(jobId);
    this.#removeStore(jobId).catch(() => {});
  }

  async #removeStore(jobId) {
    if (!this.#storeDir) return;
    await this.#serializeStore(jobId, async () => {
      const filePath = path.join(this.#storeDir, `${jobId}.json`);
      await unlink(filePath).catch(() => {});
    });
  }

  #initProgress(jobId, opts = {}) {
    const now = Date.now();
    const progress = {
      phase: 'queued',
      updated_at: new Date(now).toISOString(),
      elapsed_ms: 0,
      last_activity_at: new Date(now).toISOString(),
      idle_for_ms: null,
      queue_position: opts.queuePosition ?? null,
      attempts: { current: 0, total: opts.totalAttempts ?? 1 },
      model: opts.model ?? null,
      allowed_tools: null,
      tool_counts: createToolCounts(),
      progress_summary: 'Aguardando na fila.',
      _started_at: now,
    };
    this.#progress.set(jobId, progress);
  }

  #updateProgress(jobId, update) {
    const p = this.#progress.get(jobId);
    if (!p) return;
    const now = Date.now();
    if (update.phase !== undefined) p.phase = update.phase;
    if (update.model !== undefined) p.model = update.model;
    if (update.attempts !== undefined) Object.assign(p.attempts, update.attempts);
    if (update.tool_counts !== undefined) mergeToolCounts(p.tool_counts, update.tool_counts);
    if (update.allowed_tools !== undefined) p.allowed_tools = update.allowed_tools;
    if (update.queue_position !== undefined) p.queue_position = update.queue_position;
    p.updated_at = new Date(now).toISOString();
    p.last_activity_at = p.updated_at;
    if (p.phase !== 'idle') p.idle_for_ms = null;
    p.elapsed_ms = now - p._started_at;
    p.progress_summary = generateSummary(p);
  }

  #heartbeatTick(jobId) {
    const p = this.#progress.get(jobId);
    if (!p) return;
    const now = Date.now();
    p.updated_at = new Date(now).toISOString();
    p.elapsed_ms = now - p._started_at;
    if (p.last_activity_at) {
      const idleMs = now - new Date(p.last_activity_at).getTime();
      if (idleMs >= this.#heartbeatMs) {
        p.idle_for_ms = idleMs;
        // waiting_model não transiciona para idle — aguarda primeira tool_use
        if (p.phase !== 'waiting_model') {
          p.phase = 'idle';
        }
        p.progress_summary = generateSummary(p);
      }
    }
  }

  #startHeartbeat(jobId) {
    this.#stopHeartbeat(jobId);
    const timer = setInterval(() => this.#heartbeatTick(jobId), this.#heartbeatMs);
    timer.unref();
    this.#heartbeats.set(jobId, timer);
  }

  #stopHeartbeat(jobId) {
    const timer = this.#heartbeats.get(jobId);
    if (timer) clearInterval(timer);
    this.#heartbeats.delete(jobId);
  }

  #clearProgress(jobId) {
    this.#stopHeartbeat(jobId);
    this.#progress.delete(jobId);
  }

  #queuePosition(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) return null;
    if (TERMINAL_STATUSES.has(job.status)) return null;
    if (this.#running.has(jobId)) return 0;
    const idx = this.#queue.indexOf(jobId);
    return idx >= 0 ? idx + 1 : null;
  }

  #progressFields(jobId) {
    if (!this.#progress.has(jobId)) return {};
    const p = this.#progress.get(jobId);
    return {
      phase: p.phase,
      elapsed_ms: p.elapsed_ms,
      updated_at: p.updated_at,
      last_activity_at: p.last_activity_at,
      idle_for_ms: p.idle_for_ms,
      queue_position: this.#queuePosition(jobId),
      attempts: p.attempts,
      allowed_tools: p.allowed_tools,
      tool_counts: p.tool_counts,
      progress_summary: p.progress_summary,
      ...(p.model ? { model: p.model } : {}),
    };
  }

  #runFn = async () => ({ status: 'succeeded', summary: 'No runner set.' });

  setRunner(fn) {
    this.#runFn = fn;
  }
}
