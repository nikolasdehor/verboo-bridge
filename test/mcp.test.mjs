import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP expõe verboo_agent e falha fechado fora da allowlist', async (t) => {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      VERBOO_API_KEY: 'test-key',
      VERBOO_AGENT_ALLOWED_ROOTS: repo,
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
  const agentTool = listed.tools.find((tool) => tool.name === 'verboo_agent');
  assert.ok(agentTool);
  assert.deepEqual(agentTool.inputSchema.properties.executor.enum, [
    'opencode',
    'native',
  ]);
  assert.equal(agentTool.inputSchema.properties.executor.default, 'native');

  const result = await client.callTool({
    name: 'verboo_agent',
    arguments: { prompt: 'audite', cwd: '/etc', mode: 'read_only' },
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, 'error');
  assert.match(payload.summary, /fora das raízes autorizadas/);
});
