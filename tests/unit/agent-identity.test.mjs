/**
 * Regression: a pi process started from inside a side agent (e.g. a background
 * `pi -p` research job run through the agent's bash tool) inherits the agent's
 * PI_SIDE_* environment. Its agent_end used to mark the agent waiting_user
 * while the agent itself was still working, so agent-wait-any returned early.
 *
 * Loads the real extension in subprocesses: an "agent" process that claims the
 * identity and runs a nested pi-like process inheriting its environment.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const extensionUrl = pathToFileURL(resolve("extensions/side-agents.ts")).href;

// argv[2]: "nested" = claim the identity, then run a nested process ("end") with
// the inherited environment; "end" = load the extension and fire agent_end.
const harness = `
import { spawnSync } from "node:child_process";
const { default: factory } = await import(${JSON.stringify(extensionUrl)});
const handlers = {};
factory({ registerCommand() {}, registerTool() {}, on(name, fn) { handlers[name] = fn; } });
if (process.argv[2] === "nested") {
	const r = spawnSync(process.execPath, [process.argv[1], "end"], { stdio: "inherit" });
	process.exit(r.status ?? 1);
}
await handlers.agent_end({}, { cwd: process.env.PI_SIDE_AGENTS_ROOT });
`;

async function setup(t) {
	const root = await mkdtemp(join(tmpdir(), "pi-side-identity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const metaDir = join(root, ".pi", "side-agents");
	await mkdir(metaDir, { recursive: true });
	const registryPath = join(metaDir, "registry.json");
	const now = new Date().toISOString();
	await writeFile(
		registryPath,
		JSON.stringify({ version: 1, agents: { a1: { id: "a1", task: "t", status: "running", startedAt: now, updatedAt: now } } }),
	);
	const script = join(root, "harness.mjs");
	await writeFile(script, harness);
	const env = { ...process.env, PI_SIDE_AGENT_ID: "a1", PI_SIDE_AGENTS_ROOT: root };
	delete env.PI_SIDE_AGENT_OWNER_PID;
	const run = (mode) => {
		const r = spawnSync(process.execPath, [script, mode], { env, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
	};
	const status = async () => JSON.parse(await readFile(registryPath, "utf8")).agents.a1.status;
	return { run, status };
}

test("agent_end of a pi process nested inside a side agent leaves the agent's status alone", async (t) => {
	const { run, status } = await setup(t);
	run("nested");
	assert.equal(await status(), "running");
});

test("agent_end of the side agent itself marks it waiting_user", async (t) => {
	const { run, status } = await setup(t);
	run("end");
	assert.equal(await status(), "waiting_user");
});
