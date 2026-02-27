# pi-parallel-agents

Parallel agent orchestration for Pi.

## Goal

Keep your main coding flow unblocked by offloading side quests (questions, hotfixes, cleanups, follow-ups) to background child Pi agents running in isolated worktrees and tmux windows.

## Implemented (current)

- `/agent [-model ...] <task>` spawns a child Pi in a new tmux window
- Dynamic worktree pool (`../<repo>-agent-worktree-%04d`) with `.pi/active.lock`
- Worktree lock diagnostics (warn on locked worktrees not tracked in registry)
- Shared registry at `.pi/parallel-agents/registry.json`
- Statusline summary of active agents in project sessions
- Agent control tools:
  - `agent-start`
  - `agent-check`
  - `agent-wait-any`
  - `agent-send`
- Supporting commands:
  - `/agents`
  - `/agent-check <id>`
  - `/agent-send <id> <prompt>`
- **`agent-setup` skill** — interactive setup via `/skill:agent-setup` (interviews you about merge policy, main branch, bootstrap hooks, then writes `.pi/parallel-agent-*.sh` and the child finish skill)

## Status

MVP in progress (baseline flow implemented).

## Quick start

1. In your project, run:
   - `/skill:agent-setup` — answers a few questions, then writes lifecycle scripts tailored to your project
2. Spawn a child:
   - `/agent what does weirdMethod actually do?`
3. Inspect status:
   - statusline (`parallel-agents`)
   - `/agents`
   - `/agent-check a-0001`
4. Send follow-up:
   - `/agent-send a-0001 please also add tests`

## Docs

- Architecture draft: `docs/architecture.md`
- Implementation checklist: `docs/todo.md`

## Next steps

1. Harden finalize/merge loop and add conflict-recovery tests.
2. Improve runtime status fidelity (`thinking`/`tool`/`pending` detail) from child sessions.
3. Add optional PR flow to finish skill/script.
4. Add integration tests for concurrent agents and lock contention.
5. Polish UX around stale lock diagnostics and cleanup workflows.
