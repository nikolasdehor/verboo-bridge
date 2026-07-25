Use when the task at hand is large, repetitive, volume-heavy, or parallelizable:
- Code review of 5+ files
- Large refactors across many files
- Batch operations (rename, migrate, format)
- Running multiple independent subtasks in parallel
- Any task where Claude's context or rate limit would be hit

## How to use

The MCP server `verboo-bridge` exposes 9 tools:

### Model-specific tools

| Tool | Model | Best for |
|------|-------|----------|
| `verboo_deepseek_v4_flash` | DeepSeek V4 Flash | General coding, 1M ctx, best CxB |
| `verboo_glm_5_2` | GLM 5.2 (Ultra) | Complex reasoning, WebDev #2, 512K ctx |
| `verboo_mimo_v2_5` | Mimo V2.5 | Analysis, 1M ctx |
| `verboo_glm_4_7_flash` | GLM 4.7 Flash | Quick tasks |
| `verboo_kimi_k2_7` | Kimi K2.7 | General, 256K ctx |
| `verboo_minimax_m3` | Minimax M3 | Coding, 1M ctx |
| `verboo_qwen3_6_27b` | Qwen 3.6 27B | Light tasks |

### Convenience tools

- `verboo_code(prompt, system?, model?)` - Execute coding/implementation
- `verboo_review(code, context?, model?)` - Code review with context

## When to delegate

| Claude handles (complex reasoning) | Verboo handles (volume) |
|-------------------------------------|------------------------|
| Architecture decisions | Bulk code generation |
| Security audits | Lint fixes, formatting |
| API design | Test writing |
| Debugging complex bugs | Refactoring known patterns |
| Orchestration coordination | Parallel subtask execution |
| Prompt engineering | Code review of many files |
| User-facing decisions | Documentation generation |

## Delegation pattern

```
1. Claude receives task
2. Claude splits into orchestration (keeps) + volume (delegates to Verboo)
3. Claude calls `verboo_code` with clear prompt + system instructions
4. Claude integrates Verboo's output into the final result
5. Claude reviews/validates the result before presenting to user
```

## Model selection guide

- **deepseek-v4-flash**: default for most coding tasks (82-89% SWE-bench, 1M ctx)
- **glm-5.2**: when task needs stronger reasoning (62.1% SWE-bench Pro, 81.0 Terminal-Bench, #2 WebDev Arena)
- **mimo-v2.5**: analysis-heavy tasks (1M ctx)
- **qwen3.6-27b**: very simple/queries (cheapest)

## Cost awareness

Verboo Pro = R$174/mes flat, unlimited tokens.
Claude Max 20x = $200/mes with weekly caps.
Prioritize Verboo for high-volume work to preserve Claude cap.
