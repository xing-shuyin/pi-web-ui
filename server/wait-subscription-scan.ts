import { readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";

interface WaitSubscriptionRecord {
	version: number;
	token: string;
	sessionId: string;
	targetKind: "async" | "foreground";
	runId: string;
	requestedId: string;
	createdAt: number;
	expiresAt: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseRecord(value: unknown): WaitSubscriptionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<WaitSubscriptionRecord>;
	if (
		record.version !== 1 ||
		typeof record.token !== "string" ||
		!UUID_RE.test(record.token) ||
		typeof record.sessionId !== "string" ||
		(record.targetKind !== "async" && record.targetKind !== "foreground") ||
		typeof record.runId !== "string" ||
		typeof record.requestedId !== "string" ||
		typeof record.createdAt !== "number" ||
		!Number.isFinite(record.createdAt) ||
		typeof record.expiresAt !== "number" ||
		!Number.isFinite(record.expiresAt)
	)
		return undefined;
	return record as WaitSubscriptionRecord;
}

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

export function resolveTempScopeId(
	env: NodeJS.ProcessEnv = process.env,
	getuid: (() => number) | null | undefined = process.getuid?.bind(process),
	userInfoFn: (() => { username?: string | null }) | null = userInfo,
	homedirFn: (() => string) | null = homedir,
): string {
	if (typeof getuid === "function") return `uid-${getuid()}`;
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}
	try {
		const username = userInfoFn?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {}
	const homedirEnv = env.USERPROFILE ?? env.HOME;
	if (homedirEnv) return `home-${sanitizeTempScopeSegment(homedirEnv)}`;
	try {
		const fallbackHomedir = homedirFn?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {}
	return "shared";
}

function resolveTempRoot(env: NodeJS.ProcessEnv): string {
	const configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	return configured ? path.resolve(configured) : path.join(tmpdir(), `pi-subagents-${resolveTempScopeId(env)}`);
}

export function resolveSubscriptionsDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(resolveTempRoot(env), "wait-subscriptions");
}

export function resolveAsyncRunsDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(resolveTempRoot(env), "async-subagent-runs");
}

const ACTIVE_RUN_INDEX_DIR = ".active-runs";

interface AsyncStatusProbe {
	state?: unknown;
	sessionId?: unknown;
}

export interface ActiveRunScanOptions {
	asyncRunsDir?: string;
	sessionId?: string;
	warn?: (message: string, error: unknown) => void;
}

export function hasActiveSubagentRun(options: ActiveRunScanOptions): boolean {
	const sessionId = options.sessionId;
	if (!sessionId) return false;
	const warn = options.warn ?? ((message: string, error: unknown) => console.warn(message, error));
	const isNotFound = (error: unknown): boolean =>
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT";
	const runsDir = options.asyncRunsDir ?? resolveAsyncRunsDir();
	const indexDir = path.join(runsDir, ACTIVE_RUN_INDEX_DIR);
	let markers: string[];
	try {
		markers = readdirSync(indexDir);
	} catch (error) {
		if (!isNotFound(error)) warn(`Failed to scan active-run index in '${indexDir}':`, error);
		return false;
	}
	for (const runId of markers) {
		if (runId.startsWith(".")) continue;
		let status: unknown;
		try {
			status = JSON.parse(readFileSync(path.join(runsDir, runId, "status.json"), "utf-8"));
		} catch (error) {
			if (!isNotFound(error))
				warn(`Failed to read async run status '${path.join(runsDir, runId, "status.json")}':`, error);
			continue;
		}
		if (!status || typeof status !== "object" || Array.isArray(status)) continue;
		const probe = status as AsyncStatusProbe;
		if (probe.sessionId !== sessionId) continue;
		if (probe.state !== "queued" && probe.state !== "running") continue;
		return true;
	}
	return false;
}

export interface PendingWakeScanOptions {
	subscriptionsDir?: string;
	sessionId?: string;
	now?: () => number;
	warn?: (message: string, error: unknown) => void;
}

export function hasPendingWaitSubscription(options: PendingWakeScanOptions): boolean {
	const sessionId = options.sessionId;
	if (!sessionId) return false;
	const now = options.now ?? Date.now;
	const warn = options.warn ?? ((message: string, error: unknown) => console.warn(message, error));
	const isNotFound = (error: unknown): boolean =>
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT";
	const dir = options.subscriptionsDir ?? resolveSubscriptionsDir();
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch (error) {
		if (!isNotFound(error)) warn(`Failed to scan wait subscriptions in '${dir}':`, error);
		return false;
	}
	for (const file of files) {
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(path.join(dir, file), "utf-8"));
		} catch (error) {
			if (!isNotFound(error)) warn(`Failed to read wait subscription '${path.join(dir, file)}':`, error);
			continue;
		}
		const record = parseRecord(value);
		if (!record) continue;
		if (path.basename(file) !== `${record.token}.json`) continue;
		if (record.sessionId !== sessionId) continue;
		if (record.expiresAt <= now()) continue;
		return true;
	}
	return false;
}

export interface BackgroundTaskScanOptions {
	cwd?: string;
	sessionFile?: string;
	pid?: number;
}

export function hasRunningBackgroundTask(options: BackgroundTaskScanOptions): boolean {
	const { cwd, sessionFile } = options;
	if (!cwd || !sessionFile) return false;
	const sessionUuid = path
		.basename(sessionFile)
		.replace(/\.jsonl$/i, "")
		.split("_")
		.pop();
	if (!sessionUuid) return false;
	const ownDir = path.join(cwd, ".pi", "tasks", `${sessionUuid}-${options.pid ?? process.pid}`);
	let files: string[];
	try {
		files = readdirSync(ownDir);
	} catch {
		return false;
	}
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const task = JSON.parse(readFileSync(path.join(ownDir, f), "utf-8")) as { status?: unknown } | null;
			if (task && task.status === "running") return true;
		} catch {}
	}
	return false;
}

export interface DisplacementDecisionInput {
	pinned?: boolean;
	reviewing: boolean;
	wizardRunning: boolean;
	streaming: boolean;
	compacting?: boolean;
	promptInFlight?: boolean;
	openTerminals: number;
	listed: boolean;
	promptedSinceActive: boolean;
	hasActiveSubagentRun: boolean | (() => boolean);
	hasPendingWake: boolean | (() => boolean);
	hasRunningBackgroundTask?: boolean | (() => boolean);
}

export function shouldRetainActive(input: DisplacementDecisionInput): boolean {
	if (input.pinned) return true;
	if (input.reviewing || input.wizardRunning) return true;
	if (input.promptInFlight) return true;
	if (input.streaming || input.compacting) return true;
	if (input.openTerminals > 0) return true;
	const hasActiveRun =
		typeof input.hasActiveSubagentRun === "function" ? input.hasActiveSubagentRun() : input.hasActiveSubagentRun;
	if (hasActiveRun) return true;
	const hasPendingWake = typeof input.hasPendingWake === "function" ? input.hasPendingWake() : input.hasPendingWake;
	if (hasPendingWake) return true;
	const hasBgTask =
		typeof input.hasRunningBackgroundTask === "function"
			? input.hasRunningBackgroundTask()
			: (input.hasRunningBackgroundTask ?? false);
	if (hasBgTask) return true;
	if (input.listed && input.promptedSinceActive) return true;
	return false;
}
