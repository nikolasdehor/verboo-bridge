Use when the task is large, repetitive, or volume-heavy - delegate execution to Verboo models with unlimited tokens.

## How it works

The `verboo-bridge` MCP server exposes 9 tools. Call them like any other MCP tool.

## Available tools

### Convenience tools

- `verboo_code(prompt, system?, model?, temperature?, max_tokens?)`
  - Default model: `deepseek-v4-flash` (best CxB, 1M ctx)
- `verboo_review(code, context?, model?, temperature?)`
  - Default model: `deepseek-v4-flash`

### Model-specific tools

| Tool | Model | When to use |
|------|-------|-------------|
| `verboo_deepseek_v4_flash` | DeepSeek V4 Flash | General coding, 1M ctx |
| `verboo_glm_5_2` | GLM 5.2 | Complex reasoning, 512K ctx |
| `verboo_mimo_v2_5` | Mimo V2.5 | Heavy analysis, 1M ctx |
| `verboo_kimi_k2_7` | Kimi K2.7 | Balanced tasks |
| `verboo_minimax_m3` | Minimax M3 | Coding, 1M ctx |
| `verboo_glm_4_7_flash` | GLM 4.7 Flash | Quick tasks |
| `verboo_qwen3_6_27b` | Qwen 3.6 27B | Light tasks |

## Delegation pattern

```
1. Receive task from user
2. Split into orchestration (keep) + volume (delegate to Verboo)
3. Call verboo_code with clear instructions
4. Integrate result
5. Review/validate before presenting
```

## When to delegate

| Keep (Claude) | Delegate (Verboo) |
|---------------|-------------------|
| Architecture decisions | Bulk code generation |
| Security audits | Lint fixes, formatting |
| API design | Test writing |
| Debugging complex bugs | Refactoring known patterns |
| Prompt engineering | Code review of many files |
| User interactions | Documentation generation |

## Available resources

- `verboo://models` — JSON list of all models with specs
- `verboo://status` — Connection status

## Available prompts

- `revisar-codigo` — Code review prompt template
- `refatorar` — Refactoring prompt template
- `explicar` — Code explanation prompt template
