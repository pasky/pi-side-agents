/**
 * Status line UX: it is a quick-travel map for hopping across side agents one
 * by one (`@N` = tmux window). Every entry — parent, own children, siblings —
 * must be colored by its status so any window shows who needs attention next.
 *
 * Exercises the real formatStatusLine from extensions/side-agents.ts (loaded
 * via Node's TypeScript type stripping) with a tagging stub theme.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

const { __testing } = await import(resolve("extensions/side-agents.ts"));

const theme = { fg: (role, text) => `<${role}>${text}</${role}>` };
const SEP = "<dim>|</dim>";

// status → [short label, expected color role]
const ROLES = {
	allocating_worktree: ["alloc", "warning"],
	spawning_tmux: ["tmux", "warning"],
	running: ["run", "muted"],
	waiting_user: ["wait", "accent"],
	failed: ["fail", "error"],
	crashed: ["crash", "error"],
};

function render(agents, self) {
	return __testing.formatStatusLine(agents, self, theme);
}

for (const [status, [short, role]] of Object.entries(ROLES)) {
	test(`status line: ${status} is colored ${role} as parent, child and sibling`, () => {
		const agents = [
			{ id: "p", status, tmuxWindowIndex: 1 },
			{ id: "q", status, tmuxWindowIndex: 2 },
			{ id: "p1", parentAgentId: "p", depth: 2, status: "running", tmuxWindowIndex: 3 },
			{ id: "p2", parentAgentId: "p", depth: 2, status, tmuxWindowIndex: 4 },
		];
		const c = (id, win) => `<${role}>${id}:${short}@${win}</${role}>`;
		// depth-2 leaf: colored parent, colored sibling
		assert.equal(
			render(agents, { selfId: "p1", parentAgentId: "p", depth: 2 }),
			`<muted>parent:</muted>${c("p", 1)} ${SEP} ${c("p2", 4)}`,
		);
		// depth-1 agent: colored children, colored sibling
		assert.equal(
			render(agents, { selfId: "p", depth: 1 }),
			`<muted>p1:run@3</muted> ${c("p2", 4)} ${SEP} ${c("q", 2)}`,
		);
	});
}

test("status line: siblings of a depth-1 agent keep their status colors (never blanket-dimmed)", () => {
	const agents = [
		{ id: "a", status: "running", tmuxWindowIndex: 1 },
		{ id: "b", status: "crashed", tmuxWindowIndex: 2 },
		{ id: "d", status: "waiting_user", tmuxWindowIndex: 5 },
		{ id: "a1", parentAgentId: "a", depth: 2, status: "spawning_tmux", tmuxWindowIndex: 3 },
	];
	const line = render(agents, { selfId: "a", depth: 1 });
	assert.equal(line, `<warning>a1:tmux@3</warning> ${SEP} <error>b:crash@2</error> <accent>d:wait@5</accent>`);
	assert.doesNotMatch(line.replaceAll(SEP, ""), /<dim>/);
});

test("status line: vanished side-agent parent is flagged as gone", () => {
	const line = render([], { selfId: "c", parentAgentId: "p", depth: 2 });
	assert.equal(line, "<muted>parent:</muted><error>p:gone</error>");
});
