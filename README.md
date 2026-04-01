# pi-side-agents

**Code in sprints** (using agents *asynchronously*), **not in a marathon** (*sequential* task-by-task flow).

Instead of waiting for one backlog item to finish before starting the next, spin tasks out into single-use child agents as soon as they occur to you. Each child runs in its own **tmux window** and **git worktree**, so you can keep shipping in parallel while maintaining isolation and control (asynchronous does not mean autonomous). Each child is a one-off and lives and dies with its short topic branch and tmux window—no "teams of long-running agents messaging each other" or "role-based subagents" complexity. The workflow is unified, simple, and deterministic.

The most advanced users of AI coding agents have worked like this for a while, but the setup has been a bit daunting. This extension automates the full tmux/worktree/merge lifecycle for you and takes just a few seconds to set up. Plus, side agents can also be spawned and controlled by another agent to orchestrate its own flock of subagents.

**Warning:** You will build a lot more, which means you may run out of context windows and need to take better care of your wellbeing between sprints. Also, for the community's sake, please don't max out Claude subscriptions with Pi—use a Codex model (or APIs) by default.

---

<img width="1512" height="882" alt="image" src="https://github.com/user-attachments/assets/9010be2e-755e-41cc-9b98-312ba3fdd53e" />
(A main Pi agent console: the status line shows the currently operating side-agents. Once an agent entry turns blue, you can switch to the shown tmux window and unblock it. Fire off new ideas with a single /agent command. A new side-agent opens a tmux window in the background and automatically gets its short-lived topic branch, a separate worktree with properly replicated build setup, and merges back to main once you type "LGTM".)

## What it does

- New command `/agent [-model ...] <task>` to spawn a background child Pi agent.
- Shows active-agent summary with tmux window numbers in the statusline.
- New command `/agents` to inspect current agents and clean up stale state.
- New skill `agent-setup` to scaffold project-specific lifecycle scripts (flexible worktree initialization and merge process).
- Exposes orchestration _tools_ for parent agents: `agent-start`, `agent-check`, `agent-wait-any`, `agent-send`

## Install

```bash
pi install npm:pi-side-agents
```

This registers the extension and skill with Pi. Restart Pi after installing.

## Quick start

<p align="center">
<img width="1003" height="865" alt="image" src="https://github.com/user-attachments/assets/4bad3c72-3672-49a5-acc5-0688ba3cc78f" />
</p>

1. **Run setup once** in your project: `/skill:agent-setup`
   - If you want to change the setup later, or are upgrading this skill and want to get new setup goodies, just re-run the skill with a short prompt.
2. **Spawn asynchronous work items at any point** during your work:
   - `/agent wait, why is weirdMethod doing something-weird?`
   - `/agent -model gpt-5.3-codex add regression tests for auth`
   - Keep firing new items as they appear. As a rule of thumb, start all new work via `/agent`, but you can also use it only for ad hoc side questions.
3. **Check progress and attend** to the baby agents:
   - Check the statusline for which agents (by branch and tmux window) are waiting for you.
   - Use `/agents` to get a detailed overview of what's being done right now.
   - Steer the waiting children and work with them as normal Pi instances—just switch tmux windows.
4. If an agent is done, review its work and once happy, confirm by **LGTM, merge**.
   - Recommended: Write `commit your work when done` in your `AGENTS.md`. (You can always tell the agent to amend.)
   - Quickest way to review: ctrl+z, `git show`, `fg` to go back to the baby agent's Pi.
   - Your main worktree should be clean at this point; avoid editing in the main tree while side agents are active.
   - You can also tell your Pi to open GitHub PRs instead of merging locally, if that's what you prefer.
5. The agent will merge its work into your main repo. **Just type `/quit` and move on.**
   - Old worktrees are kept around and reused and updated by new agents.
   - Old branches are auto-pruned during reuse by a new agent.
   - You can pause your work on a topic—if you `/quit` before work is merged, the branch will stay around.

<p align="center">
<img width="706" height="364" alt="image" src="https://github.com/user-attachments/assets/212a0fc3-7f84-4889-9eaa-80007280df01" />
</p>

## Requirements

- `tmux`
- Git repository (worktrees enabled)
- Pi configured/authenticated

## Development

Run tests:

```bash
npm run test:unit
npm run test:integration
```

## Docs

- Architecture: `docs/architecture.md`
- Recovery/runbooks: `docs/recovery.md`
- Implementation notes: `docs/todo.md`
