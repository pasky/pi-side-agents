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
const STATUS_UPDATE_MESSAGE_TYPE = "parallel-agent-status";
const PROMPT_UPDATE_MESSAGE_TYPE = "parallel-agent-prompt";

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

const ALL_AGENT_STATUSES: AgentStatus[] = [
	"allocating_worktree",
	"spawning_tmux",
	"starting",
	"running",
	"waiting_user",
	"finishing",
	"waiting_merge_lock",
	"retrying_reconcile",
	"failed",
	"crashed",
];

const DEFAULT_WAIT_STATES: AgentStatus[] = ["waiting_user", "failed", "crashed"];

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
	branchHint?: string;
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
	prompt: string;
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

type StatusTransitionNotice = {
	id: string;
	fromStatus: AgentStatus;
	toStatus: AgentStatus;
	tmuxWindowIndex?: number;
};

type AgentStatusSnapshot = {
	status: AgentStatus;
	tmuxWindowIndex?: number;
};

let statusPollTimer: NodeJS.Timeout | undefined;
let statusPollContext: ExtensionContext | undefined;
let statusPollApi: ExtensionAPI | undefined;
let statusPollInFlight = false;
const statusSnapshotsByStateRoot = new Map<string, Map<string, AgentStatusSnapshot>>();
let lastRenderedStatusLine: string | undefined;

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

const PROMPT_LOG_PREFIX = "[parallel-agent][prompt]";
const TASK_PREVIEW_MAX_CHARS = 220;
const BACKLOG_LINE_MAX_CHARS = 240;
const BACKLOG_TOTAL_MAX_CHARS = 2400;
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function resolveBacklogPathForRecord(stateRoot: string, record: AgentRecord): string {
	if (record.logPath) return record.logPath;
	if (record.runtimeDir) return join(record.runtimeDir, "backlog.log");
	return join(getRuntimeDir(stateRoot, record.id), "backlog.log");
}

async function appendKickoffPromptToBacklog(
	stateRoot: string,
	record: AgentRecord,
	prompt: string,
	loggedAt = nowIso(),
): Promise<void> {
	const backlogPath = resolveBacklogPathForRecord(stateRoot, record);
	const promptLines = prompt.replace(/\r\n?/g, "\n").split("\n");
	const body = promptLines
		.map((line) => `${PROMPT_LOG_PREFIX} ${loggedAt} ${record.id}: ${line}`)
		.join("\n");
	const payload =
		`${PROMPT_LOG_PREFIX} ${loggedAt} ${record.id}: kickoff prompt begin\n` +
		`${body}\n` +
		`${PROMPT_LOG_PREFIX} ${loggedAt} ${record.id}: kickoff prompt end\n`;

	try {
		await ensureDir(dirname(backlogPath));
		await fs.appendFile(backlogPath, payload, "utf8");
		record.logPath = record.logPath ?? backlogPath;
		record.runtimeDir = record.runtimeDir ?? dirname(backlogPath);
	} catch {
		// Best effort only; prompt logging must not block agent startup.
	}
}

async function setRecordStatus(_stateRoot: string, record: AgentRecord, nextStatus: AgentStatus): Promise<boolean> {
	const previousStatus = record.status;
	if (previousStatus === nextStatus) return false;

	record.status = nextStatus;
	record.updatedAt = nowIso();
	return true;
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

function statusColorRole(status: AgentStatus): "warning" | "muted" | "accent" | "error" {
	switch (status) {
		// Rare/transient states: highlight so they stand out.
		case "allocating_worktree":
		case "spawning_tmux":
		case "starting":
		case "waiting_merge_lock":
		case "retrying_reconcile":
			return "warning";
		// Normal working states: keep low visual weight.
		case "running":
		case "finishing":
		case "done":
			return "muted";
		// Needs user attention.
		case "waiting_user":
			return "accent";
		// Terminal failure.
		case "failed":
		case "crashed":
			return "error";
	}
}

function stripTerminalNoise(text: string): string {
	return text.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "").replace(/\r/g, "").replace(CONTROL_RE, "");
}

function truncateWithEllipsis(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	if (maxChars === 1) return "…";
	return `${text.slice(0, maxChars - 1)}…`;
}

function summarizeTask(task: string): string {
	const collapsed = stripTerminalNoise(task).replace(/\s+/g, " ").trim();
	return truncateWithEllipsis(collapsed, TASK_PREVIEW_MAX_CHARS);
}

function sanitizeBacklogLines(lines: string[]): string[] {
	const out: string[] = [];
	let remaining = BACKLOG_TOTAL_MAX_CHARS;

	for (const raw of lines) {
		if (remaining <= 0) break;
		const cleaned = stripTerminalNoise(raw).trimEnd();
		if (cleaned.length === 0) continue;

		const line = truncateWithEllipsis(cleaned, BACKLOG_LINE_MAX_CHARS);
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

function normalizeWaitStates(input?: string[]): { values: AgentStatus[]; error?: string } {
	if (!input || input.length === 0) {
		return { values: DEFAULT_WAIT_STATES };
	}

	const trimmed = [...new Set(input.map((value) => value.trim()).filter(Boolean))];
	if (trimmed.length === 0) {
		return { values: DEFAULT_WAIT_STATES };
	}

	const known = new Set<AgentStatus>(ALL_AGENT_STATUSES);
	const invalid = trimmed.filter((value) => !known.has(value as AgentStatus));
	if (invalid.length > 0) {
		return {
			values: [],
			error: `Unknown status value(s): ${invalid.join(", ")}`,
		};
	}

	return {
		values: trimmed as AgentStatus[],
	};
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

/** Sanitize a raw string into a kebab-case slug suitable for branch names and agent IDs. */
function sanitizeSlug(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.filter(Boolean)
		.slice(0, 3)
		.join("-");
}

/** Turn a task description into a slug by taking the first 3 meaningful words. */
function slugFromTask(task: string): string {
	const stopWords = new Set(["a", "an", "the", "to", "in", "on", "at", "of", "for", "and", "or", "is", "it", "be", "do", "with"]);
	const words = task
		.replace(/[^a-zA-Z0-9\s]/g, " ")
		.split(/\s+/)
		.map((w) => w.toLowerCase())
		.filter((w) => w.length > 0 && !stopWords.has(w));
	const slug = words.slice(0, 3).join("-");
	return slug || "agent";
}

/** Generate a slug via LLM, falling back to heuristic extraction from task text. */
async function generateSlug(ctx: ExtensionContext, task: string): Promise<{ slug: string; warning?: string }> {
	if (!ctx.model) {
		return { slug: slugFromTask(task), warning: "No model available for slug generation; used heuristic fallback." };
	}

	try {
		const userMessage: Message = {
			role: "user",
			content: [
				{
					type: "text",
					text: task,
				},
			],
			timestamp: Date.now(),
		};

		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		const response = await complete(
			ctx.model,
			{
				systemPrompt:
					"Generate a 2-3 word kebab-case slug summarizing the given task. Reply with ONLY the slug, nothing else. Examples: fix-auth-leak, add-retry-logic, update-readme",
				messages: [userMessage],
			},
			{ apiKey, maxTokens: 30 },
		);

		const raw = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim();

		const slug = sanitizeSlug(raw);
		if (slug) return { slug };

		return { slug: slugFromTask(task), warning: "LLM returned empty slug; used heuristic fallback." };
	} catch (err) {
		return {
			slug: slugFromTask(task),
			warning: `Slug generation failed: ${stringifyError(err)}. Used heuristic fallback.`,
		};
	}
}

/** Collect all agent IDs currently known in the registry or checked out as parallel-agent branches. */
function existingAgentIds(registry: RegistryFile, repoRoot: string): Set<string> {
	const ids = new Set<string>(Object.keys(registry.agents));

	const listed = run("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
	if (listed.ok) {
		for (const line of listed.stdout.split(/\r?\n/)) {
			if (!line.startsWith("branch ")) continue;
			const branchRef = line.slice("branch ".length).trim();
			if (!branchRef || branchRef === "(detached)") continue;
			const branch = branchRef.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : branchRef;
			if (branch.startsWith("parallel-agent/")) {
				ids.add(branch.slice("parallel-agent/".length));
			}
		}
	}

	return ids;
}

/** Deduplicate a slug against existing IDs by appending -2, -3, etc. */
function deduplicateSlug(slug: string, existing: Set<string>): string {
	if (!existing.has(slug)) return slug;
	for (let i = 2; ; i++) {
		const candidate = `${slug}-${i}`;
		if (!existing.has(candidate)) return candidate;
	}
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

async function cleanupWorktreeLockBestEffort(worktreePath?: string): Promise<void> {
	if (!worktreePath) return;
	const lockPath = join(worktreePath, ".pi", "active.lock");
	await fs.unlink(lockPath).catch(() => {});
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

type OrphanWorktreeLock = {
	worktreePath: string;
	lockPath: string;
	lockAgentId?: string;
	lockPid?: number;
	lockTmuxWindowId?: string;
	blockers: string[];
};

type OrphanWorktreeLockScan = {
	reclaimable: OrphanWorktreeLock[];
	blocked: OrphanWorktreeLock[];
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

function parseOptionalPid(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && /^\d+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function isPidAlive(pid?: number): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

function summarizeOrphanLock(lock: OrphanWorktreeLock): string {
	const details: string[] = [];
	if (lock.lockAgentId) details.push(`agent:${lock.lockAgentId}`);
	if (lock.lockTmuxWindowId) details.push(`tmux:${lock.lockTmuxWindowId}`);
	if (lock.lockPid !== undefined) details.push(`pid:${lock.lockPid}`);
	if (details.length === 0) return lock.worktreePath;
	return `${lock.worktreePath} (${details.join(" ")})`;
}

async function scanOrphanWorktreeLocks(repoRoot: string, registry: RegistryFile): Promise<OrphanWorktreeLockScan> {
	const slots = await listWorktreeSlots(repoRoot);
	const reclaimable: OrphanWorktreeLock[] = [];
	const blocked: OrphanWorktreeLock[] = [];

	for (const slot of slots) {
		const lockPath = join(slot.path, ".pi", "active.lock");
		if (!(await fileExists(lockPath))) continue;

		const raw = (await readJsonFile<Record<string, unknown>>(lockPath)) ?? {};
		const lockAgentId = typeof raw.agentId === "string" ? raw.agentId : undefined;
		if (lockAgentId && registry.agents[lockAgentId]) {
			continue;
		}

		const lockPid = parseOptionalPid(raw.pid);
		const lockTmuxWindowId = typeof raw.tmuxWindowId === "string" ? raw.tmuxWindowId : undefined;

		const blockers: string[] = [];
		if (isPidAlive(lockPid)) {
			blockers.push(`pid ${lockPid} is still alive`);
		}
		if (lockTmuxWindowId && tmuxWindowExists(lockTmuxWindowId)) {
			blockers.push(`tmux window ${lockTmuxWindowId} is active`);
		}

		const candidate: OrphanWorktreeLock = {
			worktreePath: slot.path,
			lockPath,
			lockAgentId,
			lockPid,
			lockTmuxWindowId,
			blockers,
		};

		if (blockers.length > 0) {
			blocked.push(candidate);
		} else {
			reclaimable.push(candidate);
		}
	}

	return { reclaimable, blocked };
}

async function reclaimOrphanWorktreeLocks(locks: OrphanWorktreeLock[]): Promise<{
	removed: string[];
	failed: Array<{ lockPath: string; error: string }>;
}> {
	const removed: string[] = [];
	const failed: Array<{ lockPath: string; error: string }> = [];

	for (const lock of locks) {
		try {
			await fs.unlink(lock.lockPath);
			removed.push(lock.lockPath);
		} catch (err: any) {
			if (err?.code === "ENOENT") continue;
			failed.push({ lockPath: lock.lockPath, error: stringifyError(err) });
		}
	}

	return { removed, failed };
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
		// Remember old branch so we can try to clean it up after switching away.
		const oldBranchResult = run("git", ["-C", chosenPath, "branch", "--show-current"]);
		const oldBranch = oldBranchResult.ok ? oldBranchResult.stdout.trim() : "";

		run("git", ["-C", chosenPath, "merge", "--abort"]);
		runOrThrow("git", ["-C", chosenPath, "reset", "--hard", mainHead]);
		runOrThrow("git", ["-C", chosenPath, "clean", "-fd"]);
		runOrThrow("git", ["-C", chosenPath, "checkout", "-B", branch, mainHead]);

		// Best-effort cleanup: delete old branch if fully merged (-d, not -D).
		if (oldBranch && oldBranch !== branch) {
			run("git", ["-C", repoRoot, "branch", "-d", oldBranch]);
		}
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
CHILD_SKILLS_DIR=\"$WORKTREE/.pi/parallel-agent-skills\"

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
if [[ -d "$CHILD_SKILLS_DIR" ]]; then
  # agent-setup writes the child-only finish skill here; load it explicitly.
  PI_CMD+=(--skill "$CHILD_SKILLS_DIR")
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
		"-d",
		"-t",
		`${tmuxSession}:`,
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

type RefreshRuntimeResult = {
	removeFromRegistry: boolean;
};

async function refreshOneAgentRuntime(stateRoot: string, record: AgentRecord): Promise<RefreshRuntimeResult> {
	if (record.status === "done") {
		await cleanupWorktreeLockBestEffort(record.worktreePath);
		return { removeFromRegistry: true };
	}

	if (record.exitFile && (await fileExists(record.exitFile))) {
		const exit = (await readJsonFile<ExitMarker>(record.exitFile)) ?? {};
		if (typeof exit.exitCode === "number") {
			record.exitCode = exit.exitCode;
			record.finishedAt = exit.finishedAt ?? record.finishedAt ?? nowIso();
			const changed = await setRecordStatus(stateRoot, record, exit.exitCode === 0 ? "done" : "failed");
			if (!changed) {
				record.updatedAt = nowIso();
			}
			await cleanupWorktreeLockBestEffort(record.worktreePath);
			if (exit.exitCode === 0) {
				return { removeFromRegistry: true };
			}
			return { removeFromRegistry: false };
		}
	}

	if (!record.tmuxWindowId) {
		return { removeFromRegistry: false };
	}

	const live = tmuxWindowExists(record.tmuxWindowId);
	if (live) {
		if (record.status === "allocating_worktree" || record.status === "spawning_tmux" || record.status === "starting") {
			await setRecordStatus(stateRoot, record, "running");
		}
		return { removeFromRegistry: false };
	}

	if (!isTerminalStatus(record.status)) {
		record.finishedAt = record.finishedAt ?? nowIso();
		await setRecordStatus(stateRoot, record, "crashed");
		if (!record.error) {
			record.error = "tmux window disappeared before an exit marker was recorded";
		}
		await cleanupWorktreeLockBestEffort(record.worktreePath);
	}

	return { removeFromRegistry: false };
}

async function refreshAgent(stateRoot: string, agentId: string): Promise<AgentRecord | undefined> {
	let snapshot: AgentRecord | undefined;
	await mutateRegistry(stateRoot, async (registry) => {
		const record = registry.agents[agentId];
		if (!record) return;
		const refreshed = await refreshOneAgentRuntime(stateRoot, record);
		if (refreshed.removeFromRegistry) {
			delete registry.agents[agentId];
			return;
		}
		snapshot = JSON.parse(JSON.stringify(record)) as AgentRecord;
	});
	return snapshot;
}

async function refreshAllAgents(stateRoot: string): Promise<RegistryFile> {
	return mutateRegistry(stateRoot, async (registry) => {
		for (const [agentId, record] of Object.entries(registry.agents)) {
			const refreshed = await refreshOneAgentRuntime(stateRoot, record);
			if (refreshed.removeFromRegistry) {
				delete registry.agents[agentId];
			}
		}
	});
}

async function getBacklogTail(record: AgentRecord, lines = 10): Promise<string[]> {
	if (record.logPath && (await fileExists(record.logPath))) {
		try {
			const raw = await fs.readFile(record.logPath, "utf8");
			const tailed = sanitizeBacklogLines(tailLines(raw, lines));
			if (tailed.length > 0) return tailed;
		} catch {
			// fall through
		}
	}

	if (record.tmuxWindowId && tmuxWindowExists(record.tmuxWindowId)) {
		return sanitizeBacklogLines(tmuxCaptureTail(record.tmuxWindowId, lines));
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

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function splitModelPatternAndThinking(raw: string): { pattern: string; thinking?: string } {
	const trimmed = raw.trim();
	const colon = trimmed.lastIndexOf(":");
	if (colon <= 0 || colon === trimmed.length - 1) return { pattern: trimmed };

	const suffix = trimmed.slice(colon + 1);
	if (!THINKING_LEVELS.has(suffix)) return { pattern: trimmed };

	return {
		pattern: trimmed.slice(0, colon),
		thinking: suffix,
	};
}

function withThinking(modelSpec: string, thinking?: string): string {
	return thinking ? `${modelSpec}:${thinking}` : modelSpec;
}

async function resolveModelSpecForChild(
	ctx: ExtensionContext,
	requested?: string,
): Promise<{ modelSpec?: string; warning?: string }> {
	const currentModelSpec = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	if (!requested || requested.trim().length === 0) {
		return { modelSpec: currentModelSpec };
	}

	const trimmed = requested.trim();
	if (trimmed.includes("/")) {
		return { modelSpec: trimmed };
	}

	const { pattern, thinking } = splitModelPatternAndThinking(trimmed);

	if (ctx.model && pattern === ctx.model.id) {
		return {
			modelSpec: withThinking(`${ctx.model.provider}/${ctx.model.id}`, thinking),
		};
	}

	try {
		const available = (await ctx.modelRegistry.getAvailable()) as Array<{ provider: string; id: string }>;
		const exact = available.filter((model) => model.id === pattern);

		if (exact.length === 1) {
			const match = exact[0];
			return {
				modelSpec: withThinking(`${match.provider}/${match.id}`, thinking),
			};
		}

		if (exact.length > 1) {
			if (ctx.model) {
				const preferred = exact.find((model) => model.provider === ctx.model?.provider);
				if (preferred) {
					return {
						modelSpec: withThinking(`${preferred.provider}/${preferred.id}`, thinking),
					};
				}
			}

			const providers = [...new Set(exact.map((model) => model.provider))].sort();
			return {
				modelSpec: trimmed,
				warning: `Model '${pattern}' matches multiple providers (${providers.join(", ")}); child was started with raw pattern '${trimmed}'. Use provider/model to force a specific provider.`,
			};
		}
	} catch {
		// Best effort only; keep raw model pattern.
	}

	return { modelSpec: trimmed };
}

function normalizeAgentId(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	const firstToken = trimmed.split(/\s+/, 1)[0];
	return firstToken ?? "";
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

		let slug: string;
		if (params.branchHint) {
			slug = sanitizeSlug(params.branchHint);
			if (!slug) slug = slugFromTask(params.task);
		} else {
			const generated = await generateSlug(ctx, params.task);
			slug = generated.slug;
			if (generated.warning) aggregatedWarnings.push(generated.warning);
		}

		await mutateRegistry(stateRoot, async (registry) => {
			const existing = existingAgentIds(registry, repoRoot);
			agentId = deduplicateSlug(slug, existing);
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

		const runtimeDir = getRuntimeDir(stateRoot, agentId);
		await ensureDir(runtimeDir);
		const promptPath = join(runtimeDir, "kickoff.md");
		const logPath = join(runtimeDir, "backlog.log");
		const exitFile = join(runtimeDir, "exit.json");
		const launchScriptPath = join(runtimeDir, "launch.sh");
		await atomicWrite(logPath, "");

		await mutateRegistry(stateRoot, async (registry) => {
			const record = registry.agents[agentId];
			if (!record) return;
			record.worktreePath = worktree.worktreePath;
			record.branch = worktree.branch;
			record.runtimeDir = runtimeDir;
			record.promptPath = promptPath;
			record.logPath = logPath;
			record.exitFile = exitFile;
			await setRecordStatus(stateRoot, record, "spawning_tmux");
			record.warnings = [...(record.warnings ?? []), ...worktree.warnings];
		});

		const kickoff = await buildKickoffPrompt(ctx, params.task, params.includeSummary);
		if (kickoff.warning) aggregatedWarnings.push(kickoff.warning);

		await atomicWrite(promptPath, kickoff.prompt + "\n");
		try {
			await mutateRegistry(stateRoot, async (registry) => {
				const record = registry.agents[agentId];
				if (!record) return;
				await appendKickoffPromptToBacklog(stateRoot, record, kickoff.prompt);
			});
		} catch {
			// Best effort fallback when registry lock/update fails; write directly
			// to the known backlog path without requiring registry mutation.
			await appendKickoffPromptToBacklog(
				stateRoot,
				{
					id: agentId,
					task: params.task,
					status: "spawning_tmux",
					startedAt: now,
					updatedAt: nowIso(),
					runtimeDir,
					logPath,
				},
				kickoff.prompt,
			);
		}

		const resolvedModel = await resolveModelSpecForChild(ctx, params.model);
		const modelSpec = resolvedModel.modelSpec;
		if (resolvedModel.warning) aggregatedWarnings.push(resolvedModel.warning);

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
		// Run cd in the interactive pane shell first so Ctrl+Z in child Pi drops
		// back to the child worktree prompt (not the parent worktree).
		tmuxSendLine(windowId, `cd ${shellQuote(worktree.worktreePath)}`);
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
			record.model = modelSpec;
			await setRecordStatus(stateRoot, record, "running");
			record.warnings = [...(record.warnings ?? []), ...aggregatedWarnings];
		});

		const started: StartAgentResult = {
			id: agentId,
			tmuxWindowId: windowId,
			tmuxWindowIndex: windowIndex,
			worktreePath: worktree.worktreePath,
			branch: worktree.branch,
			warnings: aggregatedWarnings,
			prompt: kickoff.prompt,
		};
		emitKickoffPromptMessage(pi, started);

		return started;
	} catch (err) {
		if (spawnedWindowId) {
			run("tmux", ["kill-window", "-t", spawnedWindowId]);
		}

		if (agentId) {
			await mutateRegistry(stateRoot, async (registry) => {
				const record = registry.agents[agentId];
				if (!record) return;
				record.error = stringifyError(err);
				record.finishedAt = nowIso();
				const changed = await setRecordStatus(stateRoot, record, "failed");
				if (!changed) {
					record.updatedAt = nowIso();
				}
				if (allocatedWorktreePath) record.worktreePath = allocatedWorktreePath;
				if (allocatedBranch) record.branch = allocatedBranch;
				record.warnings = [...(record.warnings ?? []), ...aggregatedWarnings];
			});
		}

		throw err;
	}
}

async function agentCheckPayload(stateRoot: string, agentId: string): Promise<Record<string, unknown>> {
	const normalizedId = normalizeAgentId(agentId);
	if (!normalizedId) {
		return {
			ok: false,
			error: "No agent id was provided",
		};
	}

	const record = await refreshAgent(stateRoot, normalizedId);
	if (!record) {
		return {
			ok: false,
			error: `Unknown agent id: ${normalizedId}`,
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
			task: summarizeTask(record.task),
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
	const normalizedId = normalizeAgentId(agentId);
	if (!normalizedId) {
		return { ok: false, message: "No agent id was provided" };
	}

	const record = await refreshAgent(stateRoot, normalizedId);
	if (!record) {
		return { ok: false, message: `Unknown agent id: ${normalizedId}` };
	}
	if (!record.tmuxWindowId) {
		return { ok: false, message: `Agent ${normalizedId} has no tmux window id recorded` };
	}
	if (!tmuxWindowExists(record.tmuxWindowId)) {
		return { ok: false, message: `Agent ${normalizedId} tmux window is not active` };
	}

	let payload = prompt;
	if (payload.startsWith("!")) {
		tmuxInterrupt(record.tmuxWindowId);
		payload = payload.slice(1).trimStart();
		if (payload.length > 0) {
			// Brief pause so Pi can finish handling the interrupt and return to an
			// interactive prompt before the follow-up text lands in the pane.
			await sleep(300);
		}
	}
	if (payload.length > 0) {
		tmuxSendPrompt(record.tmuxWindowId, payload);
	}

	await mutateRegistry(stateRoot, async (registry) => {
		const current = registry.agents[normalizedId];
		if (!current) return;
		if (!isTerminalStatus(current.status)) {
			const changed = await setRecordStatus(stateRoot, current, "running");
			if (!changed) {
				current.updatedAt = nowIso();
			}
		}
	});

	return { ok: true, message: `Sent prompt to ${normalizedId}` };
}

async function setChildRuntimeStatus(ctx: ExtensionContext, nextStatus: AgentStatus): Promise<void> {
	const agentId = process.env[ENV_AGENT_ID];
	if (!agentId) return;

	const stateRoot = getStateRoot(ctx);
	await mutateRegistry(stateRoot, async (registry) => {
		const record = registry.agents[agentId];
		if (!record) return;
		if (isTerminalStatus(record.status)) return;
		if (
			nextStatus === "waiting_user" &&
			(record.status === "finishing" || record.status === "waiting_merge_lock" || record.status === "retrying_reconcile")
		) {
			return;
		}

		const changed = await setRecordStatus(stateRoot, record, nextStatus);
		if (!changed) {
			record.updatedAt = nowIso();
		}
	});
}

async function waitForAny(
	stateRoot: string,
	ids: string[],
	signal?: AbortSignal,
	waitStatesInput?: string[],
): Promise<Record<string, unknown>> {
	const uniqueIds = [...new Set(ids.map((id) => normalizeAgentId(id)).filter(Boolean))];
	if (uniqueIds.length === 0) {
		return { ok: false, error: "No agent ids were provided" };
	}

	const waitStates = normalizeWaitStates(waitStatesInput);
	if (waitStates.error) {
		return { ok: false, error: waitStates.error };
	}
	const waitStateSet = new Set<AgentStatus>(waitStates.values);

	let firstPass = true;

	while (true) {
		if (signal?.aborted) {
			return { ok: false, error: "agent-wait-any aborted" };
		}

		const unknownOnFirstPass: string[] = [];
		let knownCount = 0;

		for (const id of uniqueIds) {
			const checked = await agentCheckPayload(stateRoot, id);
			const ok = checked.ok === true;
			if (!ok) {
				if (firstPass) unknownOnFirstPass.push(id);
				continue;
			}

			knownCount += 1;
			const status = (checked.agent as any)?.status as AgentStatus | undefined;
			if (!status) continue;
			if (waitStateSet.has(status)) {
				return checked;
			}
		}

		// Fail immediately if any provided ID was unrecognised on the very first
		// poll — unknown agents will never become known, so waiting is pointless.
		if (firstPass && unknownOnFirstPass.length > 0) {
			return {
				ok: false,
				error: `Unknown agent id(s): ${unknownOnFirstPass.join(", ")}`,
			};
		}

		// Successful agents are auto-pruned from registry. If all tracked IDs
		// disappeared after polling started, we can no longer observe state changes.
		if (!firstPass && knownCount === 0) {
			return {
				ok: false,
				error:
					`Agent id(s) disappeared from registry: ${uniqueIds.join(", ")}. ` +
					"They may have exited successfully and been cleaned up.",
			};
		}

		firstPass = false;
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
		let statusChanged = false;
		if (!isTerminalStatus(existing.status)) {
			statusChanged = await setRecordStatus(stateRoot, existing, "running");
		}
		if (!statusChanged) {
			existing.updatedAt = nowIso();
		}
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

function isChildRuntime(): boolean {
	return Boolean(process.env[ENV_AGENT_ID]);
}

function collectStatusTransitions(stateRoot: string, agents: AgentRecord[]): StatusTransitionNotice[] {
	const previous = statusSnapshotsByStateRoot.get(stateRoot);
	const next = new Map<string, AgentStatusSnapshot>();
	const transitions: StatusTransitionNotice[] = [];

	for (const record of agents) {
		const currentSnapshot: AgentStatusSnapshot = {
			status: record.status,
			tmuxWindowIndex: record.tmuxWindowIndex,
		};
		next.set(record.id, currentSnapshot);

		const previousSnapshot = previous?.get(record.id);
		if (!previousSnapshot || previousSnapshot.status === record.status) continue;
		transitions.push({
			id: record.id,
			fromStatus: previousSnapshot.status,
			toStatus: record.status,
			tmuxWindowIndex: record.tmuxWindowIndex ?? previousSnapshot.tmuxWindowIndex,
		});
	}

	if (previous) {
		for (const [agentId, previousSnapshot] of previous.entries()) {
			if (next.has(agentId)) continue;
			if (isTerminalStatus(previousSnapshot.status)) continue;
			transitions.push({
				id: agentId,
				fromStatus: previousSnapshot.status,
				toStatus: "done",
				tmuxWindowIndex: previousSnapshot.tmuxWindowIndex,
			});
		}
	}

	statusSnapshotsByStateRoot.set(stateRoot, next);
	if (!previous) return [];
	return transitions.sort((a, b) => a.id.localeCompare(b.id));
}

function formatStatusTransitionMessage(transition: StatusTransitionNotice): string {
	const win = transition.tmuxWindowIndex !== undefined ? ` (tmux #${transition.tmuxWindowIndex})` : "";
	return `parallel-agent ${transition.id}: ${transition.fromStatus} -> ${transition.toStatus}${win}`;
}

function emitStatusTransitions(pi: ExtensionAPI, ctx: ExtensionContext, transitions: StatusTransitionNotice[]): void {
	if (isChildRuntime()) return;

	for (const transition of transitions) {
		const message = formatStatusTransitionMessage(transition);
		pi.sendMessage(
			{
				customType: STATUS_UPDATE_MESSAGE_TYPE,
				content: message,
				display: true,
				details: {
					agentId: transition.id,
					fromStatus: transition.fromStatus,
					toStatus: transition.toStatus,
					tmuxWindowIndex: transition.tmuxWindowIndex,
					emittedAt: Date.now(),
				},
			},
			{
				triggerTurn: false,
				deliverAs: "followUp",
			},
		);

		if (ctx.hasUI && (transition.toStatus === "failed" || transition.toStatus === "crashed")) {
			ctx.ui.notify(message, "error");
		}
	}
}

function emitKickoffPromptMessage(pi: ExtensionAPI, started: StartAgentResult): void {
	const win = started.tmuxWindowIndex !== undefined ? ` (tmux #${started.tmuxWindowIndex})` : "";
	const content = `parallel-agent ${started.id}: kickoff prompt${win}\n\n${started.prompt}`;
	pi.sendMessage(
		{
			customType: PROMPT_UPDATE_MESSAGE_TYPE,
			content,
			display: false,
			details: {
				agentId: started.id,
				tmuxWindowId: started.tmuxWindowId,
				tmuxWindowIndex: started.tmuxWindowIndex,
				worktreePath: started.worktreePath,
				branch: started.branch,
				prompt: started.prompt,
				emittedAt: Date.now(),
			},
		},
		{ triggerTurn: false },
	);
}

async function renderStatusLine(pi: ExtensionAPI, ctx: ExtensionContext, options?: { emitTransitions?: boolean }): Promise<void> {
	if (!ctx.hasUI) return;

	const stateRoot = getStateRoot(ctx);
	const refreshed = await refreshAllAgents(stateRoot);
	const agents = Object.values(refreshed.agents).sort((a, b) => a.id.localeCompare(b.id));

	if (options?.emitTransitions ?? true) {
		const transitions = collectStatusTransitions(stateRoot, agents);
		if (transitions.length > 0) {
			emitStatusTransitions(pi, ctx, transitions);
		}
	} else if (!statusSnapshotsByStateRoot.has(stateRoot)) {
		collectStatusTransitions(stateRoot, agents);
	}

	if (agents.length === 0) {
		if (lastRenderedStatusLine !== undefined) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			lastRenderedStatusLine = undefined;
		}
		return;
	}

	const theme = ctx.ui.theme;
	const line = agents
		.map((record) => {
			const win = record.tmuxWindowIndex !== undefined ? `@${record.tmuxWindowIndex}` : "";
			const entry = `${record.id}:${statusShort(record.status)}${win}`;
			return theme.fg(statusColorRole(record.status), entry);
		})
		.join(" ");

	if (line === lastRenderedStatusLine) return;
	ctx.ui.setStatus(STATUS_KEY, line);
	lastRenderedStatusLine = line;
}

function ensureStatusPoller(pi: ExtensionAPI, ctx: ExtensionContext): void {
	statusPollContext = ctx;
	statusPollApi = pi;
	if (!ctx.hasUI) return;

	if (!statusPollTimer) {
		statusPollTimer = setInterval(() => {
			if (statusPollInFlight || !statusPollContext || !statusPollApi) return;
			statusPollInFlight = true;
			void renderStatusLine(statusPollApi, statusPollContext)
				.catch(() => {})
				.finally(() => {
					statusPollInFlight = false;
				});
		}, 2500);
		statusPollTimer.unref();
	}

	void renderStatusLine(pi, ctx).catch(() => {});
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
				lines.push("", "prompt:");
				for (const line of started.prompt.split(/\r?\n/)) {
					lines.push(`  ${line}`);
				}
				renderInfoMessage(pi, ctx, "parallel-agent started", lines);
				await renderStatusLine(pi, ctx).catch(() => {});
			} catch (err) {
				ctx.hasUI && ctx.ui.notify(`Failed to start agent: ${stringifyError(err)}`, "error");
			}
		},
	});

	pi.registerCommand("agents", {
		description: "List tracked parallel agents",
		handler: async (_args, ctx) => {
			const stateRoot = getStateRoot(ctx);
			const repoRoot = resolveGitRoot(stateRoot);
			let registry = await refreshAllAgents(stateRoot);
			const records = Object.values(registry.agents).sort((a, b) => a.id.localeCompare(b.id));
			let orphanLocks = await scanOrphanWorktreeLocks(repoRoot, registry);

			if (records.length === 0 && orphanLocks.reclaimable.length === 0 && orphanLocks.blocked.length === 0) {
				ctx.hasUI && ctx.ui.notify("No tracked parallel agents yet.", "info");
				return;
			}

			const lines: string[] = [];
			const failedIds: string[] = [];

			if (records.length === 0) {
				lines.push("(no tracked agents)");
			} else {
				for (const [index, record] of records.entries()) {
					const win = record.tmuxWindowIndex !== undefined ? `#${record.tmuxWindowIndex}` : "-";
					const worktreeName = record.worktreePath ? basename(record.worktreePath) || record.worktreePath : "-";
					lines.push(
						`${record.id}  ${record.status}  win:${win}  branch:${record.branch ?? "-"}  worktree:${worktreeName}`,
					);
					lines.push(`  task: ${summarizeTask(record.task)}`);
					if (record.error) lines.push(`  error: ${record.error}`);
					if (record.status === "failed" || record.status === "crashed") {
						failedIds.push(record.id);
					}
					if (index < records.length - 1) {
						lines.push("");
					}
				}
			}

			if (orphanLocks.reclaimable.length > 0 || orphanLocks.blocked.length > 0) {
				if (lines.length > 0) lines.push("");
				lines.push("orphan worktree locks:");
				for (const lock of orphanLocks.reclaimable) {
					lines.push(`  reclaimable: ${summarizeOrphanLock(lock)}`);
				}
				for (const lock of orphanLocks.blocked) {
					lines.push(`  blocked: ${summarizeOrphanLock(lock)} (${lock.blockers.join("; ")})`);
				}
			}

			renderInfoMessage(pi, ctx, "parallel-agents", lines);

			if (failedIds.length > 0 && ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Clean up failed agents?",
					`Remove ${failedIds.length} failed/crashed agent(s) from registry: ${failedIds.join(", ")}`,
				);
				if (confirmed) {
					registry = await mutateRegistry(stateRoot, async (next) => {
						for (const id of failedIds) {
							delete next.agents[id];
						}
					});
					ctx.ui.notify(`Removed ${failedIds.length} agent(s): ${failedIds.join(", ")}`, "info");
				}
			}

			orphanLocks = await scanOrphanWorktreeLocks(repoRoot, registry);

			if (orphanLocks.reclaimable.length > 0 && ctx.hasUI) {
				const preview = orphanLocks.reclaimable.slice(0, 6).map((lock) => `- ${summarizeOrphanLock(lock)}`);
				if (orphanLocks.reclaimable.length > preview.length) {
					preview.push(`- ... and ${orphanLocks.reclaimable.length - preview.length} more`);
				}

				const confirmed = await ctx.ui.confirm(
					"Reclaim orphan worktree locks?",
					[
						`Remove ${orphanLocks.reclaimable.length} orphan worktree lock(s)?`,
						"Only lock files with no tracked registry agent and no live pid/tmux signal are included.",
						"",
						...preview,
					].join("\n"),
				);
				if (confirmed) {
					const reclaimed = await reclaimOrphanWorktreeLocks(orphanLocks.reclaimable);
					if (reclaimed.failed.length === 0) {
						ctx.ui.notify(`Reclaimed ${reclaimed.removed.length} orphan worktree lock(s).`, "info");
					} else {
						ctx.ui.notify(
							`Reclaimed ${reclaimed.removed.length} orphan lock(s); failed ${reclaimed.failed.length}.`,
							"warning",
						);
					}
				}
			}

			if (orphanLocks.blocked.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`Found ${orphanLocks.blocked.length} orphan lock(s) that look live; leaving them untouched.`,
					"warning",
				);
			}
		},
	});

	pi.registerTool({
		name: "agent-start",
		label: "Agent Start",
		description:
			"Start a background parallel child agent in tmux/worktree. Lifecycle: child should implement the change, then yield for review (do not auto-/quit); parent/user inspects, asks child to wrap up (finish flow), then quits. The description is sent verbatim (no automatic context summary), so include all necessary context. Provide a short kebab-case branchHint (max 3 words) for the agent's branch name. Returns { ok: true, id, tmuxWindowId, tmuxWindowIndex, worktreePath, branch, warnings[] } on success, or { ok: false, error } on failure.",
		parameters: Type.Object({
			description: Type.String({ description: "Task description for child agent kickoff prompt (include all necessary context)" }),
			branchHint: Type.String({ description: "Short kebab-case branch slug, max 3 words (e.g. fix-auth-leak)" }),
			model: Type.Optional(Type.String({ description: "Model as provider/modelId (optional)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const started = await startAgent(pi, ctx, {
					task: params.description,
					branchHint: params.branchHint,
					model: params.model,
					includeSummary: false,
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									ok: true,
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
		description:
			"Check a given parallel agent status and return compact recent output. Returns { ok: true, agent: { id, status, tmuxWindowId, tmuxWindowIndex, worktreePath, branch, task, startedAt, finishedAt?, exitCode?, error?, warnings[] }, backlog: string[] }, or { ok: false, error } if the agent id is unknown or a registry error occurs. backlog is sanitized/truncated for LLM safety; task is a compact preview. Statuses: allocating_worktree | spawning_tmux | starting | running | waiting_user | finishing | waiting_merge_lock | retrying_reconcile | failed | crashed. Agents that exit with code 0 are auto-removed from registry.",
		parameters: Type.Object({
			id: Type.String({ description: "Agent id" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const payload = await agentCheckPayload(getStateRoot(ctx), params.id);
				return {
					content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: stringifyError(err) }, null, 2) }],
				};
			}
		},
	});

	pi.registerTool({
		name: "agent-wait-any",
		label: "Agent Wait Any",
		description:
			"Poll until one of the provided agent ids reaches a target state, then return that agent's check payload (same shape as agent-check). Default wait states: waiting_user | failed | crashed. Optionally pass states[] to override. Returns { ok: false, error } immediately if any id is unknown on first pass. Successful exitCode 0 agents are auto-pruned from registry; if all tracked ids disappear, this tool returns an error instead of polling forever. The tool's abort signal is respected between poll cycles (roughly every 1 s).",
		parameters: Type.Object({
			ids: Type.Array(Type.String({ description: "Agent id" }), { description: "Agent ids to wait for" }),
			states: Type.Optional(
				Type.Array(Type.String({ description: "Agent status value" }), {
					description: "Optional target states to wait for. Default: waiting_user, failed, crashed",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const payload = await waitForAny(getStateRoot(ctx), params.ids, signal, params.states);
				return {
					content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: stringifyError(err) }, null, 2) }],
				};
			}
		},
	});

	pi.registerTool({
		name: "agent-send",
		label: "Agent Send",
		description:
			"Send a steering/follow-up prompt to a child agent's tmux pane. Prefix rules: '!' — send C-c interrupt first; if there is additional text after '!', a 300 ms pause is inserted before sending it so Pi can return to interactive prompt. '/' — forwarded as-is; Pi treats lines beginning with '/' as slash commands. Send '!' alone to interrupt without a follow-up. Returns { ok: boolean, message: string }.",
		parameters: Type.Object({
			id: Type.String({ description: "Agent id" }),
			prompt: Type.String({ description: "Prompt text to send (prefix with '!' to interrupt first, '/' for slash commands)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const payload = await sendToAgent(getStateRoot(ctx), params.id, params.prompt);
				return {
					content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: stringifyError(err) }, null, 2) }],
				};
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await ensureChildSessionLinked(pi, ctx).catch(() => {});
		ensureStatusPoller(pi, ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await ensureChildSessionLinked(pi, ctx).catch(() => {});
		ensureStatusPoller(pi, ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		await setChildRuntimeStatus(ctx, "running").catch(() => {});
	});

	pi.on("agent_end", async (_event, ctx) => {
		await setChildRuntimeStatus(ctx, "waiting_user").catch(() => {});
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		statusPollContext = ctx;
		statusPollApi = pi;
		await renderStatusLine(pi, ctx, { emitTransitions: false }).catch(() => {});
	});
}
