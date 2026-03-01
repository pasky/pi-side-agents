import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PROJECT_ROOT = resolve(process.cwd());
const EXTENSION_SOURCE = resolve(PROJECT_ROOT, "extensions/parallel-agents.ts");
const MODEL_SPEC = process.env.PI_PARALLEL_IT_MODEL ?? "openai-codex/gpt-5.1-codex-mini";
const AUTH_SOURCE = join(homedir(), ".pi", "agent", "auth.json");
const TEST_TIMEOUT = Number(process.env.PI_PARALLEL_IT_TIMEOUT_MS ?? 240_000);

let authReady = false;
let piShimCleanup = async () => {};

before(async () => {
	authReady = await hasOpenAiCodexAuth();
	piShimCleanup = await ensureLoginShellPiCommand();
});

after(async () => {
	await piShimCleanup();
});

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		timeout: options.timeoutMs ?? 30_000,
	});

	if (result.error) {
		throw new Error(`Command error: ${command} ${args.join(" ")}\n${result.error.message}`);
	}

	if ((result.status ?? 1) !== 0 && !options.allowFailure) {
		const stderr = result.stderr?.trim() || "";
		const stdout = result.stdout?.trim() || "";
		throw new Error(
			`Command failed (${result.status}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
		);
	}

	return {
		status: result.status ?? 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

async function exists(path) {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeScreen(text) {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\r/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

async function waitFor(description, fn, options = {}) {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const intervalMs = options.intervalMs ?? 250;
	const startedAt = Date.now();
	let lastError;

	while (Date.now() - startedAt < timeoutMs) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(intervalMs);
	}

	const suffix = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
	throw new Error(`Timed out waiting for ${description}${suffix}`);
}

function parseModelSpec(spec) {
	const slashIndex = spec.indexOf("/");
	if (slashIndex <= 0 || slashIndex === spec.length - 1) {
		throw new Error(`Invalid model spec: ${spec}. Expected provider/modelId`);
	}
	return {
		provider: spec.slice(0, slashIndex),
		modelId: spec.slice(slashIndex + 1),
	};
}

async function hasOpenAiCodexAuth() {
	if (!(await exists(AUTH_SOURCE))) return false;
	try {
		const raw = await readFile(AUTH_SOURCE, "utf8");
		const auth = JSON.parse(raw);
		return Boolean(auth?.["openai-codex"]);
	} catch {
		return false;
	}
}

async function ensureLoginShellPiCommand() {
	const localBinDir = join(homedir(), ".local", "bin");
	const localPi = join(localBinDir, "pi");
	if (await exists(localPi)) {
		return async () => {};
	}

	await mkdir(localBinDir, { recursive: true });
	const piPath = run("which", ["pi"]).stdout.trim();
	if (!piPath) {
		throw new Error("Could not find pi executable in PATH");
	}

	await symlink(piPath, localPi);
	return async () => {
		if (await exists(localPi)) {
			await unlink(localPi).catch(() => {});
		}
	};
}

function tmux(harness, args, options = {}) {
	return run("tmux", ["-S", harness.tmuxSocket, ...args], options);
}

async function capturePane(harness, target, lines = 400) {
	const result = tmux(harness, ["capture-pane", "-p", "-t", target, "-S", `-${lines}`]);
	return result.stdout;
}

async function captureParent(harness, lines = 500) {
	return capturePane(harness, harness.parentTarget, lines);
}

function sendLiteral(harness, target, text) {
	tmux(harness, ["send-keys", "-t", target, "-l", text]);
}

function sendEnter(harness, target) {
	tmux(harness, ["send-keys", "-t", target, "C-m"]);
}

async function sendParentCommand(harness, command) {
	sendLiteral(harness, harness.parentTarget, command);
	sendEnter(harness, harness.parentTarget);
	await sleep(120);
}

async function readRegistry(harness) {
	const registryPath = join(harness.repoRoot, ".pi", "parallel-agents", "registry.json");
	if (!(await exists(registryPath))) {
		return { version: 1, agents: {} };
	}
	return JSON.parse(await readFile(registryPath, "utf8"));
}

async function waitForAgent(harness, id, options = {}) {
	return waitFor(
		`registry entry for ${id}`,
		async () => {
			const registry = await readRegistry(harness);
			const agent = registry.agents?.[id];
			if (!agent) {
				if (options.terminal) {
					return { id, status: "cleaned_up" };
				}
				return false;
			}
			if (options.status && agent.status !== options.status) return false;
			if (options.terminal && !["failed", "crashed"].includes(agent.status)) return false;
			return agent;
		},
		{ timeoutMs: options.timeoutMs ?? 90_000, intervalMs: 300 },
	);
}

async function waitForAgentRemoved(harness, id, timeoutMs = 90_000) {
	return waitFor(
		`${id} removed from registry`,
		async () => {
			const registry = await readRegistry(harness);
			return registry.agents?.[id] ? false : true;
		},
		{ timeoutMs, intervalMs: 300 },
	);
}

async function waitForSpawnedAgent(harness, id, timeoutMs = 90_000) {
	return waitFor(
		`spawned agent metadata for ${id}`,
		async () => {
			const agent = await waitForAgent(harness, id, { timeoutMs: 5_000 });
			if (!agent.tmuxWindowId) return false;
			if (!agent.worktreePath) return false;
			if (!agent.runtimeDir) return false;
			if (!agent.promptPath) return false;
			if (!agent.logPath) return false;
			return agent;
		},
		{ timeoutMs, intervalMs: 300 },
	);
}

async function waitForAgentCount(harness, count, timeoutMs = 90_000) {
	return waitFor(
		`${count} registry agents`,
		async () => {
			const registry = await readRegistry(harness);
			const ids = Object.keys(registry.agents ?? {});
			return ids.length >= count ? registry : false;
		},
		{ timeoutMs, intervalMs: 300 },
	);
}

async function readWorktreeLock(worktreePath) {
	const lockPath = join(worktreePath, ".pi", "active.lock");
	return JSON.parse(await readFile(lockPath, "utf8"));
}

function windowExists(harness, windowId) {
	const result = tmux(
		harness,
		["display-message", "-p", "-t", windowId, "#{window_id}"],
		{ allowFailure: true },
	);
	return result.status === 0 && result.stdout.trim() === windowId;
}

async function waitForBacklogContains(harness, agentId, needle, timeoutMs = 90_000) {
	const backlogPath = join(harness.repoRoot, ".pi", "parallel-agents", "runtime", agentId, "backlog.log");
	return waitFor(
		`backlog for ${agentId} to contain ${needle}`,
		async () => {
			if (!(await exists(backlogPath))) return false;
			const raw = await readFile(backlogPath, "utf8");
			return normalizeScreen(raw).includes(needle);
		},
		{ timeoutMs, intervalMs: 350 },
	);
}

async function waitForParentContains(harness, needle, timeoutMs = 60_000) {
	return waitFor(
		`parent pane to contain ${needle}`,
		async () => {
			const pane = normalizeScreen(await captureParent(harness));
			return pane.includes(needle);
		},
		{ timeoutMs, intervalMs: 250 },
	);
}

async function waitForChildPiBooted(harness, agentId, timeoutMs = 90_000) {
	return waitForBacklogContains(harness, agentId, "pi v", timeoutMs);
}

// ---------------------------------------------------------------------------
// Session JSONL helpers — used to inspect actual tool-call request/response
// entries written by Pi during agentic LLM interactions.
//
// Session entry format (from docs/session.md):
//   { type: "message", id, parentId, timestamp, message: { role, ... } }
//
// Tool calls appear in AssistantMessage entries (role: "assistant") as
//   content items of type "toolCall" with a .name field.
// Tool results appear as ToolResultMessage entries (role: "toolResult") with
//   .toolName and .content[0].text containing the JSON the extension returned.
// ---------------------------------------------------------------------------

async function findSessionJsonlFiles(dir) {
	const results = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await findSessionJsonlFiles(fullPath)));
		} else if (entry.name.endsWith(".jsonl")) {
			results.push(fullPath);
		}
	}
	return results;
}

async function readParentSessionEntries(harness) {
	const files = await findSessionJsonlFiles(harness.parentSessionDir);
	if (files.length === 0) return [];
	files.sort();
	const raw = await readFile(files[files.length - 1], "utf8").catch(() => "");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

/**
 * Extract all tool-result session entries for a given tool name and parse
 * their JSON payload from content[0].text.
 */
function extractToolResultPayloads(entries, toolName) {
	return entries
		.filter(
			(e) =>
				e.type === "message" &&
				e.message?.role === "toolResult" &&
				e.message?.toolName === toolName,
		)
		.map((e) => {
			const text = e.message?.content?.[0]?.text ?? "{}";
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				payload = { _parseError: text };
			}
			return { entry: e, payload };
		});
}

/**
 * Find the last AssistantMessage entry that contains a toolCall for the given
 * tool name.  Used for timing checks (call timestamp vs result timestamp).
 */
function findAssistantToolCallEntry(entries, toolName) {
	for (const e of [...entries].reverse()) {
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const content = Array.isArray(e.message.content) ? e.message.content : [];
		const tc = content.find((c) => c.type === "toolCall" && c.name === toolName);
		if (tc) return { entry: e, toolCall: tc };
	}
	return null;
}

/**
 * Poll the parent session JSONL file until a tool-result entry for the named
 * tool appears, then return { entry, payload }.
 */
async function waitForToolResultInSession(harness, toolName, timeoutMs = 90_000) {
	return waitFor(
		`tool result for "${toolName}" in parent session`,
		async () => {
			const entries = await readParentSessionEntries(harness);
			const results = extractToolResultPayloads(entries, toolName);
			return results.length > 0 ? results[results.length - 1] : false;
		},
		{ timeoutMs, intervalMs: 500 },
	);
}

async function waitForNextToolResultInSession(harness, toolName, previousCount, timeoutMs = 90_000) {
	return waitFor(
		`next tool result for "${toolName}" in parent session`,
		async () => {
			const entries = await readParentSessionEntries(harness);
			const results = extractToolResultPayloads(entries, toolName);
			return results.length > previousCount ? results[results.length - 1] : false;
		},
		{ timeoutMs, intervalMs: 500 },
	);
}

async function callToolViaPrompt(harness, toolName, params, options = {}) {
	const timeoutMs = options.timeoutMs ?? 90_000;
	const retries = options.retries ?? 2;
	const argsJson = JSON.stringify(params);
	let lastError;

	for (let attempt = 1; attempt <= retries; attempt += 1) {
		const beforeEntries = await readParentSessionEntries(harness);
		const beforeCount = extractToolResultPayloads(beforeEntries, toolName).length;

		const prompt =
			attempt === 1
				? `Use the ${toolName} tool now with this exact JSON arguments object: ${argsJson}. Do not call any other tool.`
				: `Important: call the ${toolName} tool immediately (not text-only). Use exactly this JSON arguments object: ${argsJson}.`;

		await sendParentCommand(harness, prompt);

		try {
			return await waitForNextToolResultInSession(harness, toolName, beforeCount, timeoutMs);
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError ?? new Error(`Timed out waiting for ${toolName} tool result`);
}

async function callAgentCheckTool(harness, id, timeoutMs = 90_000) {
	return callToolViaPrompt(harness, "agent-check", { id }, { timeoutMs, retries: 3 });
}

async function callAgentSendTool(harness, id, prompt, timeoutMs = 90_000) {
	return callToolViaPrompt(harness, "agent-send", { id, prompt }, { timeoutMs, retries: 3 });
}

async function closeChildWindowAfterPrompt(harness, agentId) {
	const agent = await waitForAgent(harness, agentId, { terminal: true, timeoutMs: 120_000 });
	const windowId = agent.tmuxWindowId;
	assert.ok(windowId, `agent ${agentId} should have a tmuxWindowId`);

	await waitForBacklogContains(harness, agentId, "Press any key to close this tmux window", 60_000);

	if (!windowExists(harness, windowId)) {
		return;
	}

	const childPaneRaw = await capturePane(harness, windowId, 500);
	const childPane = normalizeScreen(childPaneRaw);
	assert.ok(
		childPane.includes("Press any key to close this tmux window"),
		"child pane should show press-any-key prompt before close",
	);

	const paneTargetResult = tmux(
		harness,
		["display-message", "-p", "-t", windowId, "#{pane_id}"],
		{ allowFailure: true },
	);
	const keyTarget = paneTargetResult.status === 0 ? paneTargetResult.stdout.trim() || windowId : windowId;

	tmux(harness, ["send-keys", "-t", keyTarget, "-l", "x"], { allowFailure: true });
	tmux(harness, ["send-keys", "-t", keyTarget, "C-m"], { allowFailure: true });
	try {
		await waitFor(
			`tmux window ${windowId} to close`,
			async () => {
				if (!windowExists(harness, windowId)) return true;
				tmux(harness, ["send-keys", "-t", keyTarget, "-l", "x"], { allowFailure: true });
				tmux(harness, ["send-keys", "-t", keyTarget, "C-m"], { allowFailure: true });
				return false;
			},
			{ timeoutMs: 30_000, intervalMs: 1_500 },
		);
	} catch (error) {
		tmux(harness, ["kill-window", "-t", windowId], { allowFailure: true });
		await waitFor(
			`forced close of tmux window ${windowId}`,
			async () => !windowExists(harness, windowId),
			{ timeoutMs: 10_000, intervalMs: 250 },
		);
		if (windowExists(harness, windowId)) {
			throw error;
		}
	}
}

async function createHarness(t, options = {}) {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-parallel-it-"));
	const repoRoot = join(rootDir, "repo");
	const agentDir = join(rootDir, "agent-dir");
	const parentSessionDir = join(rootDir, "sessions");
	const tmuxSocket = join(rootDir, "tmux.sock");
	const sessionName = `it-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

	const { provider, modelId } = parseModelSpec(MODEL_SPEC);

	await mkdir(repoRoot, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await mkdir(parentSessionDir, { recursive: true });

	run("git", ["init", "-b", "main"], { cwd: repoRoot });
	run("git", ["config", "user.email", "integration@example.com"], { cwd: repoRoot });
	run("git", ["config", "user.name", "Integration Runner"], { cwd: repoRoot });

	await mkdir(join(repoRoot, ".pi", "extensions"), { recursive: true });
	await writeFile(
		join(repoRoot, ".pi", "extensions", "parallel-agents.ts"),
		`export { default } from ${JSON.stringify(EXTENSION_SOURCE)};\n`,
	);
	await writeFile(join(repoRoot, "README.md"), "# integration fixture\n");

	run("git", ["add", "."], { cwd: repoRoot });
	run("git", ["commit", "-m", "fixture init"], { cwd: repoRoot });

	if (options.lockedParallelAgentSlot) {
		const occupiedSlotPath = join(rootDir, `${basename(repoRoot)}-agent-worktree-0001`);
		run("git", ["worktree", "add", "-B", "parallel-agent/a-0001", occupiedSlotPath, "main"], { cwd: repoRoot });
		await mkdir(join(occupiedSlotPath, ".pi"), { recursive: true });
		await writeFile(
			join(occupiedSlotPath, ".pi", "active.lock"),
			JSON.stringify({
				agentId: "a-0001",
				pid: 123456,
				branch: "parallel-agent/a-0001",
				startedAt: new Date().toISOString(),
			}) + "\n",
		);
	}

	if (options.staleLockSlot) {
		const staleSlotPath = join(rootDir, `${basename(repoRoot)}-agent-worktree-0001`);
		await mkdir(join(staleSlotPath, ".pi"), { recursive: true });
		await writeFile(
			join(staleSlotPath, ".pi", "active.lock"),
			JSON.stringify({
				agentId: "orphan-9999",
				pid: 123456,
				branch: "parallel-agent/orphan-9999",
				startedAt: new Date().toISOString(),
			}) + "\n",
		);
	}

	await copyFile(AUTH_SOURCE, join(agentDir, "auth.json"));
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				defaultProvider: provider,
				defaultModel: modelId,
				defaultThinkingLevel: "minimal",
				packages: [],
			},
			null,
			2,
		) + "\n",
	);

	const launchScript = join(rootDir, "launch-parent.sh");
	await writeFile(
		launchScript,
		`#!/usr/bin/env bash
set -euo pipefail
cd ${JSON.stringify(repoRoot)}
exec pi --model ${JSON.stringify(MODEL_SPEC)} --thinking minimal --session-dir ${JSON.stringify(parentSessionDir)} --no-skills --no-prompt-templates --no-themes
`,
	);
	await chmod(launchScript, 0o755);

	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_PARALLEL_AGENTS_ROOT: repoRoot,
		PI_OFFLINE: "1",
	};

	tmux(
		{ tmuxSocket },
		["new-session", "-d", "-s", sessionName, "-x", "180", "-y", "55", `bash ${launchScript}`],
		{ env },
	);

	const harness = {
		rootDir,
		repoRoot,
		agentDir,
		parentSessionDir,
		tmuxSocket,
		sessionName,
		parentTarget: `${sessionName}:0`,
	};

	t.after(async () => {
		tmux(harness, ["kill-server"], { allowFailure: true });
		await rm(rootDir, { recursive: true, force: true });
	});

	await waitFor(
		"parent pi startup",
		async () => {
			const pane = normalizeScreen(await captureParent(harness));
			return pane.includes("/ for commands") && pane.includes("parallel-agents.ts");
		},
		{ timeoutMs: 90_000, intervalMs: 300 },
	);

	return harness;
}

function assertAuthOrSkip(t) {
	if (!authReady) {
		t.skip("Requires ~/.pi/agent/auth.json with openai-codex credentials");
		return false;
	}
	return true;
}

function spawnWithCapture(command, args, options = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const timeoutMs = options.timeoutMs ?? 120_000;
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			rejectPromise(new Error(`Timed out: ${command} ${args.join(" ")}`));
		}, timeoutMs);

		child.on("error", (error) => {
			clearTimeout(timeout);
			rejectPromise(error);
		});

		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ code: code ?? -1, stdout, stderr });
		});
	});
}

test(
	"integration: /agent launch + agent-check/agent-send tools + child press-any-key close",
	{ timeout: TEST_TIMEOUT },
	async (t) => {
		if (!assertAuthOrSkip(t)) return;

		const harness = await createHarness(t);

		await sendParentCommand(harness, `/agent -model ${MODEL_SPEC} integration scenario one`);
		const started = await waitForSpawnedAgent(harness, "a-0001");
		await waitForParentContains(harness, "parallel-agent started", 45_000);
		await waitForParentContains(harness, "prompt:", 45_000);

		assert.equal(started.branch, "parallel-agent/a-0001");
		assert.ok(started.worktreePath, "worktreePath should be recorded");
		assert.ok(await exists(started.worktreePath), "worktree directory should exist");

		const runtimeDir = join(harness.repoRoot, ".pi", "parallel-agents", "runtime", "a-0001");
		for (const fileName of ["kickoff.md", "backlog.log", "launch.sh"]) {
			assert.ok(await exists(join(runtimeDir, fileName)), `runtime file missing: ${fileName}`);
		}
		await waitForBacklogContains(harness, "a-0001", "[parallel-agent][prompt]", 60_000);
		await waitForBacklogContains(harness, "a-0001", "integration scenario one", 60_000);

		const launchScript = await readFile(join(runtimeDir, "launch.sh"), "utf8");
		assert.ok(
			launchScript.includes("--skill") && launchScript.includes(".pi/parallel-agent-skills"),
			"child launch script should load .pi/parallel-agent-skills via --skill so finish is discoverable",
		);

		const linked = await waitFor(
			"child session link in registry",
			async () => {
				const agent = await waitForAgent(harness, "a-0001", { timeoutMs: 5_000 });
				return agent.childSessionId ? agent : false;
			},
			{ timeoutMs: 90_000, intervalMs: 300 },
		);
		assert.ok(linked.childSessionId, "childSessionId should be captured when child extension loads");

		const lock = await waitFor(
			"active lock to include child sessionId",
			async () => {
				const payload = await readWorktreeLock(started.worktreePath);
				return payload.sessionId ? payload : false;
			},
			{ timeoutMs: 90_000, intervalMs: 300 },
		);
		assert.equal(lock.agentId, "a-0001");
		assert.equal(lock.branch, "parallel-agent/a-0001");
		assert.equal(lock.tmuxWindowId, started.tmuxWindowId);

		await waitForParentContains(harness, "a-0001:", 45_000);

		await sendParentCommand(harness, "/agents");
		await waitForParentContains(harness, "a-0001", 30_000);
		await waitForParentContains(
			harness,
			`branch:${started.branch}  worktree:${basename(started.worktreePath)}`,
			30_000,
		);

		const runningCheck = await callAgentCheckTool(harness, "a-0001", 60_000);
		assert.equal(runningCheck.payload.ok, true, `agent-check should succeed: ${JSON.stringify(runningCheck.payload)}`);
		assert.equal(runningCheck.payload.agent?.id, "a-0001");
		assert.ok(typeof runningCheck.payload.agent?.status === "string", "agent-check should return agent.status");
		assert.ok(Array.isArray(runningCheck.payload.backlog), "agent-check should return backlog array");
		await waitForChildPiBooted(harness, "a-0001", 120_000);

		const steeringToken = `steering-token-${Date.now()}`;
		const steeringSend = await callAgentSendTool(harness, "a-0001", steeringToken, 60_000);
		assert.equal(steeringSend.payload.ok, true, `agent-send should succeed: ${JSON.stringify(steeringSend.payload)}`);
		await waitForBacklogContains(harness, "a-0001", steeringToken, 90_000);

		const quitSend = await callAgentSendTool(harness, "a-0001", "!/quit", 60_000);
		assert.equal(quitSend.payload.ok, true, `agent-send /quit should succeed: ${JSON.stringify(quitSend.payload)}`);
		await waitForBacklogContains(harness, "a-0001", "/quit", 90_000);

		await waitForAgentRemoved(harness, "a-0001", 120_000);
		assert.ok(await exists(join(runtimeDir, "exit.json")), "exit.json should be created when child exits");
		const exitPayload = JSON.parse(await readFile(join(runtimeDir, "exit.json"), "utf8"));
		assert.equal(exitPayload.exitCode, 0, `expected exitCode 0 in exit marker: ${JSON.stringify(exitPayload)}`);

		const doneCheck = await callAgentCheckTool(harness, "a-0001", 60_000);
		assert.equal(doneCheck.payload.ok, false, `agent-check after successful quit should be unknown: ${JSON.stringify(doneCheck.payload)}`);
		assert.ok(
			typeof doneCheck.payload.error === "string" && doneCheck.payload.error.includes("Unknown agent id"),
			`expected unknown-agent error after cleanup: ${JSON.stringify(doneCheck.payload)}`,
		);
		await waitForParentContains(harness, "Press any key to close this tmux window", 30_000);

		await closeChildWindowAfterPrompt(harness, "a-0001");
	},
);

test(
	"integration: next agent id skips checked-out parallel-agent branch in a stale locked slot",
	{ timeout: TEST_TIMEOUT },
	async (t) => {
		if (!assertAuthOrSkip(t)) return;

		const harness = await createHarness(t, { lockedParallelAgentSlot: true });

		await sendParentCommand(harness, `/agent -model ${MODEL_SPEC} branch collision regression`);
		const started = await waitForSpawnedAgent(harness, "a-0002", 180_000);

		assert.equal(started.branch, "parallel-agent/a-0002");
		assert.ok(started.worktreePath.endsWith("0002"), `expected slot 0002, got ${started.worktreePath}`);
		assert.ok(
			(started.warnings ?? []).some((warning) => warning.includes("Locked worktree is not tracked in registry")),
			"expected stale lock warning to be surfaced",
		);

		await waitForChildPiBooted(harness, "a-0002", 120_000);
		const quitSend = await callAgentSendTool(harness, "a-0002", "!/quit", 60_000);
		assert.equal(quitSend.payload.ok, true, `agent-send should succeed: ${JSON.stringify(quitSend.payload)}`);
		await callAgentSendTool(harness, "a-0002", "!/quit", 60_000);
		await waitForAgent(harness, "a-0002", { terminal: true, timeoutMs: 180_000 });
		await closeChildWindowAfterPrompt(harness, "a-0002");
	},
);

test(
	"integration: stale/orphan lock warning visibility and worktree slot reuse",
	{ timeout: TEST_TIMEOUT },
	async (t) => {
		if (!assertAuthOrSkip(t)) return;

		const harness = await createHarness(t, { staleLockSlot: true });

		await sendParentCommand(harness, `/agent -model ${MODEL_SPEC} stale lock test`);
		const first = await waitForSpawnedAgent(harness, "a-0001");

		assert.ok(first.worktreePath.endsWith("0002"), `expected new slot 0002, got ${first.worktreePath}`);
		assert.ok(
			(first.warnings ?? []).some((warning) => warning.includes("Locked worktree is not tracked in registry")),
			"registry warnings should include stale lock warning",
		);
		await waitForParentContains(harness, "warning: Locked worktree is not tracked in registry", 30_000);
		await waitForChildPiBooted(harness, "a-0001", 120_000);

		const firstQuitSend = await callAgentSendTool(harness, "a-0001", "!/quit", 60_000);
		assert.equal(firstQuitSend.payload.ok, true, `agent-send should succeed: ${JSON.stringify(firstQuitSend.payload)}`);
		await callAgentSendTool(harness, "a-0001", "!/quit", 60_000);
		await waitForAgent(harness, "a-0001", { terminal: true, timeoutMs: 180_000 });
		await closeChildWindowAfterPrompt(harness, "a-0001");

		const firstLockPath = join(first.worktreePath, ".pi", "active.lock");
		if (await exists(firstLockPath)) {
			await unlink(firstLockPath);
		}
		assert.equal(run("git", ["-C", first.worktreePath, "status", "--porcelain"]).stdout.trim(), "");

		await sendParentCommand(harness, `/agent -model ${MODEL_SPEC} reuse unlocked slot`);
		const second = await waitForSpawnedAgent(harness, "a-0002");
		assert.equal(second.worktreePath, first.worktreePath, "expected worktree slot to be reused");
		await waitForChildPiBooted(harness, "a-0002", 120_000);

		const secondQuitSend = await callAgentSendTool(harness, "a-0002", "!/quit", 60_000);
		assert.equal(secondQuitSend.payload.ok, true, `agent-send should succeed: ${JSON.stringify(secondQuitSend.payload)}`);
		await callAgentSendTool(harness, "a-0002", "!/quit", 60_000);
		await waitForAgent(harness, "a-0002", { terminal: true, timeoutMs: 180_000 });
		await closeChildWindowAfterPrompt(harness, "a-0002");
	},
);

test(
	"integration: concurrent multiple agents from one parent with distinct windows/worktrees",
	{ timeout: TEST_TIMEOUT },
	async (t) => {
		if (!assertAuthOrSkip(t)) return;

		const harness = await createHarness(t);

		await sendParentCommand(harness, `/agent -model ${MODEL_SPEC} concurrent one`);
		await waitForSpawnedAgent(harness, "a-0001");

		await sendParentCommand(harness, `/agent -model ${MODEL_SPEC} concurrent two`);
		await waitForAgentCount(harness, 2, 180_000);
		await waitForSpawnedAgent(harness, "a-0002", 180_000);

		const registry = await readRegistry(harness);
		const a1 = registry.agents["a-0001"];
		const a2 = registry.agents["a-0002"];

		assert.ok(a1 && a2, "both agents should exist in registry");
		assert.notEqual(a1.worktreePath, a2.worktreePath, "concurrent agents should use different worktrees");
		assert.notEqual(a1.tmuxWindowId, a2.tmuxWindowId, "concurrent agents should use different tmux windows");
		assert.notEqual(a1.tmuxWindowIndex, a2.tmuxWindowIndex, "concurrent agents should use different tmux indices");

		assert.equal(windowExists(harness, a1.tmuxWindowId), true, "a-0001 window should exist");
		assert.equal(windowExists(harness, a2.tmuxWindowId), true, "a-0002 window should exist");

		await sendParentCommand(harness, "/agents");
		await waitForParentContains(harness, "a-0001", 30_000);
		await waitForParentContains(harness, "a-0002", 30_000);
		await waitForParentContains(harness, "a-0001:", 45_000);
		await waitForParentContains(harness, "a-0002:", 45_000);
		await waitForChildPiBooted(harness, "a-0001", 120_000);
		await waitForChildPiBooted(harness, "a-0002", 120_000);

		const quitA1 = await callAgentSendTool(harness, "a-0001", "!/quit", 60_000);
		assert.equal(quitA1.payload.ok, true, `agent-send should succeed for a-0001: ${JSON.stringify(quitA1.payload)}`);
		const quitA2 = await callAgentSendTool(harness, "a-0002", "!/quit", 60_000);
		assert.equal(quitA2.payload.ok, true, `agent-send should succeed for a-0002: ${JSON.stringify(quitA2.payload)}`);
		await callAgentSendTool(harness, "a-0002", "!/quit", 60_000);

		await waitForAgent(harness, "a-0001", { terminal: true, timeoutMs: 120_000 });
		await waitForAgent(harness, "a-0002", { terminal: true, timeoutMs: 180_000 });

		await waitForBacklogContains(harness, "a-0001", "Press any key to close this tmux window", 60_000);
		await waitForBacklogContains(harness, "a-0002", "Press any key to close this tmux window", 60_000);

		await closeChildWindowAfterPrompt(harness, "a-0001");
		await closeChildWindowAfterPrompt(harness, "a-0002");
	},
);

test("integration: merge-lock serialization in finish script", { timeout: TEST_TIMEOUT }, async (t) => {
	const rootDir = await mkdtemp(join(tmpdir(), "pi-parallel-merge-it-"));
	const repoRoot = join(rootDir, "repo");
	const wt1 = join(rootDir, "worktree-a1");
	const wt2 = join(rootDir, "worktree-a2");

	t.after(async () => {
		await rm(rootDir, { recursive: true, force: true });
	});

	await mkdir(repoRoot, { recursive: true });
	run("git", ["init", "-b", "main"], { cwd: repoRoot });
	run("git", ["config", "user.email", "integration@example.com"], { cwd: repoRoot });
	run("git", ["config", "user.name", "Integration Runner"], { cwd: repoRoot });

	await writeFile(join(repoRoot, "README.md"), "merge lock fixture\n");
	run("git", ["add", "README.md"], { cwd: repoRoot });
	run("git", ["commit", "-m", "initial"], { cwd: repoRoot });

	await mkdir(join(repoRoot, ".pi"), { recursive: true });
	const finishScriptPath = join(repoRoot, ".pi", "parallel-agent-finish.sh");
	await writeFile(
		finishScriptPath,
		`#!/usr/bin/env bash
set -euo pipefail

PARENT_ROOT="\${PI_PARALLEL_PARENT_REPO:-\${1:-}}"
AGENT_ID="\${PI_PARALLEL_AGENT_ID:-\${2:-unknown}}"
MAIN_BRANCH="main"
BRANCH="$(git branch --show-current)"

if [[ -z "$PARENT_ROOT" ]]; then
  echo "[parallel-agent-finish] Missing parent checkout path."
  exit 1
fi

if [[ -z "$BRANCH" ]]; then
  echo "[parallel-agent-finish] Could not determine current branch."
  exit 1
fi

LOCK_DIR="$PARENT_ROOT/.pi/parallel-agents"
LOCK_FILE="$LOCK_DIR/merge.lock"
mkdir -p "$LOCK_DIR"

MERGE_LOCK_TIMEOUT=120

acquire_lock() {
  local payload started elapsed
  payload="{\"agentId\":\"$AGENT_ID\",\"pid\":$$,\"acquiredAt\":\"$(date -Is)\"}"
  started=$(date +%s)
  while true; do
    if ( set -o noclobber; printf '%s\\n' "$payload" > "$LOCK_FILE" ) 2>/dev/null; then
      return 0
    fi
    elapsed=$(( $(date +%s) - started ))
    if [[ "$elapsed" -ge "$MERGE_LOCK_TIMEOUT" ]]; then
      echo "[parallel-agent-finish] Timed out after \${MERGE_LOCK_TIMEOUT}s waiting for merge lock."
      echo "[parallel-agent-finish] Stale lock? Inspect: $LOCK_FILE"
      exit 3
    fi
    echo "[parallel-agent-finish] Waiting for merge lock... (\${elapsed}s / \${MERGE_LOCK_TIMEOUT}s)"
    sleep 1
  done
}

release_lock() {
  rm -f "$LOCK_FILE" || true
}

trap 'release_lock' EXIT

while true; do
  echo "[parallel-agent-finish] Reconciling child branch: git merge $MAIN_BRANCH"
  if ! git merge "$MAIN_BRANCH"; then
    echo "[parallel-agent-finish] Conflict while merging $MAIN_BRANCH into $BRANCH."
    exit 2
  fi

  acquire_lock

  set +e
  (
    cd "$PARENT_ROOT" || exit 1
    git checkout "$MAIN_BRANCH" >/dev/null 2>&1 || exit 1
    sleep 2
    git merge --no-edit "$BRANCH"
  )
  merge_status=$?
  set -e

  release_lock

  if [[ "$merge_status" -eq 0 ]]; then
    echo "[parallel-agent-finish] Success: merged $BRANCH -> $MAIN_BRANCH in parent checkout."
    rm -f "$(pwd)/.pi/active.lock" || true
    exit 0
  fi

  echo "[parallel-agent-finish] Parent merge failed (likely $MAIN_BRANCH moved)."
  echo "[parallel-agent-finish] Aborting parent merge and retrying reconcile loop..."
  (
    cd "$PARENT_ROOT" || exit 1
    git merge --abort >/dev/null 2>&1 || true
  )

  sleep 1
done
`,
	);
	await chmod(finishScriptPath, 0o755);


	run("git", ["worktree", "add", "-B", "parallel-agent/a-0001", wt1, "main"], { cwd: repoRoot });
	run("git", ["worktree", "add", "-B", "parallel-agent/a-0002", wt2, "main"], { cwd: repoRoot });

	await writeFile(join(wt1, "from-agent-1.txt"), "agent one\n");
	run("git", ["add", "from-agent-1.txt"], { cwd: wt1 });
	run("git", ["commit", "-m", "agent one change"], { cwd: wt1 });

	await writeFile(join(wt2, "from-agent-2.txt"), "agent two\n");
	run("git", ["add", "from-agent-2.txt"], { cwd: wt2 });
	run("git", ["commit", "-m", "agent two change"], { cwd: wt2 });

	const baseEnv = { ...process.env, PI_PARALLEL_PARENT_REPO: repoRoot };
	const firstPromise = spawnWithCapture("bash", [finishScriptPath], {
		cwd: wt1,
		env: { ...baseEnv, PI_PARALLEL_AGENT_ID: "a-0001" },
		timeoutMs: 180_000,
	});

	await sleep(300);

	const secondPromise = spawnWithCapture("bash", [finishScriptPath], {
		cwd: wt2,
		env: { ...baseEnv, PI_PARALLEL_AGENT_ID: "a-0002" },
		timeoutMs: 180_000,
	});

	const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

	assert.equal(firstResult.code, 0, `first finisher failed:\n${firstResult.stdout}\n${firstResult.stderr}`);
	assert.equal(secondResult.code, 0, `second finisher failed:\n${secondResult.stdout}\n${secondResult.stderr}`);

	const mergedLogs = `${firstResult.stdout}\n${secondResult.stdout}`;
	assert.ok(
		mergedLogs.includes("Waiting for merge lock"),
		`expected lock wait message in outputs:\n--- first ---\n${firstResult.stdout}\n--- second ---\n${secondResult.stdout}`,
	);

	assert.equal(await exists(join(repoRoot, ".pi", "parallel-agents", "merge.lock")), false, "merge.lock should be released");

	const tree = run("git", ["-C", repoRoot, "ls-tree", "--name-only", "-r", "main"]).stdout;
	assert.ok(tree.includes("from-agent-1.txt"), "main should contain agent-1 change");
	assert.ok(tree.includes("from-agent-2.txt"), "main should contain agent-2 change");
});

// =============================================================================
// Tool-contract integration tests
//
// These tests cover the three bugs fixed in the audit session that had no
// integration coverage, plus important response-shape contracts:
//
//  1. agent-check response shapes — unknown id → ok:false, known → ok:true
//     with a full field audit via real tool invocation.
//
//  2. agent-start tool execute → { ok: true } — the specific fix: ok:true was
//     previously absent from the tool JSON response.  Verified by reading the
//     ToolResultMessage entry written to the parent Pi session JSONL file.
//
//  3. agent-wait-any fail-fast on unknown id → { ok: false } returned in
//     < 3 s (not an infinite polling loop).  Verified via session JSONL +
//     timestamp delta between the toolCall and toolResult entries.
//
//  4. agent-send !text — C-c interrupt followed by follow-up text: both the
//     interrupt *and* the unique follow-up token must appear in the child
//     backlog, exercising the 300 ms sleep fix that prevents the follow-up
//     text from racing with the interrupt.
//
//  5. agent-wait-any behavior after successful cleanup — when an agent exits
//     with code 0 and is auto-pruned from registry, waiting on that id should
//     return { ok:false, error } rather than hanging. Tested in the same
//     harness as (2) to avoid extra Pi startup overhead.
// =============================================================================

// ---------------------------------------------------------------------------
// Test 1 — agent-check response shapes via tool invocation.
// ---------------------------------------------------------------------------
test(
	"integration: tool-contract — agent-check shapes: unknown id → ok:false, known agent → ok:true with all fields",
	{ timeout: TEST_TIMEOUT },
	async (t) => {
		if (!assertAuthOrSkip(t)) return;

		const harness = await createHarness(t);

		// — Unknown id -------------------------------------------------------
		const unknownCheck = await callAgentCheckTool(harness, "a-9999", 60_000);
		assert.equal(unknownCheck.payload.ok, false, `unknown id should return ok:false: ${JSON.stringify(unknownCheck.payload)}`);
		assert.ok(typeof unknownCheck.payload.error === "string", "unknown id should return an error string");
		assert.ok(
			unknownCheck.payload.error.includes("a-9999"),
			`error should include unknown id, got: ${unknownCheck.payload.error}`,
		);

		// — Known agent -------------------------------------------------------
		// Start one agent so we have a real registry entry to inspect.
		await sendParentCommand(harness, `/agent -model ${MODEL_SPEC} shape-audit smoke`);
		const spawned = await waitForSpawnedAgent(harness, "a-0001");

		const knownCheck = await callAgentCheckTool(harness, "a-0001", 60_000);
		assert.equal(knownCheck.payload.ok, true, `known id should return ok:true: ${JSON.stringify(knownCheck.payload)}`);
		assert.ok(knownCheck.payload.agent, "agent-check success should include agent object");
		assert.ok(Array.isArray(knownCheck.payload.backlog), "agent-check success should include backlog array");

		const checkedAgent = knownCheck.payload.agent;
		assert.equal(checkedAgent.id, "a-0001");
		assert.equal(checkedAgent.branch, "parallel-agent/a-0001");
		assert.ok(typeof checkedAgent.status === "string", "agent.status should be present");
		assert.ok(typeof checkedAgent.task === "string", "agent.task should be present");
		assert.ok(typeof checkedAgent.startedAt === "string", "agent.startedAt should be present");
		assert.ok(Array.isArray(checkedAgent.warnings), "agent.warnings should be an array");
		assert.ok(typeof checkedAgent.tmuxWindowId === "string", "agent.tmuxWindowId should be a string");
		assert.ok(typeof checkedAgent.tmuxWindowIndex === "number", "agent.tmuxWindowIndex should be a number");
		assert.ok(typeof checkedAgent.worktreePath === "string", "agent.worktreePath should be present");

		// Verify the tmux fields match what the registry recorded
		const reg = await readRegistry(harness);
		const rec = reg.agents["a-0001"];
		assert.ok(rec, "a-0001 must exist in registry");
		assert.equal(rec.tmuxWindowId, spawned.tmuxWindowId, "registry tmuxWindowId should match spawned value");
		assert.equal(rec.branch, "parallel-agent/a-0001", "registry branch should follow naming convention");

		// Cleanup — wait for child Pi to boot before sending !/quit so the
		// interrupt is delivered while Pi is at an interactive prompt.
		// Without this, C-c arrives before Pi is ready and is discarded,
		// leaving the agent running until waitForAgent(terminal) times out.
		await waitForChildPiBooted(harness, "a-0001", 120_000);
		const quitSend = await callAgentSendTool(harness, "a-0001", "!/quit", 60_000);
		assert.equal(quitSend.payload.ok, true, `agent-send should succeed: ${JSON.stringify(quitSend.payload)}`);
		await waitForAgent(harness, "a-0001", { terminal: true, timeoutMs: 120_000 });
		await closeChildWindowAfterPrompt(harness, "a-0001");
	},
);

// ---------------------------------------------------------------------------
// Test 2 — agent-start tool execute returns { ok: true } with all required
// fields AND agent-wait-any handles a success-pruned id without hanging.
//
// WHY THIS IS A GENUINE END-TO-END INTEGRATION TEST:
//
//   createHarness() starts a real Pi process inside a real tmux session backed
//   by a real isolated git repository.  sendParentCommand() types real
//   keystrokes into the tmux pane; Pi's configured LLM (a live network call,
//   no mocking) processes the message and decides to invoke agent-start.
//   Pi's extension framework runs the real agent-start execute() which creates
//   a real git worktree, spawns a real child tmux window, and writes to the
//   real registry.json.  Pi then records the exact JSON returned by execute()
//   as a ToolResultMessage in its session JSONL file — that JSONL is the only
//   authoritative record of what execute() returned to the LLM.  Reading it
//   from disk is not a mock; it is inspecting the direct output of the real
//   code path under test.
//
//   In addition, the test cross-validates the tool result against observable
//   external effects:
//     • waitForSpawnedAgent confirms the registry was written with all tmux
//       and worktree fields (side-effects of a successful execute()).
//     • windowExists(harness, sp.tmuxWindowId) confirms the tmuxWindowId
//       reported in the tool result refers to a real live tmux window in the
//       harness's tmux server — not an invented string.
//     • readRegistry() cross-checks that the registry fields match what the
//       tool result reported, proving the two sources agree.
//
// Bug fixed: agent-start execute() returned { id, tmuxWindowId, ... } without
// an ok field.  The LLM tool contract requires { ok: true, ... } on success.
// ---------------------------------------------------------------------------
test(
	"integration: tool-call — agent-start execute returns { ok: true } with all required fields; agent-wait-any returns error for success-pruned id",
	{ timeout: TEST_TIMEOUT },
	async (t) => {
		if (!assertAuthOrSkip(t)) return;

		const harness = await createHarness(t);

		// Frame the request as a natural user need rather than a raw tool-call
		// directive.  Models respond more reliably when the prompt maps clearly
		// to the tool's purpose ("start a parallel agent for me") than when
		// given a mechanical instruction ("call tool X with arg Y").
		// The agent is told to /quit immediately to keep the test short.
		await sendParentCommand(
			harness,
			`Please start a new parallel agent worker for me. The agent's task is: "integration-test worker — immediately type /quit to exit". Use the agent-start tool to create the agent now.`,
		);

		// Wait for the agent to appear in the registry with all tmux and
		// worktree fields populated — proves the tool's side-effects ran.
		const spawned = await waitForSpawnedAgent(harness, "a-0001", 180_000);

		// Read the parent session JSONL for the agent-start tool-result entry.
		// The JSONL records exactly what execute() returned to the LLM.
		const startResult = await waitForToolResultInSession(harness, "agent-start", 60_000);
		const sp = startResult.payload;

		// — Bug-fix assertion: ok: true must be present ——————————————————————
		assert.strictEqual(sp.ok, true, `agent-start tool result must have ok: true — got: ${JSON.stringify(sp)}`);

		// — Required field shapes ——————————————————————————————————————————————
		assert.strictEqual(sp.id, "a-0001", `id should be a-0001, got: ${sp.id}`);
		assert.ok(
			typeof sp.tmuxWindowId === "string" && sp.tmuxWindowId.startsWith("@"),
			`tmuxWindowId must be a "@N" string, got: ${sp.tmuxWindowId}`,
		);
		assert.ok(typeof sp.tmuxWindowIndex === "number", `tmuxWindowIndex must be a number, got: ${sp.tmuxWindowIndex}`);
		assert.ok(
			typeof sp.worktreePath === "string" && sp.worktreePath.length > 0,
			`worktreePath must be a non-empty string, got: ${sp.worktreePath}`,
		);
		assert.strictEqual(sp.branch, "parallel-agent/a-0001", `branch must be parallel-agent/a-0001, got: ${sp.branch}`);
		assert.ok(Array.isArray(sp.warnings), `warnings must be an array, got: ${JSON.stringify(sp.warnings)}`);

		// — External-effect cross-checks: tool result fields refer to real resources —
		// The tmuxWindowId in the tool result must be a live window in THIS harness's
		// tmux server.  If execute() had returned a fabricated id or crashed before
		// creating the window, this assertion would catch it.
		assert.ok(
			windowExists(harness, sp.tmuxWindowId),
			`tmuxWindowId "${sp.tmuxWindowId}" from tool result must be a real live tmux window in the harness`,
		);

		// Registry fields must match tool-result fields: the tool wrote them
		// atomically, so any disagreement indicates a serialisation bug.
		const reg = await readRegistry(harness);
		const rec = reg.agents["a-0001"];
		assert.ok(rec, "a-0001 must exist in registry");
		assert.strictEqual(rec.tmuxWindowId, sp.tmuxWindowId, "registry tmuxWindowId must match tool result");
		assert.strictEqual(rec.branch, sp.branch, "registry branch must match tool result");
		assert.strictEqual(rec.worktreePath, sp.worktreePath, "registry worktreePath must match tool result");
		assert.strictEqual(rec.tmuxWindowId, spawned.tmuxWindowId, "spawned tmuxWindowId must match tool result");

		// — agent-wait-any behavior after successful auto-prune ————————————
		// Terminate the agent, wait for registry cleanup, then ask the LLM to call
		// agent-wait-any. Because success records are removed, this should return
		// { ok: false, error } quickly instead of hanging.
		await waitForChildPiBooted(harness, "a-0001", 120_000);
		const quitSend = await callAgentSendTool(harness, "a-0001", "!/quit", 60_000);
		assert.equal(quitSend.payload.ok, true, `agent-send should succeed: ${JSON.stringify(quitSend.payload)}`);
		await waitForAgentRemoved(harness, "a-0001", 120_000);

		await sendParentCommand(
			harness,
			`Agent a-0001 finished and may already be cleaned up. Call the agent-wait-any tool with ids: ["a-0001"] and report the exact tool response.`,
		);

		const waitAnyResult = await waitFor(
			"agent-wait-any error result in parent session",
			async () => {
				const entries = await readParentSessionEntries(harness);
				const results = extractToolResultPayloads(entries, "agent-wait-any");
				const failure = results.find((r) => r.payload.ok === false);
				return failure || false;
			},
			{ timeoutMs: 90_000, intervalMs: 500 },
		);

		const wp = waitAnyResult.payload;
		assert.strictEqual(wp.ok, false, `agent-wait-any should fail once id is pruned, got: ${JSON.stringify(wp)}`);
		assert.ok(typeof wp.error === "string", `error must be a string, got: ${typeof wp.error}`);
		assert.ok(
			wp.error.toLowerCase().includes("unknown") ||
				wp.error.toLowerCase().includes("disappear") ||
				wp.error.includes("a-0001"),
			`error should explain missing/pruned id, got: ${wp.error}`,
		);

		await closeChildWindowAfterPrompt(harness, "a-0001");
	},
);

// ---------------------------------------------------------------------------
// Test 3 — agent-wait-any fails fast on unknown id.
//
// WHY THIS IS A GENUINE END-TO-END INTEGRATION TEST:
//
//   Same full stack as Test 2: real tmux → real Pi process → real LLM call →
//   real agent-wait-any execute() → real session JSONL written by Pi.
//   The session JSONL is not a mock; it is the authentic record of what
//   execute() returned after the real LLM decided to invoke the tool.
//
//   Timing is measured two complementary ways:
//
//   a) Wall-clock anchor: Date.now() is captured immediately before the
//      prompt is sent.  Once waitForToolResultInSession() resolves (meaning
//      the real ToolResultMessage entry has appeared in the real session file),
//      the elapsed wall-clock time is checked against a generous 60 s ceiling.
//      This catches an infinite polling loop regardless of timestamp precision.
//
//   b) JSONL timestamp delta: Pi writes a timestamp for both the AssistantMessage
//      (when the LLM emitted the toolCall) and the ToolResultMessage (when
//      execute() returned).  The delta between these two entries isolates the
//      tool execution latency from the LLM network round-trip.  Before the fix,
//      a single wasted 1 s poll would push the delta above 1 s; after the fix
//      it is milliseconds.
//
// Bug fixed: before the fix, waitForAny polled in an infinite 1 s-sleep loop
// for ids that would never appear in the registry.  After the fix, the first
// pass detects unknown ids and returns { ok: false, error } immediately.
// ---------------------------------------------------------------------------
test(
	"integration: tool-call — agent-wait-any fails fast on unknown id: ok:false within 3 s of tool call",
	{ timeout: TEST_TIMEOUT },
	async (t) => {
		if (!assertAuthOrSkip(t)) return;

		const harness = await createHarness(t);

		// Wall-clock anchor: capture time before the prompt is sent to Pi.
		// No agents have been started so the registry is empty — a-9999 is
		// guaranteed unknown.
		const wallClockStart = Date.now();

		// Frame the request as a natural status-check need so the model reliably
		// reaches for the agent-wait-any tool rather than responding in text.
		await sendParentCommand(
			harness,
			`Please check whether agent a-9999 has finished. Use the agent-wait-any tool with ids: ["a-9999"] and report what it returns.`,
		);

		// Wait for the tool-result entry to appear in the session JSONL.
		const result = await waitForToolResultInSession(harness, "agent-wait-any", 90_000);
		const { payload, entry: resultEntry } = result;

		// — Correct error shape ———————————————————————————————————————————————
		assert.strictEqual(
			payload.ok,
			false,
			`agent-wait-any with unknown id must return ok: false, got: ${JSON.stringify(payload)}`,
		);
		assert.ok(typeof payload.error === "string", `error must be a string, got: ${typeof payload.error}`);
		assert.ok(
			payload.error.toLowerCase().includes("a-9999") || payload.error.toLowerCase().includes("unknown"),
			`error should mention the unknown id or "unknown", got: "${payload.error}"`,
		);

		// — (b) JSONL timestamp delta: isolates execute() latency from LLM RTT —
		// Before the fix, even a single wasted 1 s poll would push the delta above
		// 1 s; after the fix the execute() path is synchronous and returns in < ms.
		const allEntries = await readParentSessionEntries(harness);
		const callEntry = findAssistantToolCallEntry(allEntries, "agent-wait-any");
		if (callEntry) {
			const callTs = new Date(callEntry.entry.timestamp).getTime();
			const resultTs = new Date(resultEntry.timestamp).getTime();
			const deltaMs = resultTs - callTs;
			assert.ok(
				deltaMs < 3_000,
				`agent-wait-any fail-fast: JSONL delta from toolCall to toolResult was ${deltaMs} ms (must be < 3 s). ` +
					"Without the fix the function would have polled indefinitely.",
			);
		}

		// — (a) Wall-clock guard: total time from prompt send to tool result ——
		// 60 s gives generous room for LLM network latency while being impossible
		// to satisfy if the tool were stuck in a 1 s polling loop.
		const wallClockElapsedMs = Date.now() - wallClockStart;
		assert.ok(
			wallClockElapsedMs < 60_000,
			`agent-wait-any fail-fast: wall-clock from prompt to tool result was ${wallClockElapsedMs} ms. ` +
				"Exceeds 60 s — suggests the tool was polling instead of returning immediately.",
		);
	},
);

// ---------------------------------------------------------------------------
// Test 4 — agent-send !text: C-c interrupt + follow-up text both land in the
// child backlog.
//
// WHY THIS IS A GENUINE END-TO-END INTEGRATION TEST:
//
//   1. /agent starts a real child Pi process in a real tmux window.
//   2. The parent is prompted to invoke the real `agent-send` tool.
//   3. The tool sends real keystrokes (including interrupt + 300 ms pause).
//   4. Assertions read the real child backlog.log for unique tokens.
//
// Bug fixed: before the 300 ms sleep fix, C-c was followed immediately by the
// follow-up text.  If Pi's interrupt handler was still running when the text
// arrived, the text was dropped or misrouted.  Removing the sleep reproduces
// the race; the test would time out on waitForBacklogContains.
// ---------------------------------------------------------------------------
test(
	"integration: agent-send !text — C-c interrupt + unique follow-up token both arrive in child backlog",
	{ timeout: TEST_TIMEOUT },
	async (t) => {
		if (!assertAuthOrSkip(t)) return;

		const harness = await createHarness(t);

		await sendParentCommand(harness, `/agent -model ${MODEL_SPEC} interrupt follow-up test`);
		await waitForSpawnedAgent(harness, "a-0001");
		await waitForChildPiBooted(harness, "a-0001", 120_000);

		// Step 1: plain send — confirm the basic send path works end-to-end.
		// A unique token avoids false-positive matches from prior test runs.
		const plainToken = `plain-send-${Date.now()}`;
		const plainSend = await callAgentSendTool(harness, "a-0001", plainToken, 60_000);
		assert.equal(plainSend.payload.ok, true, `plain agent-send should succeed: ${JSON.stringify(plainSend.payload)}`);
		await waitForBacklogContains(harness, "a-0001", plainToken, 60_000);

		// Step 2: interrupt + follow-up text using the ! prefix.
		// This exercises the race-condition fix: C-c → sleep(300 ms) → send text.
		// The unique token is generated after Step 1 completes so timestamps differ.
		const interruptToken = `after-interrupt-${Date.now()}`;
		const interruptSend = await callAgentSendTool(harness, "a-0001", `!${interruptToken}`, 60_000);
		assert.equal(interruptSend.payload.ok, true, `interrupt agent-send should succeed: ${JSON.stringify(interruptSend.payload)}`);

		// The follow-up token MUST appear in the child's real backlog.log file.
		// Without the 300 ms sleep the token can be dropped in the interrupt-
		// handler race; this assertion would time out, catching the regression.
		await waitForBacklogContains(harness, "a-0001", interruptToken, 60_000);

		// Step 3: cleanup — bare "!" (interrupt-only, no text) sends /quit.
		// The bare-interrupt path skips the 300 ms sleep; this confirms that the
		// no-follow-up branch is handled cleanly (no dangling send, no extra sleep).
		const quitSend = await callAgentSendTool(harness, "a-0001", "!/quit", 60_000);
		assert.equal(quitSend.payload.ok, true, `quit agent-send should succeed: ${JSON.stringify(quitSend.payload)}`);
		await waitForAgent(harness, "a-0001", { terminal: true, timeoutMs: 120_000 });
		await closeChildWindowAfterPrompt(harness, "a-0001");
	},
);
