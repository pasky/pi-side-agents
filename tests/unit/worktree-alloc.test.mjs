/**
 * Regression: concurrent agent starts must never be handed the same worktree slot.
 *
 * Seen in the wild: three parallel agent-start tool calls from one parent; two
 * of them both picked the free slot 0001 (scan was unlocked, the claim —
 * .pi/active.lock — was written only after the git checkout), and the second
 * one's checkout deleted the first one's branch.
 *
 * Exercises the real allocateWorktree from extensions/side-agents.ts (loaded via
 * Node's TypeScript type stripping) against a throwaway git repo.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";

const { __testing } = await import(resolve("extensions/side-agents.ts"));

function git(args, cwd) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout.trim();
}

async function makeRepo(t, freeSlots) {
	const root = await mkdtemp(join(tmpdir(), "pi-side-alloc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repoRoot = join(root, "repo");
	await mkdir(repoRoot);
	git(["init", "-q", "-b", "main"], repoRoot);
	git(["config", "user.email", "t@example.com"], repoRoot);
	git(["config", "user.name", "t"], repoRoot);
	await writeFile(join(repoRoot, ".gitignore"), ".pi/\n");
	await writeFile(join(repoRoot, "README"), "hi\n");
	git(["add", "."], repoRoot);
	git(["commit", "-q", "-m", "init"], repoRoot);
	// Pre-existing, unlocked, clean slots (left behind by earlier finished agents).
	for (let i = 1; i <= freeSlots; i += 1) {
		const slot = join(root, `${basename(repoRoot)}-agent-worktree-${String(i).padStart(4, "0")}`);
		git(["worktree", "add", "-q", "-b", `side-agent/old-${i}`, slot, "HEAD"], repoRoot);
	}
	return { root, repoRoot };
}

async function allocateConcurrently(allocate, repoRoot, ids) {
	return Promise.all(
		ids.map((agentId) => allocate({ repoRoot, stateRoot: repoRoot, agentId, parentSessionId: undefined })),
	);
}

function assertDistinctAndIntact(repoRoot, ids, results) {
	const paths = results.map((r) => r.worktreePath);
	assert.equal(new Set(paths).size, ids.length, `slots must be distinct, got: ${paths.join(", ")}`);
	for (const [i, id] of ids.entries()) {
		const branch = `side-agent/${id}`;
		assert.equal(results[i].branch, branch);
		assert.equal(git(["branch", "--show-current"], results[i].worktreePath), branch, `${id} worktree HEAD`);
		git(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
	}
}

for (const freeSlots of [0, 1, 2]) {
	test(`allocateWorktree — 4 concurrent starts with ${freeSlots} free slot(s) get distinct slots`, async (t) => {
		const { repoRoot } = await makeRepo(t, freeSlots);
		const ids = ["alpha", "beta", "gamma", "delta"];
		const results = await allocateConcurrently(__testing.allocateWorktree, repoRoot, ids);
		assertDistinctAndIntact(repoRoot, ids, results);
	});
}

test("allocateWorktreeUnlocked — the unserialized scan does race (guards the test's sensitivity)", async (t) => {
	const { repoRoot } = await makeRepo(t, 1);
	const ids = ["alpha", "beta", "gamma", "delta"];
	const results = await Promise.allSettled(
		ids.map((agentId) => __testing.allocateWorktreeUnlocked({ repoRoot, stateRoot: repoRoot, agentId })),
	);
	const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value.worktreePath);
	const collided = new Set(ok).size < ok.length || results.some((r) => r.status === "rejected");
	assert.ok(collided, `expected the unlocked allocator to collide, got: ${JSON.stringify(results.map((r) => r.status === "fulfilled" ? r.value.worktreePath : String(r.reason)))}`);
});

// ---------------------------------------------------------------------------
// Cross-process: separate node processes allocating at once
// ---------------------------------------------------------------------------

test("allocateWorktree — concurrent starts from separate processes get distinct slots", async (t) => {
	const { repoRoot } = await makeRepo(t, 1);
	const ids = ["p-alpha", "p-beta", "p-gamma"];
	const modUrl = pathToFileURL(resolve("extensions/side-agents.ts")).href;
	const script = `
		const { __testing } = await import(${JSON.stringify(modUrl)});
		const r = await __testing.allocateWorktree({ repoRoot: process.argv[1], stateRoot: process.argv[1], agentId: process.argv[2] });
		process.stdout.write(JSON.stringify(r));
	`;
	const runs = ids.map(
		(id) =>
			new Promise((resolveRun, rejectRun) => {
				const child = spawn(process.execPath, ["--input-type=module", "-e", script, repoRoot, id], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let out = "";
				let err = "";
				child.stdout.on("data", (d) => (out += d));
				child.stderr.on("data", (d) => (err += d));
				child.on("close", (code) => (code === 0 ? resolveRun(JSON.parse(out)) : rejectRun(new Error(`${id}: ${err}`))));
			}),
	);
	const results = await Promise.all(runs);
	assertDistinctAndIntact(repoRoot, ids, results);
});

// ---------------------------------------------------------------------------
// withFileLock semantics
// ---------------------------------------------------------------------------

const DEAD_PID = 2 ** 30; // above any pid_max

async function writeOldLock(lockPath, payload) {
	await mkdir(dirname(lockPath), { recursive: true });
	await writeFile(lockPath, JSON.stringify(payload) + "\n");
	const old = new Date(Date.now() - 5 * 60_000);
	await utimes(lockPath, old, old);
}

test("withFileLock — waiters racing to break the same dead-holder lock never overlap", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-side-lock-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (let round = 0; round < 30; round += 1) {
		const lockPath = join(dir, `l${round}.lock`);
		await writeOldLock(lockPath, { pid: DEAD_PID, token: "dead" });
		let active = 0;
		let maxActive = 0;
		let entered = 0;
		await Promise.all(
			Array.from({ length: 16 }, () =>
				__testing.withFileLock(
					lockPath,
					async () => {
						active += 1;
						entered += 1;
						maxActive = Math.max(maxActive, active);
						await sleep(2);
						active -= 1;
					},
					{ timeoutMs: 20_000, staleMs: Number.POSITIVE_INFINITY },
				),
			),
		);
		assert.equal(entered, 16);
		assert.equal(maxActive, 1, "critical sections must not overlap");
	}
});

test("withFileLock — a live holder is never evicted when staleMs is Infinity", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-side-lock-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const lockPath = join(dir, "live.lock");
	await writeOldLock(lockPath, { pid: process.pid, token: "someone-else" });
	let ran = false;
	await assert.rejects(
		__testing.withFileLock(lockPath, async () => {
			ran = true;
		}, { timeoutMs: 400, staleMs: Number.POSITIVE_INFINITY }),
		/Timed out waiting for lock .*held by pid/,
	);
	assert.equal(ran, false);
	assert.match(await readFile(lockPath, "utf8"), /someone-else/, "live holder's lock must stay in place");
});

test("withFileLock — an EEXIST error thrown by fn propagates instead of re-running fn", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-side-lock-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const lockPath = join(dir, "x.lock");
	let calls = 0;
	await assert.rejects(
		__testing.withFileLock(lockPath, async () => {
			calls += 1;
			throw Object.assign(new Error("boom"), { code: "EEXIST" });
		}),
		/boom/,
	);
	assert.equal(calls, 1);
	await assert.rejects(readFile(lockPath), { code: "ENOENT" }, "lock released after fn throws");
});

test("withFileLock — release does not delete a lock now owned by someone else", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-side-lock-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const lockPath = join(dir, "y.lock");
	await __testing.withFileLock(lockPath, async () => {
		// Simulate our lock having been broken and re-acquired by another owner.
		await rm(lockPath);
		await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "other-owner" }) + "\n");
	});
	assert.match(await readFile(lockPath, "utf8"), /other-owner/);
});
