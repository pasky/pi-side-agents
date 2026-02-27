import { complete, type Message } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const ENV_STATE_ROOT = "PI_PARALLEL_AGENTS_ROOT";
const ENV_AGENT_ID = "PI_PARALLEL_AGENT_ID";
const ENV_PARENT_SESSION = "PI_PARALLEL_PARENT_SESSION";
const ENV_PARENT_REPO = "PI_PARALLEL_PARENT_REPO";
const ENV_RUNTIME_DIR = "PI_PARALLEL_RUNTIME_DIR";

const STATUS_KEY = "parallel-agents";
const REGISTRY_VERSION = 1;
const CHILD_LINK_ENTRY_TYPE = "parallel-agent-link";

const SUMMARY_SYSTEM_PROMPT = `You are writing a handoff summary for a background coding agent.

Given the full parent conversation and the requested child task, produce a concise context package with:

1) Current objective and relevant constraints
2) Decisions already made
3) Important files/components to inspect
4) Risks or caveats the child should know

Keep it short and actionable.`;

type AgentStatus =
	| "allocating_worktree"
	| "spawning_tmux"
	| "starting"
	| "running"
	| "waiting_user"
	| "finishing"
	| "waiting_merge_lock"
	| "retrying_reconcile"
	| "done"
	| "failed"
	| "crashed";

type AgentRecord = {
	id: string;
	parentSessionId?: string;
	childSessionId?: string;
	tmuxSession?: string;
	tmuxWindowId?: string;
	tmuxWindowIndex?: number;
	worktreePath?: string;
	branch?: string;
	model?: string;
	task: string;
	status: AgentStatus;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	runtimeDir?: string;
	logPath?: string;
	promptPath?: string;
	exitFile?: string;
	exitCode?: number;
	error?: string;
	warnings?: string[];
};

type RegistryFile = {
	version: 1;
	agents: Record<string, AgentRecord>;
};

type AllocateWorktreeResult = {
	worktreePath: string;
	slotIndex: number;
	branch: string;
	warnings: string[];
};

type StartAgentParams = {
	task: string;
	model?: string;
	includeSummary: boolean;
};

type StartAgentResult = {
	id: string;
	tmuxWindowId: string;
	tmuxWindowIndex: number;
	worktreePath: string;
	branch: string;
	warnings: string[];
};

type ExitMarker = {
	exitCode?: number;
	finishedAt?: string;
};

type CommandResult = {
	ok: boolean;
	status: number | null;
	stdout: string;
	stderr: string;
	error?: string;
};

let statusPollTimer: NodeJS.Timeout | undefined;
let statusPollContext: ExtensionContext | undefined;
let statusPollInFlight = false;

function nowIso() {
	return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveNow) => setTimeout(resolveNow, ms));
}

function stringifyError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function emptyRegistry(): RegistryFile {
	return {
		version: REGISTRY_VERSION,
		agents: {},
	};
}

function isTerminalStatus(status: AgentStatus): boolean {
	return status === "done" || status === "failed" || status === "crashed";
}

function statusShort(status: AgentStatus): string {
	switch (status) {
		case "allocating_worktree":
			return "alloc";
		case "spawning_tmux":
			return "tmux";
		case "starting":
			return "start";
		case "running":
			return "run";
		case "waiting_user":
			return "wait";
		case "finishing":
			return "finish";
		case "waiting_merge_lock":
			return "lock";
		case "retrying_reconcile":
			return "retry";
		case "done":
			return "done";
		case "failed":
			return "fail";
		case "crashed":
			return "crash";
	}
}

function tailLines(text: string, count: number): string[] {
	const lines = text
		.split(/\r?\n/)
		.filter((line, i, arr) => !(i === arr.length - 1 && line.length === 0));
	return lines.slice(-count);
}

function run(command: string, args: string[], options?: { cwd?: string; input?: string }): CommandResult {
	const result = spawnSync(command, args, {
		cwd: options?.cwd,
		input: options?.input,
		encoding: "utf8",
	});

	if (result.error) {
		return {
			ok: false,
			status: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			error: result.error.message,
		};
	}

	return {
		ok: result.status === 0,
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function runOrThrow(command: string, args: string[], options?: { cwd?: string; input?: string }): CommandResult {
	const result = run(command, args, options);
	if (!result.ok) {
		const reason = result.error ? `error=${result.error}` : `exit=${result.status}`;
		throw new Error(`Command failed: ${command} ${args.join(" ")} (${reason})\n${result.stderr || result.stdout}`.trim());
	}
	return result;
}

function resolveGitRoot(cwd: string): string {
	const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (result.ok) {
		const root = result.stdout.trim();
		if (root.length > 0) return resolve(root);
	}
	return resolve(cwd);
}

function getStateRoot(ctx: ExtensionContext): string {
	const fromEnv = process.env[ENV_STATE_ROOT];
	if (fromEnv) return resolve(fromEnv);
	return resolveGitRoot(ctx.cwd);
}

function getMetaDir(stateRoot: string): string {
	return join(stateRoot, ".pi", "parallel-agents");
}

function getRegistryPath(stateRoot: string): string {
	return join(getMetaDir(stateRoot), "registry.json");
}

function getRegistryLockPath(stateRoot: string): string {
	return join(getMetaDir(stateRoot), "registry.lock");
}

function getRuntimeDir(stateRoot: string, agentId: string): string {
	return join(getMetaDir(stateRoot), "runtime", agentId);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await fs.stat(path);
		return true;
	} catch {
		return false;
	}
}

async function ensureDir(path: string): Promise<void> {
	await fs.mkdir(path, { recursive: true });
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
	try {
		const raw = await fs.readFile(path, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

async function atomicWrite(path: string, content: string): Promise<void> {
	await ensureDir(dirname(path));
	const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
	await fs.writeFile(tmp, content, "utf8");
	await fs.rename(tmp, path);
}

async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
	await ensureDir(dirname(lockPath));

	const started = Date.now();
	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx");
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: nowIso() }) + "\n", "utf8");
			} catch {
				// best effort
			}

			try {
				return await fn();
			} finally {
				await handle.close().catch(() => {});
				await fs.unlink(lockPath).catch(() => {});
			}
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;

			try {
				const st = await fs.stat(lockPath);
				if (Date.now() - st.mtimeMs > 30_000) {
					await fs.unlink(lockPath).catch(() => {});
					continue;
				}
			} catch {
				// ignore
			}

			if (Date.now() - started > 10_000) {
				throw new Error(`Timed out waiting for lock ${lockPath}`);
			}
			await sleep(40 + Math.random() * 80);
		}
	}
}

async function loadRegistry(stateRoot: string): Promise<RegistryFile> {
	const registryPath = getRegistryPath(stateRoot);
	const parsed = await readJsonFile<RegistryFile>(registryPath);
	if (!parsed || typeof parsed !== "object") return emptyRegistry();
	if (parsed.version !== REGISTRY_VERSION || typeof parsed.agents !== "object" || parsed.agents === null) {
		return emptyRegistry();
	}
	return parsed;
}

async function saveRegistry(stateRoot: string, registry: RegistryFile): Promise<void> {
	const registryPath = getRegistryPath(stateRoot);
	await atomicWrite(registryPath, JSON.stringify(registry, null, 2) + "\n");
}

async function mutateRegistry(stateRoot: string, mutator: (registry: RegistryFile) => Promise<void> | void): Promise<RegistryFile> {
	const lockPath = getRegistryLockPath(stateRoot);
	return withFileLock(lockPath, async () => {
		const registry = await loadRegistry(stateRoot);
		const before = JSON.stringify(registry);
		await mutator(registry);
		const after = JSON.stringify(registry);
		if (after !== before) {
			await saveRegistry(stateRoot, registry);
		}
		return registry;
	});
}

function nextAgentId(registry: RegistryFile): string {
	let max = 0;
	for (const id of Object.keys(registry.agents)) {
		const m = id.match(/^a-(\d+)$/);
		if (!m) continue;
		const n = Number(m[1]);
		if (Number.isFinite(n)) max = Math.max(max, n);
	}
	return `a-${String(max + 1).padStart(4, "0")}`;
}

async function writeWorktreeLock(worktreePath: string, payload: Record<string, unknown>): Promise<void> {
	const lockPath = join(worktreePath, ".pi", "active.lock");
	await ensureDir(dirname(lockPath));
	await atomicWrite(lockPath, JSON.stringify(payload, null, 2) + "\n");
}

async function updateWorktreeLock(worktreePath: string, patch: Record<string, unknown>): Promise<void> {
	const lockPath = join(worktreePath, ".pi", "active.lock");
	const current = (await readJsonFile<Record<string, unknown>>(lockPath)) ?? {};
	await writeWorktreeLock(worktreePath, { ...current, ...patch });
}

function listRegisteredWorktrees(repoRoot: string): Set<string> {
	const result = runOrThrow("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
	const set = new Set<string>();
	for (const line of result.stdout.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			set.add(resolve(line.slice("worktree ".length).trim()));
		}
	}
	return set;
}

type WorktreeSlot = {
	index: number;
	path: string;
};

async function listWorktreeSlots(repoRoot: string): Promise<WorktreeSlot[]> {
	const parent = dirname(repoRoot);
	const prefix = `${basename(repoRoot)}-agent-worktree-`;
	const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d{4})$`);

	const entries = await fs.readdir(parent, { withFileTypes: true });
	const slots: WorktreeSlot[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const match = entry.name.match(re);
		if (!match) continue;
		const index = Number(match[1]);
		if (!Number.isFinite(index)) continue;
		slots.push({
			index,
			path: join(parent, entry.name),
		});
	}
	slots.sort((a, b) => a.index - b.index);
	return slots;
}

async function syncParallelAgentPiFiles(parentRepoRoot: string, worktreePath: string): Promise<void> {
	const parentPiDir = join(parentRepoRoot, ".pi");
	if (!(await fileExists(parentPiDir))) return;

	const sourceEntries = await fs.readdir(parentPiDir, { withFileTypes: true });
	const names = sourceEntries
		.filter((entry) => entry.name.startsWith("parallel-agent-"))
		.map((entry) => entry.name);
	if (names.length === 0) return;

	const worktreePiDir = join(worktreePath, ".pi");
	await ensureDir(worktreePiDir);

	for (const name of names) {
		const source = join(parentPiDir, name);
		const target = join(worktreePiDir, name);

		let shouldLink = true;
		try {
			const st = await fs.lstat(target);
			if (st.isSymbolicLink()) {
				const existing = await fs.readlink(target);
				if (resolve(dirname(target), existing) === resolve(source)) {
					shouldLink = false;
				}
			}
			if (shouldLink) {
				await fs.rm(target, { recursive: true, force: true });
			}
		} catch {
			// missing target
		}

		if (shouldLink) {
			await fs.symlink(source, target);
		}
	}
}

async function allocateWorktree(options: {
	repoRoot: string;
	stateRoot: string;
	agentId: string;
	parentSessionId?: string;
}): Promise<AllocateWorktreeResult> {
	const { repoRoot, stateRoot, agentId, parentSessionId } = options;

	const warnings: string[] = [];
	const branch = `parallel-agent/${agentId}`;
	const mainHead = runOrThrow("git", ["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();

	const registry = await loadRegistry(stateRoot);
	const slots = await listWorktreeSlots(repoRoot);
	const registered = listRegisteredWorktrees(repoRoot);

	let chosen: WorktreeSlot | undefined;
	let maxIndex = 0;

	for (const slot of slots) {
		maxIndex = Math.max(maxIndex, slot.index);
		const lockPath = join(slot.path, ".pi", "active.lock");

		if (await fileExists(lockPath)) {
			const lock = await readJsonFile<Record<string, unknown>>(lockPath);
			const lockAgentId = typeof lock?.agentId === "string" ? lock.agentId : undefined;
			if (!lockAgentId || !registry.agents[lockAgentId]) {
				warnings.push(`Locked worktree is not tracked in registry: ${slot.path}`);
			}
			continue;
		}

		const isRegistered = registered.has(resolve(slot.path));
		if (isRegistered) {
			const status = run("git", ["-C", slot.path, "status", "--porcelain"]);
			if (!status.ok) {
				warnings.push(`Could not inspect unlocked worktree, skipping: ${slot.path}`);
				continue;
			}
			if (status.stdout.trim().length > 0) {
				warnings.push(`Unlocked worktree has local changes, skipping: ${slot.path}`);
				continue;
			}
		} else {
			const entries = await fs.readdir(slot.path).catch(() => []);
			if (entries.length > 0) {
				warnings.push(`Unlocked slot is not a registered worktree and not empty, skipping: ${slot.path}`);
				continue;
			}
		}

		chosen = slot;
		break;
	}

	if (!chosen) {
		const next = maxIndex + 1 || 1;
		const parent = dirname(repoRoot);
		const name = `${basename(repoRoot)}-agent-worktree-${String(next).padStart(4, "0")}`;
		chosen = { index: next, path: join(parent, name) };
	}

	const chosenPath = chosen.path;
	const chosenRegistered = registered.has(resolve(chosenPath));

	if (chosenRegistered) {
		run("git", ["-C", chosenPath, "merge", "--abort"]);
		runOrThrow("git", ["-C", chosenPath, "reset", "--hard", mainHead]);
		runOrThrow("git", ["-C", chosenPath, "clean", "-fd"]);
		runOrThrow("git", ["-C", chosenPath, "checkout", "-B", branch, mainHead]);
	} else {
		if (await fileExists(chosenPath)) {
			const entries = await fs.readdir(chosenPath).catch(() => []);
			if (entries.length > 0) {
				throw new Error(`Cannot use worktree slot ${chosenPath}: directory exists and is not empty`);
			}
		}
		await ensureDir(dirname(chosenPath));
		runOrThrow("git", ["-C", repoRoot, "worktree", "add", "-B", branch, chosenPath, mainHead]);
	}

	await ensureDir(join(chosenPath, ".pi"));
	await syncParallelAgentPiFiles(repoRoot, chosenPath);
	await writeWorktreeLock(chosenPath, {
		agentId,
		sessionId: parentSessionId,
		parentSessionId,
		pid: process.pid,
		branch,
		startedAt: nowIso(),
	});

	return {
		worktreePath: chosenPath,
		slotIndex: chosen.index,
		branch,
		warnings,
	};
}

async function buildKickoffPrompt(ctx: ExtensionContext, task: string, includeSummary: boolean): Promise<{ prompt: string; warning?: string }> {
	const parentSession = ctx.sessionManager.getSessionFile();
	if (!includeSummary || !ctx.model) {
		return { prompt: task };
	}

	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
		.map((entry) => entry.message);

	if (messages.length === 0) {
		return { prompt: task };
	}

	try {
		const llmMessages = convertToLlm(messages);
		const conversationText = serializeConversation(llmMessages);
		const userMessage: Message = {
			role: "user",
			content: [
				{
					type: "text",
					text: `## Parent conversation\n\n${conversationText}\n\n## Child task\n\n${task}`,
				},
			],
			timestamp: Date.now(),
		};

		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		const response = await complete(
			ctx.model,
			{ systemPrompt: SUMMARY_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey },
		);

		const summary = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();

		if (!summary) {
			return { prompt: task, warning: "Context summary was empty; started child with raw task only." };
		}

		const prompt = [
			task,
			"",
			"## Parent session",
			parentSession ? `- ${parentSession}` : "- (unknown)",
			"",
			"## Context summary",
			summary,
		].join("\n");

		return { prompt };
	} catch (err) {
		return {
			prompt: task,
			warning: `Failed to generate context summary: ${stringifyError(err)}. Started child with raw task only.`,
		};
	}
}

function buildLaunchScript(params: {
	agentId: string;
	parentSessionId?: string;
	parentRepoRoot: string;
	stateRoot: string;
	worktreePath: string;
	tmuxWindowId: string;
	promptPath: string;
	exitFile: string;
	modelSpec?: string;
	runtimeDir: string;
}): string {
	return `#!/usr/bin/env bash
set -euo pipefail

AGENT_ID=${shellQuote(params.agentId)}
PARENT_SESSION=${shellQuote(params.parentSessionId ?? "")}
PARENT_REPO=${shellQuote(params.parentRepoRoot)}
STATE_ROOT=${shellQuote(params.stateRoot)}
WORKTREE=${shellQuote(params.worktreePath)}
WINDOW_ID=${shellQuote(params.tmuxWindowId)}
PROMPT_FILE=${shellQuote(params.promptPath)}
EXIT_FILE=${shellQuote(params.exitFile)}
MODEL_SPEC=${shellQuote(params.modelSpec ?? "")}
RUNTIME_DIR=${shellQuote(params.runtimeDir)}
START_SCRIPT=\"$WORKTREE/.pi/parallel-agent-start.sh\"

export ${ENV_AGENT_ID}=\"$AGENT_ID\"
export ${ENV_PARENT_SESSION}=\"$PARENT_SESSION\"
export ${ENV_PARENT_REPO}=\"$PARENT_REPO\"
export ${ENV_STATE_ROOT}=\"$STATE_ROOT\"
export ${ENV_RUNTIME_DIR}=\"$RUNTIME_DIR\"

write_exit() {
  local code="$1"
  printf '{"exitCode":%d,"finishedAt":"%s"}\n' "$code" "$(date -Is)" > "$EXIT_FILE"
}

cd "$WORKTREE"

if [[ -x "$START_SCRIPT" ]]; then
  set +e
  "$START_SCRIPT" "$PARENT_REPO" "$WORKTREE" "$AGENT_ID"
  start_exit=$?
  set -e
  if [[ "$start_exit" -ne 0 ]]; then
    echo "[parallel-agent] start script failed with code $start_exit"
    write_exit "$start_exit"
    read -n 1 -s -r -p "[parallel-agent] Press any key to close this tmux window..." || true
    echo
    tmux kill-window -t "$WINDOW_ID" || true
    exit "$start_exit"
  fi
fi

PI_CMD=(pi)
if [[ -n "$MODEL_SPEC" ]]; then
  PI_CMD+=(--model "$MODEL_SPEC")
fi

set +e
"\${PI_CMD[@]}" "$(cat "$PROMPT_FILE")"
exit_code=$?
set -e

write_exit "$exit_code"

if [[ "$exit_code" -eq 0 ]]; then
  echo "[parallel-agent] Agent finished."
else
  echo "[parallel-agent] Agent exited with code $exit_code."
fi

read -n 1 -s -r -p "[parallel-agent] Press any key to close this tmux window..." || true
echo

tmux kill-window -t "$WINDOW_ID" || true
`;
}

function ensureTmuxReady(): void {
	const version = run("tmux", ["-V"]);
	if (!version.ok) {
		throw new Error("tmux is required for /agent but was not found or is not working");
	}

	const session = run("tmux", ["display-message", "-p", "#S"]);
	if (!session.ok) {
		throw new Error("/agent must be run from inside tmux (current tmux session was not detected)");
	}
}

function getCurrentTmuxSession(): string {
	const result = runOrThrow("tmux", ["display-message", "-p", "#S"]);
	const value = result.stdout.trim();
	if (!value) throw new Error("Failed to determine current tmux session");
	return value;
}

function createTmuxWindow(tmuxSession: string, name: string): { windowId: string; windowIndex: number } {
	const result = runOrThrow("tmux", [
		"new-window",
		"-t",
		tmuxSession,
		"-P",
		"-F",
		"#{window_id} #{window_index}",
		"-n",
		name,
	]);
	const out = result.stdout.trim();
	const [windowId, indexRaw] = out.split(/\s+/);
	const windowIndex = Number(indexRaw);
	if (!windowId || !Number.isFinite(windowIndex)) {
		throw new Error(`Unable to parse tmux window identity: ${out}`);
	}
	return { windowId, windowIndex };
}

function tmuxWindowExists(windowId: string): boolean {
	const result = run("tmux", ["display-message", "-p", "-t", windowId, "#{window_id}"]);
	return result.ok && result.stdout.trim() === windowId;
}

function tmuxPipePaneToFile(windowId: string, logPath: string): void {
	runOrThrow("tmux", ["pipe-pane", "-t", windowId, "-o", `cat >> ${shellQuote(logPath)}`]);
}

function tmuxSendLine(windowId: string, line: string): void {
	runOrThrow("tmux", ["send-keys", "-t", windowId, line, "C-m"]);
}

function tmuxInterrupt(windowId: string): void {
	run("tmux", ["send-keys", "-t", windowId, "C-c"]);
}

function tmuxSendPrompt(windowId: string, prompt: string): void {
	const loaded = run("tmux", ["load-buffer", "-"], { input: prompt });
	if (!loaded.ok) {
		throw new Error(`Failed to send input to tmux window ${windowId}: ${loaded.stderr || loaded.error || "unknown error"}`);
	}
	runOrThrow("tmux", ["paste-buffer", "-d", "-t", windowId]);
	runOrThrow("tmux", ["send-keys", "-t", windowId, "C-m"]);
}

function tmuxCaptureTail(windowId: string, lines = 10): string[] {
	const captured = run("tmux", ["capture-pane", "-p", "-t", windowId, "-S", "-300"]);
	if (!captured.ok) return [];
	return tailLines(captured.stdout, lines);
}

async function refreshOneAgentRuntime(record: AgentRecord): Promise<void> {
	if (record.exitFile && (await fileExists(record.exitFile))) {
		const exit = (await readJsonFile<ExitMarker>(record.exitFile)) ?? {};
		if (typeof exit.exitCode === "number") {
			record.exitCode = exit.exitCode;
			record.finishedAt = exit.finishedAt ?? record.finishedAt ?? nowIso();
			record.status = exit.exitCode === 0 ? "done" : "failed";
			record.updatedAt = nowIso();
			return;
		}
	}

	if (record.tmuxWindowId) {
		const live = tmuxWindowExists(record.tmuxWindowId);
		if (live) {
			if (record.status === "allocating_worktree" || record.status === "spawning_tmux" || record.status === "starting") {
				record.status = "running";
				record.updatedAt = nowIso();
			}
			return;
		}
	}

	if (!isTerminalStatus(record.status)) {
		record.status = "crashed";
		record.finishedAt = record.finishedAt ?? nowIso();
		record.updatedAt = nowIso();
		if (!record.error) {
			record.error = "tmux window disappeared before an exit marker was recorded";
		}
	}
}

async function refreshAgent(stateRoot: string, agentId: string): Promise<AgentRecord | undefined> {
	let snapshot: AgentRecord | undefined;
	await mutateRegistry(stateRoot, async (registry) => {
		const record = registry.agents[agentId];
		if (!record) return;
		await refreshOneAgentRuntime(record);
		snapshot = JSON.parse(JSON.stringify(record)) as AgentRecord;
	});
	return snapshot;
}

async function refreshAllAgents(stateRoot: string): Promise<RegistryFile> {
	return mutateRegistry(stateRoot, async (registry) => {
		for (const record of Object.values(registry.agents)) {
			if (record.status === "done") continue;
			await refreshOneAgentRuntime(record);
		}
	});
}

async function getBacklogTail(record: AgentRecord, lines = 10): Promise<string[]> {
	if (record.logPath && (await fileExists(record.logPath))) {
		try {
			const raw = await fs.readFile(record.logPath, "utf8");
			const tailed = tailLines(raw, lines);
			if (tailed.length > 0) return tailed;
		} catch {
			// fall through
		}
	}

	if (record.tmuxWindowId && tmuxWindowExists(record.tmuxWindowId)) {
		return tmuxCaptureTail(record.tmuxWindowId, lines);
	}

	return [];
}

function renderInfoMessage(pi: ExtensionAPI, ctx: ExtensionContext, title: string, lines: string[]): void {
	const content = [title, "", ...lines].join("\n");
	if (ctx.hasUI) {
		pi.sendMessage({
			customType: "parallel-agents-report",
			content,
			display: true,
		});
	} else {
		console.log(content);
	}
}

function parseAgentCommandArgs(raw: string): { task: string; model?: string } {
	let rest = raw;
	let model: string | undefined;

	const modelMatch = rest.match(/(?:^|\s)-model\s+(\S+)/);
	if (modelMatch) {
		model = modelMatch[1];
		rest = rest.replace(modelMatch[0], " ");
	}

	return {
		task: rest.trim(),
		model,
	};
}

async function startAgent(pi: ExtensionAPI, ctx: ExtensionContext, params: StartAgentParams): Promise<StartAgentResult> {
	ensureTmuxReady();

	const stateRoot = getStateRoot(ctx);
	const repoRoot = resolveGitRoot(stateRoot);
	const parentSessionId = ctx.sessionManager.getSessionFile();
	const now = nowIso();

	let agentId = "";
	let spawnedWindowId: string | undefined;
	let allocatedWorktreePath: string | undefined;
	let allocatedBranch: string | undefined;
	let aggregatedWarnings: string[] = [];

	try {
		await ensureDir(getMetaDir(stateRoot));

		await mutateRegistry(stateRoot, async (registry) => {
			agentId = nextAgentId(registry);
			registry.agents[agentId] = {
				id: agentId,
				parentSessionId,
				task: params.task,
				model: params.model,
				status: "allocating_worktree",
				startedAt: now,
				updatedAt: now,
			};
		});

		const worktree = await allocateWorktree({
			repoRoot,
			stateRoot,
			agentId,
			parentSessionId,
		});
		allocatedWorktreePath = worktree.worktreePath;
		allocatedBranch = worktree.branch;
		aggregatedWarnings = [...worktree.warnings];

		await mutateRegistry(stateRoot, async (registry) => {
			const record = registry.agents[agentId];
			if (!record) return;
			record.worktreePath = worktree.worktreePath;
			record.branch = worktree.branch;
			record.status = "spawning_tmux";
			record.updatedAt = nowIso();
			record.warnings = [...(record.warnings ?? []), ...worktree.warnings];
		});

		const kickoff = await buildKickoffPrompt(ctx, params.task, params.includeSummary);
		if (kickoff.warning) aggregatedWarnings.push(kickoff.warning);

		const runtimeDir = getRuntimeDir(stateRoot, agentId);
		await ensureDir(runtimeDir);
		const promptPath = join(runtimeDir, "kickoff.md");
		const logPath = join(runtimeDir, "backlog.log");
		const exitFile = join(runtimeDir, "exit.json");
		const launchScriptPath = join(runtimeDir, "launch.sh");

		await atomicWrite(promptPath, kickoff.prompt + "\n");
		await atomicWrite(logPath, "");

		const defaultModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const modelSpec = params.model ?? defaultModel;

		const tmuxSession = getCurrentTmuxSession();
		const { windowId, windowIndex } = createTmuxWindow(tmuxSession, `agent-${agentId}`);
		spawnedWindowId = windowId;

		await updateWorktreeLock(worktree.worktreePath, {
			tmuxWindowId: windowId,
			tmuxWindowIndex: windowIndex,
		});

		const launchScript = buildLaunchScript({
			agentId,
			parentSessionId,
			parentRepoRoot: repoRoot,
			stateRoot,
			worktreePath: worktree.worktreePath,
			tmuxWindowId: windowId,
			promptPath,
			exitFile,
			modelSpec,
			runtimeDir,
		});
		await atomicWrite(launchScriptPath, launchScript);
		await fs.chmod(launchScriptPath, 0o755);

		tmuxPipePaneToFile(windowId, logPath);
		tmuxSendLine(windowId, `bash ${shellQuote(launchScriptPath)}`);

		await mutateRegistry(stateRoot, async (registry) => {
			const record = registry.agents[agentId];
			if (!record) return;
			record.tmuxSession = tmuxSession;
			record.tmuxWindowId = windowId;
			record.tmuxWindowIndex = windowIndex;
			record.worktreePath = worktree.worktreePath;
			record.branch = worktree.branch;
			record.runtimeDir = runtimeDir;
			record.promptPath = promptPath;
			record.logPath = logPath;
			record.exitFile = exitFile;
			record.status = "running";
			record.updatedAt = nowIso();
			record.warnings = [...(record.warnings ?? []), ...aggregatedWarnings];
		});

		return {
			id: agentId,
			tmuxWindowId: windowId,
			tmuxWindowIndex: windowIndex,
			worktreePath: worktree.worktreePath,
			branch: worktree.branch,
			warnings: aggregatedWarnings,
		};
	} catch (err) {
		if (spawnedWindowId) {
			run("tmux", ["kill-window", "-t", spawnedWindowId]);
		}

		if (agentId) {
			await mutateRegistry(stateRoot, async (registry) => {
				const record = registry.agents[agentId];
				if (!record) return;
				record.status = "failed";
				record.error = stringifyError(err);
				record.finishedAt = nowIso();
				record.updatedAt = nowIso();
				if (allocatedWorktreePath) record.worktreePath = allocatedWorktreePath;
				if (allocatedBranch) record.branch = allocatedBranch;
				record.warnings = [...(record.warnings ?? []), ...aggregatedWarnings];
			});
		}

		throw err;
	}
}

async function agentCheckPayload(stateRoot: string, agentId: string): Promise<Record<string, unknown>> {
	const record = await refreshAgent(stateRoot, agentId);
	if (!record) {
		return {
			ok: false,
			error: `Unknown agent id: ${agentId}`,
		};
	}

	const backlog = await getBacklogTail(record, 10);

	return {
		ok: true,
		agent: {
			id: record.id,
			status: record.status,
			tmuxWindowId: record.tmuxWindowId,
			tmuxWindowIndex: record.tmuxWindowIndex,
			worktreePath: record.worktreePath,
			branch: record.branch,
			task: record.task,
			startedAt: record.startedAt,
			finishedAt: record.finishedAt,
			exitCode: record.exitCode,
			error: record.error,
			warnings: record.warnings ?? [],
		},
		backlog,
	};
}

async function sendToAgent(stateRoot: string, agentId: string, prompt: string): Promise<{ ok: boolean; message: string }> {
	const record = await refreshAgent(stateRoot, agentId);
	if (!record) {
		return { ok: false, message: `Unknown agent id: ${agentId}` };
	}
	if (!record.tmuxWindowId) {
		return { ok: false, message: `Agent ${agentId} has no tmux window id recorded` };
	}
	if (!tmuxWindowExists(record.tmuxWindowId)) {
		return { ok: false, message: `Agent ${agentId} tmux window is not active` };
	}

	let payload = prompt;
	if (payload.startsWith("!")) {
		tmuxInterrupt(record.tmuxWindowId);
		payload = payload.slice(1).trimStart();
	}
	if (payload.length > 0) {
		tmuxSendPrompt(record.tmuxWindowId, payload);
	}

	await mutateRegistry(stateRoot, async (registry) => {
		const current = registry.agents[agentId];
		if (!current) return;
		if (!isTerminalStatus(current.status)) {
			current.status = "running";
			current.updatedAt = nowIso();
		}
	});

	return { ok: true, message: `Sent prompt to ${agentId}` };
}

async function waitForAny(stateRoot: string, ids: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
	const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
	if (uniqueIds.length === 0) {
		return { ok: false, error: "No agent ids were provided" };
	}

	while (true) {
		if (signal?.aborted) {
			return { ok: false, error: "agent-wait-any aborted" };
		}

		for (const id of uniqueIds) {
			const checked = await agentCheckPayload(stateRoot, id);
			const ok = checked.ok === true;
			if (!ok) continue;
			const status = (checked.agent as any)?.status as AgentStatus | undefined;
			if (!status) continue;
			if (isTerminalStatus(status)) {
				return checked;
			}
		}

		await sleep(1000);
	}
}

async function ensureChildSessionLinked(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const agentId = process.env[ENV_AGENT_ID];
	if (!agentId) return;

	const stateRoot = getStateRoot(ctx);
	const childSession = ctx.sessionManager.getSessionFile();
	const parentSession = process.env[ENV_PARENT_SESSION];

	await mutateRegistry(stateRoot, async (registry) => {
		const existing = registry.agents[agentId];
		if (!existing) {
			registry.agents[agentId] = {
				id: agentId,
				parentSessionId: parentSession,
				childSessionId: childSession,
				task: "(child session linked without parent registry record)",
				status: "running",
				startedAt: nowIso(),
				updatedAt: nowIso(),
			};
			return;
		}

		existing.childSessionId = childSession;
		existing.parentSessionId = existing.parentSessionId ?? parentSession;
		if (!isTerminalStatus(existing.status)) {
			existing.status = "running";
		}
		existing.updatedAt = nowIso();
	});

	const lockPath = join(ctx.cwd, ".pi", "active.lock");
	if (await fileExists(lockPath)) {
		const lock = (await readJsonFile<Record<string, unknown>>(lockPath)) ?? {};
		lock.sessionId = childSession;
		lock.agentId = agentId;
		await atomicWrite(lockPath, JSON.stringify(lock, null, 2) + "\n");
	}

	const hasLinkEntry = ctx.sessionManager.getEntries().some((entry) => {
		if (entry.type !== "custom") return false;
		const customEntry = entry as { customType?: string };
		return customEntry.customType === CHILD_LINK_ENTRY_TYPE;
	});

	if (!hasLinkEntry) {
		pi.appendEntry(CHILD_LINK_ENTRY_TYPE, {
			agentId,
			parentSession,
			linkedAt: Date.now(),
		});
	}
}

async function renderStatusLine(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const stateRoot = getStateRoot(ctx);
	const refreshed = await refreshAllAgents(stateRoot);
	const agents = Object.values(refreshed.agents)
		.filter((record) => record.status !== "done")
		.sort((a, b) => a.id.localeCompare(b.id));

	if (agents.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const line = agents
		.map((record) => {
			const win = record.tmuxWindowIndex !== undefined ? `@${record.tmuxWindowIndex}` : "";
			return `${record.id}:${statusShort(record.status)}${win}`;
		})
		.join(" ");

	ctx.ui.setStatus(STATUS_KEY, line);
}

function ensureStatusPoller(ctx: ExtensionContext): void {
	statusPollContext = ctx;
	if (!ctx.hasUI) return;

	if (!statusPollTimer) {
		statusPollTimer = setInterval(() => {
			if (statusPollInFlight || !statusPollContext) return;
			statusPollInFlight = true;
			void renderStatusLine(statusPollContext)
				.catch(() => {})
				.finally(() => {
					statusPollInFlight = false;
				});
		}, 2500);
	}

	void renderStatusLine(ctx).catch(() => {});
}

function startScriptTemplate(): string {
	return `#!/usr/bin/env bash
set -euo pipefail

PARENT_ROOT="\${1:-}"
WORKTREE="\${2:-$(pwd)}"
AGENT_ID="\${3:-unknown}"

BRANCH="$(git -C "$WORKTREE" branch --show-current 2>/dev/null || true)"
echo "[parallel-agent-start] agent=$AGENT_ID branch=\${BRANCH:-?}"

# Optional bootstrap hook for project-specific setup.
if [[ -x "$WORKTREE/.pi/parallel-agent-bootstrap.sh" ]]; then
  "$WORKTREE/.pi/parallel-agent-bootstrap.sh"
fi

# Optional best-effort sync of .pi parallel-agent files from parent checkout.
if [[ -n "$PARENT_ROOT" ]] && [[ -d "$PARENT_ROOT/.pi" ]]; then
  mkdir -p "$WORKTREE/.pi"
  find "$PARENT_ROOT/.pi" -maxdepth 1 -type f -name 'parallel-agent-*' | while read -r src; do
    name="$(basename "$src")"
    dst="$WORKTREE/.pi/$name"
    rm -f "$dst"
    ln -s "$src" "$dst"
  done
fi
`;
}

function finishScriptTemplate(): string {
	return `#!/usr/bin/env bash
set -euo pipefail

PARENT_ROOT="\${PI_PARALLEL_PARENT_ROOT:-\${1:-}}"
AGENT_ID="\${PI_PARALLEL_AGENT_ID:-\${2:-unknown}}"
MAIN_BRANCH="\${PI_PARALLEL_MAIN_BRANCH:-main}"
BRANCH="$(git branch --show-current)"

if [[ -z "$PARENT_ROOT" ]]; then
  echo "[parallel-agent-finish] Missing parent checkout path."
  echo "Usage: PI_PARALLEL_PARENT_ROOT=/path/to/parent .pi/parallel-agent-finish.sh"
  exit 1
fi

if [[ -z "$BRANCH" ]]; then
  echo "[parallel-agent-finish] Could not determine current branch."
  exit 1
fi

LOCK_DIR="$PARENT_ROOT/.pi/parallel-agents"
LOCK_FILE="$LOCK_DIR/merge.lock"
mkdir -p "$LOCK_DIR"

acquire_lock() {
  local payload
  payload="{\"agentId\":\"$AGENT_ID\",\"pid\":$$,\"acquiredAt\":\"$(date -Is)\"}"
  while true; do
    if ( set -o noclobber; printf '%s\n' "$payload" > "$LOCK_FILE" ) 2>/dev/null; then
      return 0
    fi
    echo "[parallel-agent-finish] Waiting for merge lock..."
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
    echo "Resolve conflicts here, then rerun .pi/parallel-agent-finish.sh"
    exit 2
  fi

  acquire_lock

  set +e
  (
    cd "$PARENT_ROOT" || exit 1
    git checkout "$MAIN_BRANCH" >/dev/null 2>&1 || exit 1
    git merge --no-ff --no-edit "$BRANCH"
  )
  merge_status=$?
  set -e

  release_lock

  if [[ "$merge_status" -eq 0 ]]; then
    echo "[parallel-agent-finish] Success: merged $BRANCH -> $MAIN_BRANCH in parent checkout."
    exit 0
  fi

  echo "[parallel-agent-finish] Parent merge failed (likely main moved)."
  echo "[parallel-agent-finish] Aborting parent merge and retrying reconcile loop..."
  (
    cd "$PARENT_ROOT" || exit 1
    git merge --abort >/dev/null 2>&1 || true
  )

  sleep 1
done
`;
}

function finishSkillTemplate(): string {
	return `---
name: finish
description: Finalize a parallel-agent branch after explicit user approval (e.g. LGTM). Discuss/confirm finish action first; local merge is default.
---

# Parallel-agent finish workflow

When user explicitly approves (e.g. "LGTM"), do this:

1. Confirm finish action with user.
   - Default: local merge flow via \.pi/parallel-agent-finish.sh
   - Alternative (on request): open/push PR instead

2. For default local merge flow, run:

!PI_PARALLEL_PARENT_ROOT=\"$PI_PARALLEL_PARENT_REPO\" .pi/parallel-agent-finish.sh

3. If merge script reports conflict while merging main into child branch:
   - stay in this worktree
   - resolve conflicts
   - rerun finish script

4. If parent-side merge conflicts because main moved:
   - finish script retries reconcile loop automatically

5. After success:
   - report merged commit(s)
   - suggest /quit if no further work is needed
`;
}

async function setupProjectFiles(repoRoot: string, force: boolean): Promise<string[]> {
	const lines: string[] = [];
	const piDir = join(repoRoot, ".pi");
	const startPath = join(piDir, "parallel-agent-start.sh");
	const finishPath = join(piDir, "parallel-agent-finish.sh");
	const finishSkillPath = join(piDir, "parallel-agent-skills", "finish", "SKILL.md");

	await ensureDir(piDir);
	await ensureDir(dirname(finishSkillPath));

	const writes: Array<{ path: string; content: string; executable?: boolean }> = [
		{ path: startPath, content: startScriptTemplate(), executable: true },
		{ path: finishPath, content: finishScriptTemplate(), executable: true },
		{ path: finishSkillPath, content: finishSkillTemplate() },
	];

	for (const item of writes) {
		const exists = await fileExists(item.path);
		if (exists && !force) {
			lines.push(`skipped (exists): ${item.path}`);
			continue;
		}
		await atomicWrite(item.path, item.content);
		if (item.executable) {
			await fs.chmod(item.path, 0o755);
		}
		lines.push(`${exists ? "updated" : "created"}: ${item.path}`);
	}

	return lines;
}

export default function parallelAgentsExtension(pi: ExtensionAPI) {
	pi.registerCommand("agent", {
		description: "Spawn a background child agent in its own tmux window/worktree: /agent [-model <provider/id>] <task>",
		handler: async (args, ctx) => {
			const parsed = parseAgentCommandArgs(args);
			if (!parsed.task) {
				ctx.hasUI && ctx.ui.notify("Usage: /agent [-model <provider/id>] <task>", "error");
				return;
			}

			try {
				const started = await startAgent(pi, ctx, {
					task: parsed.task,
					model: parsed.model,
					includeSummary: true,
				});

				const lines = [
					`id: ${started.id}`,
					`tmux window: ${started.tmuxWindowId} (#${started.tmuxWindowIndex})`,
					`worktree: ${started.worktreePath}`,
					`branch: ${started.branch}`,
				];
				for (const warning of started.warnings) {
					lines.push(`warning: ${warning}`);
				}
				renderInfoMessage(pi, ctx, "parallel-agent started", lines);
				await renderStatusLine(ctx).catch(() => {});
			} catch (err) {
				ctx.hasUI && ctx.ui.notify(`Failed to start agent: ${stringifyError(err)}`, "error");
			}
		},
	});

	pi.registerCommand("agents", {
		description: "List tracked parallel agents",
		handler: async (_args, ctx) => {
			const stateRoot = getStateRoot(ctx);
			const registry = await refreshAllAgents(stateRoot);
			const records = Object.values(registry.agents).sort((a, b) => a.id.localeCompare(b.id));

			if (records.length === 0) {
				ctx.hasUI && ctx.ui.notify("No tracked parallel agents yet.", "info");
				return;
			}

			const lines: string[] = [];
			for (const record of records) {
				const win = record.tmuxWindowIndex !== undefined ? `#${record.tmuxWindowIndex}` : "-";
				lines.push(`${record.id}  ${record.status}  win:${win}  branch:${record.branch ?? "-"}`);
				lines.push(`  task: ${record.task}`);
				if (record.error) lines.push(`  error: ${record.error}`);
			}
			renderInfoMessage(pi, ctx, "parallel-agents", lines);
		},
	});

	pi.registerCommand("agent-check", {
		description: "Check a parallel agent status and backlog tail: /agent-check <id>",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.hasUI && ctx.ui.notify("Usage: /agent-check <id>", "error");
				return;
			}
			const payload = await agentCheckPayload(getStateRoot(ctx), id);
			renderInfoMessage(pi, ctx, `agent-check ${id}`, [JSON.stringify(payload, null, 2)]);
		},
	});

	pi.registerCommand("agent-send", {
		description: "Send follow-up to a parallel agent: /agent-send <id> <prompt>",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const splitAt = trimmed.indexOf(" ");
			if (!trimmed || splitAt <= 0) {
				ctx.hasUI && ctx.ui.notify("Usage: /agent-send <id> <prompt>", "error");
				return;
			}

			const id = trimmed.slice(0, splitAt).trim();
			const prompt = trimmed.slice(splitAt + 1);
			const sent = await sendToAgent(getStateRoot(ctx), id, prompt);
			ctx.hasUI && ctx.ui.notify(sent.message, sent.ok ? "info" : "error");
		},
	});

	pi.registerCommand("agent-setup", {
		description: "Create default .pi parallel-agent lifecycle scripts and finish skill",
		handler: async (args, ctx) => {
			const force = args.split(/\s+/).includes("--force");
			const repoRoot = resolveGitRoot(ctx.cwd);
			const lines = await setupProjectFiles(repoRoot, force);
			renderInfoMessage(pi, ctx, "parallel-agent setup", lines);
		},
	});

	pi.registerTool({
		name: "agent-start",
		label: "Agent Start",
		description:
			"Start a background parallel child agent in tmux/worktree. Description is sent as kickoff prompt. Returns id tied to tmux window id.",
		parameters: Type.Object({
			description: Type.String({ description: "Task description for child agent kickoff prompt" }),
			model: Type.Optional(Type.String({ description: "Model as provider/modelId (optional)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const started = await startAgent(pi, ctx, {
					task: params.description,
					model: params.model,
					includeSummary: false,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									id: started.id,
									tmuxWindowId: started.tmuxWindowId,
									tmuxWindowIndex: started.tmuxWindowIndex,
									worktreePath: started.worktreePath,
									branch: started.branch,
									warnings: started.warnings,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: stringifyError(err) }, null, 2) }],
				};
			}
		},
	});

	pi.registerTool({
		name: "agent-check",
		label: "Agent Check",
		description: "Check a given parallel agent status and return backlog tail (last 10 lines).",
		parameters: Type.Object({
			id: Type.String({ description: "Agent id" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const payload = await agentCheckPayload(getStateRoot(ctx), params.id);
			return {
				content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			};
		},
	});

	pi.registerTool({
		name: "agent-wait-any",
		label: "Agent Wait Any",
		description: "Wait until one of the provided agent ids stops, then return agent-check payload.",
		parameters: Type.Object({
			ids: Type.Array(Type.String({ description: "Agent id" }), { description: "Agent ids to wait for" }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const payload = await waitForAny(getStateRoot(ctx), params.ids, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			};
		},
	});

	pi.registerTool({
		name: "agent-send",
		label: "Agent Send",
		description:
			"Send steering/follow-up prompt to child agent. If prompt starts with !, interrupt first. If prompt starts with /, it is sent as a slash command.",
		parameters: Type.Object({
			id: Type.String({ description: "Agent id" }),
			prompt: Type.String({ description: "Prompt text to send" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const payload = await sendToAgent(getStateRoot(ctx), params.id, params.prompt);
			return {
				content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await ensureChildSessionLinked(pi, ctx).catch(() => {});
		ensureStatusPoller(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await ensureChildSessionLinked(pi, ctx).catch(() => {});
		ensureStatusPoller(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		statusPollContext = ctx;
		await renderStatusLine(ctx).catch(() => {});
	});
}
