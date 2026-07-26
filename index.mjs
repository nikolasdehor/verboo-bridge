#!/usr/bin/env node

import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AGENT_EXECUTORS,
  configuredModelPolicy,
  formatAgentFailure,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  resolveAgentExecutor,
  runVerbooAgent,
} from './agent-runner.mjs';
import {
  MODEL_CATALOG,
  selectModelForTask,
} from './model-router.mjs';
const require = createRequire(import.meta.url);
const { version: VERSION } = require('./package.json');
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ── Models ──────────────────────────────────────────────────────────────

const MODELS = MODEL_CATALOG;

// ── Config ──────────────────────────────────────────────────────────────

const API_KEY = process.env.VERBOO_API_KEY;
const BASE_URL = process.env.VERBOO_BASE_URL || 'https://code.verboo.ai/router/v1';
const LOG_LEVEL = (process.env.VERBOO_LOG_LEVEL || 'info').toLowerCase();
const DEFAULT_AGENT_EXECUTOR = resolveAgentExecutor(undefined, process.env);

if (!API_KEY) {
  console.error(
    'AVISO: VERBOO_API_KEY nao definida; tools de prompt direto e executor OpenCode podem ficar indisponiveis.',
  );
}

function log(level, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] >= (levels[LOG_LEVEL] ?? 1)) {
    console.error(`[verboo] ${level}:`, ...args);
  }
}

function pickContent(choice) {
  const m = choice?.message;
  const d = choice?.delta;
  return m?.content || m?.reasoning_content || d?.content || d?.reasoning_content || '';
}

function parseSSE(raw) {
  let full = ''; let usage = {};
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const parsed = JSON.parse(line.slice(6));
    full += pickContent(parsed.choices?.[0]);
    if (parsed.usage) usage = parsed.usage;
  }
  return { full, usage };
}

// ── API Client ──────────────────────────────────────────────────────────

async function callVerboo(model, messages, opts = {}) {
  if (!API_KEY) {
    throw new Error(
      'VERBOO_API_KEY não definida; use verboo_agent com executor nativo ou configure a chave.',
    );
  }
  const info = MODELS[model];
  if (!info) {
    const available = Object.keys(MODELS).join(', ');
    throw new Error(`Modelo desconhecido: "${model}". Disponiveis: ${available}`);
  }

  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? info.out,
  };

  log('debug', `POST ${BASE_URL}/chat/completions model=${model} tokens=${body.max_tokens}`);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail;
    try { detail = await res.text(); } catch { detail = res.statusText; }
    throw new Error(`API ${res.status}: ${detail}`);
  }

  const raw = await res.text();

  // SSE streaming format — router pode retornar data: lines mesmo com stream:false
  if (raw.startsWith('data:') || raw.includes('\ndata:')) {
    const { full, usage } = parseSSE(raw);
    if (!full) throw new Error('Resposta vazia da API');
    return { content: full, model, usage };
  }

  // JSON format
  const data = JSON.parse(raw);
  const content = pickContent(data.choices?.[0]);
  if (!content) throw new Error('Resposta vazia da API');
  return { content, model: data.model || model, usage: data.usage || {} };
}

// ── MCP Server ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'verboo-bridge', version: VERSION },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  },
);

// ── Tools ───────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const codec = { type: 'object', properties: { prompt: { type: 'string' }, system: { type: 'string' }, temperature: { type: 'number', default: 0.3 }, max_tokens: { type: 'number', default: 65536 } }, required: ['prompt'] };

  const tools = [
    ...Object.entries(MODELS).map(([id, info]) => ({
      name: `verboo_${id.replace(/[.-]/g, '_')}`,
      description: `${info.name} — ${info.note}. ${(info.ctx / 1024).toFixed(0)}K ctx, ${info.out} max output. Plano: ${info.tier}.`,
      inputSchema: { ...codec, properties: { ...codec.properties, max_tokens: { type: 'number', description: `Max tokens (max ${info.out})`, default: Math.min(info.out, 8192) } } },
    })),
    {
      name: 'verboo_code',
      description: 'Executa tarefa de codificacao com DeepSeek V4 Flash (1M ctx, melhor CxB)',
      inputSchema: { ...codec, properties: { ...codec.properties, model: { type: 'string', default: 'deepseek-v4-flash' } } },
    },
    {
      name: 'verboo_review',
      description: 'Revisa codigo buscando bugs, vulnerabilidades e problemas de performance',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Codigo a ser revisado' },
          context: { type: 'string', description: 'Contexto adicional (ex: linguagem, framework)' },
          model: { type: 'string', default: 'deepseek-v4-flash' },
          temperature: { type: 'number', default: 0.2 },
        },
        required: ['code'],
      },
    },
    {
      name: 'verboo_route',
      description: 'Classifica uma tarefa e explica o ranking dos modelos Verboo sem executar nenhum agente.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Tarefa que será classificada',
          },
          mode: {
            type: 'string',
            enum: ['read_only', 'write'],
            default: 'read_only',
          },
          tiers: {
            type: 'array',
            items: { type: 'string', enum: ['pro', 'ultra'] },
            default: ['pro', 'ultra'],
          },
          exclude_models: {
            type: 'array',
            items: { type: 'string', enum: Object.keys(MODELS) },
            default: [],
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'verboo_agent',
      description: 'Executa um subagente Verboo repo-aware. model=auto classifica a tarefa, distribui concorrência e tenta fallback recuperável; um modelo explícito preserva seleção manual. Quem chama escolhe native para usar o harness Verboo Code/OAuth ou opencode como fallback. read_only apenas inspeciona; write exige VERBOO_AGENT_WRITE_ENABLED=1 e pode somente editar. O orquestrador executa testes e outros comandos.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Tarefa concreta e delimitada para o agente' },
          cwd: { type: 'string', description: 'Diretório do projeto, dentro de VERBOO_AGENT_ALLOWED_ROOTS' },
          executor: {
            type: 'string',
            enum: AGENT_EXECUTORS,
            default: DEFAULT_AGENT_EXECUTOR,
            description: 'native usa o harness Verboo Code com OAuth; opencode usa o provider Verboo dentro do OpenCode',
          },
          mode: {
            type: 'string',
            enum: ['read_only', 'write'],
            default: 'read_only',
            description: 'read_only para análise; write somente para edição autorizada, sem shell',
          },
          model: {
            type: 'string',
            enum: ['auto', ...Object.keys(MODELS)],
            default: 'auto',
          },
          timeout_seconds: {
            type: 'integer',
            minimum: MIN_TIMEOUT_SECONDS,
            maximum: MAX_TIMEOUT_SECONDS,
            default: 600,
          },
        },
        required: ['prompt', 'cwd'],
      },
    },
  ];

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const match = name.match(/^verboo_(.+)$/);

  if (!match) {
    return { content: [{ type: 'text', text: `Tool desconhecida: ${name}` }], isError: true };
  }

  try {
    let model, messages;

    if (name === 'verboo_route') {
      const policy = configuredModelPolicy(Object.keys(MODELS), process.env);
      const requestedTiers = args.tiers ?? policy.allowTiers;
      const route = selectModelForTask({
        prompt: args.prompt,
        mode: args.mode ?? 'read_only',
        availableModels: policy.availableModels,
        allowTiers: requestedTiers.filter(
          (tier) => policy.allowTiers.includes(tier),
        ),
        excludeModels: args.exclude_models ?? [],
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            selected_model: route.model,
            reason: route.reason,
            task_profile: route.profile,
            ranking: route.ranking,
          }, null, 2),
        }],
      };
    } else if (name === 'verboo_agent') {
      const result = await runVerbooAgent(args, {
        availableModels: Object.keys(MODELS),
        env: process.env,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } else if (name === 'verboo_code') {
      model = args.model ?? 'deepseek-v4-flash';
      messages = [];
      if (args.system) messages.push({ role: 'system', content: args.system });
      messages.push({ role: 'user', content: args.prompt });
    } else if (name === 'verboo_review') {
      model = args.model ?? 'deepseek-v4-flash';
        let contextPrefix = '';
        if (args.context) contextPrefix = `Contexto: ${args.context}\n\n`;
        messages = [
          { role: 'system', content: 'Voce e um revisor de codigo especialista. Analise o codigo abaixo e aponte: bugs, vulnerabilidades de seguranca, problemas de performance, code smells, e sugestoes de melhoria. Seja direto e especifico.' },
          { role: 'user', content: `${contextPrefix}\`\`\`\n${args.code}\n\`\`\`` },
        ];
    } else {
      model = Object.keys(MODELS).find(m => m.replace(/[.-]/g, '_') === match[1]);
      if (!model) {
        const known = Object.keys(MODELS).map(m => `verboo_${m.replace(/[.-]/g, '_')}`).join(', ');
        throw new Error(`Tool desconhecida: ${name}. Tools disponiveis: verboo_code, verboo_review, ${known}`);
      }
      messages = [];
      if (args.system) messages.push({ role: 'system', content: args.system });
      messages.push({ role: 'user', content: args.prompt });
    }

    const result = await callVerboo(model, messages, {
      temperature: args.temperature,
      max_tokens: args.max_tokens,
    });

    const info = MODELS[model];
    const header = `## ${info?.name || model}`;
    const footer = `\n---\n*Modelo: ${result.model} | Tokens: ${result.usage?.total_tokens ?? '?'} (${result.usage?.prompt_tokens ?? '?'} in + ${result.usage?.completion_tokens ?? '?'} out)*`;

    return {
      content: [{ type: 'text', text: `${header}\n\n${result.content}${footer}` }],
    };
  } catch (err) {
    log('error', err.message);
    if (name === 'verboo_agent') {
      return {
        content: [{ type: 'text', text: JSON.stringify(formatAgentFailure(err), null, 2) }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Erro: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Prompts ─────────────────────────────────────────────────────────────

const PROMPTS = {
  'revisar-codigo': {
    name: 'Revisar codigo',
    description: 'Template para revisao de codigo usando modelo Verboo',
    arguments: [
      { name: 'codigo', description: 'Codigo fonte a ser revisado', required: true },
      { name: 'contexto', description: 'Contexto do projeto', required: false },
      { name: 'modelo', description: 'Modelo Verboo (default: deepseek-v4-flash)', required: false },
    ],
  },
  'refatorar': {
    name: 'Refatorar codigo',
    description: 'Template para refatoracao de codigo',
    arguments: [
      { name: 'codigo', description: 'Codigo a refatorar', required: true },
      { name: 'instrucoes', description: 'O que melhorar', required: false },
      { name: 'modelo', description: 'Modelo Verboo', required: false },
    ],
  },
  'explicar': {
    name: 'Explicar codigo',
    description: 'Explica um trecho de codigo em detalhe',
    arguments: [
      { name: 'codigo', description: 'Codigo a explicar', required: true },
      { name: 'modelo', description: 'Modelo Verboo', required: false },
    ],
  },
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.entries(PROMPTS).map(([id, p]) => ({
    name: id,
    description: p.description,
    arguments: p.arguments,
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const prompt = PROMPTS[req.params.name];
  if (!prompt) throw new Error(`Prompt desconhecido: ${req.params.name}`);

  const modelo = req.params.arguments?.modelo || 'deepseek-v4-flash';

  if (req.params.name === 'revisar-codigo') {
    const ctx = req.params.arguments?.contexto || '';
    return {
      messages: [
        { role: 'system', content: { type: 'text', text: `Voce é um revisor de codigo usando ${MODELS[modelo]?.name || modelo}. Seja critico e direto.` } },
        { role: 'user', content: { type: 'text', text: `${ctx}\n\`\`\`\n${req.params.arguments?.codigo}\n\`\`\`` } },
      ],
    };
  }

  if (req.params.name === 'refatorar') {
    const inst = req.params.arguments?.instrucoes || 'Melhore a qualidade, legibilidade e performance';
    return {
      messages: [
        { role: 'user', content: { type: 'text', text: `Refatore o codigo abaixo.\nInstrucoes: ${inst}\n\`\`\`\n${req.params.arguments?.codigo}\n\`\`\`` } },
      ],
    };
  }

  if (req.params.name === 'explicar') {
    return {
      messages: [
        { role: 'user', content: { type: 'text', text: `Explique este codigo em detalhe:\n\`\`\`\n${req.params.arguments?.codigo}\n\`\`\`` } },
      ],
    };
  }

  throw new Error(`Prompt nao implementado: ${req.params.name}`);
});

// ── Resources ───────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'verboo://models',
      name: 'Modelos disponiveis',
      description: 'Lista de todos os modelos Verboo com especificacoes',
      mimeType: 'application/json',
    },
    {
      uri: 'verboo://status',
      name: 'Status da bridge',
      description: 'Informacoes sobre a conexao e configuracao',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === 'verboo://models') {
    return {
      contents: [{
        uri: 'verboo://models',
        mimeType: 'application/json',
        text: JSON.stringify(Object.entries(MODELS).map(([id, m]) => ({
          id,
          name: m.name,
          context_window: m.ctx,
          max_output: m.out,
          tier: m.tier,
          note: m.note,
        })), null, 2),
      }],
    };
  }

  if (req.params.uri === 'verboo://status') {
    return {
      contents: [{
        uri: 'verboo://status',
        mimeType: 'application/json',
        text: JSON.stringify({
          version: VERSION,
          base_url: BASE_URL,
          models_count: Object.keys(MODELS).length,
          log_level: LOG_LEVEL,
          api_key_configured: Boolean(API_KEY),
          agent_allowed_roots_configured: Boolean(process.env.VERBOO_AGENT_ALLOWED_ROOTS),
          agent_executor: DEFAULT_AGENT_EXECUTOR,
          agent_default_executor: DEFAULT_AGENT_EXECUTOR,
          agent_executors: AGENT_EXECUTORS,
        }, null, 2),
      }],
    };
  }

  throw new Error(`Resource desconhecido: ${req.params.uri}`);
});

// ── Start ───────────────────────────────────────────────────────────────

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('info', `verboo-bridge ready | ${Object.keys(MODELS).length} models | ${BASE_URL}`);
} catch (err) {
  console.error('FATAL:', err.message);
  process.exit(1);
}
