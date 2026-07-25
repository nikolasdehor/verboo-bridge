<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node >=18">
  <img src="https://img.shields.io/badge/MCP-1.0.0-purple" alt="MCP">
  <img src="https://img.shields.io/badge/status-ativo-success" alt="Status">
</p>

<div align="center">
  <h1>verboo-bridge</h1>
  <p><strong>Use modelos da Verboo como sub-agentes no Claude Code, Codex, OpenCode, Cursor ou qualquer cliente MCP</strong></p>
  <p>Transforme tokens ilimitados da Verboo em execucao distribuida para seu orquestrador preferido</p>
</div>

---

## Arquitetura

```mermaid
graph TB
    subgraph "Orquestrador"
        CLAUDE[Claude Code]
        CODEX[Codex]
        OPENCODE[OpenCode]
        CURSOR[Cursor]
    end

    subgraph "verboo-bridge"
        MCP[MCP Server<br/>stdio]
        CLI[CLI wrapper<br/>bin/vb]
        AGENT[verboo_agent<br/>repo-aware]
        NATIVE[Verboo Code nativo<br/>OAuth]
        HARNESS[OpenCode<br/>fallback]
    end

    subgraph "Verboo API"
        DS[DeepSeek V4 Flash<br/>1M ctx]
        GLM[GLM 5.2<br/>512K ctx]
        MIMO[Mimo V2.5<br/>1M ctx]
        OUTROS[Kimi / Minimax / Qwen]
    end

    CLAUDE -->|MCP tools| MCP
    CODEX -->|MCP tools| MCP
    CURSOR -->|MCP tools| MCP
    Terminal -->|CLI direta| CLI

    MCP --> AGENT
    AGENT -->|preferencial| NATIVE
    AGENT -->|opcional| HARNESS
    NATIVE -->|OAuth| DS
    HARNESS -->|provider verboo| DS
    OPENCODE -->|provider verboo| DS
    MCP -->|API key| DS
    MCP -->|API key| GLM
    MCP -->|API key| MIMO
    MCP -->|API key| OUTROS
    CLI -->|API key| DS
    CLI -->|API key| OUTROS
```

---

## Modelos disponiveis

| Modelo | Contexto | Tier | SWE-bench Pro | Terminal-Bench | WebDev Arena | Ideal para |
|--------|----------|------|:-:|:-:|:-:|-----------|
| **DeepSeek V4 Flash** | 1.048.576 | Pro | 82-89% | 56.9 | - | Codificacao geral, **melhor CxB** |
| **Mimo V2.5** | 1.048.576 | Pro | - | - | - | Analise pesada, 63 tok/s |
| **GLM 4.7 Flash** | 200.704 | Pro | - | - | - | Tarefas rapidas |
| **Qwen 3.6 27B** | 262.144 | Pro | - | - | - | Tarefas leves, 27B params |
| **GLM 5.2** | 524.288 | Ultra | 62.1% | 81.0 | #2 (1.593 Elo) | Raciocinio complexo |
| **Kimi K2.7** | 262.144 | Ultra | ~60% | - | - | Tarefas gerais, visao |
| **Minimax M3** | 1.048.576 | Ultra | - | - | - | Codificacao, 87 tok/s, visao |

---

## Instalacao rapida

```bash
git clone https://github.com/nikolasdehor/verboo-bridge.git
cd verboo-bridge
npm install
```

Requisitos: Node.js 18+ e, para `verboo_agent`, `@verboo/code` com OAuth
ou OpenCode 1.17.9+ como fallback.

### Variavel de ambiente

```bash
export VERBOO_AGENT_ALLOWED_ROOTS="/caminho/para/seus/projetos"
export VERBOO_AGENT_EXECUTOR="native"
export VERBOO_CODE_BIN="/caminho/para/verboo"
# Opcional e sensivel: habilita edicao (sem shell)
export VERBOO_AGENT_WRITE_ENABLED="1"
```

Antes do modo nativo, autentique a CLI oficial uma vez com
`verboo auth login` ou `verboo auth login --headless`. A sessão OAuth é lida
pelo subprocesso via diretório do usuário; a API key não é repassada ao
executor nativo.

Se o comando `verboo` não apontar para a CLI oficial, use Node e o entrypoint:

```bash
export VERBOO_CODE_BIN="/caminho/para/node"
export VERBOO_CODE_ENTRYPOINT="/caminho/para/@verboo/code/dist/cli.mjs"
```

`VERBOO_API_KEY` continua opcionalmente disponível para as tools de prompt
simples (`verboo_code`, `verboo_review` e tools por modelo). Não grave a chave
no repositório.

---

## Configuracao por plataforma

### Claude Code

Adicione no `~/.claude.json`:

```json
{
  "mcpServers": {
    "verboo-bridge": {
      "command": "node",
      "args": ["/caminho/para/verboo-bridge/index.mjs"],
      "env": {
        "VERBOO_AGENT_ALLOWED_ROOTS": "/caminho/para/seus/projetos",
        "VERBOO_AGENT_EXECUTOR": "native",
        "VERBOO_CODE_BIN": "/caminho/para/verboo"
      }
    }
  }
}
```

O Claude Code ainda pode pedir aprovação para a chamada MCP. Essa aprovação é
do orquestrador e é separada do OAuth e das permissões internas do Verboo Code.

### OpenCode

**Opcao 1 — MCP server**:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "verboo-bridge": {
      "type": "local",
      "command": ["node", "/caminho/para/verboo-bridge/index.mjs"],
      "environment": {
        "VERBOO_API_KEY": "{env:VERBOO_API_KEY}",
        "VERBOO_AGENT_ALLOWED_ROOTS": "/caminho/para/seus/projetos",
        "VERBOO_OPENCODE_BIN": "/caminho/para/opencode"
      },
      "enabled": true
    }
  }
}
```

Para habilitar edicao conscientemente, adicione
`"VERBOO_AGENT_WRITE_ENABLED": "1"` ao bloco `environment`. Sem isso,
`verboo_agent` aceita somente `read_only`.

**Opcao 2 — Provider direto** (necessario para `verboo_agent`):

```json
{
  "provider": {
    "verboo": {
      "name": "Verboo",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://code.verboo.ai/router/v1",
        "apiKey": "{env:VERBOO_API_KEY}"
      },
      "models": {
        "deepseek-v4-flash": { "name": "DeepSeek V4 Flash", "limit": { "context": 1048576, "output": 65536 } },
        "glm-5.2":           { "name": "GLM 5.2",           "limit": { "context": 524288,  "output": 65536 } },
        "mimo-v2.5":         { "name": "Mimo V2.5",         "limit": { "context": 1048576, "output": 65536 } },
        "kimi-k2.7":         { "name": "Kimi K2.7",         "limit": { "context": 262144,  "output": 65536 } },
        "minimax-m3":        { "name": "Minimax M3",        "limit": { "context": 1048576, "output": 65536 } },
        "glm-4.7-flash":     { "name": "GLM 4.7 Flash",    "limit": { "context": 200704,  "output": 65536 } },
        "qwen3.6-27b":       { "name": "Qwen 3.6 27B",     "limit": { "context": 262144,  "output": 65536 } }
      }
    }
  }
}
```

### Codex

Adicione no `~/.codex/config.toml`:

```toml
[mcp_servers.verboo-bridge]
command = "node"
args = ["/caminho/para/verboo-bridge/index.mjs"]

[mcp_servers.verboo-bridge.env]
VERBOO_AGENT_ALLOWED_ROOTS = "/caminho/para/seus/projetos"
VERBOO_AGENT_EXECUTOR = "native"
VERBOO_CODE_BIN = "/caminho/para/verboo"
```

O Codex ainda controla a aprovação da chamada `verboo_agent`. O executor nativo
recebe apenas as ferramentas compatíveis com o modo solicitado: leitura no
`read_only`; leitura e edição no `write`; Bash, web, hooks e MCPs internos ficam
bloqueados.

Reinicie o cliente depois de alterar a configuracao. MCPs novos nao entram em
uma sessao ja aberta.

### Cursor

Adicione no `.cursor/mcp.json` do projeto:

```json
{
  "mcpServers": {
    "verboo-bridge": {
      "command": "node",
      "args": ["/caminho/para/verboo-bridge/index.mjs"],
      "env": {
        "VERBOO_API_KEY": "${VERBOO_API_KEY}",
        "VERBOO_AGENT_ALLOWED_ROOTS": "/caminho/para/seus/projetos",
        "VERBOO_OPENCODE_BIN": "/caminho/para/opencode"
      }
    }
  }
}
```

---

## Uso

### Via MCP (Claude/Codex/Cursor)

Quando o MCP server estiver registrado, o orquestrador tera acesso a estas tools:

| Tool | Descricao |
|------|-----------|
| `verboo_agent` | Subagente repo-aware via Verboo Code nativo/OAuth ou OpenCode fallback (`read_only` ou `write`) |
| `verboo_code` | Codificacao com DeepSeek V4 Flash |
| `verboo_review` | Code review |
| `verboo_deepseek_v4_flash` | Modelo especifico |
| `verboo_glm_5_2` | Modelo especifico |
| `verboo_mimo_v2_5` | Modelo especifico |
| `verboo_kimi_k2_7` | Modelo especifico |
| `verboo_minimax_m3` | Modelo especifico |
| `verboo_glm_4_7_flash` | Modelo especifico |
| `verboo_qwen3_6_27b` | Modelo especifico |

Exemplo de delegacao nativa:

> _"Use `verboo_agent` em modo `write`, com cwd neste repo, para editar os testes
> deste modulo. Depois revise o diff e rode a suite local no orquestrador."_

`read_only` bloqueia edicao, shell, web, agentes aninhados e acesso fora do
projeto. `write` libera somente ferramentas de leitura e edicao; shell, web,
agentes aninhados e diretorios externos permanecem desabilitados. O orquestrador
continua responsavel por executar testes e outros comandos, revisar o diff,
commitar e fazer deploy. O subprocesso recebe somente uma allowlist minima de
variaveis de ambiente; tokens de GitHub, AWS e outros servicos nao sao herdados.
O modo `write` falha fechado enquanto `VERBOO_AGENT_WRITE_ENABLED` nao for `1`.

### Via CLI direta

```bash
# Prompt simples
vb "Explique closures em JavaScript"

# Com modelo especifico e system prompt
vb -m glm-5.2 -s "Seja conciso e tecnico" "Analise a complexidade deste algoritmo"

# Pipe de arquivo
cat main.py | vb -m mimo-v2.5 "Revise este codigo"

# Listar modelos
vb --list
```

### Via Verboo Code nativo

```bash
verboo auth login
verboo -p --output-format stream-json "Revise este projeto"
```

### Via OpenCode (fallback)

```bash
opencode run -m verboo/deepseek-v4-flash "Refatore este componente"
opencode run -m verboo/glm-5.2 "Resolva este problema complexo"
```

---

## Skill para Claude e Codex

Para ensinar o Claude a delegar automaticamente tarefas de volume para a Verboo, copie o skill file:

```bash
cp -r skills/verboo-executor ~/.claude/skills/
cp -r skills/verboo-executor ~/.codex/skills/
```

O skill ensina o padrao de delegacao:

1. Claude recebe a tarefa
2. Claude separa em **orquestracao** (fica com Claude) + **volume** (delega pra Verboo)
3. Claude/Codex chama `verboo_agent` com `cwd`, modo e instrucoes claras
4. Claude integra e valida o resultado

---

## Planos Verboo

| Plano | Preco | Tokens | Conexoes | Modelos |
|-------|-------|--------|----------|---------|
| Junior | R$ 75/mes | Ilimitado | 2 | Modelos basicos |
| **Pro** | **R$ 174/mes** | **Ilimitado** | **4** | **deepseek-v4-flash, mimo-v2.5 (1M ctx)** |
| Ultra | R$ 900/mes | Ilimitado | 2 | + GLM 5.2, todos |

> **Recomendacao:** Pro (R$ 174/mes) — 4 conexoes concorrentes, 1M de contexto, tokens ilimitados.
> Unico plano com 4 conexoes simultaneas (Ultra tem apenas 2).

---

## Exemplos reais

### Code review em lote

```bash
# Revisar varios arquivos de uma vez com Verboo
for f in src/**/*.ts; do
  cat "$f" | vb -m mimo-v2.5 -s "Revise este arquivo TypeScript" > "reviews/$(basename $f).review.md"
done
```

### Refatoracao assistida

```mermaid
sequenceDiagram
    participant Vc as Voce
    participant C as Claude Code
    participant VB as Verboo Bridge

    Vc->>C: Refatore este modulo
    C->>VB: verboo_code("Extraia a logica de pagamento")
    VB-->>C: Codigo refatorado
    C->>VB: verboo_review(codigo)
    VB-->>C: Review aponta 2 melhorias
    C->>Vc: Resultado final revisado
```

### Geracao de testes

> "Claude, use o `verboo_code` para gerar testes unitarios para cada funcao neste modulo. Depois execute e me diga se passam."

---

## Recursos do MCP server

O server tambem expoe **resources** e **prompts**:

| Tipo | URI | Descricao |
|------|-----|-----------|
| Resource | `verboo://models` | Lista de modelos com specs |
| Resource | `verboo://status` | Status da conexao |
| Prompt | `revisar-codigo` | Template de code review |
| Prompt | `refatorar` | Template de refatoracao |
| Prompt | `explicar` | Template de explicacao |

---

## Variaveis de ambiente

| Variavel | Default | Descricao |
|----------|---------|-----------|
| `VERBOO_API_KEY` | — | **Obrigatoria.** Chave da API Verboo |
| `VERBOO_BASE_URL` | `https://code.verboo.ai/router/v1` | URL base da API |
| `VERBOO_LOG_LEVEL` | `info` | Nivel de log: `debug`, `info`, `warn`, `error` |
| `VERBOO_AGENT_ALLOWED_ROOTS` | — | Raizes repo-aware separadas pelo delimitador de paths do SO; sem valor, `verboo_agent` falha fechado |
| `VERBOO_AGENT_WRITE_ENABLED` | — | Defina `1` para habilitar `write`; por padrao somente `read_only` e aceito |
| `VERBOO_AGENT_MAX_CONCURRENCY` | `1` | Execucoes simultaneas do agente; inteiro entre 1 e 8, valores invalidos usam 1 |
| `VERBOO_AGENT_EXECUTOR` | `opencode` | `native` usa Verboo Code/OAuth; `opencode` preserva compatibilidade |
| `VERBOO_CODE_BIN` | `verboo` | Executavel da CLI oficial; pode ser Node quando `VERBOO_CODE_ENTRYPOINT` estiver definido |
| `VERBOO_CODE_ENTRYPOINT` | — | Caminho opcional para `@verboo/code/dist/cli.mjs` |
| `VERBOO_OPENCODE_BIN` | `opencode` | Caminho do OpenCode 1.17.9+ |
| `VERBOO_ENV_FILE` | — | Arquivo opcional lido por `bin/verboo-mcp` para obter `VERBOO_API_KEY` sem `source` |
| `VERBOO_NODE_BIN` | `node` | Binario Node usado por `bin/verboo-mcp` |

---

## Desenvolvimento

```bash
git clone https://github.com/nikolasdehor/verboo-bridge.git
cd verboo-bridge
npm install
node index.mjs
npm test
```

Testar o MCP server:

```bash
# Inicializar e listar tools
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node index.mjs
```

---

## Licenca

MIT — use, modifique, compartilhe.
