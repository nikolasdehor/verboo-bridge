---
name: verboo-executor
description: Delegate bounded editing, review, and analysis tasks to Verboo models through the repo-aware verboo_agent MCP tool.
---

# Verboo Executor

Use Verboo for bounded execution while the current assistant remains the
orchestrator, reviewer, and final validator.

## Native agent tool

Prefer `verboo_agent` when the task needs to inspect or modify a repository:

- Requires OpenCode 1.17.9 or newer.
- `prompt`: one concrete task with owned files and validation commands.
- `cwd`: project directory under `VERBOO_AGENT_ALLOWED_ROOTS`.
- `mode`: `read_only` by default; use `write` only when the user authorized changes.
- `model`: `deepseek-v4-flash` by default; use `glm-5.2` for harder reasoning.
- `timeout_seconds`: 10-1800, normally 600.

`read_only` enables only repository inspection tools. `write` adds the edit tool;
shell, nested-agent, web, and external-directory tools remain disabled. The
orchestrator must run tests, linters, builds, Git commands, and every other command.
The bridge rejects `write` unless its server has `VERBOO_AGENT_WRITE_ENABLED=1`.
The subprocess inherits only a small environment allowlist, excluding GitHub, AWS,
and unrelated service tokens. Treat these controls as defense in depth, not a
security sandbox.

The tool returns a stable object with `status`, `summary`, `result`,
`next_actions`, `artifacts`, and the OpenCode `session_id`.

## Delegation pattern

1. Keep architecture, product decisions, secrets, production, and user communication
   with the orchestrator.
2. Give Verboo a narrow task and explicit file ownership.
3. Use `read_only` for exploration or review.
4. Use `write` only for an authorized, bounded patch.
5. Inspect the diff and run the repository's own checks in the orchestrator.
6. Never let the Verboo agent commit, push, deploy, or handle credentials.

For health, auth, clinical, financial, tenant-isolation, or other high-risk code,
use Verboo only as an additional opinion. The primary security/code reviewer owns
the decision.

## Text-only tools

Use `verboo_code`, `verboo_review`, or a model-specific tool only when all required
context is already in the prompt. They do not read files or run tests.

## Privacy

Do not send `.env`, credentials, private transcripts, production databases, logs,
patient/customer records, payment data, or other sensitive material to Verboo.

## Availability

After installing or changing the MCP configuration, restart Codex, Claude Code, or
the other MCP client. Tools are discovered at session startup and do not appear
inside an already-running session.
