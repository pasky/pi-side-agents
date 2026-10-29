# pi-side-agents recovery runbook

Practical recovery steps for common side-agent failures.

> Assumptions: run commands from the **parent repo root** (git toplevel), unless noted.
>
> Agent IDs are **slugs** (e.g. `fix-auth-leak`, `add-auth-tests-2`). Replace examples accordingly.

## Quick state map

- Registry: `.pi/side-agents/registry.json`
- Registry lock: `.pi/side-agents/registry.lock`
- Runtime files per agent:
  - `.pi/side-agents/runtime/<agent-id>/kickoff.md`
  - `.pi/side-agents/runtime/<agent-id>/backlog.log`
  - `.pi/side-agents/runtime/<agent-id>/exit.json`
  - `.pi/side-agents/runtime/<agent-id>/launch.sh`
- Runtime archive (if an agent id was reused):
  - `.pi/side-agents/runtime-archive/<agent-id>/...`
- Worktree lock per agent slot:
  - `../<repo>-agent-worktree-XXXX/.pi/active.lock`
- Merge critical-section lock (only if your finish script uses it):
  - `.pi/side-agents/merge.lock`

---

## 1) Unknown / invalid agent IDs

### Symptoms

- `agent-check`: `{ "ok": false, "error": "Unknown agent id: ..." }`
- `agent-wait-any`: `{ "ok": false, "error": "Unknown agent id(s): ..." }` (fails fast on first poll)
- `agent-send`: `{ "ok": false, "message": "Unknown agent id: ..." }`

### Why it happens

- You mistyped the id (common).
- The agent **finished successfully** and was auto-pruned from the registry.

### Recovery

1. List known agents:
   - `/agents`

2. Retry with an existing id.

3. If you expected a just-started agent, check registry directly:

```bash
node -e 'const fs=require("fs");const p=".pi/side-agents/registry.json";if(!fs.existsSync(p)){console.log("registry missing");process.exit(0)};const r=JSON.parse(fs.readFileSync(p,"utf8"));console.log(Object.keys(r.agents||{}).sort().join("\n"));'
```

4. If the id is gone but you need logs, inspect runtime artifacts:

```bash
ID="fix-auth-leak"
ls -la ".pi/side-agents/runtime/$ID" 2>/dev/null || true
[ -f ".pi/side-agents/runtime/$ID/backlog.log" ] && tail -n 120 ".pi/side-agents/runtime/$ID/backlog.log"

# If the id was reused, older logs may have been archived:
find ".pi/side-agents/runtime-archive/$ID" -maxdepth 3 -type f -name backlog.log 2>/dev/null | head
```

---

## 2) Agent crashed / tmux window disappeared

### Symptoms

- Agent status becomes `crashed`
- Error often: `tmux window disappeared before an exit marker was recorded`
- `agent-send` returns `tmux window is not active`

### Recovery

1. Inspect current state (tool):

```text
agent-check { "id": "<id>" }
```

2. Inspect runtime artifacts:

```bash
ID="fix-auth-leak"
ls -la ".pi/side-agents/runtime/$ID"
tail -n 120 ".pi/side-agents/runtime/$ID/backlog.log"
[ -f ".pi/side-agents/runtime/$ID/exit.json" ] && cat ".pi/side-agents/runtime/$ID/exit.json"
```

3. If tmux window still exists, try graceful stop (tool):

```text
agent-send { "id": "<id>", "prompt": "!/quit" }
```

4. If tmux window is gone (e.g. after a reboot or tmux server restart), treat as terminal crash:

- collect backlog/error
- usually just `/agent-resume` it: failed/crashed agents' sessions are listed there, and resuming one replaces its stale registry record and releases its worktree lock
- or spawn a replacement agent (`/agent ...` or `agent-start`) and clean up the old record (see section 5)

---

## 3) Stale registry lock contention (`registry.lock`)

### Symptoms

- Commands/tools fail with: `Timed out waiting for lock .../.pi/side-agents/registry.lock`

### Notes

- Registry writes use a file lock.
- Lock wait timeout is ~10s.
- Lock files older than ~30s are automatically considered stale and reaped.

### Recovery

1. Inspect lock file and timestamp:

```bash
LOCK=".pi/side-agents/registry.lock"
ls -l "$LOCK" 2>/dev/null || echo "no registry.lock"
[ -f "$LOCK" ] && cat "$LOCK"
```

2. If lock keeps timing out and no active parent operation is running, remove stale lock:

```bash
rm -f ".pi/side-agents/registry.lock"
```

3. Retry the failed action (`/agents`, `agent-check` tool, etc.).

4. If contention recurs, reduce concurrent parent sessions mutating the same registry.

---

## 4) Stale worktree `.pi/active.lock` files

### Symptoms

- Start warnings such as:
  - `Locked worktree is not tracked in registry: ...`
- New agents skip a slot that looks abandoned.

### Recovery

1. List lock files in worktree pool:

```bash
REPO_NAME="$(basename "$PWD")"
find .. -maxdepth 2 -type f -path "../${REPO_NAME}-agent-worktree-*/.pi/active.lock" -print
```

2. Inspect each lock and cross-check with `/agents` or `registry.json`.

3. Fast path: run `/agents` and confirm **Reclaim orphan worktree locks?** when offered.

- This only targets orphan locks with **no tracked registry agent** and **no live pid/tmux signal**.

4. Manual cleanup (if you prefer): remove lock files directly:

```bash
LOCK="../<repo>-agent-worktree-0007/.pi/active.lock"
rm -f "$LOCK"
```

5. Before reusing/removing that worktree, check for uncommitted changes:

```bash
WT="../<repo>-agent-worktree-0007"
git -C "$WT" status --short
```

If non-empty, preserve work first (commit/patch) before destructive cleanup.

---

## 5) Failed/crashed agents cleanup flow

Use this when an agent is terminal (`failed` or `crashed`) and you want to tidy state.

1. Capture diagnostics first:
   - `agent-check` tool for `<id>`
   - save backlog/error if needed

2. Preserve any useful work in the agent worktree (`git -C <worktree> status`, patch/commit).

3. Remove registry entry (recommended path):
   - run `/agents`
   - confirm **Clean up failed agents?** prompt

4. Clean runtime and lock leftovers for that id:

```bash
ID="fix-auth-leak"
WT="../<repo>-agent-worktree-0001"   # use actual worktreePath from agent-check
rm -rf ".pi/side-agents/runtime/$ID"
rm -f "$WT/.pi/active.lock"
```

5. If tmux window still exists unexpectedly, close it:

```bash
tmux kill-window -t "@<window-id>" 2>/dev/null || true
```

---

## 6) Safe manual inspection commands (registry/runtime/locks)

### Read-only inspection

```bash
# Registry summary (id, status, tmux window, worktree)
node -e 'const fs=require("fs");const p=".pi/side-agents/registry.json";if(!fs.existsSync(p)){console.log("registry missing");process.exit(0)};const r=JSON.parse(fs.readFileSync(p,"utf8"));for(const id of Object.keys(r.agents||{}).sort()){const a=r.agents[id];console.log(`${id}\t${a.status}\t${a.tmuxWindowId??"-"}\t${a.worktreePath??"-"}`)}'

# Runtime dirs
find .pi/side-agents/runtime -maxdepth 2 -mindepth 2 -type d 2>/dev/null | sort

# Lock files
ls -l .pi/side-agents/*.lock 2>/dev/null || true
REPO_NAME="$(basename "$PWD")"; find .. -maxdepth 2 -type f -path "../${REPO_NAME}-agent-worktree-*/.pi/active.lock" -print
```

### Safe cleanup primitives

```bash
# Remove only known-stale lock files
rm -f .pi/side-agents/registry.lock
rm -f .pi/side-agents/merge.lock
rm -f ../<repo>-agent-worktree-XXXX/.pi/active.lock

# Remove runtime artifacts for one terminal agent
rm -rf .pi/side-agents/runtime/<agent-id>
```

Prefer `/agents` for registry record cleanup to avoid manual JSON edits while another session may be writing.
