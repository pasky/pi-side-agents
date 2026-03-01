# pi-parallel-agents architecture (v0 draft)

## 1) Problem statement

`pi-parallel-agents` should let users keep momentum in a primary Pi session while side tasks execute in parallel child Pi sessions, each isolated in its own git worktree + tmux window.

Primary outcomes:

- No context-switch blocking in the main session.
- Safe parallel code changes via isolated branches/worktrees.
- Quick observability (statusline + check commands).
- Deterministic child lifecycle (start/setup → work → finish/rebase/PR).

## 2) Scope

### In scope (MVP)

- `/agent [-model ...] <task>` command from parent session.
- One child Pi process per task, launched in new tmux window.
- Worktree pool allocation/reuse with lock files.
- Parent-visible child status + tmux window id.
- Child lifecycle scripts (`.pi/parallel-agent-start.sh`, finish skill/script path).
- Programmatic control tools: `agent-start`, `agent-check`, `agent-wait-any`, `agent-send`.

### Out of scope (initially)

- Cross-machine/distributed scheduling.
- Complex priority queues/fairness policies.
- Full web dashboard (statusline + CLI checks first).

## 3) High-level architecture

```text
Parent Pi session
  ├─ /agent command handler
  │   ├─ AgentRegistry (state store)
  │   ├─ WorktreePoolManager
  │   ├─ TmuxOrchestrator
  │   └─ Prompt/HandoffBuilder
  ├─ Statusline integration
  └─ Agent control tools API

Child Pi session (one per agent)
  ├─ Bootstrapped by parallel-agent-start.sh
  ├─ Works inside allocated worktree + branch
  ├─ Reports status/log tail
  └─ Finishes via finish skill (merge/PR workflow)
```

## 4) Key components

### 4.1 `/agent` command handler

Responsibilities:

1. Parse flags (`-model`, future options).
2. Reserve worktree slot from pool.
3. Build kickoff prompt (task + optional context summary).
4. Spawn tmux window running child Pi command.
5. Register child metadata in parent registry.
6. Return immediately to parent user.

### 4.2 Agent registry

Persistent file-backed registry so all Pi sessions can render current child state.

Suggested location:

- Parent checkout: `.pi/parallel-agents/registry.json`
- Optional per-agent detail: `.pi/parallel-agents/agents/<agentId>.json`

Minimal fields per agent:

- `id`
- `parentSessionId`
- `childSessionId` (once known)
- `tmuxSession`
- `tmuxWindowId`
- `worktreePath`
- `branch`
- `model`
- `task`
- `status`
- `startedAt`, `updatedAt`, `finishedAt`
- `lastBacklogLines` (or pointer to backlog source)
- `exitCode` / `error`

### 4.3 Worktree pool manager

Pool naming requirement from your spec:

- `../$(basename "$cwd")-agent-worktree-%04d`

Each worktree contains `.pi/active.lock` with diagnostic info (at least session id).

Lock file JSON proposal:

```json
{
  "agentId": "a-0007",
  "sessionId": "...",
  "parentSessionId": "...",
  "pid": 12345,
  "tmuxWindowId": "@19",
  "branch": "parallel-agent/a-0007",
  "startedAt": "2026-02-27T04:58:00Z"
}
```

Rules:

- Reuse unlocked pool slots.
- If locked but not tracked in parent registry, warn as stale/orphaned lock.
- If slot missing, create via `git worktree add ...`.
- Ensure worktree branch policy is deterministic (`parallel-agent/<id>`).
- Treat branch naming as internal implementation detail (not UX-facing).

### 4.4 Tmux orchestrator

Responsibilities:

- Create/find target tmux session.
- Open new window per agent.
- Run child Pi launch command in that window.
- Capture tmux identifiers (`window_id`, `window_index`) for status display.
- On child exit, keep window open with a one-key acknowledgement prompt (`read`), then close.

### 4.5 Child lifecycle scripts

#### Start script

- Path: `.pi/parallel-agent-start.sh`
- Responsibilities:
  - Validate worktree + branch.
  - Sync branch baseline from main checkout HEAD (according to policy).
  - Resync `.pi` assets.
  - Run optional dependency bootstrap hook (project-configured; skipped if unset).
  - Emit structured diagnostics for failures.

#### Finish flow

- Skill path (planned): `.pi/parallel-agent-skills/finish/SKILL.md`
- Typical trigger: explicit child-local user approval (e.g., “LGTM”).
- Finish skill instruction should discuss/confirm finish action with user before executing.
- Default finish algorithm (`.pi/parallel-agent-finish.sh`):
  1. In child worktree on `parallel-agent/<id>`, run `git rebase main`.
  2. If rebase conflicts, keep user in child branch for resolution (`git rebase --continue`) and retry.
  3. If successful, enter short critical section in parent checkout and fast-forward `main` to `parallel-agent/<id>` (`git merge --ff-only`).
  4. If parent-side fast-forward fails (because main moved), return to child worktree, re-run step 1, retry.
  5. On success, release worktree lock and let the launcher exit with code 0 (successful agents are auto-pruned from registry).
- Optional alternative flow: create/push PR when explicitly requested.

### 4.6 Parent statusline integration

Display compact view in every Pi session in same project:

- Agent id
- status (`thinking`, `tool`, `pending`, `running`, `waiting_user`, `failed`, `crashed`)
- tmux window reference (index/id)

Requires lightweight polling or event update from registry.

### 4.7 Agent control tools (for swarm orchestration)

1. `agent-start(model?, description)` → `{ id, tmuxWindowId, ... }`
   - `description` is sent verbatim to the child (tool path does not add context summary).
   - Lifecycle contract: child implements requested changes, then **yields for review** (no immediate `/quit`).
2. `agent-check(id)` → status + compact backlog tail (sanitized/truncated for safe context usage)
3. `agent-wait-any(ids[], states?)` → blocks until one agent reaches any target state
   - default states: `waiting_user | failed | crashed`
   - optional `states` overrides defaults
4. `agent-send(id, prompt)`
   - `!` prefix: interrupt current thinking/tool call before dispatch
   - `/` prefix: pass command (e.g. `/quit`)

### 4.8 Merge critical-section lock (parent checkout)

Because multiple agents may try to finalize concurrently, parent-checkout merge should be serialized with a short-lived lock.

Suggested lock file:

- `.pi/parallel-agents/merge.lock`

Suggested lock contents (diagnostic JSON):

```json
{
  "agentId": "a-0007",
  "sessionId": "...",
  "pid": 12345,
  "acquiredAt": "2026-02-27T05:40:00Z"
}
```

Behavior:

- Lock is held only for parent-side `parallel-agent/<id> -> main` fast-forward attempt.
- If busy, finishing agents wait/retry with progress status.
- On stale lock detection, warn with manual recovery instructions (consistent with warn-only lock policy).

## 5) State model

Suggested normalized states:

- `allocating_worktree`
- `spawning_tmux`
- `starting`
- `running`
- `waiting_user`
- `finishing`
- `waiting_merge_lock`
- `retrying_reconcile`
- `failed`
- `crashed`

UI can map these to compact labels/icons.

## 6) Baseline `/agent` flow (sequence)

1. Parent user runs `/agent <task>`.
2. Parent allocates worktree slot + writes lock.
3. Parent creates agent id + internal branch (`parallel-agent/<id>`).
4. Parent spawns tmux window and launches child with kickoff prompt.
5. Parent updates registry to `running` and returns control immediately.
6. Child performs work; status + backlog tail are queryable.
7. When implementation is ready, child yields for review (`waiting_user`) instead of quitting immediately.
8. Parent/user inspects results and can send follow-ups (`agent-send`) for revisions.
9. On explicit "wrap up" instruction, child runs finish flow (reconcile + serialized parent merge or PR policy).
10. After finish success, child can stay open for post-merge notes.
11. Parent/user finally quits child (`/quit`), launcher writes exit marker, tmux window closes, and successful records are pruned from registry.

## 7) Failure and recovery

- If child crashes: mark `crashed`, retain logs/backlog pointer.
- If tmux window disappears unexpectedly: mark `failed` with diagnostics.
- If lock exists without live child and no registry record: show stale-lock warning + recovery guidance.
- If parent fast-forward fails because `main` moved: return to child branch rebase step, retry.
- If finish integration fails for other reasons: keep branch/worktree, emit actionable next steps.
- If merge lock appears stale: warn and provide manual recovery guidance.

## 8) Security / safety constraints

- Never auto-merge without explicit approval policy.
- Do not enforce parent-checkout read-only mode in MVP (keep behavior policy-driven).
- Persist enough metadata for postmortem troubleshooting.

## 9) Agreed defaults (2026-02-27)

- Finish policy default: **local rebase + fast-forward**.
- Finish skill must **discuss/confirm** the action with user before running it.
- Parent checkout read-only mode: **not enforced**.
- `/agent` handoff/context summary: **enabled by default**.
- tmux window lifecycle: on child exit show **press-any-key/read** prompt, then close.
- Worktree pool sizing: **dynamic, no cap**.
- Stale lock handling: **warn only** (no auto-reclaim).
- Finish approval source: **child-local `LGTM` accepted**.

## 10) Remaining open decisions

1. **Bootstrap strictness**: keep startup bootstrap as optional hook (`.pi/parallel-agent-bootstrap.sh`) or enforce policy checks (e.g., branch/head sync hard-fail) by default?
2. **Status fidelity**: whether/how to expose richer live child states (`thinking` / `tool` / `pending`) instead of coarse runtime states only.
