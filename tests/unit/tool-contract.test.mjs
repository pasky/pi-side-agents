/**
 * Tool contract unit tests for pi-side-agents.
 *
 * These tests validate the JSON-shape contracts and pure-function behavior of
 * the agent control tools without requiring a live Pi process, real tmux, or
 * real git worktrees.  They complement the full integration suite at
 * tests/integration/side-agents.integration.test.mjs.
 *
 * Tests are grouped by tool / concern:
 *   1. Pure helper functions (ported to JS for direct testing)
 *   2. JSON shape / ok-field contracts
 *   3. waitForAny fail-fast semantics using a real temp registry on disk
 *   4. sendToAgent interrupt-prefix stripping logic
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Minimal JS re-implementations of pure extension functions
// (kept in sync with extensions/side-agents.ts by contract)
// ---------------------------------------------------------------------------

/** @param {string} status */
function isTerminalStatus(status) {
	return status === "done" || status === "failed" || status === "crashed";
}

const BACKLOG_SEPARATOR_RE = /^[-─—_=]{5,}$/u;

function isBacklogSeparatorLine(line) {
	return BACKLOG_SEPARATOR_RE.test(line.trim());
}

function splitLines(text) {
	return text
		.split(/\r?\n/)
		.filter((line, i, arr) => !(i === arr.length - 1 && line.length === 0));
}

/**
 * @param {string} text
 * @param {number} count
 * @returns {string[]}
 */
function tailLines(text, count) {
	return splitLines(text).slice(-count);
}

function stripTerminalNoise(text) {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\r/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function truncateWithEllipsis(text, maxChars) {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	if (maxChars === 1) return "…";
	return `${text.slice(0, maxChars - 1)}…`;
}

function summarizeTask(task, maxChars = 220) {
	const collapsed = stripTerminalNoise(task).replace(/\s+/g, " ").trim();
	return truncateWithEllipsis(collapsed, maxChars);
}

function collectRecentBacklogLines(lines, minimumLines) {
	if (minimumLines <= 0) return [];

	const selected = [];
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const cleaned = stripTerminalNoise(lines[i]).trimEnd();
		if (cleaned.length === 0) continue;
		if (isBacklogSeparatorLine(cleaned)) continue;
		selected.push(lines[i]);
		if (selected.length >= minimumLines) break;
	}

	return selected.reverse();
}

function selectBacklogTailLines(text, minimumLines) {
	return collectRecentBacklogLines(splitLines(text), minimumLines);
}

function sanitizeBacklogLines(lines, lineMax = 240, totalMax = 2400) {
	const out = [];
	let remaining = totalMax;

	for (const raw of lines) {
		if (remaining <= 0) break;
		const cleaned = stripTerminalNoise(raw).trimEnd();
		if (cleaned.length === 0) continue;
		if (isBacklogSeparatorLine(cleaned)) continue;

		const line = truncateWithEllipsis(cleaned, lineMax);
		if (line.length <= remaining) {
			out.push(line);
			remaining -= line.length + 1;
			continue;
		}

		out.push(truncateWithEllipsis(line, remaining));
		remaining = 0;
		break;
	}

	return out;
}

/**
 * Minimal re-implementation of waitForAny fail-fast path.
 * Reads a registry JSON at stateRoot/.pi/side-agents/registry.json.
 *
 * Returns { ok: false, error } immediately when all IDs are unknown on the
 * first poll cycle. Resolves with the matching agent payload when one reaches
 * a default wait target state.
 *
 * NOTE: This does NOT poll — it is synchronous to make unit testing
 * straightforward. The real extension polls with 1 s sleeps; this validates
 * only the first-pass fail-fast logic.
 *
 * @param {string} stateRoot
 * @param {string[]} ids
 * @returns {Promise<Record<string, unknown>>}
 */
async function waitForAnyFirstPass(stateRoot, ids) {
	const { readFile } = await import("node:fs/promises");

	const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
	if (uniqueIds.length === 0) {
		return { ok: false, error: "No agent ids were provided" };
	}

	const waitStates = new Set(["waiting_user", "failed", "crashed"]);

	const registryPath = join(stateRoot, ".pi", "side-agents", "registry.json");
	let registry = { agents: {} };
	try {
		registry = JSON.parse(await readFile(registryPath, "utf8"));
	} catch {
		// empty registry
	}

	const unknownOnFirstPass = [];
	for (const id of uniqueIds) {
		const record = registry?.agents?.[id];
		if (!record) {
			unknownOnFirstPass.push(id);
			continue;
		}
		if (waitStates.has(record.status)) {
			return {
				ok: true,
				agent: record,
				backlog: [],
			};
		}
	}

	if (unknownOnFirstPass.length > 0) {
		return {
			ok: false,
			error: `Unknown agent id(s): ${unknownOnFirstPass.join(", ")}`,
		};
	}

	// All IDs known but none in target state — caller would need to poll.
	return { ok: false, error: "no target-state agent found (poll required)" };
}

/**
 * Best-effort re-implementation of worktree lock cleanup.
 *
 * @param {string | undefined} worktreePath
 */
async function cleanupWorktreeLockBestEffort(worktreePath) {
	if (!worktreePath) return;
	const lockPath = join(worktreePath, ".pi", "active.lock");
	await rm(lockPath, { force: true }).catch(() => {});
}

/**
 * Re-implementation of status-transition collection used by status polling.
 * Returns the next snapshot map and the transitions that should be emitted.
 *
 * @param {Map<string, { status: string, tmuxWindowIndex?: number }> | undefined} previous
 * @param {Array<{ id: string, status: string, tmuxWindowIndex?: number }>} agents
 */
function collectStatusTransitions(previous, agents) {
	const next = new Map();
	const transitions = [];

	for (const record of agents) {
		const current = {
			status: record.status,
			tmuxWindowIndex: record.tmuxWindowIndex,
		};
		next.set(record.id, current);

		const prev = previous?.get(record.id);
		if (!prev || prev.status === record.status) continue;
		transitions.push({
			id: record.id,
			fromStatus: prev.status,
			toStatus: record.status,
			tmuxWindowIndex: record.tmuxWindowIndex ?? prev.tmuxWindowIndex,
		});
	}

	if (previous) {
		for (const [id, prev] of previous.entries()) {
			if (next.has(id)) continue;
			if (isTerminalStatus(prev.status)) continue;
			transitions.push({
				id,
				fromStatus: prev.status,
				toStatus: "done",
				tmuxWindowIndex: prev.tmuxWindowIndex,
			});
		}
	}

	return {
		next,
		transitions: previous ? transitions.sort((a, b) => a.id.localeCompare(b.id)) : [],
	};
}

const TRANSITION_SETTLE_MS = 5000;
const TRANSITION_PATH_LIMIT = 6;

/**
 * Re-implementation of pending-transition coalescing used before delivery.
 *
 * @param {Map<string, any>} pending
 * @param {Array<{ id: string, fromStatus: string, toStatus: string, tmuxWindowIndex?: number }>} transitions
 * @param {number} now
 */
function mergePendingTransitions(pending, transitions, now) {
	for (const transition of transitions) {
		const existing = pending.get(transition.id);
		if (!existing) {
			pending.set(transition.id, {
				...transition,
				firstObservedAt: now,
				lastObservedAt: now,
				coalescedCount: 1,
				path: [transition.toStatus],
			});
			continue;
		}
		existing.toStatus = transition.toStatus;
		existing.tmuxWindowIndex = transition.tmuxWindowIndex ?? existing.tmuxWindowIndex;
		existing.lastObservedAt = now;
		existing.coalescedCount += 1;
		if (existing.path.length < TRANSITION_PATH_LIMIT) {
			existing.path.push(transition.toStatus);
		} else {
			existing.path[existing.path.length - 1] = transition.toStatus;
		}
	}
}

/**
 * Re-implementation of settled-transition draining.
 *
 * @param {Map<string, any>} pending
 * @param {number} now
 * @param {boolean} idle
 * @param {number} settleMs
 */
function drainSettledTransitions(pending, now, idle = true, settleMs = TRANSITION_SETTLE_MS) {
	if (!idle) return [];
	const settled = [];
	for (const [agentId, entry] of pending.entries()) {
		const ready = isTerminalStatus(entry.toStatus) || now - entry.lastObservedAt >= settleMs;
		if (!ready) continue;
		pending.delete(agentId);
		settled.push(entry);
	}
	return settled.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Helper: temporary registry factory
// ---------------------------------------------------------------------------

async function makeTempRegistry(t, agents = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-side-unit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const metaDir = join(dir, ".pi", "side-agents");
	await mkdir(metaDir, { recursive: true });

	const registry = { version: 1, agents };
	await writeFile(join(metaDir, "registry.json"), JSON.stringify(registry, null, 2) + "\n", "utf8");

	return dir;
}

// ---------------------------------------------------------------------------
// 1. Pure helper functions
// ---------------------------------------------------------------------------

test("isTerminalStatus — done/failed/crashed are terminal", () => {
	assert.ok(isTerminalStatus("done"), "done must be terminal");
	assert.ok(isTerminalStatus("failed"), "failed must be terminal");
	assert.ok(isTerminalStatus("crashed"), "crashed must be terminal");
});

test("isTerminalStatus — running/waiting/finishing are non-terminal", () => {
	const nonTerminal = [
		"allocating_worktree",
		"spawning_tmux",
		"starting",
		"running",
		"waiting_user",
		"finishing",
		"waiting_merge_lock",
		"retrying_reconcile",
	];
	for (const status of nonTerminal) {
		assert.ok(!isTerminalStatus(status), `${status} must NOT be terminal`);
	}
});

test("tailLines — returns last N lines", () => {
	assert.deepEqual(tailLines("a\nb\nc\nd\ne", 3), ["c", "d", "e"]);
});

test("tailLines — trailing newline is not treated as an empty line", () => {
	assert.deepEqual(tailLines("a\nb\nc\n", 2), ["b", "c"]);
});

test("tailLines — requesting more lines than exist returns all", () => {
	assert.deepEqual(tailLines("a\nb", 10), ["a", "b"]);
});

test("tailLines — empty string returns empty array", () => {
	assert.deepEqual(tailLines("", 5), []);
});

test("selectBacklogTailLines — returns at least requested non-separator tail lines when available", () => {
	const text = [
		"line 01",
		"line 02",
		"line 03",
		"line 04",
		"line 05",
		"line 06",
		"line 07",
		"line 08",
		"line 09",
		"line 10",
		"line 11",
		"line 12",
		"-----------",
		"────────────",
		"  --------  ",
		"",
		"           ",
	].join("\n");

	const selected = selectBacklogTailLines(text, 10);
	assert.equal(selected.length, 10, `expected 10 selected lines, got ${selected.length}`);
	assert.deepEqual(selected, [
		"line 03",
		"line 04",
		"line 05",
		"line 06",
		"line 07",
		"line 08",
		"line 09",
		"line 10",
		"line 11",
		"line 12",
	]);
});

test("sanitizeBacklogLines — filters divider-only lines but keeps regular dash text", () => {
	const cleaned = sanitizeBacklogLines(["ok", "-----------", "────────────", "step - with context"]);
	assert.deepEqual(cleaned, ["ok", "step - with context"]);
});

test("sanitizeBacklogLines — strips ANSI/control sequences and truncates lines", () => {
	const noisy = [
		"\u001b[31mERROR\u001b[0m something happened",
		"x".repeat(400),
		"\u001b]0;title\u0007ok",
	];
	const cleaned = sanitizeBacklogLines(noisy, 80, 200);

	assert.ok(cleaned.length > 0, "expected sanitized lines");
	assert.ok(cleaned[0].startsWith("ERROR"), `expected ANSI stripped line, got: ${cleaned[0]}`);
	assert.ok(cleaned[1].endsWith("…"), "long line should be truncated with ellipsis");
	for (const line of cleaned) {
		assert.ok(!line.includes("\u001b"), `line must not contain escape chars: ${JSON.stringify(line)}`);
	}
});

test("collectRecentBacklogLines — extracts content from visible pane with footer at bottom", () => {
	// A real tmux visible pane has ~50 lines of content with a 3-4 line TUI
	// footer at the very bottom.  When requesting 10 lines, we should get
	// actual content mixed with just a few footer lines — much better than
	// the old backlog.log approach which was 100% footer redraws.
	const visiblePaneLines = [
		// ... many earlier content lines ...
		" $ npm test -- tests/e2e/auth.test.ts",
		"",
		" PASS  tests/e2e/auth.test.ts",
		"  Auth module",
		"    ✓ login flow (230 ms)",
		"    ✓ logout clears session (45 ms)",
		"",
		" All 474 tests pass (473 + 1 new). Let me amend the commit:",
		"",
		" $ git add -u && git commit --amend --no-edit",
		"",
		" check for added large files..................................................Passed",
		" [side-agent/fix-auth 450d750] feat: fix auth leak in login page",
		"  3 files changed, 42 insertions(+), 7 deletions(-)",
		"",
		// Footer (only the last few lines)
		"── smart ──────────────────────────────────────────────────────────────",
		"~/projects/repo-worktree-0001 (side-agent/fix-auth)",
		"↑25 ↓5.6k R375k W28k $0.500 (sub) 13.9%/200k (auto)                 (anthropic) claude-opus-…",
		"YOLO mode fix-auth:run@10 │ Claude │ Ctx ━━━━━━ 14% used │ 5h 3h44m left",
	];

	const result = collectRecentBacklogLines(visiblePaneLines, 10);
	assert.ok(result.length > 0, `expected non-empty result, got ${result.length} lines`);

	// With 10 requested lines, we should get actual content (commit messages,
	// test output) mixed in — not purely footer/status lines.
	const joined = result.join("\n");
	assert.ok(
		joined.includes("tests pass") || joined.includes("fix-auth 450d750") || joined.includes("git commit") || joined.includes("PASS"),
		`expected meaningful content in backlog, got:\n${joined}`,
	);

	// Separator lines should be filtered out
	for (const line of result) {
		const cleaned = stripTerminalNoise(line).trim();
		assert.ok(!BACKLOG_SEPARATOR_RE.test(cleaned), `separator line should be filtered: ${line}`);
	}
});

test("collectRecentBacklogLines — visible pane is bounded unlike backlog.log", () => {
	// The key improvement of using tmux capture-pane (visible) over backlog.log:
	// backlog.log accumulates footer redraws unboundedly — thousands of lines of
	// pure footer noise.  The visible pane is bounded to one screen (~50 lines)
	// so even in the worst case, footer lines are limited and real content from
	// above is included.
	//
	// Simulate a backlog.log-style accumulation: 200 footer redraws, then one
	// real content line far back.  selectBacklogTailLines (used for file reading)
	// would miss the content entirely.
	const backlogFileLines = [];
	backlogFileLines.push("Real content: all tests passed");
	for (let i = 0; i < 200; i++) {
		backlogFileLines.push("── smart ──────────────────────────────────────────────────────────────");
		backlogFileLines.push("~/projects/repo (side-agent/foo)");
		backlogFileLines.push(`↑10 ↓2k R100k W5k $0.${String(i).padStart(3, "0")}`);
		backlogFileLines.push("YOLO mode foo:run@3 │ Claude │ Ctx ━━━━━━ 5% used");
	}

	// With backlog.log approach (tail 10 from 800+ lines) — content is buried
	const fromFile = selectBacklogTailLines(backlogFileLines.join("\n"), 10);
	const fileJoined = fromFile.join("\n");
	assert.ok(
		!fileJoined.includes("all tests passed"),
		"backlog.log tail should miss content buried under footer redraws",
	);

	// With visible pane approach — content is nearby (screen is bounded)
	// Simulate a visible pane: content + just one footer at the bottom
	const visibleLines = [
		"Real content: all tests passed",
		"── smart ──────────────────────────────────────────────────────────────",
		"~/projects/repo (side-agent/foo)",
		"↑10 ↓2k R100k W5k $0.100",
		"YOLO mode foo:run@3 │ Claude │ Ctx ━━━━━━ 5% used",
	];
	const fromVisible = collectRecentBacklogLines(visibleLines, 10);
	const visibleJoined = fromVisible.join("\n");
	assert.ok(
		visibleJoined.includes("all tests passed"),
		`visible pane should include real content, got:\n${visibleJoined}`,
	);
});

test("summarizeTask — collapses whitespace and truncates", () => {
	const task = "Line one\n\n\tline two with details " + "x".repeat(400);
	const summary = summarizeTask(task, 120);
	assert.ok(!summary.includes("\n"), "summary should be single-line");
	assert.ok(summary.length <= 120, `summary too long: ${summary.length}`);
	assert.ok(summary.endsWith("…"), "summary should be truncated with ellipsis");
});

test("collectStatusTransitions — first snapshot emits no transitions", () => {
	const { next, transitions } = collectStatusTransitions(undefined, [
		{ id: "alpha", status: "running", tmuxWindowIndex: 7 },
	]);

	assert.equal(next.get("alpha")?.status, "running");
	assert.equal(next.get("alpha")?.tmuxWindowIndex, 7);
	assert.deepEqual(transitions, []);
});

test("collectStatusTransitions — changed status emits transition with tmux fallback", () => {
	const previous = new Map([
		["alpha", { status: "running", tmuxWindowIndex: 17 }],
	]);

	const { transitions } = collectStatusTransitions(previous, [{ id: "alpha", status: "waiting_user" }]);
	assert.deepEqual(transitions, [
		{
			id: "alpha",
			fromStatus: "running",
			toStatus: "waiting_user",
			tmuxWindowIndex: 17,
		},
	]);
});

test("collectStatusTransitions — removed non-terminal agent emits synthetic -> done transition", () => {
	const previous = new Map([
		["alpha", { status: "waiting_user", tmuxWindowIndex: 17 }],
	]);

	const { transitions } = collectStatusTransitions(previous, []);
	assert.deepEqual(transitions, [
		{
			id: "alpha",
			fromStatus: "waiting_user",
			toStatus: "done",
			tmuxWindowIndex: 17,
		},
	]);
});

test("collectStatusTransitions — removed terminal agent does not emit synthetic done", () => {
	const previous = new Map([
		["failed-agent", { status: "failed", tmuxWindowIndex: 3 }],
		["crashed-agent", { status: "crashed", tmuxWindowIndex: 4 }],
	]);

	const { transitions } = collectStatusTransitions(previous, []);
	assert.deepEqual(transitions, []);
});

test("pending transitions — a burst collapses into one first->last notice", () => {
	const pending = new Map();
	const t0 = 1_000_000;
	mergePendingTransitions(pending, [{ id: "alpha", fromStatus: "spawning_tmux", toStatus: "running", tmuxWindowIndex: 3 }], t0);
	mergePendingTransitions(pending, [{ id: "alpha", fromStatus: "running", toStatus: "waiting_user" }], t0 + 2000);
	mergePendingTransitions(pending, [{ id: "alpha", fromStatus: "waiting_user", toStatus: "running" }], t0 + 3000);
	// Still settling while non-terminal: nothing delivered yet.
	assert.deepEqual(drainSettledTransitions(pending, t0 + 3500), []);

	mergePendingTransitions(pending, [{ id: "alpha", fromStatus: "running", toStatus: "done" }], t0 + 4000);

	// Terminal state flushes immediately, without waiting out the settle window.
	const settled = drainSettledTransitions(pending, t0 + 4000);
	assert.equal(settled.length, 1);
	assert.equal(settled[0].fromStatus, "spawning_tmux");
	assert.equal(settled[0].toStatus, "done");
	assert.equal(settled[0].tmuxWindowIndex, 3);
	assert.equal(settled[0].coalescedCount, 4);
	assert.equal(pending.size, 0, "drained entries must not be redelivered");
});

test("pending transitions — a cycle is still reported, with its route", () => {
	// waiting_user -> running -> waiting_user means the child completed another
	// requested iteration; identical endpoints must not swallow the notice.
	const pending = new Map();
	const t0 = 2_000_000;
	mergePendingTransitions(pending, [{ id: "beta", fromStatus: "waiting_user", toStatus: "running" }], t0);
	mergePendingTransitions(pending, [{ id: "beta", fromStatus: "running", toStatus: "waiting_user" }], t0 + 500);

	const settled = drainSettledTransitions(pending, t0 + 500 + TRANSITION_SETTLE_MS);
	assert.equal(settled.length, 1);
	assert.equal(settled[0].fromStatus, "waiting_user");
	assert.equal(settled[0].toStatus, "waiting_user");
	assert.deepEqual(settled[0].path, ["running", "waiting_user"]);
	assert.equal(pending.size, 0);
});

test("pending transitions — long flip-flop keeps the path capped with the latest status last", () => {
	const pending = new Map();
	const t0 = 6_000_000;
	const statuses = ["running", "waiting_user", "running", "waiting_user", "running", "waiting_user", "running", "done"];
	let from = "spawning_tmux";
	statuses.forEach((to, i) => {
		mergePendingTransitions(pending, [{ id: "delta", fromStatus: from, toStatus: to }], t0 + i);
		from = to;
	});

	const entry = pending.get("delta");
	assert.equal(entry.fromStatus, "spawning_tmux", "the origin status must survive coalescing");
	assert.equal(entry.toStatus, "done");
	assert.equal(entry.path.length, TRANSITION_PATH_LIMIT);
	assert.equal(entry.path.at(-1), "done");
	assert.equal(entry.coalescedCount, statuses.length);
});

test("pending transitions — distinct agents settle independently and sort by id", () => {
	const pending = new Map();
	const t0 = 3_000_000;
	mergePendingTransitions(pending, [
		{ id: "zeta", fromStatus: "running", toStatus: "done" },
		{ id: "alpha", fromStatus: "running", toStatus: "failed" },
	], t0);
	const first = drainSettledTransitions(pending, t0);
	assert.deepEqual(first.map((t) => [t.id, t.fromStatus, t.toStatus]), [
		["alpha", "running", "failed"],
		["zeta", "running", "done"],
	]);
	assert.equal(pending.size, 0);
});

test("pending transitions — non-terminal states wait out the settle window", () => {
	const pending = new Map();
	const t0 = 4_000_000;
	mergePendingTransitions(pending, [{ id: "beta", fromStatus: "spawning_tmux", toStatus: "running" }], t0);
	assert.deepEqual(drainSettledTransitions(pending, t0 + TRANSITION_SETTLE_MS - 1), []);

	const settled = drainSettledTransitions(pending, t0 + TRANSITION_SETTLE_MS);
	assert.deepEqual(settled.map((t) => [t.id, t.fromStatus, t.toStatus]), [["beta", "spawning_tmux", "running"]]);
});

test("pending transitions — nothing is delivered while the parent is busy, and it keeps coalescing", () => {
	const pending = new Map();
	const t0 = 5_000_000;
	mergePendingTransitions(pending, [{ id: "gamma", fromStatus: "spawning_tmux", toStatus: "running", tmuxWindowIndex: 9 }], t0);

	// Busy: even a settled, terminal notice stays buffered rather than being
	// queued as its own turn.
	assert.deepEqual(drainSettledTransitions(pending, t0 + 10 * TRANSITION_SETTLE_MS, false), []);
	mergePendingTransitions(pending, [{ id: "gamma", fromStatus: "running", toStatus: "done" }], t0 + 60_000);
	assert.deepEqual(drainSettledTransitions(pending, t0 + 60_000, false), []);
	assert.equal(pending.size, 1, "buffered notice must survive until it can be delivered");

	// Idle again: the whole busy stretch arrives as a single notice.
	const settled = drainSettledTransitions(pending, t0 + 61_000, true);
	assert.deepEqual(settled.map((t) => [t.id, t.fromStatus, t.toStatus, t.coalescedCount]), [
		["gamma", "spawning_tmux", "done", 2],
	]);
});

test("cleanupWorktreeLockBestEffort — removes existing lock and remains idempotent", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-side-lock-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const worktreePath = join(dir, "wt-0001");
	const lockPath = join(worktreePath, ".pi", "active.lock");
	await mkdir(join(worktreePath, ".pi"), { recursive: true });
	await writeFile(lockPath, JSON.stringify({ agentId: "a-0001" }) + "\n", "utf8");

	await cleanupWorktreeLockBestEffort(worktreePath);

	let exists = true;
	try {
		await readFile(lockPath, "utf8");
	} catch {
		exists = false;
	}
	assert.equal(exists, false, "lock file should be removed");

	await assert.doesNotReject(() => cleanupWorktreeLockBestEffort(worktreePath));
});

test("cleanupWorktreeLockBestEffort — missing path and missing lock never throw", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-side-lock-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	await assert.doesNotReject(() => cleanupWorktreeLockBestEffort(undefined));
	await assert.doesNotReject(() => cleanupWorktreeLockBestEffort(join(dir, "wt-no-lock")));
});

// ---------------------------------------------------------------------------
// 2. JSON shape / ok-field contracts
// ---------------------------------------------------------------------------

test("agent-start success shape must include ok: true and task", () => {
	// This test acts as a living specification for the tool contract.
	// If this shape changes, the tool description and docs must be updated.
	const exampleSuccess = {
		ok: true,
		id: "a-0001",
		task: "refactor auth module",
		tmuxWindowId: "@5",
		tmuxWindowIndex: 5,
		worktreePath: "/tmp/repo-agent-worktree-0001",
		branch: "side-agent/a-0001",
		warnings: [],
	};

	assert.strictEqual(exampleSuccess.ok, true, "success response must have ok: true");
	assert.ok(typeof exampleSuccess.id === "string", "id must be a string");
	assert.ok(typeof exampleSuccess.task === "string", "task must be a string");
	assert.ok(typeof exampleSuccess.tmuxWindowId === "string", "tmuxWindowId must be a string");
	assert.ok(typeof exampleSuccess.tmuxWindowIndex === "number", "tmuxWindowIndex must be a number");
	assert.ok(typeof exampleSuccess.worktreePath === "string", "worktreePath must be a string");
	assert.ok(typeof exampleSuccess.branch === "string", "branch must be a string");
	assert.ok(Array.isArray(exampleSuccess.warnings), "warnings must be an array");
});

test("agent-start task field — short description is not truncated", () => {
	const desc = "Fix the login bug";
	const task = desc.length > 200 ? desc.slice(0, 200) + "…" : desc;
	assert.strictEqual(task, "Fix the login bug");
	assert.ok(!task.endsWith("…"), "short task should not have ellipsis");
});

test("agent-start task field — long description is truncated with ellipsis", () => {
	const desc = "x".repeat(300);
	const task = desc.length > 200 ? desc.slice(0, 200) + "…" : desc;
	assert.strictEqual(task.length, 201, "truncated task should be 200 chars + ellipsis");
	assert.ok(task.endsWith("…"), "truncated task must end with ellipsis");
	assert.strictEqual(task.slice(0, 200), "x".repeat(200));
});

test("agent-start task field — exactly 200 chars is not truncated", () => {
	const desc = "y".repeat(200);
	const task = desc.length > 200 ? desc.slice(0, 200) + "…" : desc;
	assert.strictEqual(task.length, 200);
	assert.ok(!task.endsWith("…"), "exact-boundary task should not have ellipsis");
});

test("agent-start error shape must include ok: false and error string", () => {
	const exampleError = { ok: false, error: "tmux is not available" };
	assert.strictEqual(exampleError.ok, false);
	assert.ok(typeof exampleError.error === "string");
});

test("agent-check success shape", () => {
	const exampleSuccess = {
		ok: true,
		agent: {
			id: "a-0001",
			status: "running",
			tmuxWindowId: "@5",
			tmuxWindowIndex: 5,
			worktreePath: "/tmp/repo-agent-worktree-0001",
			branch: "side-agent/a-0001",
			task: "refactor auth module",
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: undefined,
			exitCode: undefined,
			error: undefined,
			warnings: [],
		},
		backlog: ["line 1", "line 2"],
	};

	assert.strictEqual(exampleSuccess.ok, true);
	assert.ok(typeof exampleSuccess.agent.id === "string");
	assert.ok(typeof exampleSuccess.agent.status === "string");
	assert.ok(Array.isArray(exampleSuccess.backlog));
});

test("agent-send success shape", () => {
	const exampleSuccess = { ok: true, message: "Sent prompt to a-0001" };
	assert.strictEqual(exampleSuccess.ok, true);
	assert.ok(typeof exampleSuccess.message === "string");
});

test("agent-send failure shape", () => {
	const exampleFailure = { ok: false, message: "Agent a-9999 tmux window is not active" };
	assert.strictEqual(exampleFailure.ok, false);
	assert.ok(typeof exampleFailure.message === "string");
});

// ---------------------------------------------------------------------------
// 3. waitForAny fail-fast semantics
// ---------------------------------------------------------------------------

test("waitForAny — empty ids array returns error immediately", async () => {
	const result = await waitForAnyFirstPass("/does/not/exist", []);
	assert.strictEqual(result.ok, false);
	assert.ok(typeof result.error === "string");
	assert.ok(result.error.includes("No agent ids"), `expected 'No agent ids' in: ${result.error}`);
});

test("waitForAny — unknown agent id returns { ok: false, error } immediately on first pass", async (t) => {
	const stateRoot = await makeTempRegistry(t, {}); // empty registry
	const result = await waitForAnyFirstPass(stateRoot, ["a-9999"]);

	assert.strictEqual(result.ok, false, "should be ok: false for unknown id");
	assert.ok(typeof result.error === "string", "error must be a string");
	assert.ok(result.error.includes("a-9999"), `error should name the unknown id, got: ${result.error}`);
});

test("waitForAny — mix of known+unknown ids fails fast on unknown", async (t) => {
	const now = new Date().toISOString();
	const stateRoot = await makeTempRegistry(t, {
		"a-0001": {
			id: "a-0001",
			task: "real task",
			status: "running",
			startedAt: now,
			updatedAt: now,
		},
	});

	const result = await waitForAnyFirstPass(stateRoot, ["a-0001", "a-9999"]);
	assert.strictEqual(result.ok, false, "should fail fast when any id is unknown");
	assert.ok(result.error.includes("a-9999"), `error should name a-9999, got: ${result.error}`);
});

test("waitForAny — waiting_user agent is detected on first pass", async (t) => {
	const now = new Date().toISOString();
	const stateRoot = await makeTempRegistry(t, {
		"a-0001": {
			id: "a-0001",
			task: "some task",
			status: "waiting_user",
			startedAt: now,
			updatedAt: now,
		},
	});

	const result = await waitForAnyFirstPass(stateRoot, ["a-0001"]);
	assert.strictEqual(result.ok, true, "should detect waiting_user as default target state");
	assert.strictEqual(result.agent?.id, "a-0001");
	assert.strictEqual(result.agent?.status, "waiting_user");
});

test("waitForAny — failed agent is detected on first pass", async (t) => {
	const now = new Date().toISOString();
	const stateRoot = await makeTempRegistry(t, {
		"a-0001": {
			id: "a-0001",
			task: "some task",
			status: "failed",
			startedAt: now,
			updatedAt: now,
			finishedAt: now,
		},
	});

	const result = await waitForAnyFirstPass(stateRoot, ["a-0001"]);
	assert.strictEqual(result.ok, true, "should detect failed as default target state");
	assert.strictEqual(result.agent?.id, "a-0001");
	assert.strictEqual(result.agent?.status, "failed");
});

test("waitForAny — legacy done status is not in default wait targets", async (t) => {
	const now = new Date().toISOString();
	const stateRoot = await makeTempRegistry(t, {
		"a-0001": {
			id: "a-0001",
			task: "some task",
			status: "done",
			startedAt: now,
			updatedAt: now,
			finishedAt: now,
		},
	});

	const result = await waitForAnyFirstPass(stateRoot, ["a-0001"]);
	assert.strictEqual(result.ok, false, "done should not be a default wait target anymore");
	assert.ok(result.error.includes("poll required") || typeof result.error === "string");
});

test("waitForAny — running agent with valid registry signals poll-needed", async (t) => {
	const now = new Date().toISOString();
	const stateRoot = await makeTempRegistry(t, {
		"a-0001": {
			id: "a-0001",
			task: "some task",
			status: "running",
			startedAt: now,
			updatedAt: now,
		},
	});

	// First pass finds a known agent, but not in default target states.
	const result = await waitForAnyFirstPass(stateRoot, ["a-0001"]);
	assert.strictEqual(result.ok, false, "running should not return ok: true yet");
	assert.ok(result.error.includes("poll required") || typeof result.error === "string");
});

// ---------------------------------------------------------------------------
// 4. agent-send interrupt prefix stripping
// ---------------------------------------------------------------------------

test("agent-send '!' strips interrupt prefix and returns remaining text", () => {
	function parsePrompt(prompt) {
		let payload = prompt;
		let interrupted = false;
		if (payload.startsWith("!")) {
			interrupted = true;
			payload = payload.slice(1).trimStart();
		}
		return { interrupted, text: payload };
	}

	const r1 = parsePrompt("! please refocus on the auth module");
	assert.ok(r1.interrupted, "should detect interrupt");
	assert.strictEqual(r1.text, "please refocus on the auth module");

	const r2 = parsePrompt("!please refocus");
	assert.ok(r2.interrupted, "should detect interrupt without space");
	assert.strictEqual(r2.text, "please refocus");

	const r3 = parsePrompt("!");
	assert.ok(r3.interrupted, "bare '!' should interrupt");
	assert.strictEqual(r3.text, "", "bare '!' leaves no follow-up text");

	const r4 = parsePrompt("/agent-check a-0001");
	assert.ok(!r4.interrupted, "slash command should not interrupt");
	assert.strictEqual(r4.text, "/agent-check a-0001");
});

test("agent-send '/' prefix is forwarded verbatim (no special parse)", () => {
	function parsePrompt(prompt) {
		let payload = prompt;
		let interrupted = false;
		if (payload.startsWith("!")) {
			interrupted = true;
			payload = payload.slice(1).trimStart();
		}
		return { interrupted, text: payload };
	}

	const r = parsePrompt("/quit");
	assert.ok(!r.interrupted);
	assert.strictEqual(r.text, "/quit", "slash command is forwarded as-is");
});

// ---------------------------------------------------------------------------
// 5. Kickoff prompt — parent session suffix
// ---------------------------------------------------------------------------

/**
 * Re-implementation of the session-suffix logic from buildKickoffPrompt.
 *
 * The real function appends the parent session path in all cases except when
 * includeSummary is true but there are zero messages (nothing to query back).
 * This helper covers the "suffix applied" paths; the no-messages early-return
 * is a separate code path that returns the raw task.
 */
function buildSimpleKickoffPrompt(task, parentSession) {
	const sessionSuffix = parentSession ? `\n\nParent Pi session: ${parentSession}` : "";
	return task + sessionSuffix;
}

test("kickoff prompt — appends parent session path when available", () => {
	const result = buildSimpleKickoffPrompt("Fix the bug", "/home/user/.pi/agent/sessions/abc123/session.jsonl");
	assert.ok(result.startsWith("Fix the bug"), "task must come first");
	assert.ok(result.includes("Parent Pi session: /home/user/.pi/agent/sessions/abc123/session.jsonl"),
		"must include parent session path");
});

test("kickoff prompt — no suffix when parent session is undefined", () => {
	const result = buildSimpleKickoffPrompt("Fix the bug", undefined);
	assert.strictEqual(result, "Fix the bug", "should be raw task without suffix");
});

test("kickoff prompt — no suffix when parent session is empty string", () => {
	const result = buildSimpleKickoffPrompt("Fix the bug", "");
	assert.strictEqual(result, "Fix the bug", "empty session should produce no suffix");
});

test("kickoff prompt — suffix is separated by blank line from task", () => {
	const result = buildSimpleKickoffPrompt("Do something", "/tmp/session.jsonl");
	const lines = result.split("\n");
	// task, blank, blank (from \n\n), then "Parent Pi session: ..."
	assert.ok(lines.length >= 3, `expected at least 3 lines, got ${lines.length}`);
	assert.strictEqual(lines[0], "Do something");
	assert.strictEqual(lines[1], "", "first separator line should be empty");
	assert.ok(lines[2].startsWith("Parent Pi session:"), "third line should be the session ref");
});

// ---------------------------------------------------------------------------
// 6. Branch naming convention
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Slug generation helpers (kept in sync with extensions/side-agents.ts)
// ---------------------------------------------------------------------------

function sanitizeSlug(raw) {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter(Boolean)
		.slice(0, 3)
		.join("-");
}

function slugFromTask(task) {
	const stopWords = new Set(["a", "an", "the", "to", "in", "on", "at", "of", "for", "and", "or", "is", "it", "be", "do", "with"]);
	const words = task
		.replace(/[^a-zA-Z0-9\s]/g, " ")
		.split(/\s+/)
		.map((w) => w.toLowerCase())
		.filter((w) => w.length > 0 && !stopWords.has(w));
	const slug = words.slice(0, 3).join("-");
	return slug || "agent";
}

function deduplicateSlug(slug, existing) {
	if (!existing.has(slug)) return slug;
	for (let i = 2; ; i++) {
		const candidate = `${slug}-${i}`;
		if (!existing.has(candidate)) return candidate;
	}
}

test("sanitizeSlug — basic kebab-case conversion", () => {
	assert.strictEqual(sanitizeSlug("Fix Auth Leak"), "fix-auth-leak");
	assert.strictEqual(sanitizeSlug("  ADD retry LOGIC  "), "add-retry-logic");
	assert.strictEqual(sanitizeSlug("hello---world"), "hello-world");
});

test("sanitizeSlug — truncates to 3 words", () => {
	assert.strictEqual(sanitizeSlug("one two three four five"), "one-two-three");
});

test("sanitizeSlug — strips special chars", () => {
	assert.strictEqual(sanitizeSlug("fix: the bug!"), "fix-the-bug");
	assert.strictEqual(sanitizeSlug("...leading-dots..."), "leading-dots");
});

test("sanitizeSlug — empty input returns empty string", () => {
	assert.strictEqual(sanitizeSlug(""), "");
	assert.strictEqual(sanitizeSlug("!!!"), "");
});

test("slugFromTask — extracts meaningful words, skips stop words", () => {
	assert.strictEqual(slugFromTask("Fix the auth leak in the login page"), "fix-auth-leak");
	assert.strictEqual(slugFromTask("Add a retry to the upload logic"), "add-retry-upload");
});

test("slugFromTask — falls back to 'agent' for empty/stopword-only input", () => {
	assert.strictEqual(slugFromTask(""), "agent");
	assert.strictEqual(slugFromTask("the a an"), "agent");
});

test("deduplicateSlug — returns slug as-is when no collision", () => {
	assert.strictEqual(deduplicateSlug("fix-auth", new Set()), "fix-auth");
	assert.strictEqual(deduplicateSlug("fix-auth", new Set(["other"])), "fix-auth");
});

test("deduplicateSlug — appends suffix on collision", () => {
	assert.strictEqual(deduplicateSlug("fix-auth", new Set(["fix-auth"])), "fix-auth-2");
	assert.strictEqual(deduplicateSlug("fix-auth", new Set(["fix-auth", "fix-auth-2"])), "fix-auth-3");
});

test("agent branch name follows side-agent/<slug> convention", () => {
	function branchForId(id) {
		return `side-agent/${id}`;
	}

	assert.strictEqual(branchForId("fix-auth-leak"), "side-agent/fix-auth-leak");
	assert.strictEqual(branchForId("add-retry"), "side-agent/add-retry");

	// Branch must not start with a slash or dot
	const branch = branchForId("fix-auth-leak");
	assert.ok(!branch.startsWith("/"), "branch must not start with /");
	assert.ok(!branch.startsWith("."), "branch must not start with .");
});

// ---------------------------------------------------------------------------
// 6. /agent-resume contracts
// ---------------------------------------------------------------------------

const CHILD_LINK_ENTRY_TYPE = "side-agent-link";

/**
 * Ported from extensions/side-agents.ts scanSessionFile link-entry extraction
 * (contract copy). The LAST side-agent-link entry wins.
 * @param {string} raw session file content (JSONL)
 */
function extractSessionAgentId(raw) {
	let found;
	for (const line of raw.split("\n")) {
		if (!line.includes(CHILD_LINK_ENTRY_TYPE)) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.customType === CHILD_LINK_ENTRY_TYPE && typeof entry.data?.agentId === "string") {
				found = entry.data.agentId;
			}
		} catch {
			// skip unparsable lines
		}
	}
	return found;
}

/**
 * Ported from extensions/side-agents.ts listResumableSessions branch
 * assignment (contract copy): newest-first candidates; only the first
 * session per agent id may reattach `side-agent/<id>`, and ids of currently
 * active agents are seeded as already taken.
 * @param {Array<{agentId: string | undefined}>} newestFirst
 * @param {Set<string>} activeAgentIds
 */
function assignResumeBranches(newestFirst, activeAgentIds = new Set()) {
	const seen = new Set(activeAgentIds);
	const out = [];
	for (const { agentId } of newestFirst) {
		if (!agentId) continue; // no side-agent-link → not offered
		const branchHeldElsewhere = seen.has(agentId);
		seen.add(agentId);
		out.push({ agentId, branch: branchHeldElsewhere ? undefined : `side-agent/${agentId}`, branchHeldElsewhere });
	}
	return out;
}

test("extractSessionAgentId — finds agent id in link entry", () => {
	const raw = [
		JSON.stringify({ type: "custom", customType: "other", data: { agentId: "nope" } }),
		JSON.stringify({ type: "custom", customType: CHILD_LINK_ENTRY_TYPE, data: { agentId: "fix-auth" } }),
	].join("\n");
	assert.strictEqual(extractSessionAgentId(raw), "fix-auth");
});

test("extractSessionAgentId — last link entry wins (resumed under deduplicated id)", () => {
	const raw = [
		JSON.stringify({ type: "custom", customType: CHILD_LINK_ENTRY_TYPE, data: { agentId: "fix-auth" } }),
		JSON.stringify({ type: "message" }),
		JSON.stringify({ type: "custom", customType: CHILD_LINK_ENTRY_TYPE, data: { agentId: "fix-auth-2" } }),
	].join("\n");
	assert.strictEqual(extractSessionAgentId(raw), "fix-auth-2");
});

test("extractSessionAgentId — tolerates malformed lines and missing links", () => {
	assert.strictEqual(extractSessionAgentId(""), undefined);
	assert.strictEqual(extractSessionAgentId('{"type":"message"}'), undefined);
	const raw = [
		`garbage ${CHILD_LINK_ENTRY_TYPE} not-json`,
		JSON.stringify({ type: "custom", customType: CHILD_LINK_ENTRY_TYPE, data: { agentId: "ok-id" } }),
	].join("\n");
	assert.strictEqual(extractSessionAgentId(raw), "ok-id");
});

test("extractSessionAgentId — ignores link entries with non-string agentId", () => {
	const raw = [
		JSON.stringify({ type: "custom", customType: CHILD_LINK_ENTRY_TYPE, data: { agentId: 42 } }),
		JSON.stringify({ type: "custom", customType: CHILD_LINK_ENTRY_TYPE, data: {} }),
	].join("\n");
	assert.strictEqual(extractSessionAgentId(raw), undefined);
	const mixed = [
		JSON.stringify({ type: "custom", customType: CHILD_LINK_ENTRY_TYPE, data: { agentId: "real-id" } }),
		JSON.stringify({ type: "custom", customType: CHILD_LINK_ENTRY_TYPE, data: { agentId: null } }),
	].join("\n");
	assert.strictEqual(extractSessionAgentId(mixed), "real-id");
});

test("assignResumeBranches — newest session per agent id keeps the branch", () => {
	const out = assignResumeBranches([
		{ agentId: "fix-auth" },
		{ agentId: "add-retry" },
		{ agentId: "fix-auth" }, // older incarnation of the same id
		{ agentId: undefined }, // no link → excluded
	]);
	assert.deepStrictEqual(out, [
		{ agentId: "fix-auth", branch: "side-agent/fix-auth", branchHeldElsewhere: false },
		{ agentId: "add-retry", branch: "side-agent/add-retry", branchHeldElsewhere: false },
		{ agentId: "fix-auth", branch: undefined, branchHeldElsewhere: true },
	]);
});

test("assignResumeBranches — active agent ids block branch reattachment", () => {
	const out = assignResumeBranches(
		[{ agentId: "fix-auth" }, { agentId: "add-retry" }],
		new Set(["fix-auth"]), // fix-auth is currently running — its branch is live
	);
	assert.deepStrictEqual(out, [
		{ agentId: "fix-auth", branch: undefined, branchHeldElsewhere: true },
		{ agentId: "add-retry", branch: "side-agent/add-retry", branchHeldElsewhere: false },
	]);
});

// ---------------------------------------------------------------------------
// 7. /agent-resume picker-name rename sanitizer (contract copies)
// ---------------------------------------------------------------------------

function resumeBranchNotePort(c) {
	if (c.branch) return c.branchExists ? "" : "[branch pruned; will recreate from HEAD]";
	return c.branchHeldBy === "active-agent"
		? "[branch held by ACTIVE agent → fresh branch]"
		: "[branch owned by newer session → fresh branch]";
}

function resumePreviewBodyPort(c) {
	if (c.name) return c.name;
	return truncateWithEllipsis(stripTerminalNoise(c.firstMessage ?? "").replace(/\s+/g, " ").trim(), 80);
}

function synthesizedPickerNamePort(c) {
	const note = resumeBranchNotePort(c);
	const body = resumePreviewBodyPort(c);
	const parts = [c.agentId];
	if (note) parts.push(note);
	if (body) parts.push(`· ${body}`);
	return parts.join(" ");
}

function sanitizeRenameTitlePort(c, input) {
	let next = input.trim();
	if (!next) return undefined;
	if (next === synthesizedPickerNamePort(c)) return undefined;
	const note = resumeBranchNotePort(c);
	if (note) next = next.split(note).join(" ");
	next = next.replace(/\s+/g, " ").trim();
	const prefix = `${c.agentId} · `;
	if (next.includes(prefix)) next = next.split(prefix).join("");
	next = next.replace(/\s+/g, " ").trim();
	if (!next || next === c.agentId) return undefined;
	if (c.name && next === c.name) return undefined;
	if (!c.name && next === resumePreviewBodyPort(c)) return undefined;
	return next;
}

const NAMED = { agentId: "fix-auth", name: "Old", branch: "side-agent/fix-auth", branchExists: true };
const UNNAMED_HELD = { agentId: "fix-auth", firstMessage: "fix the auth leak", branchHeldBy: "newer-session" };

test("sanitizeRenameTitle — untouched prefill is a no-op", () => {
	assert.strictEqual(sanitizeRenameTitlePort(NAMED, synthesizedPickerNamePort(NAMED)), undefined);
	assert.strictEqual(sanitizeRenameTitlePort(UNNAMED_HELD, synthesizedPickerNamePort(UNNAMED_HELD)), undefined);
});

test("sanitizeRenameTitle — typing at cursor position 0 strips decorations", () => {
	// prefill "fix-auth · Old", cursor at 0, user types "X"
	assert.strictEqual(sanitizeRenameTitlePort(NAMED, "Xfix-auth · Old"), "XOld");
	// with a branch note in the prefill
	const prefill = synthesizedPickerNamePort(UNNAMED_HELD);
	assert.strictEqual(sanitizeRenameTitlePort(UNNAMED_HELD, `X${prefill}`), "Xfix the auth leak");
});

test("sanitizeRenameTitle — edited body keeps only the user title", () => {
	assert.strictEqual(sanitizeRenameTitlePort(NAMED, "fix-auth · New title"), "New title");
	assert.strictEqual(
		sanitizeRenameTitlePort(UNNAMED_HELD, "fix-auth [branch owned by newer session → fresh branch] · New title"),
		"New title",
	);
});

test("sanitizeRenameTitle — fresh typed name passes through", () => {
	assert.strictEqual(sanitizeRenameTitlePort(NAMED, "My new name"), "My new name");
});

test("sanitizeRenameTitle — degenerate results are no-ops", () => {
	assert.strictEqual(sanitizeRenameTitlePort(NAMED, "fix-auth"), undefined); // bare id
	assert.strictEqual(sanitizeRenameTitlePort(NAMED, "fix-auth · Old"), undefined); // unchanged real name
	assert.strictEqual(sanitizeRenameTitlePort(UNNAMED_HELD, "fix the auth leak"), undefined); // preview as-is
	assert.strictEqual(sanitizeRenameTitlePort(NAMED, "   "), undefined); // empty
});

// ---------------------------------------------------------------------------
// 8. /agent-resume slot preference (contract copy of allocateWorktree reorder)
// ---------------------------------------------------------------------------

/**
 * Ported from extensions/side-agents.ts allocateWorktree: the free-slot scan
 * takes the first eligible slot, so the resumed session's original directory
 * is moved to the front of the slot list when present.
 * @param {{index:number,path:string}[]} slots
 * @param {string|undefined} preferredPath
 */
function preferSlotPort(slots, preferredPath) {
	if (preferredPath) {
		const resolvedPreferred = resolvePath(preferredPath);
		const idx = slots.findIndex((s) => resolvePath(s.path) === resolvedPreferred);
		if (idx > 0) slots.unshift(...slots.splice(idx, 1));
	}
	return slots;
}

test("agent-resume slot preference — original session dir is scanned first", () => {
	const mk = () => [
		{ index: 1, path: "/w/repo-agent-worktree-0001" },
		{ index: 2, path: "/w/repo-agent-worktree-0002" },
		{ index: 3, path: "/w/repo-agent-worktree-0003" },
	];
	assert.deepStrictEqual(
		preferSlotPort(mk(), "/w/repo-agent-worktree-0002/").map((s) => s.index),
		[2, 1, 3],
	);
	// preferred already first / absent / undefined → order untouched
	assert.deepStrictEqual(preferSlotPort(mk(), "/w/repo-agent-worktree-0001").map((s) => s.index), [1, 2, 3]);
	assert.deepStrictEqual(preferSlotPort(mk(), "/w/repo").map((s) => s.index), [1, 2, 3]);
	assert.deepStrictEqual(preferSlotPort(mk(), undefined).map((s) => s.index), [1, 2, 3]);
});
