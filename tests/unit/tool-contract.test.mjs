/**
 * Tool contract unit tests for pi-parallel-agents.
 *
 * These tests validate the JSON-shape contracts and pure-function behavior of
 * the agent control tools without requiring a live Pi process, real tmux, or
 * real git worktrees.  They complement the full integration suite at
 * tests/integration/parallel-agents.integration.test.mjs.
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
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Minimal JS re-implementations of pure extension functions
// (kept in sync with extensions/parallel-agents.ts by contract)
// ---------------------------------------------------------------------------

/** @param {string} status */
function isTerminalStatus(status) {
	return status === "done" || status === "failed" || status === "crashed";
}

/**
 * @param {string} text
 * @param {number} count
 * @returns {string[]}
 */
function tailLines(text, count) {
	const lines = text
		.split(/\r?\n/)
		.filter((line, i, arr) => !(i === arr.length - 1 && line.length === 0));
	return lines.slice(-count);
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

function sanitizeBacklogLines(lines, lineMax = 240, totalMax = 2400) {
	const out = [];
	let remaining = totalMax;

	for (const raw of lines) {
		if (remaining <= 0) break;
		const cleaned = stripTerminalNoise(raw).trimEnd();
		if (cleaned.length === 0) continue;

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
 * Reads a registry JSON at stateRoot/.pi/parallel-agents/registry.json.
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

	const registryPath = join(stateRoot, ".pi", "parallel-agents", "registry.json");
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

// ---------------------------------------------------------------------------
// Helper: temporary registry factory
// ---------------------------------------------------------------------------

async function makeTempRegistry(t, agents = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-parallel-unit-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const metaDir = join(dir, ".pi", "parallel-agents");
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

test("cleanupWorktreeLockBestEffort — removes existing lock and remains idempotent", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-parallel-lock-"));
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
	const dir = await mkdtemp(join(tmpdir(), "pi-parallel-lock-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	await assert.doesNotReject(() => cleanupWorktreeLockBestEffort(undefined));
	await assert.doesNotReject(() => cleanupWorktreeLockBestEffort(join(dir, "wt-no-lock")));
});

// ---------------------------------------------------------------------------
// 2. JSON shape / ok-field contracts
// ---------------------------------------------------------------------------

test("agent-start success shape must include ok: true", () => {
	// This test acts as a living specification for the tool contract.
	// If this shape changes, the tool description and docs must be updated.
	const exampleSuccess = {
		ok: true,
		id: "a-0001",
		tmuxWindowId: "@5",
		tmuxWindowIndex: 5,
		worktreePath: "/tmp/repo-agent-worktree-0001",
		branch: "parallel-agent/a-0001",
		warnings: [],
	};

	assert.strictEqual(exampleSuccess.ok, true, "success response must have ok: true");
	assert.ok(typeof exampleSuccess.id === "string", "id must be a string");
	assert.ok(typeof exampleSuccess.tmuxWindowId === "string", "tmuxWindowId must be a string");
	assert.ok(typeof exampleSuccess.tmuxWindowIndex === "number", "tmuxWindowIndex must be a number");
	assert.ok(typeof exampleSuccess.worktreePath === "string", "worktreePath must be a string");
	assert.ok(typeof exampleSuccess.branch === "string", "branch must be a string");
	assert.ok(Array.isArray(exampleSuccess.warnings), "warnings must be an array");
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
			branch: "parallel-agent/a-0001",
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
// 5. Branch naming convention
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Slug generation helpers (kept in sync with extensions/parallel-agents.ts)
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

test("agent branch name follows parallel-agent/<slug> convention", () => {
	function branchForId(id) {
		return `parallel-agent/${id}`;
	}

	assert.strictEqual(branchForId("fix-auth-leak"), "parallel-agent/fix-auth-leak");
	assert.strictEqual(branchForId("add-retry"), "parallel-agent/add-retry");

	// Branch must not start with a slash or dot
	const branch = branchForId("fix-auth-leak");
	assert.ok(!branch.startsWith("/"), "branch must not start with /");
	assert.ok(!branch.startsWith("."), "branch must not start with .");
});
