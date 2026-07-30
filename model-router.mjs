const TIE_BREAK_ORDER = [
  'deepseek-v4-flash',
  'glm-5.2',
  'mimo-v2.5',
  'minimax-m3',
  'kimi-k2.7',
  'glm-4.7-flash',
  'qwen3.6-27b',
];

export const MODEL_CATALOG = Object.freeze({
  'deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    note: 'Melhor CxB para codificação',
    capabilities: {
      coding: 10,
      reasoning: 8,
      review: 9,
      security: 8,
      ux: 7,
      analysis: 8,
      long_context: 10,
      speed: 8,
      light: 6,
    },
    bias: 0.6,
  },
  'deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'max',
    auto: false,
    note: 'Variante Max para codificação mais exigente',
    capabilities: {
      coding: 10,
      reasoning: 9,
      review: 9,
      security: 9,
      ux: 8,
      analysis: 9,
      long_context: 10,
      speed: 6,
      light: 4,
    },
    bias: 0,
  },
  'glm-4.7-flash': {
    name: 'GLM 4.7 Flash',
    ctx: 200_704,
    out: 65_536,
    tier: 'pro',
    note: 'Rápido para tarefas simples',
    capabilities: {
      coding: 6,
      reasoning: 6,
      review: 6,
      security: 5,
      ux: 7,
      analysis: 5,
      long_context: 4,
      speed: 10,
      light: 10,
    },
    bias: 0.2,
  },
  'glm-5.2': {
    name: 'GLM 5.2',
    ctx: 196_608,
    out: 65_536,
    tier: 'ultra',
    note: 'Raciocínio complexo e desenvolvimento web',
    capabilities: {
      coding: 9,
      reasoning: 10,
      review: 9,
      security: 10,
      ux: 10,
      analysis: 9,
      long_context: 8,
      speed: 6,
      light: 4,
    },
    bias: 0.1,
  },
  'kimi-k2.7': {
    name: 'Kimi K2.7',
    ctx: 259_072,
    out: 65_536,
    tier: 'ultra',
    note: 'Bom equilíbrio para tarefas gerais e visuais',
    capabilities: {
      coding: 7,
      reasoning: 8,
      review: 7,
      security: 7,
      ux: 8,
      analysis: 8,
      long_context: 6,
      speed: 7,
      light: 6,
    },
    bias: 0.3,
  },
  'mimo-v2.5': {
    name: 'Mimo V2.5',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    note: 'Análise pesada com contexto de 1M',
    capabilities: {
      coding: 7,
      reasoning: 8,
      review: 8,
      security: 7,
      ux: 6,
      analysis: 10,
      long_context: 10,
      speed: 7,
      light: 5,
    },
    bias: 0.2,
  },
  'mimo-v2.5-pro': {
    name: 'Mimo V2.5 Pro',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'max',
    auto: false,
    note: 'Variante Max para análise mais exigente',
    capabilities: {
      coding: 8,
      reasoning: 9,
      review: 9,
      security: 8,
      ux: 7,
      analysis: 10,
      long_context: 10,
      speed: 6,
      light: 4,
    },
    bias: 0,
  },
  'minimax-m3': {
    name: 'Minimax M3',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'ultra',
    note: 'Codificação rápida com contexto de 1M',
    capabilities: {
      coding: 9,
      reasoning: 8,
      review: 8,
      security: 7,
      ux: 8,
      analysis: 8,
      long_context: 10,
      speed: 9,
      light: 6,
    },
    bias: 0.3,
  },
  'qwen3.6-27b': {
    name: 'Qwen 3.6 27B',
    ctx: 262_144,
    out: 65_536,
    tier: 'pro',
    note: 'Modelo leve para tarefas curtas',
    capabilities: {
      coding: 6,
      reasoning: 6,
      review: 6,
      security: 5,
      ux: 6,
      analysis: 5,
      long_context: 6,
      speed: 9,
      light: 10,
    },
    bias: 0.1,
  },
});

const MODEL_ORDER = [
  ...TIE_BREAK_ORDER.filter((model) => model in MODEL_CATALOG),
  ...Object.keys(MODEL_CATALOG).filter(
    (model) => !TIE_BREAK_ORDER.includes(model),
  ),
];

const DIMENSION_LABELS = {
  coding: 'codificação',
  reasoning: 'raciocínio',
  review: 'revisão',
  security: 'segurança',
  ux: 'UX/web',
  analysis: 'análise',
  long_context: 'contexto longo',
  speed: 'velocidade',
  light: 'tarefa leve',
};

function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matches(text, pattern) {
  return pattern.test(text);
}

export function classifyTask({ prompt, mode = 'read_only' }) {
  const text = normalizedText(prompt);
  const weights = Object.fromEntries(
    Object.keys(DIMENSION_LABELS).map((dimension) => [dimension, 0]),
  );
  const tags = new Set();

  const add = (tag, additions) => {
    tags.add(tag);
    for (const [dimension, weight] of Object.entries(additions)) {
      weights[dimension] += weight;
    }
  };

  if (mode === 'write') add('coding', { coding: 7, review: 1 });
  if (matches(text, /\b(implement|codific|refator|refactor|api|bugfix|fix|corrij|edit|crie|build|migrat|test|teste)\w*/)) {
    add('coding', { coding: 6, review: 1 });
  }
  if (matches(text, /\b(seguranc|security|vulnerab|auth|autoriz|tenant|csrf|xss|injection|permission|privileg|isolamento)\w*/)) {
    add('security', { security: 10, reasoning: 6, review: 4 });
  }
  if (matches(text, /\b(arquitet|architecture|complex|raciocin|trade.?off|decis|causa raiz|root cause|debug dificil)\w*/)) {
    add('reasoning', { reasoning: 9, analysis: 4 });
  }
  if (matches(text, /\b(ux|ui|frontend|front-end|web|design|acessib|responsive|responsiv|css|html|visual)\w*/)) {
    add('ux', { ux: 10, reasoning: 3, review: 2 });
  }
  if (matches(text, /\b(revis|review|audit|auditoria|code smell|performance|desempenho)\w*/)) {
    add('review', { review: 8, analysis: 3 });
  }
  if (matches(text, /\b(monorepo|contexto longo|long context|1m|milhao|muitos arquivos|large codebase|repositorio grande|volume)\w*/)) {
    add('long_context', { long_context: 10, analysis: 8 });
  }
  if (matches(text, /\b(analis|analy[sz]|investig|pesquis|research|compar|mapear)\w*/)) {
    add('analysis', { analysis: 7, reasoning: 2 });
  }
  if (matches(text, /\b(rapido|quick|simple|simples|typo|curto|light|leve|resposta curta)\w*/)) {
    add('speed', { speed: 10, light: 10 });
    if (text.length < 160) weights.coding = Math.min(weights.coding, 2);
  }

  if (tags.size === 0) {
    add('general', { coding: 4, reasoning: 3, analysis: 2 });
  }

  return {
    mode,
    tags: [...tags],
    weights,
  };
}

function runtimePenalty(state, now) {
  const penalties = [];
  let value = 0;
  const inFlight = Number(state?.inFlight ?? 0);
  if (inFlight > 0) {
    const penalty = inFlight * 1.25;
    value += penalty;
    penalties.push(`concorrência: -${penalty.toFixed(2)} (${inFlight} em execução)`);
  }
  const lastSelectedAt = Number(state?.lastSelectedAt ?? 0);
  if (lastSelectedAt > 0 && now - lastSelectedAt < 30_000) {
    value += 0.75;
    penalties.push('uso recente: -0.75');
  }
  const failures = Number(state?.failures ?? 0);
  if (failures > 0) {
    const penalty = Math.min(failures, 4) * 0.5;
    value += penalty;
    penalties.push(`falhas recentes: -${penalty.toFixed(2)}`);
  }
  const cooldownUntil = Number(state?.cooldownUntil ?? 0);
  if (cooldownUntil > now) {
    value += 50;
    penalties.push(`cooldown até ${new Date(cooldownUntil).toISOString()}: -50.00`);
  }
  return { value, penalties };
}

function affinityScore(profile, capabilities) {
  const weighted = Object.entries(profile.weights)
    .filter(([, weight]) => weight > 0);
  const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight === 0) return 0;
  return weighted.reduce(
    (sum, [dimension, weight]) => sum + (capabilities[dimension] ?? 0) * weight,
    0,
  ) / totalWeight;
}

function reasonsFor(profile, model) {
  return Object.entries(profile.weights)
    .filter(([, weight]) => weight > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([dimension]) => (
      `${DIMENSION_LABELS[dimension]} ${model.capabilities[dimension]}/10`
    ));
}

export function rankModelsForTask({
  prompt,
  mode = 'read_only',
  profile: providedProfile,
  availableModels = Object.keys(MODEL_CATALOG),
  allowTiers = ['pro', 'ultra'],
  excludeModels = [],
  includePremiumModels = false,
  runtimeState = {},
  now = Date.now(),
}) {
  const profile = providedProfile ?? classifyTask({ prompt, mode });
  const available = new Set(availableModels);
  const tiers = new Set(allowTiers);
  const excluded = new Set(excludeModels);

  return MODEL_ORDER
    .filter((model) => (
      available.has(model)
      && !excluded.has(model)
      && tiers.has(MODEL_CATALOG[model].tier)
      && (includePremiumModels || MODEL_CATALOG[model].auto !== false)
    ))
    .map((model) => {
      const metadata = MODEL_CATALOG[model];
      const affinity = affinityScore(profile, metadata.capabilities);
      const { value: penalty, penalties } = runtimePenalty(
        runtimeState[model],
        now,
      );
      const score = affinity + metadata.bias - penalty;
      return {
        model,
        name: metadata.name,
        tier: metadata.tier,
        score: Number(score.toFixed(3)),
        affinity: Number(affinity.toFixed(3)),
        reasons: reasonsFor(profile, metadata),
        penalties,
      };
    })
    .sort((left, right) => (
      right.score - left.score
      || MODEL_ORDER.indexOf(left.model) - MODEL_ORDER.indexOf(right.model)
    ));
}

export function selectModelForTask(options) {
  const profile = classifyTask(options);
  const ranking = rankModelsForTask({ ...options, profile });
  if (ranking.length === 0) {
    const error = new Error('Nenhum modelo disponível após aplicar filtros e tiers.');
    error.code = 'MODEL_ROUTE_EMPTY';
    throw error;
  }
  const selected = ranking[0];
  return {
    model: selected.model,
    profile,
    ranking,
    reason: `Selecionado por afinidade com ${selected.reasons.join(', ')}.`,
  };
}
