# pi-parallel-agents

Parallel agent orchestration for Pi.

## Goal

Keep your main coding flow unblocked by offloading side quests (questions, hotfixes, cleanups, follow-ups) to background child Pi agents running in isolated worktrees and tmux windows.

## Planned capabilities

- `/agent <task>` to spawn a child agent in a dedicated tmux window
- Child lifecycle scripts for deterministic setup/finish flow
- Worktree pool with lock tracking and reuse
- Parent statusline integration (agent state + tmux window id)
- Agent control tools (`agent-start`, `agent-check`, `agent-wait-any`, `agent-send`)
- Optional swarm workflows for overnight autonomous cleanup work

## Status

Early scaffold.

## Docs

- Architecture draft: `docs/architecture.md`
- Implementation checklist: `docs/todo.md`

## Next steps

1. Confirm open design decisions (merge policy, branch naming, stale lock handling, approval flow).
2. Implement `/agent` command baseline flow.
3. Implement worktree pool management.
4. Add child lifecycle scripts and finish skill.
5. Expose parent-agent control tools.
6. Integrate statusline updates.
