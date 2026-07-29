import test from 'node:test';
import assert from 'node:assert/strict';

import { parseVerbooCodeEvents } from '../agent-runner.mjs';
import { extractMemoryNote } from '../memory-store.mjs';

// Mesma string de fallback usada em agent-runner.mjs:1767 (successfulAgentResult).
const FALLBACK_RESULT = 'Execução concluída sem mensagem final.';

// Reproduz o cenário confirmado ao vivo no job f1410537-3cfa-4ec3-a727-8d435c202bdb:
// modo write, Read e Write bem-sucedidos (artefato real gravado em disco), mas o
// evento "result" do CLI nativo chega sem texto final porque o último turno do
// assistente foi só o tool_use do Write, sem bloco de texto depois dele.
test('job succeeded com Write bem-sucedido não deve devolver result vazio/fallback', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'assistant',
      session_id: 's9',
      message: {
        content: [
          { type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: '/repo/a.js' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      session_id: 's9',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'read1', content: 'conteúdo lido' },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      session_id: 's9',
      message: {
        content: [
          { type: 'tool_use', id: 'write1', name: 'Write', input: { file_path: '/repo/out.txt' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      session_id: 's9',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'write1', content: 'escrito com sucesso' },
        ],
      },
    }),
    // Sem bloco de texto do assistente após o Write, e o evento result final chega vazio.
    JSON.stringify({ type: 'result', session_id: 's9', result: '' }),
  ].join('\n');

  const parsed = parseVerbooCodeEvents(raw, cwd);
  assert.deepEqual(parsed.successfulTools, ['Read', 'Write']);

  // Mesma composição usada em successfulAgentResult (agent-runner.mjs:1761 e 1767).
  const memory = extractMemoryNote(parsed.result);
  const output = memory.result || FALLBACK_RESULT;

  assert.notEqual(
    output,
    FALLBACK_RESULT,
    'output não deveria cair no fallback quando o job teve tool calls bem-sucedidas (Write incluso)',
  );
  assert.notEqual(output.trim(), '', 'output não deveria ser string vazia');
});
