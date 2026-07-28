import assert from 'node:assert/strict';
import { chmod, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JobQueue, createJobRecord } from '../job-queue.mjs';

// ── Helpers ────────────────────────────────────────────────────────────

function fakeResult(opts = {}) {
  const now = new Date().toISOString();
  return {
    status: 'succeeded',
    finished_at: now,
    summary: opts.summary ?? 'Done.',
    result: opts.output ?? 'Resposta final.',
    next_actions: [],
    artifacts: [],
    tools_used: [],
    session_id: opts.sessionId ?? null,
    model: opts.model ?? null,
    executor: opts.executor ?? null,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

test('createJobRecord: gera job_id e estado inicial', () => {
  const r = createJobRecord({ cwd: '/repo', model: 'auto', executor: 'native' });
  assert.ok(r.job_id);
  assert.equal(r.status, 'queued');
  assert.ok(r.created_at);
  assert.equal(r.cwd, '/repo');
  assert.equal(r.model, 'auto');
  assert.equal(r.executor, 'native');
});

test('JobQueue: enqueue retorna job_id imediatamente', () => {
  const q = new JobQueue({ concurrency: 1 });
  const result = q.enqueue({
    cwd: '/repo',
    model: 'auto',
    executor: 'native',
    runnerData: { prompt: 'test', cwd: '/repo', mode: 'read_only' },
  });
  assert.ok(result.job_id);
  assert.equal(typeof result.job_id, 'string');
  assert.equal(result.error, undefined);
});

test('JobQueue: fila FIFO com concorrencia 4', async () => {
  const q = new JobQueue({ concurrency: 4 });

  // Set runner to track started order
  const started = [];
  q.setRunner(async (job, signal, data) => {
    started.push(data.prompt);
    await new Promise((r) => setTimeout(r, 10));
    return fakeResult({ summary: data.prompt });
  });

  q.enqueue({ runnerData: { prompt: 'A' } });
  q.enqueue({ runnerData: { prompt: 'B' } });
  q.enqueue({ runnerData: { prompt: 'C' } });
  q.enqueue({ runnerData: { prompt: 'D' } });

  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(started, ['A', 'B', 'C', 'D']);
  const s = q.status;
  assert.equal(s.queued, 0);
  assert.equal(s.running, 0);
  assert.equal(s.total, 4);
});

test('JobQueue: fila com overflow enfileira em vez de rejeitar', async () => {
  const q = new JobQueue({ concurrency: 1, maxQueued: 3 });

  const runningJobs = [];
  q.setRunner(async (job, signal, data) => {
    runningJobs.push(data.prompt);
    await new Promise((r) => setTimeout(r, 50));
    return fakeResult({ summary: data.prompt });
  });

  // Enqueue jobs that will run immediately
  q.enqueue({ runnerData: { prompt: 'J1' } });
  q.enqueue({ runnerData: { prompt: 'J2' } });
  q.enqueue({ runnerData: { prompt: 'J3' } });

  // Give time for first to start running
  await new Promise((r) => setTimeout(r, 30));

  const s = q.status;
  assert.equal(s.queued, 2); // 2 waiting
  assert.equal(s.running, 1); // 1 running

  // Should queue 4th (maxQueued=3, so this fills it)
  const result4 = q.enqueue({ runnerData: { prompt: 'J4' } });
  assert.ok(result4.job_id);
  assert.equal(result4.error, undefined);

  // Should reject 5th
  const result5 = q.enqueue({ runnerData: { prompt: 'J5' } });
  assert.equal(result5.error, 'QUEUE_FULL');

  await new Promise((r) => setTimeout(r, 300));
});

test('JobQueue: get retorna job publico sem dados sensiveis', async () => {
  const q = new JobQueue({ concurrency: 1 });
  q.enqueue({ runnerData: { prompt: 'secret', cwd: '/repo' } });
  await new Promise((r) => setTimeout(r, 50));

  const jobs = q.listJobs();
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].job_id);
  assert.equal(jobs[0].status, 'succeeded');
  // Must not contain prompt or secrets
  assert.equal(jobs[0].prompt, undefined);
  assert.equal(jobs[0].runnerData, undefined);
  assert.equal(jobs[0].result, undefined);
  assert.equal(jobs[0].error, undefined);
});

test('JobQueue: result retorna resultado completo', () => {
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => fakeResult({
    summary: 'Done.',
    output: 'Análise substantiva.',
  }));
  const { job_id } = q.enqueue({ runnerData: { prompt: 'test' } });
  return new Promise((resolve) => {
    q.on('completed', () => {
      const result = q.getJobResult(job_id);
      assert.ok(result);
      assert.ok(result.result);
      assert.equal(result.result.summary, 'Done.');
      assert.equal(result.result.output, 'Análise substantiva.');
      assert.equal(result.result.memory_note, undefined);
      resolve();
    });
  });
});

test('JobQueue: cancel de job na fila remove da fila', async () => {
  const q = new JobQueue({ concurrency: 1 });
  const r1 = q.enqueue({ runnerData: { prompt: 'slow' } });
  const r2 = q.enqueue({ runnerData: { prompt: 'queued' } });

  // Cancel the queued one
  const cancelResult = await q.cancel(r2.job_id);
  assert.equal(cancelResult.status, 'cancelled');

  const job = q.getJob(r2.job_id);
  assert.equal(job.status, 'cancelled');
});

test('JobQueue: cancel de job running aborta execucao', () => {
  const q = new JobQueue({ concurrency: 1 });

  let aborted = false;
  q.setRunner(async (job, signal) => {
    // Hang until signal aborts
    await new Promise((resolve, reject) => {
      if (signal.aborted) {
        aborted = true;
        reject(new Error('CANCELLED'));
        return;
      }
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('CANCELLED'));
      });
    });
  });

  const { job_id } = q.enqueue({ runnerData: { prompt: 'cancel-me' } });

  // Cancel as soon as it starts
  q.on('started', () => {
    setImmediate(() => { void q.cancel(job_id); });
  });

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.ok(aborted);
      const job = q.getJob(job_id);
      assert.equal(job.status, 'cancelled');
      resolve();
    }, 300);
  });
});

test('JobQueue: TTL remove jobs antigos', () => {
  const q = new JobQueue({ concurrency: 1, ttl: 50, resultTtl: 50, maxResults: 100 });
  q.setRunner(async () => fakeResult({ summary: 'ttl' }));
  q.enqueue({ runnerData: { prompt: 'a' } });
  return new Promise((resolve) => {
    q.on('completed', () => {
      setTimeout(() => {
        assert.equal(q.listJobs().length, 0);
        resolve();
      }, 100);
    });
  });
});

test('JobQueue: restart recovery marca interrupted como failed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-job-store-'));
  const q = new JobQueue({ concurrency: 1 });

  // Manually set a job as running in store
  const storeJob = createJobRecord({ cwd: '/repo' });
  storeJob.status = 'running';
  await q.initStore(dir);  // First init with empty store

  // Write directly to store simulating a previous run
  const { writeFile } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const staleId = randomUUID();
  const stale = {
    job_id: staleId,
    status: 'queued',
    created_at: new Date(Date.now() - 60000).toISOString(),
    updated_at: new Date(Date.now() - 60000).toISOString(),
    model: null, executor: null, cwd: '/repo',
    result: null, error: null,
  };
  await writeFile(
    path.join(dir, `${staleId}.json`),
    JSON.stringify(stale),
    { mode: 0o600 },
  );
  await chmod(path.join(dir, `${staleId}.json`), 0o600);

  // Second queue with same store to trigger recovery
  const q2 = new JobQueue({ concurrency: 1 });
  await q2.initStore(dir);

  const recovered = q2.getJobResult(staleId);
  assert.ok(recovered, 'Job should be recovered');
  assert.equal(recovered.status, 'failed');
  assert.ok(recovered.error, 'Error should be set on recovery');
  assert.equal(recovered.error.code, 'RESTART');

  const { readFile } = await import('node:fs/promises');
  const rewritten = JSON.parse(
    await readFile(path.join(dir, `${staleId}.json`), 'utf-8'),
  );
  assert.equal(rewritten.status, 'failed');
  assert.equal(rewritten.error.code, 'RESTART');
  assert.equal(rewritten.cwd, undefined);
  assert.equal(rewritten.result, undefined);

  // Cleanup
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: list exporta schema compativel Moonshot', () => {
  const q = new JobQueue({ concurrency: 1 });
  q.enqueue({ runnerData: { prompt: 'x' } });
  const jobs = q.listJobs();
  assert.ok(Array.isArray(jobs));
  if (jobs.length > 0) {
    const j = jobs[0];
    // Moonshot-compatible fields
    assert.equal(typeof j.job_id, 'string');
    assert.equal(typeof j.status, 'string');
    assert.ok(j.created_at);
    assert.ok(j.updated_at);
    // No sensitive data
    assert.equal(j.prompt, undefined);
  }
});

test('JobQueue: capacidade exposta no status', () => {
  const q = new JobQueue({ concurrency: 4 });
  assert.equal(q.capacity, 4);
  assert.equal(q.status.concurrency, 4);
});

test('JobQueue: estados terminal nao pode ser cancelado', async () => {
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => fakeResult({ summary: 'ok' }));
  const { job_id } = q.enqueue({ runnerData: { prompt: 'fast' } });
  await new Promise((resolve) => q.on('completed', resolve));
  const result = await q.cancel(job_id);
  assert.equal(result.error, 'ALREADY_FINISHED');
});

test('JobQueue: status resource sem dados sensiveis', () => {
  const q = new JobQueue({ concurrency: 2 });
  q.enqueue({ runnerData: { prompt: 'a' } });
  q.enqueue({ runnerData: { prompt: 'b' } });
  const s = q.status;
  assert.equal(typeof s.concurrency, 'number');
  assert.equal(typeof s.queued, 'number');
  assert.equal(typeof s.running, 'number');
  assert.equal(typeof s.total, 'number');
  assert.ok(s.by_status); // Aggregated counts, no individual job data
});

test('JobQueue: late-result guard nao sobrescreve cancelled', async () => {
  const q = new JobQueue({ concurrency: 1 });
  let resolveRunner;
  q.setRunner(async () => {
    await new Promise((r) => { resolveRunner = r; });
    return { status: 'succeeded', finished_at: new Date().toISOString(), summary: 'late' };
  });
  const { job_id } = q.enqueue({ runnerData: { prompt: 'late' } });

  // Aguarda job ficar running
  await new Promise((resolve) => q.on('started', resolve));

  // Cancela enquanto runner ainda executa
  await q.cancel(job_id);
  assert.equal(q.getJob(job_id).status, 'cancelled');

  // Runner termina tarde — não deve sobrescrever cancelled
  resolveRunner();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(q.getJob(job_id).status, 'cancelled');
});

test('JobQueue: cancel de running seta finished_at', async () => {
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => new Promise(() => {}));
  const { job_id } = q.enqueue({ runnerData: { prompt: 'hang' } });
  await new Promise((resolve) => q.on('started', resolve));
  await q.cancel(job_id);
  const job = q.getJob(job_id);
  assert.equal(job.status, 'cancelled');
  assert.ok(job.finished_at, 'cancelled deve ter finished_at');
});

test('JobQueue: runnerData limpo apos terminal', async () => {
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => ({ status: 'succeeded', finished_at: new Date().toISOString(), summary: 'ok' }));
  const { job_id } = q.enqueue({ runnerData: { prompt: 'clean' } });
  await new Promise((resolve) => q.on('completed', resolve));
  // runnerData interno não exposto publicamente, mas verifica que foi limpo
  const result = q.getJobResult(job_id);
  assert.ok(result);
  assert.equal(result.status, 'succeeded');
  assert.equal(q.status.runner_data_retained, 0);
});

test('JobQueue: dispose cancela jobs e limpa dados sensiveis', async () => {
  const q = new JobQueue({ concurrency: 2 });
  let runnerStarted;
  q.setRunner(async () => {
    runnerStarted = true;
    await new Promise(() => {});
  });
  const { job_id } = q.enqueue({ runnerData: { prompt: 'a' } });
  await new Promise((resolve) => q.on('started', resolve));
  q.dispose();
  assert.equal(q.status.running, 0);
  assert.equal(q.status.total, 1); // job ainda existe mas running foi limpo
  assert.equal(q.status.runner_data_retained, 0);
  assert.equal(q.status.disposed, true);
  assert.equal(q.getJob(job_id).status, 'cancelled');
  assert.ok(q.getJob(job_id).finished_at);
  assert.equal(q.enqueue({ runnerData: { prompt: 'late' } }).error, 'QUEUE_DISPOSED');
});

test('JobQueue: default concurrency 4', () => {
  const q = new JobQueue();
  assert.equal(q.capacity, 4);
  assert.equal(q.status.concurrency, 4);
});

test('JobQueue: persistencia armazena apenas metadados seguros', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-safe-store-'));
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => ({ status: 'succeeded', finished_at: new Date().toISOString(), summary: 'data' }));
  await q.initStore(dir);

  const { job_id } = q.enqueue({ runnerData: { prompt: 'secret-data' } });
  await new Promise((resolve) => q.on('completed', resolve));
  await q.waitForPersistence(job_id);

  // Lê o arquivo direto do disco — retenta até 1s para aguardar I/O do #persistJob
  const { readFile } = await import('node:fs/promises');
  const filePath2 = path.join(dir, `${job_id}.json`);
  let stored;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const raw = await readFile(filePath2, 'utf-8');
      stored = JSON.parse(raw);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!stored) throw new Error('Nao conseguiu ler o arquivo persistido apos 10 tentativas');

  // Deve ter só campos seguros
  assert.ok(stored.job_id);
  assert.ok(stored.status);
  assert.ok(stored.created_at);
  assert.ok(!stored.cwd, 'cwd não deve ser persistido');
  assert.ok(!stored.result, 'result não deve ser persistido');
  assert.ok(stored.error === null || (stored.error && !stored.error.message), 'error.message não deve ser persistido');
  assert.ok(!stored.prompt, 'prompt não deve ser persistido');
  assert.ok(!stored.runnerData, 'runnerData não deve ser persistido');

  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: resultado duravel exige opt-in na escrita e recuperacao', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-durable-result-'));
  const { readFile, rm } = await import('node:fs/promises');
  const q = new JobQueue({ concurrency: 1, persistResults: true });
  q.setRunner(async () => ({
    ...fakeResult({ output: 'Resultado proprietário.' }),
    memory: {
      injected_project_entries: 2,
      injected_shared_files: 1,
      persisted: true,
      memory_note: 'nunca persistir esta nota',
    },
    warnings: [{ code: 'SAFE_WARNING', message: 'Aviso público.' }],
  }));
  await q.initStore(dir);

  const { job_id } = await q.enqueuePersisted({
    cwd: '/repo-secreto',
    runnerData: { prompt: 'prompt secreto', env: { TOKEN: 'segredo' } },
  });
  await new Promise((resolve) => q.on('completed', resolve));
  await q.waitForPersistence(job_id);

  const file = path.join(dir, `${job_id}.json`);
  let stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.schema_version, 2);
  assert.equal(stored.result.output, 'Resultado proprietário.');
  assert.equal(stored.result.memory.persisted, true);
  assert.equal(stored.result.memory.memory_note, undefined);
  assert.equal(stored.result.warnings[0].code, 'SAFE_WARNING');
  assert.equal(stored.result.warnings[0].message, undefined);
  assert.equal(stored.cwd, undefined);
  assert.equal(stored.prompt, undefined);
  assert.equal(stored.runnerData, undefined);
  assert.equal(stored.env, undefined);

  const recoveredEnabled = new JobQueue({ concurrency: 1, persistResults: true });
  await recoveredEnabled.initStore(dir);
  assert.equal(
    recoveredEnabled.getJobResult(job_id).result.output,
    'Resultado proprietário.',
  );

  const recoveredDisabled = new JobQueue({ concurrency: 1, persistResults: false });
  await recoveredDisabled.initStore(dir);
  assert.equal(recoveredDisabled.getJobResult(job_id).result, null);
  stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.result, undefined);

  q.dispose();
  recoveredEnabled.dispose();
  recoveredDisabled.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: resultado duravel recupera warning failed e cancelled', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-durable-states-'));
  const { readFile, rm } = await import('node:fs/promises');
  const q = new JobQueue({ concurrency: 1, persistResults: true });
  await q.initStore(dir);
  q.setRunner(async (_job, signal, data) => {
    if (data.kind === 'warning') {
      return { ...fakeResult({ output: 'parcial' }), status: 'warning' };
    }
    if (data.kind === 'failed') {
      throw Object.assign(new Error('falha pública'), { code: 'TEST_FAILURE' });
    }
    await new Promise((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('cancelado'), { code: 'CANCELLED' })),
        { once: true },
      );
    });
    return fakeResult();
  });

  const warningCompleted = new Promise((resolve) => q.once('completed', resolve));
  const warning = q.enqueue({ runnerData: { kind: 'warning' } });
  await warningCompleted;
  await q.waitForPersistence(warning.job_id);

  const failedCompleted = new Promise((resolve) => q.once('completed', resolve));
  const failed = q.enqueue({ runnerData: { kind: 'failed' } });
  await failedCompleted;
  await q.waitForPersistence(failed.job_id);

  const cancelledStarted = new Promise((resolve) => q.once('started', resolve));
  const cancelled = q.enqueue({ runnerData: { kind: 'cancelled' } });
  await cancelledStarted;
  await q.cancel(cancelled.job_id);
  const cancelledStored = JSON.parse(
    await readFile(path.join(dir, `${cancelled.job_id}.json`), 'utf8'),
  );
  assert.equal(
    cancelledStored.status,
    'cancelled',
    'cancel só confirma depois de persistir o estado terminal',
  );

  const recovered = new JobQueue({ concurrency: 1, persistResults: true });
  await recovered.initStore(dir);
  assert.equal(recovered.getJobResult(warning.job_id).status, 'warning');
  assert.equal(recovered.getJobResult(warning.job_id).result.output, 'parcial');
  assert.equal(recovered.getJobResult(failed.job_id).status, 'failed');
  assert.equal(recovered.getJobResult(failed.job_id).error.code, 'TEST_FAILURE');
  assert.equal(recovered.getJobResult(failed.job_id).error.message, undefined);
  assert.equal(recovered.getJobResult(cancelled.job_id).status, 'cancelled');
  assert.equal(recovered.getJobResult(cancelled.job_id).result, null);

  q.dispose();
  recovered.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: schema desconhecido e legado nunca recuperam resultado', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-durable-schema-'));
  const { randomUUID } = await import('node:crypto');
  const { access, rm, writeFile } = await import('node:fs/promises');
  const unknownId = randomUUID();
  const legacyId = randomUUID();
  const terminal = {
    status: 'succeeded',
    created_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    result: { output: 'não recuperar' },
  };
  await writeFile(path.join(dir, `${unknownId}.json`), JSON.stringify({
    app: 'verboo-bridge-job-v1',
    schema_version: 999,
    job_id: unknownId,
    ...terminal,
  }));
  await writeFile(path.join(dir, `${legacyId}.json`), JSON.stringify({
    job_id: legacyId,
    ...terminal,
  }));

  const q = new JobQueue({ concurrency: 1, persistResults: true });
  await q.initStore(dir);
  assert.equal(q.getJob(unknownId), null);
  assert.equal(q.getJobResult(legacyId).result, null);
  await access(path.join(dir, `${unknownId}.json`));

  q.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: falha ao gravar resultado nunca publica sucesso falso', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-durable-failure-'));
  const { rm } = await import('node:fs/promises');
  const q = new JobQueue({ concurrency: 1, persistResults: true });
  let release;
  q.setRunner(async () => {
    await new Promise((resolve) => { release = resolve; });
    return fakeResult({ output: 'não pode virar sucesso' });
  });
  await q.initStore(dir);
  const { job_id } = await q.enqueuePersisted({ runnerData: { prompt: 'x' } });
  await new Promise((resolve) => q.once('started', resolve));
  await chmod(dir, 0o500);
  release();
  await new Promise((resolve) => q.once('completed', resolve));

  const result = q.getJobResult(job_id);
  assert.equal(result.status, 'failed');
  assert.equal(result.result, null);
  assert.equal(result.error.code, 'RESULT_STORE_WRITE_FAILED');

  q.dispose();
  await chmod(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: enqueuePersisted grava estado queued antes de responder', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-queued-store-'));
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async (_job, signal) => {
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
      }, { once: true });
    });
    return fakeResult();
  });
  await q.initStore(dir);

  const first = await q.enqueuePersisted({ runnerData: { prompt: 'running' } });
  await new Promise((resolve) => q.once('started', resolve));
  const second = await q.enqueuePersisted({ runnerData: { prompt: 'queued' } });

  const { readFile, rm } = await import('node:fs/promises');
  const stored = JSON.parse(
    await readFile(path.join(dir, `${second.job_id}.json`), 'utf8'),
  );
  assert.equal(stored.status, 'queued');
  assert.equal(q.getJob(second.job_id).status, 'queued');

  await q.cancel(second.job_id);
  await q.cancel(first.job_id);
  q.dispose();
  await Promise.all([
    q.waitForPersistence(first.job_id),
    q.waitForPersistence(second.job_id),
  ]);
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: recuperação normaliza timestamps inválidos', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-invalid-date-'));
  const { randomUUID } = await import('node:crypto');
  const { rm, writeFile } = await import('node:fs/promises');
  const jobId = randomUUID();
  await writeFile(
    path.join(dir, `${jobId}.json`),
    JSON.stringify({
      app: 'verboo-bridge-job-v1',
      job_id: jobId,
      status: 'succeeded',
      created_at: 123,
      finished_at: { invalid: true },
    }),
  );

  const q = new JobQueue({ concurrency: 1 });
  await q.initStore(dir);
  const [job] = q.listJobs();
  assert.equal(typeof job.created_at, 'string');
  assert.equal(typeof job.finished_at, 'string');
  assert.ok(Number.isFinite(Date.parse(job.created_at)));
  assert.ok(Number.isFinite(Date.parse(job.finished_at)));

  q.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: initStore rejeita path traversal em filename', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-traversal-'));
  const { writeFile } = await import('node:fs/promises');
  // Nome inválido dentro do store deve ser removido sem tocar fora dele.
  const invalidFile = path.join(dir, 'not-a-uuid.json');
  await writeFile(invalidFile, JSON.stringify({ job_id: 'nested', status: 'succeeded' }));

  // Cria também um UUID válido
  const { randomUUID } = await import('node:crypto');
  const validId = randomUUID();
  await writeFile(
    path.join(dir, `${validId}.json`),
    JSON.stringify({ job_id: validId, status: 'succeeded', finished_at: new Date().toISOString() }),
  );
  const mismatchedId = randomUUID();
  await writeFile(
    path.join(dir, `${mismatchedId}.json`),
    JSON.stringify({ job_id: randomUUID(), status: 'succeeded' }),
  );

  const q = new JobQueue({ concurrency: 1 });
  await q.initStore(dir);

  // Só o UUID válido deve ter sido carregado
  assert.ok(q.getJob(validId));
  assert.ok(!q.getJob('nested'));
  assert.ok(!q.getJob(mismatchedId));
  const { access } = await import('node:fs/promises');
  await access(invalidFile);
  await access(path.join(dir, `${mismatchedId}.json`));

  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: prune autonomo remove job e arquivo persistido', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-autoprune-'));
  const q = new JobQueue({
    concurrency: 1,
    ttl: 20,
    resultTtl: 20,
    pruneIntervalMs: 10,
  });
  q.setRunner(async () => ({
    status: 'succeeded',
    finished_at: new Date().toISOString(),
    summary: 'expira',
  }));
  await q.initStore(dir);

  const { job_id } = q.enqueue({ runnerData: { prompt: 'expire' } });
  await new Promise((resolve) => q.on('completed', resolve));

  const { access, rm } = await import('node:fs/promises');
  const persisted = path.join(dir, `${job_id}.json`);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await access(persisted);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(q.getJob(job_id), null);
  await assert.rejects(() => access(persisted));
  q.dispose();
  await rm(dir, { recursive: true, force: true });
});

test('JobQueue: listJobs nao expoe cwd', async () => {
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => ({ status: 'succeeded', finished_at: new Date().toISOString(), summary: 'ok' }));
  q.enqueue({ cwd: '/secret/repo', runnerData: { prompt: 'x' } });
  await new Promise((resolve) => q.on('completed', resolve));
  const jobs = q.listJobs();
  assert.equal(jobs[0].cwd, undefined, 'listJobs nao deve expor cwd');
});

// ── Progress / Heartbeat ────────────────────────────────────────────────

test('JobQueue: getJob inclui campos de progresso para job ativo', async () => {
  const q = new JobQueue({ concurrency: 1 });
  let resolveRunner;
  q.setRunner(async () => new Promise((r) => { resolveRunner = r; }));
  const { job_id } = q.enqueue({ runnerData: { prompt: 'progress' } });

  // Job ainda na fila
  let status = q.getJob(job_id);
  assert.equal(status.phase, 'queued');
  assert.equal(typeof status.elapsed_ms, 'number');
  assert.equal(status.last_activity_at, status.updated_at);
  assert.ok(status.queue_position > 0);
  assert.deepEqual(status.attempts, { current: 0, total: 1 });
  assert.equal(typeof status.progress_summary, 'string');

  // Deixa executar e verifica fase 'routing'
  await new Promise((resolve) => q.on('started', resolve));
  status = q.getJob(job_id);
  assert.equal(status.phase, 'routing');
  assert.equal(status.queue_position, 0);

  resolveRunner();
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test('JobQueue: progresso tem tool_counts enquanto ativo e limpa no terminal', async () => {
  const q = new JobQueue({ concurrency: 1 });
  let release;
  q.setRunner(async (_job, _signal, _data, onProgress) => {
    onProgress({
      tool_counts: {
        Read: { total: 1, succeeded: 0, failed: 0 },
        Edit: { total: 1, succeeded: 0, failed: 0 },
        Glob: { total: 1, succeeded: 0, failed: 0 },
        total: { total: 3, succeeded: 0, failed: 0 },
      },
    });
    await new Promise((resolve) => { release = resolve; });
    return {
    status: 'succeeded',
    finished_at: new Date().toISOString(),
    summary: 'Done',
    result: 'ok',
    tools_used: ['read', 'edit', 'glob'],
    };
  });
  const { job_id } = q.enqueue({ runnerData: { prompt: 'tools' } });
  await new Promise((resolve) => q.on('started', resolve));
  const active = q.getJob(job_id);
  assert.equal(active.tool_counts.total.total, 3);
  assert.equal(active.tool_counts.Read.total, 1);
  assert.equal(active.tool_counts.Edit.total, 1);
  assert.equal(active.tool_counts.Glob.total, 1);
  release();
  await new Promise((resolve) => q.on('completed', resolve));
  const result = q.getJobResult(job_id);
  assert.equal(result.tool_counts, undefined);
  assert.equal(result.phase, undefined);
  assert.equal(result.queue_position, null);
});

test('JobQueue: queue_position 0 running positivo queued null terminal', async () => {
  const q = new JobQueue({ concurrency: 1 });
  let release;
  q.setRunner(async () => new Promise((r) => { release = r; }));
  const r1 = q.enqueue({ runnerData: { prompt: 'a' } });
  const r2 = q.enqueue({ runnerData: { prompt: 'b' } });

  await new Promise((resolve) => q.on('started', resolve));
  assert.equal(q.getJob(r1.job_id).queue_position, 0);
  assert.equal(q.getJob(r2.job_id).queue_position, 1);

  release?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(q.getJob(r1.job_id).queue_position, null);
});

test('JobQueue: listJobs nao expoe campos de progresso', async () => {
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => ({
    status: 'succeeded',
    finished_at: new Date().toISOString(),
    summary: 'ok',
    result: 'ok',
    tools_used: ['read'],
  }));
  const { job_id } = q.enqueue({ runnerData: { prompt: 'list-no-progress' } });
  await new Promise((resolve) => q.on('completed', resolve));
  const jobs = q.listJobs();
  const j = jobs.find((x) => x.job_id === job_id);
  assert.ok(j);
  assert.equal(j.phase, undefined);
  assert.equal(j.elapsed_ms, undefined);
  assert.equal(j.tool_counts, undefined);
  assert.equal(j.progress_summary, undefined);
});

test('JobQueue: progresso limpo ao cancelar', async () => {
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => new Promise(() => {}));
  const { job_id } = q.enqueue({ runnerData: { prompt: 'cancel-progress' } });
  await new Promise((resolve) => q.on('started', resolve));
  assert.ok(q.getJob(job_id).phase);
  await q.cancel(job_id);
  assert.equal(q.getJob(job_id).phase, undefined);
});

test('JobQueue: progresso limpo ao fazer dispose', async () => {
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => new Promise(() => {}));
  const { job_id } = q.enqueue({ runnerData: { prompt: 'dispose-progress' } });
  await new Promise((resolve) => q.on('started', resolve));
  q.dispose();
  assert.equal(q.getJob(job_id).phase, undefined);
});

test('JobQueue: progress_summary gerado a partir da fase e contadores', async () => {
  const q = new JobQueue({ concurrency: 1 });
  let release;
  q.setRunner(async (_job, _signal, _data, onProgress) => {
    onProgress({
      phase: 'generating',
      model: 'glm-5.2',
      tool_counts: {
        Read: { total: 2, succeeded: 0, failed: 0 },
        Edit: { total: 1, succeeded: 0, failed: 0 },
        Glob: { total: 1, succeeded: 0, failed: 0 },
        Bash: { total: 1, succeeded: 0, failed: 0 },
        total: { total: 5, succeeded: 0, failed: 0 },
      },
    });
    await new Promise((resolve) => { release = resolve; });
    return {
      status: 'succeeded',
      finished_at: new Date().toISOString(),
      summary: 'Done',
      result: 'ok',
      tools_used: ['read', 'read', 'edit', 'glob', 'bash'],
    };
  });
  const { job_id } = q.enqueue({ model: 'glm-5.2', runnerData: { prompt: 'summary' } });
  await new Promise((resolve) => q.on('started', resolve));
  const status = q.getJob(job_id);
  assert.ok(typeof status.progress_summary === 'string');
  assert.ok(status.progress_summary.length > 0);
  assert.ok(status.progress_summary.length <= 200);
  assert.match(status.progress_summary, /Modelo: glm-5\.2/);
  assert.match(status.progress_summary, /Ferramentas: 0\/5 sucesso/);
  release();
  await new Promise((resolve) => q.on('completed', resolve));
  assert.equal(q.getJob(job_id).progress_summary, undefined);
});

test('JobQueue: getJob expoe updated_at no progresso', async () => {
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => ({ status: 'succeeded', finished_at: new Date().toISOString(), summary: 'ok' }));
  const { job_id } = q.enqueue({ runnerData: { prompt: 'updated_at' } });
  const status = q.getJob(job_id);
  assert.ok(status.updated_at, 'deve expor updated_at');
  assert.equal(status.updated_at, status.last_activity_at);
  await new Promise((resolve) => q.on('completed', resolve));
});

test('JobQueue: runnerData original nao contem __onProgress apos enqueue', () => {
  const q = new JobQueue({ concurrency: 1 });
  const original = { prompt: 'segredo' };
  const { job_id } = q.enqueue({ runnerData: original });
  assert.equal(original.__onProgress, undefined, 'runnerData original nao deve conter __onProgress');
});

test('JobQueue: heartbeat relata silencio como idle e atividade restaura fase', async () => {
  const q = new JobQueue({ concurrency: 1, heartbeatMs: 10 });
  let release;
  let report;
  q.setRunner(async (_job, _signal, _data, onProgress) => {
    report = onProgress;
    onProgress({ phase: 'generating' });
    return new Promise((r) => { release = r; });
  });
  const { job_id } = q.enqueue({ runnerData: { prompt: 'idle-guard' } });
  await new Promise((resolve) => q.on('started', resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
  let progress = q.getJob(job_id);
  assert.equal(progress.phase, 'idle');
  assert.ok(progress.idle_for_ms >= 10);

  report({ phase: 'executing_tool' });
  progress = q.getJob(job_id);
  assert.equal(progress.phase, 'executing_tool');
  assert.equal(progress.idle_for_ms, null);
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('JobQueue: cancelamento com falha de persistência não expõe status de cancelado confirmado', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'verboo-cancel-write-fail-'));
  const { rm } = await import('node:fs/promises');
  const q = new JobQueue({ concurrency: 1 });
  q.setRunner(async () => new Promise(() => {}));
  await q.initStore(dir);
  const { job_id } = q.enqueue({ runnerData: { prompt: 'cancel-fail' } });
  await chmod(dir, 0o500);

  const res = await q.cancel(job_id);
  assert.equal(res.status, undefined, 'não deve confirmar status cancelled');
  assert.equal(res.error, 'JOB_STORE_WRITE_FAILED');
  assert.match(res.message, /não pôde ser persistido/);

  q.dispose();
  await chmod(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});
