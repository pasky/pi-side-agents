# tmux-switch — window switcher that shows which agents need you

With several side agents running, it's hard to know which tmux window to visit next. `tmux-switch` is a full-screen fzf popup that:

- groups windows by project, folding `<repo>-agent-worktree-N` side-agent worktrees into their repo (shown as `⎇N`)
- colors each pi window by agent state: `● working`, **`✔ done`** (finished, not yet looked at), `○ idle`, with time since the last change
- lays out nested side agents (spawned by another side agent) as a tree under their parent agent, dimmed and left out of the project counts. They report to their parent, not to you, so a finished grandchild doesn't look like it's waiting for you. The parent is read from the `@side_agent_id`/`@side_agent_parent` window options that pi-side-agents sets on agent windows, or from the project's `.pi/side-agents/registry.json` for windows created before those options existed
- shows the pi session summary, a live pane preview, and per-project `✔`/`●` counts

Keys: `j/k` move, `J/K` next/prev project, `g/G` top/bottom, `C-d/C-u` half page, `l`/`Enter` switch, digits jump to a window number, `/` search, `C-/` toggle preview, `q`/`Esc` quit.

## Pieces

| File | Role |
|---|---|
| `tmux-agent-state.ts` | pi extension: publishes `@agent_state` (`working`/`done`/`idle`) and `@agent_since` as tmux window options |
| `tmux-agent-seen` | tmux hook helper: turns `done` into `idle` once you've visited the window |
| `tmux-switch` | the popup (Python via `uv run --script`, driving `fzf`) |
| `tmux-switch-action` | fast per-keystroke helper for fzf; must be in the same directory as `tmux-switch` |

Requires `tmux` ≥ 3.3 (`display-popup -B`), a recent `fzf` (tested with 0.74; uses `--gutter`), and `uv`.

## Setup

1. Put the scripts on your PATH, e.g. symlink them into `~/bin`:

   ```bash
   d=$(npm root -g)/pi-side-agents/contrib/tmux-switch   # or wherever your copy lives
   ln -s "$d"/tmux-switch "$d"/tmux-switch-action "$d"/tmux-agent-seen ~/bin/
   ```

2. Load the extension in pi, e.g. by symlinking it into `~/.pi/agent/extensions/`:

   ```bash
   ln -s "$d"/tmux-agent-state.ts ~/.pi/agent/extensions/
   ```

   It does nothing outside tmux and outside the interactive TUI.

3. Add to `~/.tmux.conf`:

   ```tmux
   # window switcher popup (the default choose-window stays available on prefix-w)
   unbind '"'
   bind '"' display-popup -B -E -w 100% -h 100% "~/bin/tmux-switch '#{session_name}'"

   # "done" (finished, unseen) becomes "idle" once you visit the window
   set-hook -g session-window-changed 'run-shell -b "~/bin/tmux-agent-seen \"#{hook_session_name}\""'
   ```

   Then run `tmux source ~/.tmux.conf`.
