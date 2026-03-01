# pi-parallel-agents implementation TODO

## Current decisions

- Default finish path is local rebase + fast-forward (with explicit in-skill user confirmation).
- `/agent` includes context summary by default.
- Worktree pool is dynamic (no hard cap).
- Stale locks are warning-only by default in MVP; `/agents` can offer user-confirmed auto-reclaim for orphan worktree locks.
- Child-local `LGTM` can trigger finish flow.
- Parent checkout is not forced read-only.

## Phase 0 — Foundation

- [x] Create project structure (`extensions/`, `docs/`, script template scaffolder via `/agent-setup`).
- [ ] Define config file shape (`.pi/parallel-agents/config.json` or equivalent).
- [x] Add typed models for Agent, WorktreeSlot, RegistryState.
- [ ] Add logging helpers and error taxonomy.

**Exit criteria**: module skeleton in place; baseline integration harness added.

## Phase 1 — `/agent` baseline command

- [x] Implement command parser for `/agent [-model ...] <task>`.
- [x] Implement kickoff prompt builder (task + optional context summary).
- [x] Allocate agent id and initialize registry record.
- [x] Spawn child Pi in new tmux window.
- [x] Return immediate user confirmation including agent id + tmux window.

**Exit criteria**: ✅ user can launch child agent and continue working in parent.

## Phase 2 — Worktree pool manager

- [x] Implement pool slot discovery using pattern `../<cwd>-agent-worktree-%04d`.
- [x] Add create/reuse logic via `git worktree`.
- [x] Implement `.pi/active.lock` write/read/validate with session id diagnostics.
- [x] Detect orphaned/stale locks and show warnings.
- [ ] Ensure cleanup/unlock on normal finish.

**Exit criteria**: largely met; unlock policy on finish remains to be hardened.

## Phase 3 — Child lifecycle scripts + finish skill

- [x] Scaffold `.pi/parallel-agent-start.sh`.
- [ ] Enforce branch/head sync policy in start script (currently lightweight bootstrap hook only).
- [x] Resync `.pi` and run dependency/bootstrap hook surface.
- [x] Scaffold `.pi/parallel-agent-skills/finish/SKILL.md`.
- [x] Implement `.pi/parallel-agent-finish.sh` for deterministic rebase + fast-forward loop baseline.

**Exit criteria**: scaffolded and functional baseline; policy hardening still needed.

## Phase 4 — Statusline + observability

- [x] Expose active-agent summary from registry.
- [x] Render status + tmux window id in project statusline.
- [x] Implement `agent-check` payload with backlog tail.
- [x] Add crash/failure diagnostics output.

**Exit criteria**: ✅ parent can inspect running/failed child agents.

## Phase 5 — Agent control tools (swarm)

- [x] `agent-start` tool.
- [x] `agent-check` tool.
- [x] `agent-wait-any` tool.
- [x] `agent-send` tool with `!` interrupt and `/` command forwarding.
- [x] Add integration tests for multi-agent orchestration.
- [x] Audit and harden tool contracts:
  - `agent-start` success response now includes `ok: true` (consistent with error shape).
  - `agent-wait-any` fails fast (`{ ok: false }`) on first-pass unknown IDs instead of looping forever.
  - `agent-send` inserts a 300 ms pause after C-c interrupt so Pi can return to prompt before text lands.
  - `agent-check`, `agent-wait-any`, `agent-send` tools now wrapped in try/catch (registry lock timeout no longer propagates as an unhandled throw).
  - Tool descriptions updated to document exact input/output shapes, prefix semantics, and signal behaviour.
- [x] Add unit test suite (`tests/unit/tool-contract.test.mjs`, `npm run test:unit`) — 19 tests covering pure helpers, JSON shapes, `waitForAny` fail-fast, interrupt prefix stripping, branch naming.
- [x] Document tool contract in `README.md` ("Tool contract" section).

**Exit criteria**: ✅ orchestration primitives implemented, integration-tested, contract-hardened, and documented.

## Phase 6 — Hardening

- [ ] Retry policies for transient tmux/worktree failures.
- [ ] Graceful shutdown and cleanup on parent exit.
- [x] Concurrency guards for registry writes/reads.
- [x] Documentation for recovery runbooks (`docs/recovery.md`).

**Exit criteria**: robust behavior under crash/restart scenarios.

## Stretch goals

- [ ] Overnight autonomous chore planner (spawn N agents from one prompt).
- [ ] Policy profiles (`local-rebase`, `pr-only`, `read-only-main`).
- [ ] Optional persistent dashboard view.
