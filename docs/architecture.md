# pi-side-agents architecture (as implemented)

This document describes the **current** behaviour of `pi-side-agents` as implemented in:

- `extensions/side-agents.ts`

Project-specific lifecycle scripts are created by the `agent-setup` skill under `.pi/` in your repository root. These files are **local/runtime configuration** and should remain **untracked**.

## 1) Problem statement

Run multiple Pi coding tasks in parallel without blocking the main session:

- Keep momentum in a primary Pi session.
- Spawn short-lived child Pi sessions in parallel.
- Isolate changes via **git worktrees + topic branches**.
- Provide observability (statusline + `/agents` + tools).

## 2) Public surfaces (stable contract)

### Commands

- `/agent [-model <provider/id-or-pattern>] <task>` — spawn a child agent.
- `/agents` — list tracked agents, show orphan worktree locks, offer interactive cleanup.
- `/agent-resume [prompt]` — pick a previously `/quit` child session and reopen it (conversation + branch) in a worktree/tmux window.

### Tools (for orchestration)

- `agent-start`
- `agent-check`
- `agent-wait-any`
- `agent-send`

These are the contract used by the Pi side-agent harness (and by other parent agents).

## 3) State root + on-disk layout

**State root** is normally the git repo root (`git rev-parse --show-toplevel`).

It can be overridden via environment variable:

- `PI_SIDE_AGENTS_ROOT` — used mostly so child sessions always write to the *parent* repo’s registry/runtime directories.

Paths (relative to state root):

- Registry: `.pi/side-agents/registry.json`
- Registry lock: `.pi/side-agents/registry.lock`
- Runtime per agent: `.pi/side-agents/runtime/<agentId>/`
  - `kickoff.md` — kickoff prompt text
  - `backlog.log` — tmux pane output (via `tmux pipe-pane`)
  - `exit.json` — exit marker written by launcher (`{ exitCode, finishedAt }`)
  - `launch.sh` — generated launcher script (what tmux runs)
- Runtime archive (when reusing an agent id): `.pi/side-agents/runtime-archive/<agentId>/<stamp>/...`

Worktree pool (sibling directories of repo root):

- `../<repoBasename>-agent-worktree-0001`
- `../<repoBasename>-agent-worktree-0002`
- ... (dynamic; no fixed cap)

Per-worktree lock (inside each worktree):

- `<worktree>/.pi/active.lock`

Merge critical-section lock (only if your **finish script** uses it):

- `.pi/side-agents/merge.lock`

## 4) Agent identity model

### 4.1 Agent IDs

Agent IDs are **kebab-case slugs** (e.g. `fix-auth-leak`, `add-auth-tests-2`).

- `/agent` generates a slug from the task (LLM-assisted when possible, with heuristic fallback).
- `agent-start` requires an explicit `branchHint` slug.
- IDs are deduplicated (`-2`, `-3`, …) against:
  - current registry entries
  - all existing `side-agent/<id>` branch refs (including parked, not-checked-out branches left behind by `/quit`)
  - any `side-agent/<id>` branches in `git worktree list --porcelain`

### 4.2 Branch names

Each agent uses a deterministic branch name:

- `side-agent/<agentId>`

## 5) Worktree pool manager

### 5.1 Slot selection

When starting an agent, the extension scans `..` (parent directory of repo root) for directories matching:

- `<repoBasename>-agent-worktree-####` (4-digit index)

It chooses the **first** usable unlocked slot:

- Skips slots with `.pi/active.lock`.
- Skips unlocked slots with local changes (`git status --porcelain` non-empty).
- Skips non-worktree directories that are non-empty.

If none are available, it creates the next slot with `git worktree add`.

### 5.2 Baseline commit

Agents are based on the **parent checkout’s current `HEAD`**, not necessarily the `main` branch:

- The parent’s `HEAD` commit hash is read once at spawn time.
- The agent worktree is hard-reset/cleaned to that commit.

This is intentional: it lets you spawn agents from whatever state you are currently on.

### 5.3 Reset/checkout policy for reused slots

For an already-registered worktree slot, the extension performs (best-effort):

- `git merge --abort` (ignore errors)
- `git checkout --detach` (so the reset below moves only HEAD, never the old branch ref — unmerged branches must survive slot recycling)
- `git reset --hard <parentHead>`
- `git clean -fd`
- `git checkout -B side-agent/<agentId> <parentHead>`

It then tries to delete the previous branch name (only if fully merged) to avoid accumulating old side-agent branches.

### 5.3b Resume allocation (`/agent-resume`)

Resume discovery filters pi's own session registry (`SessionManager.list`) down to this repo's worktree slots, keeps only sessions carrying a `side-agent-link` entry (the last such entry names the agent id → branch `side-agent/<id>`), excludes sessions of currently tracked agents, and offers the newest ~20. When several sessions share an agent id, only the newest may reattach the branch; older ones get a fresh branch.

Worktree allocation in resume mode:

- Branch still checked out in an **idle, unlocked slot** → resume in place; the working tree is left untouched (it may carry uncommitted state from before `/quit`).
- Branch exists but is not checked out → normal slot selection, then `git checkout <branch>` (no reset to parent HEAD).
- Branch was pruned (it was fully merged) → recreated from current HEAD with a warning.

The child pi is launched with `--session <file>` when the session's recorded cwd matches the allocated worktree (in-place), and with `--fork <file>` otherwise — pi restores the session's cwd from its header, so re-homing into a different slot requires a fork. No `--model` is passed on resume (the session restores its own model); an optional `/agent-resume [prompt]` argument is sent as the kickoff message, otherwise the session reopens idle.

### 5.4 Worktree lock file (`.pi/active.lock`)

A JSON lock file is written into the chosen worktree:

- `<worktree>/.pi/active.lock`

Example (fields may evolve):

```json
{
  "agentId": "fix-auth-leak",
  "sessionId": "/path/to/parent/session.jsonl",
  "parentSessionId": "/path/to/parent/session.jsonl",
  "pid": 12345,
  "branch": "side-agent/fix-auth-leak",
  "startedAt": "2026-03-03T02:58:00.000Z",
  "tmuxWindowId": "@19",
  "tmuxWindowIndex": 3
}
```

Notes:

- `sessionId` is initially written as the parent session id, then updated by the **child** session to its own session id once linked.
- Orphan/stale lockfiles are never auto-deleted; `/agents` can offer a **user-confirmed** reclaim.

### 5.5 Replicating `.pi/side-agent-*` into worktrees

On allocation, the extension symlinks any entries in the parent repo’s `.pi/` whose names start with `side-agent-` into the child worktree’s `.pi/`.

This is how child worktrees discover:

- `.pi/side-agent-start.sh`
- `.pi/side-agent-finish.sh`
- `.pi/side-agent-skills/` (child-only skill directory)
- optional `.pi/side-agent-bootstrap.sh`

## 6) Tmux orchestrator + launcher

### 6.1 Preconditions

- `tmux` must be installed.
- `/agent` must be executed from within a tmux session.

### 6.2 Window lifecycle

- A new window is created in the **current tmux session**, named `agent-<agentId>`.
- The tmux pane is piped into `backlog.log`.
- The window runs the generated `launch.sh`.
- On Pi exit, the launcher writes `exit.json`, prompts:
  - `Press any key to close this tmux window…`
  and then kills the tmux window.

### 6.3 Child environment variables

The launcher exports (at minimum):

- `PI_SIDE_AGENT_ID`
- `PI_SIDE_PARENT_SESSION`
- `PI_SIDE_PARENT_REPO`
- `PI_SIDE_AGENTS_ROOT`
- `PI_SIDE_RUNTIME_DIR`

The child session uses these to link itself into the parent registry and to update the worktree lock.

## 7) Registry + status model

### 7.1 Registry file

Registry is a single JSON file:

- `.pi/side-agents/registry.json`

Writes are protected by:

- `.pi/side-agents/registry.lock`

Lock behaviour:

- Wait timeout: ~10s
- Stale lock reap: lock file older than ~30s is considered stale and removed

### 7.2 Runtime refresh rules

When the parent (or tools) refresh an agent record:

- If `exit.json` exists:
  - sets `exitCode` + `finishedAt`
  - marks status `done` for exit code `0`, else `failed`
  - removes `.pi/active.lock`
  - **auto-prunes** successful (`exitCode=0`) agents from registry
- If the tmux window is gone but no exit marker was recorded:
  - marks `crashed`
  - sets `error: "tmux window disappeared before an exit marker was recorded"` if missing
  - removes `.pi/active.lock`

### 7.3 Statuses

Statuses currently used by the core extension:

- `allocating_worktree` — parent is reserving record / picking a slot
- `spawning_tmux` — runtime dir + tmux window + launcher are being set up
- `running` — child is actively producing output
- `waiting_user` — child is idle and waiting for input (set from Pi lifecycle events in the child)
- `failed` — agent exited non-zero (exit marker recorded)
- `crashed` — tmux window disappeared without an exit marker
- `done` — internal terminal success state; record is usually immediately pruned

Statuses reserved for future / project-specific integration:

- `starting`
- `finishing`
- `waiting_merge_lock`
- `retrying_reconcile`

## 8) Statusline integration

In UI sessions, the extension polls every ~2.5s and sets a statusline segment under key `side-agents`.

Format (approx):

- `<id>:<short>@<tmuxWindowIndex>`

Example:

- `fix-auth-leak:wait@3 add-auth-tests:run@5`

## 9) Child lifecycle scripts (project-local)

The extension does **not** hardcode your bootstrap/merge policy.

Instead, `/skill:agent-setup` scaffolds these project-local (untracked) files:

- `.pi/side-agent-start.sh` — optional bootstrap/validation hook (run by launcher if executable)
  - Important: do **not** reset the worktree’s HEAD here; the extension already checked out the correct commit/branch.
- `.pi/side-agent-finish.sh` — your finish policy (default template: rebase + fast-forward)
- `.pi/side-agent-skills/finish/SKILL.md` — a child-only skill that invokes the finish script after explicit user confirmation

If your finish script uses a parent-side merge critical section, it typically implements it via `.pi/side-agents/merge.lock`.

## 10) Tool contract (current)

### 10.1 `agent-start`

Input:

```json
{ "description": "...", "branchHint": "fix-auth-leak", "model": "optional" }
```

Output (success):

```json
{ "ok": true, "id": "fix-auth-leak", "tmuxWindowId": "@19", "tmuxWindowIndex": 3, "worktreePath": "...", "branch": "side-agent/fix-auth-leak", "warnings": [] }
```

Notes:

- The `description` is sent verbatim.
- No parent context summary is added for tool-started agents.

### 10.2 `agent-check`

Input:

```json
{ "id": "fix-auth-leak" }
```

Output:

- `{ ok: true, agent: { ... }, backlog: string[] }` or `{ ok: false, error }`

### 10.3 `agent-wait-any`

Input:

```json
{ "ids": ["fix-auth-leak", "add-auth-tests"], "states": ["waiting_user", "failed"] }
```

Notes:

- Default wait states are `waiting_user | failed | crashed`.
- Fails fast on unknown ids on the first poll.
- If all requested ids disappear from registry (often meaning they all exited successfully), returns `{ ok:false, error }`.

### 10.4 `agent-send`

Input:

```json
{ "id": "fix-auth-leak", "prompt": "!/quit" }
```

Prefix rules:

- `!` — send Ctrl+C first; if there is more text after `!`, wait ~300ms, then send it.
- `/` — forwarded as-is; Pi interprets it as a slash command.
