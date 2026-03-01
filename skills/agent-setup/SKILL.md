---
name: agent-setup
description: Initialize or update setup for pi-parallel-agents (running asynchronous agents spawned/controlled from main session)
---

# Parallel Agent Setup

Set up the pi-parallel-agents lifecycle scripts for this project.

Initial first time setup (no .pi/parallel-agent* yet): Work through two phases: interview, then file creation.

Update setup: Chat with the user about what needs changing, use file examples below as reference for comparison.

**Important (local-only files):** everything this skill creates is under `.pi/` and is runtime/local configuration. Do **not** `git add`, `git add -f`, or commit these files. They should remain untracked. If they were accidentally committed, remove them from git tracking while keeping them locally.

## Phase 1: Interview

Ask the user the following questions. You may ask them all at once or one at a time — use your judgment based on how they engage.

1. **Main branch name** – What is the primary integration branch? *(default: `main`)*

2. **Bootstrap steps** – Does each agent worktree need custom setup before work begins? For example: `npm install`, copying `.env` files, running migrations. If yes, what commands specifically?

3. **Merge policy** – When an agent finishes, should it:
   - **Merge locally** into the main branch in the parent checkout (default), or
   - **Open a pull request** instead?

4. **Overwrite existing files** – If `.pi/parallel-agent-start.sh` or similar already exist, overwrite them? *(default: no — skip existing files)*

Before asking the questions, autonomously try to answer questions 1, 2 and 4, and propose project-specific answers to the user.

Collect all answers before proceeding to Phase 2.

---

## Phase 2: Create Setup Files

Determine the git repo root:

```bash
GIT_ROOT=$(git rev-parse --show-toplevel)
```

Create the three files below. For each file, check whether it already exists before writing — if it exists and the user said not to overwrite, skip it and tell the user. Otherwise write (or overwrite) it.

---

### File 1: `$GIT_ROOT/.pi/parallel-agent-start.sh`

Write this file and make it executable (`chmod +x`).

Use `MAIN_BRANCH` set to whatever the user specified in question 1 (or `main` by default). The start script must enforce branch/head sync **before** bootstrap. Do **not** force-update the local `MAIN_BRANCH` ref (e.g. `git branch -f`) because that branch is often checked out in the parent worktree.

**Default content** — substitute `MAIN_BRANCH_VALUE` with the actual branch name, then append bootstrap steps based on question 2:

```bash
#!/usr/bin/env bash
set -euo pipefail

PARENT_ROOT="${1:-}"
WORKTREE="${2:-$(pwd)}"
AGENT_ID="${3:-unknown}"
MAIN_BRANCH="MAIN_BRANCH_VALUE"

BRANCH="$(git -C "$WORKTREE" branch --show-current 2>/dev/null || true)"
if [[ -z "$BRANCH" ]]; then
  echo "[parallel-agent-start] Could not determine current branch in $WORKTREE."
  exit 1
fi

echo "[parallel-agent-start] agent=$AGENT_ID branch=$BRANCH main=$MAIN_BRANCH"

REMOTE_MAIN_REF="refs/remotes/origin/$MAIN_BRANCH"
LOCAL_MAIN_REF="refs/heads/$MAIN_BRANCH"

if git -C "$WORKTREE" remote get-url origin >/dev/null 2>&1; then
  echo "[parallel-agent-start] Fetching origin/$MAIN_BRANCH..."
  git -C "$WORKTREE" fetch --prune origin "$MAIN_BRANCH" >/dev/null 2>&1 || \
    echo "[parallel-agent-start] origin/$MAIN_BRANCH not fetched (missing branch or fetch failure)."
else
  echo "[parallel-agent-start] No origin remote configured; checking local refs only."
fi

BASE_REF=""
BASE_LABEL=""
if git -C "$WORKTREE" show-ref --verify --quiet "$REMOTE_MAIN_REF"; then
  BASE_REF="$REMOTE_MAIN_REF"
  BASE_LABEL="origin/$MAIN_BRANCH"
elif git -C "$WORKTREE" show-ref --verify --quiet "$LOCAL_MAIN_REF"; then
  BASE_REF="$LOCAL_MAIN_REF"
  BASE_LABEL="$MAIN_BRANCH"
  echo "[parallel-agent-start] origin/$MAIN_BRANCH missing; using local $MAIN_BRANCH as fallback."
else
  echo "[parallel-agent-start] ERROR: missing both origin/$MAIN_BRANCH and local $MAIN_BRANCH."
  echo "[parallel-agent-start] Create/fetch $MAIN_BRANCH and rerun."
  exit 1
fi

if [[ "$BRANCH" == "$MAIN_BRANCH" ]]; then
  echo "[parallel-agent-start] ERROR: child worktree is on $MAIN_BRANCH; expected a dedicated agent branch."
  exit 1
fi

echo "[parallel-agent-start] Resetting $BRANCH to $BASE_LABEL."
git -C "$WORKTREE" checkout "$BRANCH" >/dev/null 2>&1
git -C "$WORKTREE" reset --hard "$BASE_REF" >/dev/null
```

- If the user wants **no custom bootstrap**: append the optional hook block:
  ```bash
  # Optional project bootstrap hook — create .pi/parallel-agent-bootstrap.sh to use.
  if [[ -x "$WORKTREE/.pi/parallel-agent-bootstrap.sh" ]]; then
    "$WORKTREE/.pi/parallel-agent-bootstrap.sh"
  fi
  ```

- If the user gave **specific bootstrap commands**: append them directly instead, e.g.:
  ```bash
  # Project bootstrap
  cd "$WORKTREE"
  npm install
  cp .env.example .env 2>/dev/null || true
  ```

---

### File 2: `$GIT_ROOT/.pi/parallel-agent-finish.sh`

Write this file and make it executable (`chmod +x`).

Use `MAIN_BRANCH` set to whatever the user specified (or `main` by default).

**For local merge policy** (default), use this content — substituting `MAIN_BRANCH_VALUE` with the actual branch name:

```bash
#!/usr/bin/env bash
set -euo pipefail

PARENT_ROOT="${PI_PARALLEL_PARENT_REPO:-${1:-}}"
AGENT_ID="${PI_PARALLEL_AGENT_ID:-${2:-unknown}}"
MAIN_BRANCH="MAIN_BRANCH_VALUE"
BRANCH="$(git branch --show-current)"

if [[ -z "$PARENT_ROOT" ]]; then
  echo "[parallel-agent-finish] Missing parent checkout path."
  echo "Usage: PI_PARALLEL_PARENT_REPO=/path/to/parent .pi/parallel-agent-finish.sh"
  exit 1
fi

if [[ -z "$BRANCH" ]]; then
  echo "[parallel-agent-finish] Could not determine current branch."
  exit 1
fi

LOCK_DIR="$PARENT_ROOT/.pi/parallel-agents"
LOCK_FILE="$LOCK_DIR/merge.lock"
mkdir -p "$LOCK_DIR"

MERGE_LOCK_TIMEOUT=120

acquire_lock() {
  local payload started elapsed
  payload="{\"agentId\":\"$AGENT_ID\",\"pid\":$$,\"acquiredAt\":\"$(date -Is)\"}"
  started=$(date +%s)
  while true; do
    if ( set -o noclobber; printf '%s\n' "$payload" > "$LOCK_FILE" ) 2>/dev/null; then
      return 0
    fi
    elapsed=$(( $(date +%s) - started ))
    if [[ "$elapsed" -ge "$MERGE_LOCK_TIMEOUT" ]]; then
      echo "[parallel-agent-finish] Timed out after ${MERGE_LOCK_TIMEOUT}s waiting for merge lock."
      echo "[parallel-agent-finish] Stale lock? Inspect: $LOCK_FILE"
      exit 3
    fi
    echo "[parallel-agent-finish] Waiting for merge lock... (${elapsed}s / ${MERGE_LOCK_TIMEOUT}s)"
    sleep 1
  done
}

release_lock() {
  rm -f "$LOCK_FILE" || true
}

trap 'release_lock' EXIT

while true; do
  echo "[parallel-agent-finish] Reconciling child branch: git merge $MAIN_BRANCH"
  if ! git merge "$MAIN_BRANCH"; then
    echo "[parallel-agent-finish] Conflict while merging $MAIN_BRANCH into $BRANCH."
    echo "Resolve conflicts here, then rerun .pi/parallel-agent-finish.sh"
    exit 2
  fi

  acquire_lock

  set +e
  (
    cd "$PARENT_ROOT" || exit 1
    git checkout "$MAIN_BRANCH" >/dev/null 2>&1 || exit 1
    git merge --no-edit "$BRANCH"
  )
  merge_status=$?
  set -e

  release_lock

  if [[ "$merge_status" -eq 0 ]]; then
    echo "[parallel-agent-finish] Success: merged $BRANCH -> $MAIN_BRANCH in parent checkout."
    rm -f "$(pwd)/.pi/active.lock" || true
    exit 0
  fi

  echo "[parallel-agent-finish] Parent merge failed (likely $MAIN_BRANCH moved)."
  echo "[parallel-agent-finish] Aborting parent merge and retrying reconcile loop..."
  (
    cd "$PARENT_ROOT" || exit 1
    git merge --abort >/dev/null 2>&1 || true
  )

  sleep 1
done
```

**For PR policy**: write a finish script that pushes the branch and opens a PR via the `gh` CLI:

```bash
#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="${PI_PARALLEL_AGENT_ID:-${1:-unknown}}"
MAIN_BRANCH="MAIN_BRANCH_VALUE"
BRANCH="$(git branch --show-current)"

echo "[parallel-agent-finish] Pushing $BRANCH..."
git push -u origin "$BRANCH"

echo "[parallel-agent-finish] Opening pull request against $MAIN_BRANCH..."
gh pr create --base "$MAIN_BRANCH" --head "$BRANCH" --fill
```

---

### File 3: `$GIT_ROOT/.pi/parallel-agent-skills/finish/SKILL.md`

This is a skill for the **child agent** (not this session) that tells it how to finalize its work.

**For local merge policy**, write:

```markdown
---
name: finish
description: Merge the branch with current work to upstream after explicit user sign-off (e.g. "LGTM")
---

# Parallel-agent finish workflow

When the user explicitly approves the work (e.g. says "LGTM", "ship it", "merge it"):

1. **Confirm** the finish action with the user before doing anything.

2. Run the finish script:

```bash
PI_PARALLEL_PARENT_REPO="$PI_PARALLEL_PARENT_REPO" .pi/parallel-agent-finish.sh
```

3. If the finish script exits with code 2 (conflict merging MAIN_BRANCH_VALUE into child branch):
   - Stay in this worktree
   - Resolve conflicts manually
   - Re-run the finish script

4. If the parent-side merge fails because MAIN_BRANCH_VALUE moved ahead:
   - The finish script retries the reconcile loop automatically
   - Parent-side merge is a bit sensitive operation as it can make big mess; solve simple issues yourself, but escalate to the user with major issues (such as dirty parent worktree)

5. After success: report the merged commit(s). Suggest `/quit` if no further work is needed.
```

**For PR policy**, write a simpler finish skill:

```markdown
---
name: finish
description: Open a PR for the branch with current work to upstream after explicit user sign-off (e.g. "LGTM")
---

# Parallel-agent finish workflow

When the user explicitly approves the work (e.g. says "LGTM", "ship it"):

1. **Confirm** with user before pushing.

2. Run the finish script to push the branch and open a PR automatically:

```bash
.pi/parallel-agent-finish.sh
```

3. Suggest `/quit` if no further work is needed.
```

---

## Phase 3: Report

Tell the user which files were created, updated, or skipped, and how to proceed.

Explicitly remind the user that `.pi/parallel-agent-*` files are local runtime setup and should stay untracked (not committed to git).


- Start an agent: `/agent <task description>`
- Watch status: statusline shows active agents, ...@<number> is the tmux window to switch to; `/agents` lists all
- Ask you to set up and manage a flock of multiple parallel agents on your own to solve a task (you have the tools)
