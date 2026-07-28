import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_RECENT_ENTRIES = 8;
const MAX_MEMORY_NOTE_CHARS = 2_000;
const MAX_SHARED_FILES = 8;
const MAX_SHARED_FILE_CHARS = 4_000;
const MAX_SHARED_CONTEXT_CHARS = 12_000;
const MAX_PROJECT_MEMORY_READ_BYTES = 256 * 1024;
const MEMORY_NOTE_PATTERN = /<memory_note>([\s\S]*?)<\/memory_note>/i;

const appendQueues = new Map();

function enabledValue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function trimEdgeHyphens(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

export function memoryEnabled(env) {
  return enabledValue(env.VERBOO_MEMORY_ENABLED);
}

export function memoryDirectory(env) {
  const configured = String(env.VERBOO_MEMORY_DIR ?? '').trim();
  if (configured) return path.resolve(configured);
  return path.join(env.HOME || os.homedir(), '.local', 'share', 'verboo-bridge', 'memory');
}

function safeProjectName(cwd) {
  const normalized = path.basename(cwd)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-');
  const basename = trimEdgeHyphens(normalized).slice(0, 48) || 'project';
  const digest = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return `${basename}-${digest}`;
}

export function projectMemoryFile(cwd, env) {
  return path.join(memoryDirectory(env), `${safeProjectName(path.resolve(cwd))}.jsonl`);
}

function redactSensitive(value) {
  return String(value ?? '')
    .replace(
      /\b(?:sk-(?:ant|proj|svc)-|sk_|vbk_|gh[pousr]_|github_pat_|hf_|glpat-)[a-z0-9_-]{8,}\b/gi,
      '[SEGREDO REDIGIDO]',
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[SEGREDO REDIGIDO]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[SEGREDO REDIGIDO]')
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      '[CHAVE PRIVADA REDIGIDA]',
    )
    .replace(
      /\b(authorization|api[_-]?key|token|password|senha)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*')/gi,
      '$1=[SEGREDO REDIGIDO]',
    )
    .replace(
      /\b(authorization|api[_-]?key|token|password|senha)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[SEGREDO REDIGIDO]',
    )
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[EMAIL REDIGIDO]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF REDIGIDO]')
    .replace(
      /\+?\d[\d ().-]{8,}\d/g,
      (candidate) => {
        const digits = candidate.replace(/\D/g, '');
        const national = digits.startsWith('55') ? digits.slice(2) : digits;
        return national.length === 10 || national.length === 11
          ? '[TELEFONE REDIGIDO]'
          : candidate;
      },
    );
}

function sanitizeNote(value) {
  return redactSensitive(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MEMORY_NOTE_CHARS);
}

export function extractMemoryNote(result) {
  const text = String(result ?? '');
  const match = MEMORY_NOTE_PATTERN.exec(text);
  return {
    result: text.replace(MEMORY_NOTE_PATTERN, '').trim(),
    note: sanitizeNote(match?.[1]),
  };
}

function parseEntries(raw) {
  const entries = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.note === 'string' && entry.note.trim()) {
        entries.push(entry);
      }
    } catch {
      // Uma linha interrompida não invalida o restante do diário.
    }
  }
  return entries;
}

export async function readProjectMemory(cwd, env, limit = DEFAULT_RECENT_ENTRIES) {
  if (!memoryEnabled(env)) return [];
  try {
    const handle = await open(projectMemoryFile(cwd, env), 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - MAX_PROJECT_MEMORY_READ_BYTES);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let raw = buffer.toString('utf8');
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
      return parseEntries(raw)
        .slice(-Math.max(1, limit))
        .map((entry) => ({ ...entry, note: sanitizeNote(entry.note) }))
        .filter((entry) => entry.note);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function enqueueAppend(file, operation) {
  const previous = appendQueues.get(file) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  appendQueues.set(file, current);
  return current.finally(() => {
    if (appendQueues.get(file) === current) appendQueues.delete(file);
  });
}

export async function rememberProjectNote(cwd, note, metadata, env) {
  if (!memoryEnabled(env)) return false;
  const sanitized = sanitizeNote(note);
  if (!sanitized) return false;

  const file = projectMemoryFile(cwd, env);
  const entry = {
    timestamp: new Date().toISOString(),
    note: sanitized,
    model: metadata.model ?? null,
    mode: metadata.mode ?? null,
    executor: metadata.executor ?? null,
    status: metadata.status ?? null,
    artifacts: (metadata.artifacts ?? [])
      .map((artifact) => path.relative(cwd, artifact))
      .filter((artifact) => (
        artifact
        && !artifact.startsWith('..')
        && !path.isAbsolute(artifact)
      ))
      .slice(0, 20),
  };

  await enqueueAppend(file, async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  });
  return true;
}

export function configuredSharedMemoryFiles(env) {
  return String(env.VERBOO_SHARED_MEMORY_FILES ?? '')
    .split(path.delimiter)
    .map((file) => file.trim())
    .filter(Boolean)
    .slice(0, MAX_SHARED_FILES);
}

async function readSharedMemory(env) {
  const sections = [];
  let usedChars = 0;
  for (const file of configuredSharedMemoryFiles(env)) {
    if (usedChars >= MAX_SHARED_CONTEXT_CHARS) break;
    try {
      const raw = await readFile(file, 'utf8');
      const remaining = MAX_SHARED_CONTEXT_CHARS - usedChars;
      const content = redactSensitive(
        raw.slice(0, Math.min(MAX_SHARED_FILE_CHARS, remaining)),
      ).trim();
      if (!content) continue;
      sections.push(`Fonte compartilhada: ${path.basename(file)}\n${content}`);
      usedChars += content.length;
    } catch {
      // Memória compartilhada é contexto opcional; indisponibilidade não bloqueia o agente.
    }
  }
  return sections;
}

export async function loadMemoryContext(cwd, env) {
  if (!memoryEnabled(env)) {
    return {
      enabled: false,
      text: '',
      projectEntries: 0,
      sharedFiles: 0,
    };
  }

  const [entries, sharedSections] = await Promise.all([
    readProjectMemory(cwd, env),
    readSharedMemory(env),
  ]);
  const projectSection = entries.length
    ? [
        'Memória operacional recente deste projeto:',
        ...entries.map((entry) => `- ${entry.note}`),
      ].join('\n')
    : '';
  const text = [projectSection, ...sharedSections].filter(Boolean).join('\n\n');
  return {
    enabled: true,
    text,
    projectEntries: entries.length,
    sharedFiles: sharedSections.length,
  };
}

export function promptWithMemory(prompt, memoryContext) {
  if (!memoryContext.enabled) return prompt;
  const memory = memoryContext.text
    ? [
        '<verboo_memory>',
        'Contexto potencialmente desatualizado: confirme no repositório antes de concluir.',
        memoryContext.text,
        '</verboo_memory>',
        '',
      ].join('\n')
    : '';
  return [
    memory,
    'Tarefa atual:',
    prompt,
    '',
    'Ao finalizar, inclua uma única nota técnica durável entre',
    '<memory_note> e </memory_note>. Não inclua segredos, credenciais, dados',
    'pessoais, código bruto nem detalhes temporários nessa nota.',
  ].filter(Boolean).join('\n');
}

export function memoryStatus(env) {
  return {
    enabled: memoryEnabled(env),
    directory: memoryDirectory(env),
    shared_files: configuredSharedMemoryFiles(env).length,
  };
}
