---
name: verboo-executor
description: Delegate bounded editing, review, and analysis tasks to Verboo models through the repo-aware verboo_agent MCP tool.
---

# Verboo Executor

Use Verboo for bounded execution while the current assistant remains the
orchestrator, reviewer, and final validator.

## Native agent tool

Prefer `verboo_agent` when the task needs to inspect or modify a repository:

- Use `verboo_route` first when you need an explainable ranking without executing
  an agent.
- `prompt`: one concrete task with owned files and validation commands.
- `cwd`: project directory under `VERBOO_AGENT_ALLOWED_ROOTS`.
- `executor`: choose `native` to use the Verboo Code/Claude Code-style harness
  with OAuth, or `opencode` to use the OpenCode fallback.
- `mode`: `read_only` by default; use `write` only when the user authorized changes.
- `model`: `auto` by default. Pin a model only when the orchestrator has a
  concrete reason to override the explainable router.
- `timeout_seconds`: 10-1800, normally 600.

Prefer `native` when `@verboo/code` is installed and authenticated. It keeps
Verboo's own agent harness while the MCP caller remains the orchestrator.
Use `opencode` when the caller explicitly wants the OpenCode harness or native
OAuth is unavailable.

`read_only` enables only repository inspection tools. `write` adds the edit tool;
shell, nested-agent, web, and external-directory tools remain disabled. The
orchestrator must run tests, linters, builds, Git commands, and every other command.
The bridge rejects `write` unless its server has `VERBOO_AGENT_WRITE_ENABLED=1`.
The subprocess inherits only a small environment allowlist, excluding GitHub, AWS,
and unrelated service tokens. Treat these controls as defense in depth, not a
security sandbox.

The auto router classifies coding, security, review, UX/web, analysis, long
context, and quick tasks. It also considers in-flight work, recent use, failures,
and cooldown so concurrent calls are distributed without blind round-robin.
Recoverable model errors can fall back to a freshly ranked model only in
`read_only`; `write` and explicit model choices never rotate silently.

The tool returns a stable object with `status`, `summary`, `result`,
`next_actions`, `artifacts`, `executor`, the executor `session_id`, and
`routing` metadata with the reason, ranking, and attempts.

## Delegation pattern

1. Keep architecture, product decisions, secrets, production, and user communication
   with the orchestrator.
2. Give Verboo a narrow task and explicit file ownership.
3. Keep `model: auto` unless a manual model choice is justified; inspect
   `verboo_route` when the routing decision matters.
4. Choose `native` or `opencode` explicitly when the harness matters.
5. Use `read_only` for exploration or review.
6. Use `write` only for an authorized, bounded patch.
7. Inspect the diff and run the repository's own checks in the orchestrator.
8. Never let the Verboo agent commit, push, deploy, or handle credentials.

For health, auth, clinical, financial, tenant-isolation, or other high-risk code,
use Verboo only as an additional opinion. The primary security/code reviewer owns
the decision.

## Text-only tools

Use `verboo_code`, `verboo_review`, or a model-specific tool only when all required
context is already in the prompt. They do not read files or run tests.

## No direct CLI fallback

Never invoke `verboo`, `vb`, `opencode`, or any equivalent Verboo command through
the shell for repository delegation. Do not reproduce the bridge's internal
arguments, use `--permission-mode bypassPermissions`, or treat a shell command as
an MCP call.

If `verboo_agent` is missing or the MCP server is stale, stop and report the
configuration problem. Ask the user to configure or restart the MCP client. Do
not silently fall back to the CLI.

## Privacy

Do not send `.env`, credentials, private transcripts, production databases, logs,
patient/customer records, payment data, or other sensitive material to Verboo.

## Availability

After installing or changing the MCP configuration, restart Codex, Claude Code, or
the other MCP client. Tools are discovered at session startup and do not appear
inside an already-running session.
