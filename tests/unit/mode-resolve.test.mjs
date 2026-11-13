/**
 * `-mode` / `mode` (pi-amplike modes) resolution for new side agents, shared by
 * the `/agent` command and the `agent-start` tool.
 *
 * Exercises the real resolveRequestedModel from extensions/side-agents.ts
 * against a project-level `.pi/modes.json` in a temp dir (project file wins
 * over the global one, so the test does not depend on the user's setup).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const { __testing } = await import(resolve("extensions/side-agents.ts"));

async function withModes(modes, fn) {
	const cwd = await mkdtemp(join(tmpdir(), "side-agents-modes-"));
	try {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(cwd, ".pi", "modes.json"), JSON.stringify({ modes }));
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

const MODES = {
	rush: { provider: "anthropic", modelId: "claude-haiku-4-5", thinkingLevel: "low" },
	plain: { provider: "openai", modelId: "gpt-5" },
	broken: { thinkingLevel: "high" },
};

test("mode resolves to provider/modelId with the mode's thinking level", async () => {
	await withModes(MODES, async (cwd) => {
		assert.deepStrictEqual(await __testing.resolveRequestedModel(cwd, undefined, "rush"), {
			model: "anthropic/claude-haiku-4-5:low",
		});
		assert.deepStrictEqual(await __testing.resolveRequestedModel(cwd, undefined, "plain"), {
			model: "openai/gpt-5",
		});
	});
});

test("explicit model wins over mode", async () => {
	await withModes(MODES, async (cwd) => {
		assert.deepStrictEqual(await __testing.resolveRequestedModel(cwd, "openai/gpt-5", "rush"), {
			model: "openai/gpt-5",
		});
	});
});

test("unknown or incomplete mode warns and requests no model", async () => {
	await withModes(MODES, async (cwd) => {
		for (const mode of ["nope", "broken"]) {
			const result = await __testing.resolveRequestedModel(cwd, undefined, mode);
			assert.equal(result.model, undefined);
			assert.match(result.warning, new RegExp(`Mode '${mode}'.*child inherits the current model`));
		}
	});
});

test("no model and no mode requests nothing", async () => {
	assert.deepStrictEqual(await __testing.resolveRequestedModel(tmpdir(), undefined, undefined), {});
});
