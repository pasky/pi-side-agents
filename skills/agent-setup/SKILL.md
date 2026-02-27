---
name: agent-setup
description: Interactive setup for pi-parallel-agents. Chats with you about merge policy, main branch name, and bootstrap needs, then creates or updates .pi/parallel-agent-start.sh, .pi/parallel-agent-finish.sh, and .pi/parallel-agent-skills/finish/SKILL.md tailored to your answers. Run via /skill:agent-setup.
---

# Parallel Agent Setup

Set up the pi-parallel-agents lifecycle scripts for this project. Work through two phases: interview, then file creation.

## Phase 1: Interview

Ask the user the following questions. You may ask them all at once or one at a time — use your judgment based on how they engage.

1. **Main branch name** – What is the primary integration branch? *(default: `main`)*

2. **Bootstrap steps** – Does each agent worktree need custom setup before work begins? For example: `npm install`, copying `.env` files, running migrations. If yes, what commands specifically?

3. **Merge policy** – When an agent finishes, should it:
   - **Merge locally** into the main branch in the parent checkout (default), or
   - **Open a pull request** instead?

4. **Overwrite existing files** – If `.pi/parallel-agent-start.sh` or similar already exist, overwrite them? *(default: no — skip existing files)*

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

**Default content** — adjust the bootstrap section based on user's answer to question 2:

```bash
#!/usr/bin/env bash
set -euo pipefail

PARENT_ROOT="${1:-}"
WORKTREE="${2:-$(pwd)}"
AGENT_ID="${3:-unknown}"

BRANCH="$(git -C "$WORKTREE" branch --show-current 2>/dev/null || true)"
echo "[parallel-agent-start] agent=$AGENT_ID branch=${BRANCH:-?}"
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

acquire_lock() {
  local payload
  payload="{\"agentId\":\"$AGENT_ID\",\"pid\":$$,\"acquiredAt\":\"$(date -Is)\"}"
  while true; do
    if ( set -o noclobber; printf '%s\n' "$payload" > "$LOCK_FILE" ) 2>/dev/null; then
      return 0
    fi
    echo "[parallel-agent-finish] Waiting for merge lock..."
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
    git merge --no-ff --no-edit "$BRANCH"
  )
  merge_status=$?
  set -e

  release_lock

  if [[ "$merge_status" -eq 0 ]]; then
    echo "[parallel-agent-finish] Success: merged $BRANCH -> $MAIN_BRANCH in parent checkout."
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

**For PR policy**: write a simpler finish script that pushes the branch and prints a URL or instructions:

```bash
#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="${PI_PARALLEL_AGENT_ID:-${1:-unknown}}"
MAIN_BRANCH="MAIN_BRANCH_VALUE"
BRANCH="$(git branch --show-current)"

echo "[parallel-agent-finish] Pushing $BRANCH for pull request..."
git push -u origin "$BRANCH"

echo ""
echo "[parallel-agent-finish] Branch pushed. Open a PR against $MAIN_BRANCH:"
echo "  https://github.com/$(git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')/compare/$MAIN_BRANCH...$BRANCH"
```

---

### File 3: `$GIT_ROOT/.pi/parallel-agent-skills/finish/SKILL.md`

This is a skill for the **child agent** (not this session) that tells it how to finalize its work.

**For local merge policy**, write:

```markdown
---
name: finish
description: Finalize a parallel-agent branch after explicit user approval (e.g. LGTM). Confirm the finish action with user first; default path is local merge via .pi/parallel-agent-finish.sh.
---

# Parallel-agent finish workflow

When the user explicitly approves the work (e.g. says "LGTM", "ship it", "merge it"):

1. **Confirm** the finish action with the user before doing anything.
   - Default: local merge via `.pi/parallel-agent-finish.sh`
   - Alternative (if user requests): push branch and open a PR instead

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

5. After success: report the merged commit(s). Suggest `/quit` if no further work is needed.
```

**For PR policy**, write a simpler finish skill:

```markdown
---
name: finish
description: Finalize a parallel-agent branch by pushing and opening a PR, after explicit user approval (e.g. LGTM).
---

# Parallel-agent finish workflow

When the user explicitly approves the work (e.g. says "LGTM", "ship it"):

1. **Confirm** with user before pushing.

2. Run the finish script to push and get a PR URL:

```bash
.pi/parallel-agent-finish.sh
```

3. Share the PR URL with the user.

4. Suggest `/quit` if no further work is needed.
```

---

## Phase 3: Report

Tell the user which files were created, updated, or skipped, and how to proceed:

- Start an agent: `/agent <task description>`
- Watch status: statusline shows active agents; `/agents` lists all
- Check a specific agent: `/agent-check <id>`
- Send follow-up: `/agent-send <id> <message>`
