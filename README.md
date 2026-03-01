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
- Parent-side agent state-change feed as append-only `parallel-agent-status` messages in session history (plus error toasts for failed/crashed transitions)
- Agent control tools (tool-only; no `/agent-check` or `/agent-send` slash commands):
  - `agent-start`
  - `agent-check`
  - `agent-wait-any`
  - `agent-send`
- Supporting command:
  - `/agents` (lists agents, optionally cleans failed/crashed registry entries, and now offers interactive orphan `.pi/active.lock` reclaim)
- **`agent-setup` skill** — interactive setup via `/skill:agent-setup` (interviews you about finish policy, main branch, bootstrap hooks, then writes `.pi/parallel-agent-*.sh` and the child finish skill)

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
   - `agent-check` tool (for a specific id, e.g. `a-0001`)
4. Send follow-up:
   - `agent-send` tool (e.g. prompt: `please also add tests`)

## Tool contract (orchestrating parent agents)

The four tools below are designed for use by a parent Pi agent orchestrating
multiple children.  Each tool returns a JSON-encoded string inside a standard
tool-content block.  All tools return `{ ok: false, error: string }` on any
unexpected error, so callers can always do a consistent `payload.ok` check.

### `agent-start`

Start a background child agent in its own tmux window + git worktree.

Lifecycle expectation: the child should implement changes, then **yield for review** (not auto-`/quit`).
After review, parent/user asks the child to wrap up (finish flow), then quits it.

**Input**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `description` | string | ✅ | Kickoff prompt sent verbatim to the child.  No automatic context summary is added — embed all relevant context here. |
| `model` | string | optional | `provider/modelId`; inherits parent model if omitted. |

**Output (success)**

```json
{
  "ok": true,
  "id": "a-0001",
  "tmuxWindowId": "@5",
  "tmuxWindowIndex": 5,
  "worktreePath": "/abs/path/to/repo-agent-worktree-0001",
  "branch": "parallel-agent/a-0001",
  "warnings": []
}
```

**Output (failure)**

```json
{ "ok": false, "error": "tmux is required but not found" }
```

---

### `agent-check`

Inspect the current status and recent output of an agent.

`agent.task` is a compact preview; `backlog` is ANSI-stripped + truncated for safe LLM context usage, and includes synthetic `[parallel-agent][prompt] ...` kickoff-prompt lines written by the parent.

**Input**: `{ "id": "a-0001" }`

**Output (success)**

```json
{
  "ok": true,
  "agent": {
    "id": "a-0001",
    "status": "running",
    "tmuxWindowId": "@5",
    "tmuxWindowIndex": 5,
    "worktreePath": "/abs/path/...",
    "branch": "parallel-agent/a-0001",
    "task": "refactor auth module",
    "startedAt": "2026-01-01T00:00:00.000Z",
    "finishedAt": null,
    "exitCode": null,
    "error": null,
    "warnings": []
  },
  "backlog": ["last", "10", "log", "lines"]
}
```

**Status values**

- Non-terminal: `allocating_worktree` · `spawning_tmux` · `starting` · `running` · `waiting_user` · `finishing` · `waiting_merge_lock` · `retrying_reconcile`
- Terminal (persisted): `failed` · `crashed`
- Successful exits (`exitCode === 0`) are auto-removed from the registry.

**Output (failure)**

```json
{ "ok": false, "error": "Unknown agent id: a-9999" }
```

---

### `agent-wait-any`

Block until one of the given agents reaches a target state, then return its
`agent-check` payload.

**Input**:

```json
{ "ids": ["a-0001", "a-0002"], "states": ["waiting_user", "failed", "crashed"] }
```

`states` is optional. Default wait states are: `waiting_user`, `failed`, `crashed`.

**Behaviour**

- Polls every ~1 s; respects the tool's abort signal between cycles.
- Returns `{ ok: false, error }` **immediately** if any `id` is unknown on the
  first poll — unknown agents never become known, so waiting would be pointless.
- If all tracked ids disappear mid-wait (for example because they exited with code 0 and were auto-pruned), returns `{ ok: false, error }` instead of polling forever.
- Returns as soon as one agent matches any target state, with full `agent-check` payload.

---

### `agent-send`

Send a prompt or command to a running child agent's tmux pane.

**Input**: `{ "id": "a-0001", "prompt": "..." }`

**Prefix rules**

| Prefix | Behaviour |
|--------|-----------|
| `!text` | Send C-c interrupt; after a 300 ms delay (allowing Pi to return to prompt), send `text`. |
| `!` alone | Send C-c interrupt only; no follow-up text. |
| `/command` | Forwarded verbatim; Pi handles lines starting with `/` as slash commands. |
| _(none)_ | Text is pasted into the pane and Enter is pressed. |

**Output**

```json
{ "ok": true,  "message": "Sent prompt to a-0001" }
{ "ok": false, "message": "Agent a-0001 tmux window is not active" }
```

---

### Typical orchestration pattern

```
agent-start  → get id
   ↓
agent-wait-any([id])           ← default waits for waiting_user/failed/crashed
   ↓
check result.agent.status
  "waiting_user" → inspect backlog/diff, request fixes or send "wrap up"
  "failed"       → inspect error; retry/steer as needed
  "crashed"      → inspect logs, restart if needed

# After /quit with exitCode 0, agent is removed from registry.
# agent-check / agent-wait-any for that id will return unknown/disappeared.
```

---

## Integration tests

A full no-mocking integration suite is included at:

- `tests/integration/parallel-agents.integration.test.mjs`

It runs against real runtime pieces:

- temporary real git repositories/worktrees
- isolated real tmux servers/sessions
- real parent + child Pi processes
- real tmux screen-buffer assertions (`capture-pane`)
- real filesystem assertions for registry/runtime/lock side effects
- merge-lock serialization checks via real finish-script concurrency

Run locally:

```bash
npm run test:integration
```

Optional env vars:

- `PI_PARALLEL_IT_MODEL` (default: `openai-codex/gpt-5.1-codex-mini`)
- `PI_PARALLEL_IT_TIMEOUT_MS` (per-test timeout override)

Prerequisites:

- `tmux` installed
- authenticated Pi credentials in `~/.pi/agent/auth.json` (tests copy into an isolated `PI_CODING_AGENT_DIR`)

## Docs

- Architecture draft: `docs/architecture.md`
- Recovery runbooks: `docs/recovery.md`
- Implementation checklist: `docs/todo.md`

## Next steps

1. Harden finalize/rebase loop conflict UX in child guidance.
2. Improve runtime status fidelity (`thinking`/`tool`/`pending` detail) from child sessions.
3. Add optional PR flow to finish skill/script.
4. Add CI strategy for gated/manual integration test runs.
5. Polish UX around stale lock diagnostics and cleanup workflows.
