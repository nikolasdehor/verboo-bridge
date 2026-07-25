# verboo-bridge

Use modelos da Verboo (DeepSeek V4 Flash, GLM 5.2, Mimo V2.5, etc.) como **sub-agentes** dentro do Claude Code, Codex, OpenCode, Cursor ou qualquer cliente MCP.

## Como funciona

`verboo-bridge` e um servidor MCP que expoe cada modelo da Verboo como uma tool. O orquestrador (Claude/Codex) chama as tools para delegar trabalho pesado para os modelos Verboo com tokens ilimitados.

```
Claude/Codex (orquestrador)
  |-> verboo_code("refatore esse modulo")  -> DeepSeek V4 Flash
  |-> verboo_review(codigo)                -> DeepSeek V4 Flash
  |-> verboo_glm_5_2("analise complexa")   -> GLM 5.2
  |-> verboo_mimo_v2_5("analise")          -> Mimo V2.5
```

## Instalacao

```bash
git clone https://github.com/nikolasdehor/verboo-bridge.git
cd verboo-bridge
npm install
```

## Configuracao

### 1. Variavel de ambiente

```bash
export VERBOO_API_KEY="sua_chave_aqui"
```

### 2. Claude Code

Adicione no `~/.claude.json`:

```json
{
  "mcpServers": {
    "verboo-bridge": {
      "command": "node",
      "args": ["/caminho/para/verboo-bridge/index.mjs"],
      "env": {
        "VERBOO_API_KEY": "${VERBOO_API_KEY}"
      }
    }
  }
}
```

O `${VERBOO_API_KEY}` sera resolvido automaticamente pelo Claude Code.

### 3. Codex / OpenCode

Adicione no `opencode.json`:

```json
{
  "mcpServers": {
    "verboo-bridge": {
      "command": "node",
      "args": ["/caminho/para/verboo-bridge/index.mjs"],
      "env": {
        "VERBOO_API_KEY": "{env:VERBOO_API_KEY}"
      }
    }
  }
}
```

### 4. CLI direta

```bash
# Instalar o comando vb
cp bin/vb ~/.local/bin/
chmod +x ~/.local/bin/vb

# Usar
vb "Refatore isso" --model deepseek-v4-flash
vb "Revise esse codigo" --model mimo-v2.5 --system "Seja critico"
```

## Tools disponiveis

| Tool | Modelo | Contexto | Ideal para |
|------|--------|----------|------------|
| `verboo_deepseek_v4_flash` | DeepSeek V4 Flash | 1M | Codificacao geral, melhor CxB |
| `verboo_glm_5_2` | GLM 5.2 | 512K | Raciocinio complexo, #2 WebDev Arena |
| `verboo_mimo_v2_5` | Mimo V2.5 | 1M | Analise pesada |
| `verboo_kimi_k2_7` | Kimi K2.7 | 256K | Tarefas gerais |
| `verboo_minimax_m3` | Minimax M3 | 1M | Codificacao |
| `verboo_glm_4_7_flash` | GLM 4.7 Flash | 200K | Tarefas rapidas |
| `verboo_qwen3_6_27b` | Qwen 3.6 27B | 256K | Tarefas leves |
| `verboo_code` | DeepSeek V4 Flash (default) | 1M | Atalho para codificacao |
| `verboo_review` | DeepSeek V4 Flash (default) | - | Atalho para code review |

## Skill para Claude

Para ensinar o Claude a delegar automaticamente, copie o skill file:

```bash
cp -r skills/verboo-executor ~/.claude/skills/
```

## Planos Verboo

| Plano | Preco | Tokens | Concorrencia | Modelos |
|-------|-------|--------|-------------|---------|
| Junior | R$ 75/mes | Ilimitado | 2 | Modelos basicos |
| Pro | R$ 174/mes | Ilimitado | 4 | deepseek-v4-flash, mimo-v2.5 (1M ctx) |
| Ultra | R$ 900/mes | Ilimitado | 2 | + GLM 5.2, todos os modelos |

> Recomendacao: **Pro (R$ 174/mes)** e o melhor custo-beneficio. 4 conexoes concorrentes, 1M de contexto, tokens ilimitados.

## Compatibilidade

- Claude Code (via MCP)
- Codex (via MCP)
- OpenCode (via MCP ou provider direto)
- Cursor (via MCP)
- Qualquer cliente MCP (stdio)

## Licenca

MIT
