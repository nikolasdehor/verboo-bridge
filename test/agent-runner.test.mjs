import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildOpenCodeInvocation,
  buildVerbooCodeInvocation,
  buildChildEnv,
  formatAgentFailure,
  normalizeAgentRequest,
  parseOpenCodeEvents,
  parseVerbooCodeEvents,
  resolveAgentExecutor,
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

test('executor pode ser escolhido por chamada e usa native como padrão', () => {
  assert.equal(resolveAgentExecutor(undefined, {}), 'native');
  assert.equal(
    resolveAgentExecutor(undefined, { VERBOO_AGENT_EXECUTOR: 'opencode' }),
    'opencode',
  );
  assert.equal(
    resolveAgentExecutor('native', { VERBOO_AGENT_EXECUTOR: 'opencode' }),
    'native',
  );
  assert.equal(
    resolveAgentExecutor('opencode', { VERBOO_AGENT_EXECUTOR: 'native' }),
    'opencode',
  );
  assert.throws(
    () => resolveAgentExecutor('inventado', {}),
    /executor deve ser/,
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

test('invocação nativa usa Verboo Code headless com ferramentas delimitadas', () => {
  const request = {
    prompt: '--file=/etc/passwd',
    cwd: '/repo',
    mode: 'write',
    model: 'glm-5.2',
  };
  const invocation = buildVerbooCodeInvocation(
    request,
    '/opt/node',
    '/opt/@verboo/code/dist/cli.mjs',
  );

  assert.equal(invocation.executor, 'native');
  assert.equal(invocation.command, '/opt/node');
  assert.equal(invocation.args[0], '/opt/@verboo/code/dist/cli.mjs');
  assert.ok(invocation.args.includes('stream-json'));
  assert.ok(invocation.args.includes('dontAsk'));
  assert.ok(invocation.args.includes('Read,Glob,Grep,Edit,Write'));
  assert.ok(!invocation.args.includes('--allowedTools'));
  assert.ok(!invocation.args.includes('Bash'));
  assert.equal(invocation.args.at(-2), '--');
  assert.equal(invocation.args.at(-1), request.prompt);

  const settings = JSON.parse(invocation.args[invocation.args.indexOf('--settings') + 1]);
  assert.equal(settings.disableAllHooks, true);
  assert.ok(settings.permissions.allow.includes('Read(/repo/**)'));
  assert.ok(settings.permissions.allow.includes('Edit(/repo/**)'));
  assert.ok(settings.permissions.allow.includes('Write(/repo/**)'));
  assert.ok(settings.permissions.deny.includes('Read(/repo/**/.env.*)'));
  assert.ok(settings.permissions.deny.includes('Bash'));
});

test('subprocesso desativa config de projeto e recebe apenas ambiente necessário', () => {
  const invocation = buildOpenCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4-flash',
  });
  const env = buildChildEnv(
    {
      HOME: '/home/test',
      PATH: '/bin',
      VERBOO_API_KEY: 'vbk_test',
      GITHUB_TOKEN: 'nao-deve-vazar',
      AWS_SECRET_ACCESS_KEY: 'nao-deve-vazar',
      OPENCODE_DISABLE_PROJECT_CONFIG: '0',
    },
    invocation,
  );

  assert.deepEqual(env, {
    HOME: '/home/test',
    PATH: '/bin',
    VERBOO_API_KEY: 'vbk_test',
    OPENCODE_CONFIG_CONTENT: invocation.inlineConfig,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  });
});

test('executor nativo herda OAuth pelo HOME sem receber API key', () => {
  const invocation = buildVerbooCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4-flash',
  });
  const env = buildChildEnv(
    {
      HOME: '/home/test',
      PATH: '/bin',
      VERBOO_API_KEY: 'nao-deve-vazar',
      GITHUB_TOKEN: 'nao-deve-vazar',
    },
    invocation,
  );

  assert.deepEqual(env, {
    HOME: '/home/test',
    PATH: '/bin',
    VERBOO_DISABLE_EARLY_INPUT: '1',
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

test('parser nativo confirma somente ferramentas concluídas e artefatos internos', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native_123' }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'native_123',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool_ok',
            name: 'Edit',
            input: { file_path: '/repo/src/app.js' },
          },
          {
            type: 'tool_use',
            id: 'tool_failed',
            name: 'Read',
            input: { file_path: '/etc/passwd' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      session_id: 'native_123',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool_ok', content: 'ok' },
          {
            type: 'tool_result',
            tool_use_id: 'tool_failed',
            content: 'denied',
            is_error: true,
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'result',
      session_id: 'native_123',
      result: '<think>oculto</think>\nConcluído nativamente.',
    }),
  ].join('\n');

  assert.deepEqual(parseVerbooCodeEvents(raw, cwd), {
    sessionId: 'native_123',
    result: 'Concluído nativamente.',
    artifacts: ['/repo/src/app.js'],
    toolsUsed: ['Edit', 'Read'],
    successfulTools: ['Edit'],
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
    {
      prompt: 'crie um arquivo',
      cwd: base,
      executor: 'opencode',
      mode: 'write',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        ...process.env,
        VERBOO_AGENT_ALLOWED_ROOTS: base,
        VERBOO_AGENT_WRITE_ENABLED: '1',
        VERBOO_AGENT_EXECUTOR: 'native',
        VERBOO_API_KEY: 'test-key',
        VERBOO_OPENCODE_BIN: fakeOpenCode,
      },
    },
  );

  assert.equal(result.status, 'warning');
  assert.equal(result.executor, 'opencode');
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

test('executor opencode exige API key por chamada, mas native não', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'verboo-opencode-key-'));

  await assert.rejects(
    () => runVerbooAgent(
      {
        prompt: 'audite',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { VERBOO_AGENT_ALLOWED_ROOTS: base },
      },
    ),
    (error) => error.code === 'VERBOO_API_KEY_REQUIRED',
  );
});

test('runVerbooAgent seleciona executor nativo e retorna contrato E2E', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'verboo-native-'));
  const fakeVerboo = path.join(base, 'verboo-code');
  await writeFile(
    fakeVerboo,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'native_run'
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'assistant',
  session_id: 'native_run',
  message: {
    content: [{
      type: 'tool_use',
      id: 'edit_1',
      name: 'Edit',
      input: { file_path: 'status.txt' }
    }]
  }
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'user',
  session_id: 'native_run',
  message: {
    content: [{
      type: 'tool_result',
      tool_use_id: 'edit_1',
      content: 'ok'
    }]
  }
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  session_id: 'native_run',
  result: 'Alteração concluída.'
}) + '\\n');
`,
  );
  await chmod(fakeVerboo, 0o755);

  const result = await runVerbooAgent(
    {
      prompt: 'edite status.txt',
      cwd: base,
      executor: 'native',
      mode: 'write',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        ...process.env,
        VERBOO_AGENT_ALLOWED_ROOTS: base,
        VERBOO_AGENT_WRITE_ENABLED: '1',
        VERBOO_AGENT_EXECUTOR: 'opencode',
        VERBOO_CODE_BIN: fakeVerboo,
      },
    },
  );

  assert.equal(result.status, 'success');
  assert.equal(result.executor, 'native');
  assert.equal(result.session_id, 'native_run');
  assert.deepEqual(result.tools_used, ['Edit']);
  assert.deepEqual(result.artifacts, [path.join(await realpath(base), 'status.txt')]);
});

test('executor nativo traduz ausência de OAuth em recuperação acionável', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'verboo-native-auth-'));
  const fakeVerboo = path.join(base, 'verboo-code');
  await writeFile(
    fakeVerboo,
    `#!/usr/bin/env node
process.stderr.write('Não autenticado no Verboo. Execute verboo auth login.\\n');
process.exit(1);
`,
  );
  await chmod(fakeVerboo, 0o755);

  await assert.rejects(
    () => runVerbooAgent(
      {
        prompt: 'audite',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          ...process.env,
          VERBOO_AGENT_ALLOWED_ROOTS: base,
          VERBOO_CODE_BIN: fakeVerboo,
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'VERBOO_AUTH_REQUIRED');
      assert.deepEqual(formatAgentFailure(error).next_actions, [
        'Execute a CLI oficial com `verboo auth login` ou `verboo auth login --headless`.',
        'Depois reinicie o cliente MCP para que o executor herde a sessão OAuth.',
      ]);
      return true;
    },
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
      VERBOO_API_KEY: 'test-key',
    },
    spawnImpl,
  };

  const first = runVerbooAgent(
    {
      prompt: 'primeira',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      timeout_seconds: 10,
    },
    options,
  );
  await started;
  await assert.rejects(
    () => runVerbooAgent(
      {
        prompt: 'segunda',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      options,
    ),
    (error) => error.code === 'AGENT_BUSY',
  );

  release();
  assert.equal((await first).status, 'success');

  const afterRelease = runVerbooAgent(
    {
      prompt: 'terceira',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      timeout_seconds: 10,
    },
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
      {
        prompt: 'audite',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          VERBOO_AGENT_ALLOWED_ROOTS: base,
          VERBOO_API_KEY: 'test-key',
        },
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
      {
        prompt: 'audite',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          VERBOO_AGENT_ALLOWED_ROOTS: base,
          VERBOO_API_KEY: 'test-key',
        },
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
