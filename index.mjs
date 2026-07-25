#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const MODELS = {
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', context: 1_048_576, output: 65_536 },
  'glm-4.7-flash':     { name: 'GLM 4.7 Flash',     context: 200_704,  output: 65_536 },
  'glm-5.2':           { name: 'GLM 5.2',            context: 524_288,  output: 65_536 },
  'kimi-k2.7':         { name: 'Kimi K2.7',          context: 262_144,  output: 65_536 },
  'mimo-v2.5':         { name: 'Mimo V2.5',          context: 1_048_576, output: 65_536 },
  'minimax-m3':        { name: 'Minimax M3',         context: 1_048_576, output: 65_536 },
  'qwen3.6-27b':       { name: 'Qwen 3.6 27B',       context: 262_144,  output: 65_536 },
};

const API_KEY = process.env.VERBOO_API_KEY;
const BASE_URL = 'https://code.verboo.ai/router/v1';

if (!API_KEY) {
  console.error('VERBOO_API_KEY not set');
  process.exit(1);
}

async function callVerboo(model, messages, opts = {}) {
  const info = MODELS[model];
  if (!info) throw new Error(`Unknown model: ${model}. Available: ${Object.keys(MODELS).join(', ')}`);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens ?? info.output,
    }),
  });

  if (!res.ok) throw new Error(`Verboo API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    model: data.model ?? model,
    usage: data.usage ?? {},
  };
}

const server = new Server(
  { name: 'verboo-bridge', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = Object.entries(MODELS).map(([id, info]) => ({
    name: `verboo_${id.replace(/[.-]/g, '_')}`,
    description: `Complete using ${info.name} (${(info.context / 1024).toFixed(0)}K ctx)`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt:      { type: 'string' },
        system:      { type: 'string' },
        temperature: { type: 'number', default: 0.3 },
        max_tokens:  { type: 'number', default: info.output },
      },
      required: ['prompt'],
    },
  }));

  tools.push({
    name: 'verboo_code',
    description: 'Execute a coding task using DeepSeek V4 Flash (1M ctx, best CxB)',
    inputSchema: {
      type: 'object',
      properties: {
        prompt:      { type: 'string' },
        system:      { type: 'string' },
        model:       { type: 'string', default: 'deepseek-v4-flash' },
        temperature: { type: 'number', default: 0.3 },
        max_tokens:  { type: 'number', default: 65536 },
      },
      required: ['prompt'],
    },
  });

  tools.push({
    name: 'verboo_review',
    description: 'Review code using DeepSeek V4 Flash',
    inputSchema: {
      type: 'object',
      properties: {
        code:        { type: 'string' },
        context:     { type: 'string' },
        model:       { type: 'string', default: 'deepseek-v4-flash' },
        temperature: { type: 'number', default: 0.2 },
      },
      required: ['code'],
    },
  });

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const match = name.match(/^verboo_(.+)$/);
  if (!match) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };

  try {
    let model, messages;

    if (name === 'verboo_code') {
      model = args.model ?? 'deepseek-v4-flash';
      messages = [];
      if (args.system) messages.push({ role: 'system', content: args.system });
      messages.push({ role: 'user', content: args.prompt });
    } else if (name === 'verboo_review') {
      model = args.model ?? 'deepseek-v4-flash';
      messages = [
        { role: 'system', content: 'You are an expert code reviewer. Find bugs, security issues, and performance problems.' },
        { role: 'user', content: `Review:\n\`\`\`\n${args.code}\n\`\`\`\n${args.context ? `\nContext: ${args.context}` : ''}` },
      ];
    } else {
      model = Object.keys(MODELS).find(m => m.replace(/[.-]/g, '_') === match[1]);
      if (!model) throw new Error(`Unknown model in: ${name}`);
      messages = [];
      if (args.system) messages.push({ role: 'system', content: args.system });
      messages.push({ role: 'user', content: args.prompt });
    }

    const result = await callVerboo(model, messages, {
      temperature: args.temperature,
      max_tokens: args.max_tokens,
    });

    const label = MODELS[model]?.name ?? model;
    const meta = `*Model: ${result.model} | Tokens: ${result.usage?.total_tokens ?? '?'}*`;
    return { content: [{ type: 'text', text: `## ${label}\n\n${result.content}\n\n---\n${meta}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error('verboo-bridge ready');
}

main().catch((e) => { console.error(e); process.exit(1); });
