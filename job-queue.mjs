#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
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
const VALID_STATUSES = new Set([
  'queued', 'running', 'succeeded', 'warning', 'failed', 'cancelled',
]);

function nowISO() { return new Date().toISOString(); }

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  #runnerData = new Map();
  #pruneTimer;
  #disposed = false;

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
      if (job && !['succeeded', 'warning', 'failed', 'cancelled'].includes(job.status)) {
        job.status = 'cancelled';
        job.updated_at = timestamp;
        job.finished_at = timestamp;
        this.#persistJob(job).catch(() => {});
      }
      entry.controller.abort();
    }
    for (const jobId of this.#queue) {
      const job = this.#jobs.get(jobId);
      if (!job || job.status !== 'queued') continue;
      job.status = 'cancelled';
      job.updated_at = timestamp;
      job.finished_at = timestamp;
      this.#persistJob(job).catch(() => {});
    }
    this.#running.clear();
    this.#queue = [];
    this.#runnerData.clear();
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
    return {
      job_id: job.job_id,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      model: job.model,
      executor: job.executor,
    };
  }

  getJobResult(jobId) {
    this.#prune();
    const job = this.#jobs.get(jobId);
    if (!job) return null;
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
    this.emit('enqueued', job.job_id);

    setImmediate(() => this.#drain());

    return { job_id: job.job_id };
  }

  cancel(jobId) {
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

    this.#persistJob(job).catch(() => {});
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

      this.emit('started', jobId);

      this.#executeJob(job, controller.signal).then((result) => {
        this.#running.delete(jobId);

        // Late-result guard: cancel() externo já marcou cancelled —
        // não sobrescreve status/timestamps com resultado tardio.
        if (job.status === 'cancelled') {
          if (!this.#disposed) this.#drain();
          return;
        }

        Object.assign(job, result);
        job.updated_at = nowISO();

        this.#runnerData.delete(jobId);

        this.#persistJob(job).catch(() => {});
        this.emit('completed', jobId);
        if (!this.#disposed) this.#drain();
      });
    }
  }

  async #executeJob(job, signal) {
    const runnerData = this.#runnerData.get(job.job_id) ?? {};
    try {
      const result = await this.#runFn(job, signal, runnerData);
      if (signal.aborted) {
        throw Object.assign(new Error('Job cancelado.'), { code: 'CANCELLED' });
      }

      const status = result.status === 'warning' ? 'warning' : 'succeeded';
      return {
        status,
        finished_at: nowISO(),
        result: {
          summary: result.summary,
          next_actions: result.next_actions,
          artifacts: result.artifacts,
          tools_used: result.tools_used,
          session_id: result.session_id,
          memory_note: result.memory_note ?? null,
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
    await chmod(storeDir, 0o700);

    const files = await readdir(storeDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const basename = path.basename(file, '.json');
      const content = await readFile(path.join(storeDir, file), 'utf-8').catch(() => null);
      if (!content) continue;

      const record = safeJSON(content, null);
      if (!record) continue;

      // Nunca remove JSON alheio de um diretório configurado por engano.
      // Arquivos do bridge levam marcador explícito; legado válido é aceito e reescrito.
      if (!UUID_RE.test(basename)) {
        if (record.app === STORE_MARKER) {
          await unlink(path.join(storeDir, file)).catch(() => {});
        }
        continue;
      }
      if (!UUID_RE.test(record.job_id) || record.job_id !== basename) {
        if (record.app === STORE_MARKER) {
          await unlink(path.join(storeDir, file)).catch(() => {});
        }
        continue;
      }

      if (!VALID_STATUSES.has(record.status)) continue;

      // Sanitiza recovery: mantém só metadados seguros
      const safe = {
        job_id: record.job_id,
        status: record.status,
        created_at: record.created_at ?? nowISO(),
        updated_at: nowISO(),
        started_at: null,
        finished_at: null,
        model: record.model ?? null,
        executor: record.executor ?? null,
        result: null,
        error: null,
      };

      const isPending = record.status === 'queued' || record.status === 'running';

      safe.status = isPending ? 'failed' : record.status;
      safe.finished_at = isPending ? nowISO() : (record.finished_at ?? nowISO());
      safe.error = isPending
        ? { code: 'RESTART' }
        : record.status === 'failed' && record.error?.code
          ? { code: record.error.code }
          : null;

      this.#jobs.set(safe.job_id, safe);
      // Reescreve imediatamente usando o mesmo schema mínimo da persistência normal.
      await this.#persistJob(safe);
    }
  }

  async #persistJob(job) {
    if (!this.#storeDir) return;
    const safe = {
      app: STORE_MARKER,
      job_id: job.job_id,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      model: job.model,
      executor: job.executor,
      error: job.error ? { code: job.error.code } : null,
    };
    const filePath = path.join(this.#storeDir, `${job.job_id}.json`);
    await writeFile(filePath, JSON.stringify(safe), { mode: 0o600 });
    await chmod(filePath, 0o600);
  }

  #prune() {
    const now = Date.now();
    const finished = [...this.#jobs.values()]
      .filter((j) => ['succeeded', 'warning', 'failed', 'cancelled'].includes(j.status))
      .sort((a, b) => (a.finished_at ?? a.updated_at).localeCompare(b.finished_at ?? b.updated_at));

    for (const job of finished) {
      const t = job.finished_at ?? job.updated_at;
      if (!t) continue;
      const age = now - new Date(t).getTime();
      if (job.result && age > this.#resultTtl) {
        this.#removeStore(job.job_id);
        this.#jobs.delete(job.job_id);
        this.#runnerData.delete(job.job_id);
      } else if (!job.result && age > this.#ttl) {
        this.#removeStore(job.job_id);
        this.#jobs.delete(job.job_id);
        this.#runnerData.delete(job.job_id);
      }
    }

    const remaining = [...this.#jobs.values()]
      .filter((j) => ['succeeded', 'warning', 'failed', 'cancelled'].includes(j.status))
      .sort((a, b) => (b.finished_at ?? b.updated_at).localeCompare(a.finished_at ?? a.updated_at));
    if (remaining.length > this.#maxResults) {
      for (const job of remaining.slice(this.#maxResults)) {
        this.#removeStore(job.job_id);
        this.#jobs.delete(job.job_id);
        this.#runnerData.delete(job.job_id);
      }
    }

    if (this.#queue.length > this.#maxQueued) {
      const excess = this.#queue.splice(this.#maxQueued);
      for (const id of excess) {
        this.#jobs.delete(id);
        this.#removeStore(id);
        this.#runnerData.delete(id);
      }
    }
  }

  async #removeStore(jobId) {
    if (!this.#storeDir) return;
    const filePath = path.join(this.#storeDir, `${jobId}.json`);
    await unlink(filePath).catch(() => {});
  }

  #runFn = async () => ({ status: 'succeeded', summary: 'No runner set.' });

  setRunner(fn) {
    this.#runFn = fn;
  }
}
