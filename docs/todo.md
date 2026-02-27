# pi-parallel-agents implementation TODO

## Current decisions

- Default finish path is local merge (with explicit in-skill user confirmation).
- `/agent` includes context summary by default.
- Worktree pool is dynamic (no hard cap).
- Stale locks are warning-only in MVP.
- Child-local `LGTM` can trigger finish flow.
- Parent checkout is not forced read-only.

## Phase 0 — Foundation

- [ ] Create project structure (`src/`, `docs/`, script templates).
- [ ] Define config file shape (`.pi/parallel-agents/config.json` or equivalent).
- [ ] Add typed models for Agent, WorktreeSlot, RegistryState.
- [ ] Add logging helpers and error taxonomy.

**Exit criteria**: basic module skeleton compiles/tests run.

## Phase 1 — `/agent` baseline command

- [ ] Implement command parser for `/agent [-model ...] <task>`.
- [ ] Implement kickoff prompt builder (task + optional context summary).
- [ ] Allocate agent id and initialize registry record.
- [ ] Spawn child Pi in new tmux window.
- [ ] Return immediate user confirmation including agent id + tmux window.

**Exit criteria**: user can launch child agent and continue working in parent.

## Phase 2 — Worktree pool manager

- [ ] Implement pool slot discovery using pattern `../<cwd>-agent-worktree-%04d`.
- [ ] Add create/reuse logic via `git worktree`.
- [ ] Implement `.pi/active.lock` write/read/validate with session id diagnostics.
- [ ] Detect orphaned/stale locks and show warnings.
- [ ] Ensure cleanup/unlock on normal finish.

**Exit criteria**: multiple child agents get isolated, reusable worktrees safely.

## Phase 3 — Child lifecycle scripts + finish skill

- [ ] Scaffold `.pi/parallel-agent-start.sh`.
- [ ] Enforce branch/head sync policy in start script.
- [ ] Resync `.pi` and run dependency bootstrap hooks.
- [ ] Scaffold `.pi/parallel-agent-skills/finish/SKILL.md`.
- [ ] Implement `.pi/parallel-agent-finish.sh` for deterministic merge/PR path.

**Exit criteria**: child setup and closeout are consistent and reproducible.

## Phase 4 — Statusline + observability

- [ ] Expose active-agent summary from registry.
- [ ] Render status + tmux window id in project statusline.
- [ ] Implement `agent-check` payload with backlog tail.
- [ ] Add crash/failure diagnostics output.

**Exit criteria**: parent can quickly inspect every running child.

## Phase 5 — Agent control tools (swarm)

- [ ] `agent-start` tool.
- [ ] `agent-check` tool.
- [ ] `agent-wait-any` tool.
- [ ] `agent-send` tool with `!` interrupt and `/` command forwarding.
- [ ] Add integration tests for multi-agent orchestration.

**Exit criteria**: parent agent can autonomously coordinate child agents.

## Phase 6 — Hardening

- [ ] Retry policies for transient tmux/worktree failures.
- [ ] Graceful shutdown and cleanup on parent exit.
- [ ] Concurrency guards for registry writes/reads.
- [ ] Documentation for recovery runbooks.

**Exit criteria**: robust behavior under crash/restart scenarios.

## Stretch goals

- [ ] Overnight autonomous chore planner (spawn N agents from one prompt).
- [ ] Policy profiles (`local-merge`, `pr-only`, `read-only-main`).
- [ ] Optional persistent dashboard view.
