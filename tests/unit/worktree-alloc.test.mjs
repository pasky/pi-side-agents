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
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
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
