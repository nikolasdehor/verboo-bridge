import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_CATALOG,
  classifyTask,
  rankModelsForTask,
  selectModelForTask,
} from '../model-router.mjs';

const ALL_MODELS = Object.keys(MODEL_CATALOG);

test('classifica e direciona implementação para DeepSeek', () => {
  const selection = selectModelForTask({
    prompt: 'Implemente esta API em Node, edite os arquivos e escreva testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
  });

  assert.equal(selection.model, 'deepseek-v4-flash');
  assert.ok(selection.profile.tags.includes('coding'));
  assert.match(selection.reason, /codificação/i);
});

test('direciona auditoria de segurança complexa para GLM 5.2', () => {
  const selection = selectModelForTask({
    prompt: 'Faça uma auditoria de segurança multi-tenant e raciocine sobre a arquitetura.',
    mode: 'read_only',
    availableModels: ALL_MODELS,
  });

  assert.equal(selection.model, 'glm-5.2');
  assert.ok(selection.profile.tags.includes('security'));
  assert.ok(selection.profile.tags.includes('reasoning'));
});

test('direciona análise de contexto longo para Mimo', () => {
  const selection = selectModelForTask({
    prompt: 'Analise um monorepo enorme com muitos arquivos e contexto longo de 1 milhão.',
    mode: 'read_only',
    availableModels: ALL_MODELS,
  });

  assert.equal(selection.model, 'mimo-v2.5');
  assert.ok(selection.profile.tags.includes('long_context'));
});

test('direciona tarefa simples e rápida para GLM Flash', () => {
  const selection = selectModelForTask({
    prompt: 'Resposta rápida: corrija um typo simples nesta mensagem.',
    mode: 'read_only',
    availableModels: ALL_MODELS,
  });

  assert.equal(selection.model, 'glm-4.7-flash');
  assert.ok(selection.profile.tags.includes('speed'));
});

test('respeita tier permitido e exclusões com fallback determinístico', () => {
  const proOnly = rankModelsForTask({
    prompt: 'Audite a segurança e a arquitetura deste sistema complexo.',
    mode: 'read_only',
    availableModels: ALL_MODELS,
    allowTiers: ['pro'],
  });
  assert.ok(proOnly.every((item) => item.tier === 'pro'));
  assert.notEqual(proOnly[0].model, 'glm-5.2');

  const fallback = selectModelForTask({
    prompt: 'Implemente uma refatoração grande com testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
    excludeModels: ['deepseek-v4-flash'],
  });
  assert.equal(fallback.model, 'minimax-m3');
});

test('expõe modelos Max para seleção manual sem colocá-los no roteamento automático', () => {
  assert.equal(MODEL_CATALOG['deepseek-v4-pro'].tier, 'max');
  assert.equal(MODEL_CATALOG['mimo-v2.5-pro'].tier, 'max');

  const ranking = rankModelsForTask({
    prompt: 'Implemente uma refatoração grande com testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
    allowTiers: ['pro', 'max', 'ultra'],
  });
  assert.ok(!ranking.some((item) => item.model === 'deepseek-v4-pro'));
  assert.ok(!ranking.some((item) => item.model === 'mimo-v2.5-pro'));
});

test('penaliza concorrência e uso recente sem fazer round-robin cego', () => {
  const now = 1_000_000;
  const ranking = rankModelsForTask({
    prompt: 'Implemente uma refatoração grande com testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
    runtimeState: {
      'deepseek-v4-flash': {
        inFlight: 2,
        lastSelectedAt: now - 1_000,
        failures: 0,
        cooldownUntil: 0,
      },
    },
    now,
  });

  assert.equal(ranking[0].model, 'minimax-m3');
  const deepseek = ranking.find((item) => item.model === 'deepseek-v4-flash');
  assert.ok(deepseek.penalties.some((reason) => reason.includes('concorrência')));
  assert.ok(deepseek.penalties.some((reason) => reason.includes('uso recente')));
});

test('classificação é explicável e não depende de aleatoriedade', () => {
  const input = {
    prompt: 'Revise acessibilidade, UX responsiva e componentes web.',
    mode: 'read_only',
  };
  assert.deepEqual(classifyTask(input), classifyTask(input));

  const selection = selectModelForTask({
    ...input,
    availableModels: ALL_MODELS,
  });
  assert.equal(selection.model, 'glm-5.2');
  assert.ok(selection.ranking[0].reasons.length > 0);
});

test('lança MODEL_ROUTE_EMPTY quando os filtros removem todos os modelos', () => {
  assert.throws(
    () => selectModelForTask({
      prompt: 'Implemente algo.',
      availableModels: ALL_MODELS,
      excludeModels: ALL_MODELS,
    }),
    (error) => error.code === 'MODEL_ROUTE_EMPTY',
  );
});

test('cooldown ativo desprioriza o modelo', () => {
  const now = 1_000_000;
  const ranking = rankModelsForTask({
    prompt: 'Implemente uma refatoração grande com testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
    runtimeState: {
      'deepseek-v4-flash': { cooldownUntil: now + 60_000 },
    },
    now,
  });

  assert.notEqual(ranking[0].model, 'deepseek-v4-flash');
  assert.equal(ranking.at(-1).model, 'deepseek-v4-flash');
});
