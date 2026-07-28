import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
  assert.ok(agentTool.inputSchema.properties.model.enum.includes('auto'));
  assert.ok(agentTool.inputSchema.properties.model.enum.includes('deepseek-v4-pro'));
  assert.ok(agentTool.inputSchema.properties.model.enum.includes('mimo-v2.5-pro'));
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
