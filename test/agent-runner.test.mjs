import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildOpenCodeInvocation,
  buildChildEnv,
  formatAgentFailure,
  normalizeAgentRequest,
  parseOpenCodeEvents,
  resolveAllowedCwd,
  runVerbooAgent,
} from '../agent-runner.mjs';

const MODELS = ['deepseek-v4-flash', 'glm-5.2'];

test('normaliza request com defaults seguros', () => {
  assert.deepEqual(
    normalizeAgentRequest({ prompt: ' revise ', cwd: '/repo' }, MODELS),
    {
      prompt: 'revise',
      cwd: '/repo',
      mode: 'read_only',
      model: 'deepseek-v4-flash',
      timeoutSeconds: 600,
    },
  );
});

test('rejeita modelo, modo e timeout fora da allowlist', () => {
  assert.throws(
    () => normalizeAgentRequest({ prompt: 'x', cwd: '/repo', model: 'inventado' }, MODELS),
    /Modelo desconhecido/,
  );
  assert.throws(
    () => normalizeAgentRequest({ prompt: 'x', cwd: '/repo', mode: 'root' }, MODELS),
    /mode deve ser/,
  );
  assert.throws(
    () => normalizeAgentRequest({ prompt: 'x', cwd: '/repo', timeout_seconds: 2 }, MODELS),
    /timeout_seconds/,
  );
});

test('cwd precisa estar dentro de uma raiz autorizada após realpath', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'verboo-agent-'));
  const allowed = path.join(base, 'allowed');
  const sibling = path.join(base, 'allowed-escape');
  const project = path.join(allowed, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(sibling);

  assert.equal(await resolveAllowedCwd(project, allowed), await realpath(project));
  await assert.rejects(() => resolveAllowedCwd(sibling, allowed), /fora das raízes/);
  await assert.rejects(() => resolveAllowedCwd(project, ''), /não foi configurada/);
});

test('invocação usa OpenCode puro e mantém prompt com aparência de opção como posicional', () => {
  const request = {
    prompt: '--file=/etc/passwd',
    cwd: '/repo',
    mode: 'write',
    model: 'glm-5.2',
  };
  const invocation = buildOpenCodeInvocation(request, '/opt/opencode');

  assert.equal(invocation.command, '/opt/opencode');
  assert.deepEqual(invocation.args.slice(0, 9), [
    'run',
    '--pure',
    '--format',
    'json',
    '--model',
    'verboo/glm-5.2',
    '--agent',
    'verboo-bridge-agent',
    '--dir',
  ]);
  assert.equal(invocation.args.at(-2), '--');
  assert.equal(invocation.args.at(-1), request.prompt);
  assert.ok(!invocation.args.includes('--dangerously-skip-permissions'));

  const config = JSON.parse(invocation.inlineConfig);
  const permission = config.agent['verboo-bridge-agent'].permission;
  assert.equal(permission['*'], 'deny');
  assert.equal(permission.bash, 'deny');
  assert.deepEqual(permission.read, {
    '*': 'allow',
    '*.env': 'deny',
    '*.env.*': 'deny',
    '**/*.env': 'deny',
    '**/*.env.*': 'deny',
    '*.env.example': 'allow',
    '**/*.env.example': 'allow',
  });
  assert.deepEqual(permission.edit, permission.read);
});

test('read_only usa default deny e libera somente ferramentas de inspeção', () => {
  const invocation = buildOpenCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4-flash',
  });
  const permission = JSON.parse(invocation.inlineConfig)
    .agent['verboo-bridge-agent'].permission;

  assert.equal(permission['*'], 'deny');
  assert.equal(permission.edit, 'deny');
  assert.equal(permission.bash, 'deny');
  assert.equal(permission.external_directory, 'deny');
  for (const tool of ['glob', 'list']) {
    assert.equal(permission[tool], 'allow');
  }
  assert.equal(permission.grep, 'deny');
  assert.equal(permission.read['*.env'], 'deny');
  assert.equal(permission.read['**/*.env.*'], 'deny');
  assert.equal(permission.lsp, 'deny');
  assert.equal(permission.webfetch, 'deny');
  assert.equal(permission.task, 'deny');
});

test('subprocesso desativa config de projeto e recebe apenas ambiente necessário', () => {
  const env = buildChildEnv(
    {
      HOME: '/home/test',
      PATH: '/bin',
      VERBOO_API_KEY: 'vbk_test',
      GITHUB_TOKEN: 'nao-deve-vazar',
      AWS_SECRET_ACCESS_KEY: 'nao-deve-vazar',
      OPENCODE_DISABLE_PROJECT_CONFIG: '0',
    },
    '{"permission":{}}',
  );

  assert.deepEqual(env, {
    HOME: '/home/test',
    PATH: '/bin',
    VERBOO_API_KEY: 'vbk_test',
    OPENCODE_CONFIG_CONTENT: '{"permission":{}}',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  });
});

test('parser retorna resposta final, sessão e artefatos internos', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({ type: 'step_start', sessionID: 'ses_123' }),
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_123',
      part: {
        tool: 'read',
        state: { status: 'completed', input: { filePath: '/repo/src/app.js' } },
      },
    }),
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_123',
      part: {
        tool: 'read',
        state: { status: 'completed', input: { filePath: '/etc/passwd' } },
      },
    }),
    JSON.stringify({
      type: 'text',
      sessionID: 'ses_123',
      part: { text: '<think>oculto</think>\nConcluído.' },
    }),
  ].join('\n');

  assert.deepEqual(parseOpenCodeEvents(raw, cwd), {
    sessionId: 'ses_123',
    result: 'Concluído.',
    artifacts: ['/repo/src/app.js'],
    toolsUsed: ['read'],
    successfulTools: ['read'],
  });
});

test('write com edit falho retorna warning, não sucesso falso', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'verboo-warning-'));
  const fakeOpenCode = path.join(base, 'opencode');
  await writeFile(
    fakeOpenCode,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'tool_use',
  sessionID: 'ses_warning',
  part: {
    tool: 'edit',
    state: {
      status: 'error',
      input: { filePath: 'broken.js' },
      error: 'falhou'
    }
  }
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'text',
  sessionID: 'ses_warning',
  part: { text: 'Eu criaria o arquivo.' }
}) + '\\n');
`,
  );
  await chmod(fakeOpenCode, 0o755);

  const result = await runVerbooAgent(
    { prompt: 'crie um arquivo', cwd: base, mode: 'write', timeout_seconds: 10 },
    {
      availableModels: MODELS,
      env: {
        ...process.env,
        VERBOO_AGENT_ALLOWED_ROOTS: base,
        VERBOO_AGENT_WRITE_ENABLED: '1',
        VERBOO_OPENCODE_BIN: fakeOpenCode,
      },
    },
  );

  assert.equal(result.status, 'warning');
  assert.match(result.summary, /nenhuma mudança foi confirmada/);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.tools_used, ['edit']);
});

test('write falha fechado sem feature gate server-side', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'verboo-write-gate-'));

  await assert.rejects(
    () => runVerbooAgent(
      { prompt: 'edite um arquivo', cwd: base, mode: 'write' },
      {
        availableModels: MODELS,
        env: { VERBOO_AGENT_ALLOWED_ROOTS: base },
      },
    ),
    (error) => error.code === 'WRITE_DISABLED',
  );
});

test('limite global rejeita concorrência com AGENT_BUSY e libera o slot', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'verboo-concurrency-'));
  let release;
  let markStarted;
  let markStartedAgain;
  let spawnCalls = 0;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const startedAgain = new Promise((resolve) => { markStartedAgain = resolve; });
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    release = () => {
      child.stdout.end(`${JSON.stringify({
        type: 'text',
        sessionID: 'ses_concurrency',
        part: { text: 'Concluído.' },
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    };
    spawnCalls += 1;
    if (spawnCalls === 1) markStarted();
    if (spawnCalls === 2) markStartedAgain();
    return child;
  };
  const options = {
    availableModels: MODELS,
    env: {
      VERBOO_AGENT_ALLOWED_ROOTS: base,
      VERBOO_AGENT_MAX_CONCURRENCY: '1',
    },
    spawnImpl,
  };

  const first = runVerbooAgent(
    { prompt: 'primeira', cwd: base, mode: 'read_only', timeout_seconds: 10 },
    options,
  );
  await started;
  await assert.rejects(
    () => runVerbooAgent(
      { prompt: 'segunda', cwd: base, mode: 'read_only', timeout_seconds: 10 },
      options,
    ),
    (error) => error.code === 'AGENT_BUSY',
  );

  release();
  assert.equal((await first).status, 'success');

  const afterRelease = runVerbooAgent(
    { prompt: 'terceira', cwd: base, mode: 'read_only', timeout_seconds: 10 },
    options,
  );
  await startedAgain;
  release();
  assert.equal((await afterRelease).status, 'success');
});

test('limite de saída encerra o grupo POSIX com TERM, graça e KILL', {
  skip: process.platform === 'win32',
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'verboo-process-group-'));
  const signals = [];
  let spawnOptions;
  let child;
  const spawnImpl = (_command, _args, options) => {
    spawnOptions = options;
    child = new EventEmitter();
    child.pid = 43210;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => child.stdout.write(Buffer.alloc((4 * 1024 * 1024) + 1)));
    return child;
  };
  const killImpl = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null));
  };

  await assert.rejects(
    () => runVerbooAgent(
      { prompt: 'audite', cwd: base, mode: 'read_only', timeout_seconds: 10 },
      {
        availableModels: MODELS,
        env: { VERBOO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl,
        killImpl,
        killGraceMs: 5,
      },
    ),
    (error) => error.code === 'OUTPUT_LIMIT',
  );

  assert.equal(spawnOptions.detached, true);
  assert.deepEqual(signals, [
    [-43210, 'SIGTERM'],
    [-43210, 'SIGKILL'],
  ]);
});

test('fechamento do processo direto após TERM não cancela KILL do grupo POSIX', {
  skip: process.platform === 'win32',
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'verboo-orphan-group-'));
  const signals = [];
  let child;
  const spawnImpl = () => {
    child = new EventEmitter();
    child.pid = 54321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => child.stdout.write(Buffer.alloc((4 * 1024 * 1024) + 1)));
    return child;
  };
  const killImpl = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 'SIGTERM') setImmediate(() => child.emit('close', null));
  };

  await assert.rejects(
    () => runVerbooAgent(
      { prompt: 'audite', cwd: base, mode: 'read_only', timeout_seconds: 10 },
      {
        availableModels: MODELS,
        env: { VERBOO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl,
        killImpl,
        killGraceMs: 5,
      },
    ),
    (error) => error.code === 'OUTPUT_LIMIT',
  );

  assert.deepEqual(signals, [
    [-54321, 'SIGTERM'],
    [-54321, 'SIGKILL'],
  ]);
});

test('falha tem contrato de recuperação determinístico', () => {
  const error = new Error('OpenCode não encontrado');
  error.code = 'OPENCODE_NOT_FOUND';
  assert.deepEqual(formatAgentFailure(error), {
    status: 'error',
    summary: 'OpenCode não encontrado',
    result: '',
    next_actions: [
      'Instale o OpenCode ou configure VERBOO_OPENCODE_BIN com o caminho absoluto.',
    ],
    artifacts: [],
    session_id: null,
  });
});
