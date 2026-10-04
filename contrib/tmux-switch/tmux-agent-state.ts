import { execFile, execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Publish this pi's activity as tmux window user options, for tmux-switch:
 *   @agent_state = working | done | idle   (done = finished, not yet looked at)
 *   @agent_since = unix seconds of the last state change
 * The done -> idle transition on viewing is done by a tmux session-window-changed hook
 * (tmux-agent-seen). See README.md in this directory.
 * No-op outside tmux and in non-TUI modes.
 */
export default function (pi: ExtensionAPI) {
	const pane = process.env.TMUX_PANE;
	if (!process.env.TMUX || !pane) return;

	let enabled = false;
	let last: string | undefined;

	const tmux = (...args: string[]) => {
		execFile("tmux", args, { timeout: 2000 }, () => {
			/* best effort: ignore errors (e.g. tmux server gone) */
		});
	};

	const publish = (state: "working" | "done" | "idle") => {
		if (!enabled || state === last) return;
		last = state;
		const since = String(Math.floor(Date.now() / 1000));
		tmux("set-option", "-w", "-t", pane, "@agent_state", state, ";", "set-option", "-w", "-t", pane, "@agent_since", since);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		enabled = true;
		last = undefined;
		publish(ctx.isIdle?.() === false ? "working" : "idle");
	});

	pi.on("agent_start", () => publish("working"));

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx?.isIdle?.() === true) publish("done");
	});

	pi.on("session_shutdown", () => {
		if (!enabled) return;
		enabled = false;
		// sync: the process may be about to exit
		try {
			execFileSync("tmux", ["set-option", "-wu", "-t", pane, "@agent_state", ";", "set-option", "-wu", "-t", pane, "@agent_since"], { timeout: 1000, stdio: "ignore" });
		} catch {
			/* best effort */
		}
	});
}
