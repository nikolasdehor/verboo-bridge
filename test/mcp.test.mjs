import assert from 'node:assert/strict';
import { realpathSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP expõe verboo_agent e falha fechado fora da allowlist', async (t) => {
  const repo = path.resolve('.');
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), 'verboo-mcp-memory-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      VERBOO_API_KEY: 'test-key',
      VERBOO_AGENT_ALLOWED_ROOTS: repo,
      VERBOO_MODEL_ALLOWLIST: 'deepseek-v4-flash,glm-5.2',
      VERBOO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4-flash',
      VERBOO_MODEL_DENYLIST: '',
      VERBOO_MODEL_TIERS: 'pro',
      VERBOO_MEMORY_ENABLED: '1',
      VERBOO_MEMORY_DIR: memoryDir,
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'verboo-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => { try { await client.close(); } catch {} });
  await client.connect(transport);

  assert.match(client.getInstructions() ?? '', /subagente externo/);
  assert.match(client.getInstructions() ?? '', /verboo_agent_start por padrão em App\/IDE/);
  assert.match(client.getInstructions() ?? '', /mostre o job_id/);
  assert.match(client.getInstructions() ?? '', /continue trabalhando e consulte verboo_job/);
  assert.match(client.getInstructions() ?? '', /Reserve verboo_agent síncrono para tarefa curta/);
  assert.match(client.getInstructions() ?? '', /nunca execute a CLI no shell/);
  assert.match(client.getInstructions() ?? '', /reporte erro de configuração/);

  const listed = await client.listTools();
  const routeTool = listed.tools.find((tool) => tool.name === 'verboo_route');
  const agentTool = listed.tools.find((tool) => tool.name === 'verboo_agent');
  const agentStartTool = listed.tools.find((tool) => tool.name === 'verboo_agent_start');
  const jobTool = listed.tools.find((tool) => tool.name === 'verboo_job');
  const memoryTool = listed.tools.find((tool) => tool.name === 'verboo_memory');
  assert.ok(routeTool);
  assert.ok(agentTool);
  assert.ok(agentStartTool);
  assert.ok(jobTool);
  assert.ok(memoryTool);
  assert.match(agentTool.description, /forma síncrona e bloqueia até concluir/);
  assert.match(agentTool.description, /use apenas para tarefa curta/);
  assert.match(agentStartTool.description, /padrão para App\/IDE/);
  assert.match(agentStartTool.description, /Mostre o job_id/);
  assert.match(jobTool.description, /Nunca reenvie a tarefa/);
  assert.deepEqual(routeTool.inputSchema.properties.executor.enum, [
    'opencode',
    'native',
  ]);
  assert.equal(routeTool.inputSchema.properties.executor.default, 'native');
  assert.deepEqual(agentTool.inputSchema.properties.executor.enum, [
    'opencode',
    'native',
  ]);
  assert.equal(agentTool.inputSchema.properties.executor.default, 'native');
  assert.equal(agentTool.inputSchema.properties.model.default, 'auto');
  assert.deepEqual(agentTool.inputSchema.properties.model.enum, [
    'auto',
    'deepseek-v4-flash',
  ]);
  assert.deepEqual(memoryTool.inputSchema.properties.action.enum, [
    'status',
    'read',
    'remember',
  ]);

  const remembered = await client.callTool({
    name: 'verboo_memory',
    arguments: {
      action: 'remember',
      cwd: repo,
      note: 'O bridge usa memória isolada por projeto.',
    },
  });
  assert.notEqual(remembered.isError, true);
  assert.equal(JSON.parse(remembered.content[0].text).persisted, true);

  const recalled = await client.callTool({
    name: 'verboo_memory',
    arguments: { action: 'read', cwd: repo },
  });
  const recalledPayload = JSON.parse(recalled.content[0].text);
  assert.equal(recalledPayload.enabled, true);
  assert.equal(recalledPayload.entries.length, 1);
  assert.equal(
    recalledPayload.entries[0].note,
    'O bridge usa memória isolada por projeto.',
  );

  const routed = await client.callTool({
    name: 'verboo_route',
    arguments: {
      prompt: 'Faça uma auditoria de segurança complexa da arquitetura.',
      mode: 'read_only',
    },
  });
  assert.notEqual(routed.isError, true);
  const routePayload = JSON.parse(routed.content[0].text);
  assert.equal(routePayload.executor, 'native');
  assert.equal(routePayload.selected_model, 'deepseek-v4-flash');
  assert.deepEqual(
    routePayload.ranking.map((candidate) => candidate.model),
    ['deepseek-v4-flash'],
  );

  const oversizedRoute = await client.callTool({
    name: 'verboo_route',
    arguments: { prompt: 'x'.repeat(100_001) },
  });
  assert.equal(oversizedRoute.isError, true);
  assert.match(oversizedRoute.content[0].text, /limite de 100000 caracteres/);

  const result = await client.callTool({
    name: 'verboo_agent',
    arguments: { prompt: 'audite', cwd: '/etc', mode: 'read_only' },
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, 'error');
  assert.match(payload.summary, /fora das raízes autorizadas/);
});

test('MCP aplica denylist em tools, schemas, recursos e chamadas antigas', async (t) => {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      VERBOO_API_KEY: 'test-key',
      VERBOO_AGENT_ALLOWED_ROOTS: repo,
      VERBOO_MODEL_DENYLIST: 'qwen3.6-27b,glm-4.7-flash,glm-5.2',
      VERBOO_MEMORY_ENABLED: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'verboo-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);
  assert.ok(!toolNames.includes('verboo_qwen3_6_27b'));
  assert.ok(!toolNames.includes('verboo_glm_4_7_flash'));
  for (const name of ['verboo_code', 'verboo_review']) {
    const modelEnum = listed.tools.find((tool) => tool.name === name)
      .inputSchema.properties.model.enum;
    assert.ok(!modelEnum.includes('qwen3.6-27b'));
    assert.ok(!modelEnum.includes('glm-4.7-flash'));
    assert.ok(!modelEnum.includes('glm-5.2'));
  }
  for (const name of ['verboo_route', 'verboo_agent', 'verboo_agent_start']) {
    const schema = listed.tools.find((tool) => tool.name === name).inputSchema;
    const modelEnum = schema.properties.model?.enum
      ?? schema.properties.exclude_models.items.enum;
    assert.ok(!modelEnum.includes('qwen3.6-27b'));
    assert.ok(!modelEnum.includes('glm-4.7-flash'));
    assert.ok(!modelEnum.includes('glm-5.2'));
  }

  const modelsResource = await client.readResource({ uri: 'verboo://models' });
  const modelIds = JSON.parse(modelsResource.contents[0].text)
    .map((model) => model.id);
  assert.ok(!modelIds.includes('qwen3.6-27b'));
  assert.ok(!modelIds.includes('glm-4.7-flash'));
  assert.ok(!modelIds.includes('glm-5.2'));

  const staleDirectCall = await client.callTool({
    name: 'verboo_qwen3_6_27b',
    arguments: { prompt: 'não deve executar' },
  });
  assert.equal(staleDirectCall.isError, true);
  assert.match(staleDirectCall.content[0].text, /DENYLIST/);

  const staleGlm52Call = await client.callTool({
    name: 'verboo_glm_5_2',
    arguments: { prompt: 'não deve executar' },
  });
  assert.equal(staleGlm52Call.isError, true);
  assert.match(staleGlm52Call.content[0].text, /DENYLIST/);

  const deniedAsyncCall = await client.callTool({
    name: 'verboo_agent_start',
    arguments: {
      prompt: 'não deve enfileirar',
      cwd: repo,
      model: 'glm-4.7-flash',
    },
  });
  assert.equal(deniedAsyncCall.isError, true);
  assert.match(deniedAsyncCall.content[0].text, /DENYLIST/);
  assert.equal(JSON.parse(deniedAsyncCall.content[0].text).job_id, undefined);

  const deniedGlm52Call = await client.callTool({
    name: 'verboo_agent_start',
    arguments: {
      prompt: 'não deve enfileirar',
      cwd: repo,
      model: 'glm-5.2',
    },
  });
  assert.equal(deniedGlm52Call.isError, true);
  assert.match(deniedGlm52Call.content[0].text, /DENYLIST/);
  assert.equal(JSON.parse(deniedGlm52Call.content[0].text).job_id, undefined);
});

test('MCP verboo_agent_start enfileira e verboo_job cancela execução em andamento', async (t) => {
  const repo = path.resolve('.');
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'verboo-mcp-agent-'));
  const fakeAgent = path.join(fixture, 'fake-agent.mjs');
  await writeFile(
    fakeAgent,
    [
      "process.on('SIGTERM', () => process.exit(0));",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      VERBOO_API_KEY: 'test-key',
      VERBOO_AGENT_ALLOWED_ROOTS: repo,
      VERBOO_MODEL_ALLOWLIST: 'deepseek-v4-flash',
      VERBOO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4-flash',
      VERBOO_MODEL_TIERS: 'pro',
      VERBOO_MEMORY_ENABLED: '0',
      VERBOO_CODE_BIN: process.execPath,
      VERBOO_CODE_ENTRYPOINT: fakeAgent,
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'verboo-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);

  // verboo_agent_start
  const enqueued = await client.callTool({
    name: 'verboo_agent_start',
    arguments: { prompt: 'lista arquivos', cwd: repo, mode: 'read_only', timeout_seconds: 30 },
  });
  const enqueuedPayload = JSON.parse(enqueued.content[0].text);
  assert.ok(enqueuedPayload.job_id);
  assert.equal(enqueuedPayload.error, undefined);

  let runningPayload;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const runningResult = await client.callTool({
      name: 'verboo_job',
      arguments: { action: 'status', job_id: enqueuedPayload.job_id },
    });
    runningPayload = JSON.parse(runningResult.content[0].text);
    if (runningPayload.status === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(runningPayload.status, 'running');

  // verboo_job action=cancel — cancela deterministicamente o agente fake.
  const cancelResult = await client.callTool({
    name: 'verboo_job',
    arguments: { action: 'cancel', job_id: enqueuedPayload.job_id },
  });
  const cancelPayload = JSON.parse(cancelResult.content[0].text);
  assert.equal(cancelPayload.status, 'cancelled');

  // verboo_job action=status
  const statusResult = await client.callTool({
    name: 'verboo_job',
    arguments: { action: 'status', job_id: enqueuedPayload.job_id },
  });
  const statusPayload = JSON.parse(statusResult.content[0].text);
  assert.equal(statusPayload.status, 'cancelled');
  assert.ok(statusPayload.finished_at, 'cancelled deve ter finished_at');

  // verboo_job action=list
  const listResult = await client.callTool({
    name: 'verboo_job',
    arguments: { action: 'list' },
  });
  const listPayload = JSON.parse(listResult.content[0].text);
  assert.ok(Array.isArray(listPayload.jobs));

  // verboo_job action=result com job inexistente
  const missingResult = await client.callTool({
    name: 'verboo_job',
    arguments: { action: 'result', job_id: '00000000-0000-0000-0000-000000000000' },
  });
  const missingPayload = JSON.parse(missingResult.content[0].text);
  assert.equal(missingPayload.error, 'NOT_FOUND');
  assert.equal(missingResult.isError, true);
});

test('MCP verboo://status resource contem capacity/queued/running/total', async (t) => {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      VERBOO_API_KEY: 'test-key',
      VERBOO_AGENT_ALLOWED_ROOTS: repo,
      VERBOO_MODEL_ALLOWLIST: 'deepseek-v4-flash',
      VERBOO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4-flash',
      VERBOO_MODEL_TIERS: 'pro',
      VERBOO_MEMORY_ENABLED: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'verboo-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);

  const resources = await client.listResources();
  const statusResource = resources.resources.find((r) => r.uri === 'verboo://status');
  assert.ok(statusResource);

  const statusRead = await client.readResource({ uri: 'verboo://status' });
  const statusPayload = JSON.parse(statusRead.contents[0].text);
  assert.ok(statusPayload.version);
  assert.ok(statusPayload.job_queue);
  assert.equal(typeof statusPayload.job_queue.concurrency, 'number');
  assert.equal(typeof statusPayload.job_queue.queued, 'number');
  assert.equal(typeof statusPayload.job_queue.running, 'number');
  assert.equal(typeof statusPayload.job_queue.total, 'number');
});


function makeValidateClientEnv(extra) {
  return {
    ...process.env,
    VERBOO_API_KEY: 'test-key',
    VERBOO_MEMORY_ENABLED: '0',
    ...extra,
  };
}

async function connectValidateClient(t, env) {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'verboo-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);
  return client;
}

async function callValidate(client, cwd, commands, extra = {}) {
  const result = await client.callTool({
    name: 'verboo_validate',
    arguments: { cwd, commands, ...extra },
  });
  return { result, payload: JSON.parse(result.content[0].text) };
}

// Fake npm controlado: NUNCA roda o npm real nem scripts do repositório.
// Imprime o próprio caminho, o node real, HOME e a presença da API key,
// provando executáveis fixados, isolamento de env e precedência de PATH.
const FAKE_NPM_SCRIPT = [
  '#!/usr/bin/env node',
  "console.log(`FAKE_NPM_PATH:${process.argv[1]}`);",
  "console.log(`FAKE_NODE_PATH:${process.execPath}`);",
  "console.log(`FAKE_NPM_HOME:${process.env.HOME}`);",
  "console.log(`FAKE_NPM_KEY:${process.env.VERBOO_API_KEY ?? 'empty'}`);",
  "const args = process.argv.slice(2).join(' ');",
  "if (args === 'run fail') process.exit(3);",
  "if (args === 'run big') process.stdout.write('x'.repeat(70000));",
  "if (args === 'run slow') setTimeout(() => {}, 30000);",
  "if (args === 'run stubborn') { process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000); }",
  "if (args === 'run leak') console.log('Bearer abcdef123456');",
  '',
].join('\n');

async function makeValidateFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'verboo-validate-'));
  const binDir = path.join(fixture, 'bin');
  const hijackDir = path.join(fixture, 'bin-hijack');
  const projectDir = path.join(fixture, 'proj');
  await mkdir(binDir, { recursive: true });
  await mkdir(hijackDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  symlinkSync(process.execPath, path.join(binDir, 'node'));
  await writeFile(path.join(binDir, 'npm'), FAKE_NPM_SCRIPT, { mode: 0o755 });
  await writeFile(
    path.join(hijackDir, 'npm'),
    '#!/bin/sh\necho "HIJACKED_NPM:$0"\nexit 0\n',
    { mode: 0o755 },
  );
  await writeFile(path.join(projectDir, 'ok.js'), 'module.exports = 1;\n');
  return { fixture, binDir, hijackDir, projectDir };
}

function validateEnv(binDir, projectDir, extra = {}) {
  return makeValidateClientEnv({
    VERBOO_AGENT_ALLOWED_ROOTS: projectDir,
    VERBOO_AGENT_VERIFY_ENABLED: '1',
    VERBOO_AGENT_VERIFY_NPM_SCRIPTS: 'ok,fail,big,slow,stubborn,leak',
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ...extra,
  });
}

test('MCP verboo_validate falha fechado sem opt-in e anota ação não read-only', async (t) => {
  const repo = path.resolve('.');
  const client = await connectValidateClient(t, makeValidateClientEnv({
    VERBOO_AGENT_ALLOWED_ROOTS: repo,
    VERBOO_AGENT_VERIFY_ENABLED: '0',
  }));

  const listed = await client.listTools();
  const validateTool = listed.tools.find((tool) => tool.name === 'verboo_validate');
  assert.ok(validateTool);
  assert.match(validateTool.description, /VERBOO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1/);
  assert.match(validateTool.description, /Não é read-only/);
  assert.match(validateTool.description, /shell:false/);
  assert.match(validateTool.description, /Sem isolamento de filesystem ou rede/);
  assert.match(validateTool.description, /mesmo usuário do bridge/);
  assert.match(validateTool.description, /Nunca oferece comandos de commit, push, publish ou deploy/);
  assert.deepEqual(
    validateTool.inputSchema.properties.commands.items.properties.cmd.enum,
    ['npm', 'node', 'git'],
  );
  assert.equal(validateTool.inputSchema.properties.stop_on_failure.default, true);
  assert.equal(validateTool.annotations?.readOnlyHint, false);
  assert.equal(validateTool.annotations?.openWorldHint, true);

  const { result, payload } = await callValidate(client, repo, [
    { cmd: 'node', args: ['--check', 'index.mjs'] },
  ]);
  assert.equal(result.isError, true);
  assert.equal(payload.status, 'error');
  assert.match(payload.error, /VERBOO_AGENT_VERIFY_ENABLED=1/);
});

test('MCP verboo_validate separa perfil estático de project-code com segundo gate', async (t) => {
  const { binDir, projectDir } = await makeValidateFixture();
  const client = await connectValidateClient(
    t,
    validateEnv(binDir, projectDir, { VERBOO_AGENT_VERIFY_PROJECT_CODE_ENABLED: '0' }),
  );

  const projectCode = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['test'] },
  ]);
  assert.equal(projectCode.result.isError, true);
  assert.equal(projectCode.payload.status, 'error');
  assert.match(projectCode.payload.error, /VERBOO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1/);
  assert.deepEqual(projectCode.payload.executed, []);

  const staticProfile = await callValidate(client, projectDir, [
    { cmd: 'node', args: ['--check', 'ok.js'] },
  ]);
  assert.equal(staticProfile.payload.status, 'ok');
  assert.equal(staticProfile.payload.results[0].exit_code, 0);
});

test('MCP verboo_validate executa binário resolvido e rejeita política adversarial', async (t) => {
  const { binDir, hijackDir, projectDir } = await makeValidateFixture();
  const client = await connectValidateClient(
    t,
    validateEnv(binDir, projectDir, { VERBOO_AGENT_VERIFY_PROJECT_CODE_ENABLED: '1' }),
  );
  const expectedNpm = realpathSync(path.join(binDir, 'npm'));
  const expectedNode = realpathSync(path.join(binDir, 'node'));

  const happy = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['test'] },
    { cmd: 'npm', args: ['run', 'ok'] },
    { cmd: 'node', args: ['--check', 'ok.js'] },
  ]);
  assert.equal(happy.payload.status, 'ok');
  assert.deepEqual(happy.payload.results.map((item) => item.exit_code), [0, 0, 0]);

  const stdout = happy.payload.results[0].stdout;
  assert.ok(
    stdout.includes(`FAKE_NPM_PATH:${expectedNpm}`),
    `binário executado deve ser o resolvido (${expectedNpm}), stdout: ${stdout}`,
  );
  assert.ok(
    stdout.includes(`FAKE_NODE_PATH:${expectedNode}`),
    `npm deve executar com o node absoluto resolvido (${expectedNode})`,
  );
  assert.ok(!stdout.includes('HIJACKED_NPM'), 'PATH hijack não pode vencer a resolução');
  assert.ok(stdout.includes('FAKE_NPM_KEY:empty'), 'env do filho não pode conter VERBOO_API_KEY');
  assert.ok(stdout.includes('verboo-verify-home-'), 'HOME do filho deve ser isolado');
  assert.ok(!stdout.includes(`FAKE_NPM_HOME:${os.homedir()}`), 'HOME real do host vazou');

  assert.ok(hijackDir.includes('bin-hijack'), 'fixture de hijack presente para o cenário acima');

  symlinkSync('/etc/passwd', path.join(projectDir, 'link-escape.js'));
  const denials = [
    { cmd: 'bash', args: ['-c', 'id'] },
    { cmd: 'sh', args: ['-c', 'id'] },
    { cmd: 'npx', args: ['--no-install', 'jest'] },
    { cmd: 'npm', args: ['run', 'evil'] },
    { cmd: 'npm', args: ['test', '--', '--watch'] },
    { cmd: 'npm', args: ['install', 'left-pad'] },
    { cmd: 'node', args: ['-e', 'process.exit(0)'] },
    { cmd: 'node', args: ['--check', '../outside.js'] },
    { cmd: 'node', args: ['--check', '/etc/passwd'] },
    { cmd: 'node', args: ['--check', 'link-escape.js'] },
    { cmd: 'git', args: ['push'] },
    { cmd: 'git', args: ['config', 'user.email', 'x@y.z'] },
    { cmd: 'git', args: ['status', '--porcelain=v1', ';', 'rm', '-rf', '/'] },
  ];
  for (const bad of denials) {
    const { result, payload } = await callValidate(client, projectDir, [bad]);
    assert.equal(result.isError, true, `deveria negar: ${bad.cmd} ${bad.args.join(' ')}`);
    assert.equal(payload.status, 'error');
    assert.deepEqual(payload.executed, []);
    assert.ok(!String(payload.error).includes(projectDir), 'erro não expõe path interno');
  }
});

test('MCP verboo_validate stop_on_failure, timeout total, truncamento e redaction', async (t) => {
  const { binDir, projectDir } = await makeValidateFixture();
  const client = await connectValidateClient(
    t,
    validateEnv(binDir, projectDir, { VERBOO_AGENT_VERIFY_PROJECT_CODE_ENABLED: '1' }),
  );

  const stopped = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['run', 'fail'] },
    { cmd: 'npm', args: ['run', 'ok'] },
  ]);
  assert.equal(stopped.payload.status, 'failed');
  assert.equal(stopped.payload.stopped_early, true);
  assert.equal(stopped.payload.results.length, 1);
  assert.equal(stopped.payload.results[0].exit_code, 3);

  const continued = await callValidate(
    client,
    projectDir,
    [
      { cmd: 'npm', args: ['run', 'fail'] },
      { cmd: 'npm', args: ['run', 'ok'] },
    ],
    { stop_on_failure: false },
  );
  assert.equal(continued.payload.status, 'failed');
  assert.equal(continued.payload.stopped_early, false);
  assert.equal(continued.payload.results.length, 2);
  assert.equal(continued.payload.results[1].exit_code, 0);

  const timed = await callValidate(
    client,
    projectDir,
    [{ cmd: 'npm', args: ['run', 'slow'] }],
    { timeout_seconds: 1 },
  );
  assert.equal(timed.payload.status, 'failed');
  assert.equal(timed.payload.results[0].timed_out, true);
  assert.ok(
    timed.payload.results[0].duration_ms < 20000,
    `processo deveria ser cancelado cedo: ${timed.payload.results[0].duration_ms}ms`,
  );

  // Timeout TOTAL: comando que ignora SIGTERM estoura o orçamento da sequência
  // (deadline = 1s por comando × 2), e o segundo comando nem inicia.
  const total = await callValidate(
    client,
    projectDir,
    [
      { cmd: 'npm', args: ['run', 'stubborn'] },
      { cmd: 'npm', args: ['run', 'ok'] },
    ],
    { timeout_seconds: 1, stop_on_failure: false },
  );
  assert.equal(total.payload.status, 'failed');
  assert.equal(total.payload.stop_reason, 'total_timeout');
  assert.equal(total.payload.results.length, 1);
  assert.equal(total.payload.results[0].timed_out, true);

  const big = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['run', 'big'] },
  ]);
  assert.equal(big.payload.results[0].stdout_truncated, true);
  assert.ok(big.payload.results[0].stdout.length <= 8192);

  const leak = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['run', 'leak'] },
  ]);
  assert.equal(leak.payload.status, 'ok');
  assert.ok(!leak.payload.results[0].stdout.includes('abcdef123456'));
  assert.match(leak.payload.results[0].stdout, /Bearer <redacted>/);
});
