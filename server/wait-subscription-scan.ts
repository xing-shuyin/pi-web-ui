// ---------------------------------------------------------------------------
// 挂起 wake 订阅扫描（retain conversations with pending subagent wakes）
// ---------------------------------------------------------------------------
// 背景：pi-subagents 扩展在后台异步子代理运行结束后，通过持久化的
// wait-subscription 记录唤醒父会话（pi.sendMessage({ triggerTurn: true })）。
// 记录是独立的小 JSON 文件，存放在共享目录
//   <tmp>/pi-subagents-<scope>/wait-subscriptions/<token>.json
// 其中 scope 与 pi-subagents/src/shared/types.ts 的 resolveTempScopeId() 一致：
//   PI_SUBAGENTS_TEMP_ROOT 环境变量优先，否则 uid-N / user-<用户名> /
//   home-<主目录> / shared（完整 fallback 链见 resolveTempScopeId 注释）。
// 记录的 sessionId 是会话 .jsonl 文件的绝对路径（AgentSession.sessionFile），
// 记录自带 expiresAt（毫秒时间戳），因此任何基于它的保留策略都是自限的：
// 记录过期后即不再触发保留，内存/运行时开销有硬上界。
//
// fail-open / fail-closed 决策：只有「能完整解析为合法 wait-subscription 记录、
// sessionId 匹配且未过期」的文件才算证据（→ fail-closed 保留运行时）。
// 损坏 JSON、格式不符（含非有限数值，见 parseRecord）、外部会话的记录一律
// 视为「无证据」（→ fail-open 允许释放）：这些文件无法给出可信的过期时间，
// 若 fail-closed 会造成运行时永久泄漏；而误释放的最坏后果只是本 bug 已知的
// 行为（重开聊天时唤醒）。
// ---------------------------------------------------------------------------
// Scan for pending "wait subscription" records (pi-subagents). A pending record
// means the conversation's session is owed a wake-up turn by a finished
// background subagent run, so its runtime must be kept alive across project /
// conversation switches. See the Chinese block above for the persistence layout
// and the fail-open vs fail-closed rationale.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";

/** 与 pi-subagents WaitSubscriptionRecord 的必填字段保持一致（结构校验）。 */
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

/**
 * 严格结构校验：任何字段缺失/类型不符（含非有限数值 —— 例如 JSON 里的 1e999
 * 经 JSON.parse 变成 Infinity）都视为「外部格式」，不算证据（fail-open）。
 * 非有限 expiresAt 会破坏「记录过期即自限」的不变量，必须挡在校验层。
 */
function parseRecord(value: unknown): WaitSubscriptionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Partial<WaitSubscriptionRecord>;
	if (record.version !== 1
		|| typeof record.token !== "string"
		|| !UUID_RE.test(record.token)
		|| typeof record.sessionId !== "string"
		|| (record.targetKind !== "async" && record.targetKind !== "foreground")
		|| typeof record.runId !== "string"
		|| typeof record.requestedId !== "string"
		|| typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)
		|| typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return undefined;
	return record as WaitSubscriptionRecord;
}

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

/**
 * 复刻 pi-subagents 的临时目录 scope（resolveTempScopeId，types.ts:2054）。
 * Fallback 链与上游逐层对齐：
 *   1. getuid() 可用 → `uid-<n>`；
 *   2. USERNAME / USER / LOGNAME 环境变量 → `user-<名>`；
 *   3. os.userInfo().username（try/catch，抛错则落到下一层）→ `user-<名>`；
 *   4. USERPROFILE / HOME 环境变量，再退 os.homedir()（非空字符串才用）→
 *      `home-<主目录>`；
 *   5. 全部不可得 → "shared"。
 * Mirror of pi-subagents' temp-scope resolution so both sides agree on the
 * shared wait-subscriptions directory without importing pi-subagents.
 * getuid / userInfo / homedir 可注入以便逐层测试（生产用 os 默认值）。
 */
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
	} catch {
		// Fall through to home-directory-based scoping.
	}
	const homedirEnv = env.USERPROFILE ?? env.HOME;
	if (homedirEnv) return `home-${sanitizeTempScopeSegment(homedirEnv)}`;
	try {
		const fallbackHomedir = homedirFn?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}
	return "shared";
}

/** wait-subscriptions 目录默认位置（与 pi-subagents 的推导一致）。 */
export function resolveSubscriptionsDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	const root = configured
		? path.resolve(configured)
		: path.join(tmpdir(), `pi-subagents-${resolveTempScopeId(env)}`);
	return path.join(path.dirname(path.join(root, "async-subagent-runs")), "wait-subscriptions");
}

/**
 * async-subagent-runs 目录默认位置（与 pi-subagents ASYNC_DIR 推导一致）。
 * Default async-runs dir: same temp root as wait-subscriptions.
 */
export function resolveAsyncRunsDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	const root = configured
		? path.resolve(configured)
		: path.join(tmpdir(), `pi-subagents-${resolveTempScopeId(env)}`);
	return path.join(root, "async-subagent-runs");
}

export interface PendingWakeScanOptions {
	/** 默认 resolveSubscriptionsDir()。测试可注入临时目录。 */
	subscriptionsDir?: string;
	/** 会话标识 = pi-subagents 记录中的 sessionId = session .jsonl 绝对路径。 */
	sessionId?: string;
	now?: () => number;
	/** I/O 警告出口（测试可静音）。默认 console.warn。 */
	warn?: (message: string, error: unknown) => void;
}

/**
 * 磁盘扫描：该会话是否还有未过期的 wake 订阅记录。
 * Does the session still have a non-expired wait-subscription record on disk?
 * 任何 I/O / 解析错误都按「无证据」处理（fail-open，见文件头说明）；
 * 非 ENOENT 的 I/O 错误会 console.warn 一次（与 pi-subagents :142 对齐），
 * ENOENT（目录/文件尚不存在）保持静默。
 */
export function hasPendingWaitSubscription(options: PendingWakeScanOptions): boolean {
	const sessionId = options.sessionId;
	if (!sessionId) return false;
	const now = options.now ?? Date.now;
	const warn = options.warn ?? ((message: string, error: unknown) => console.warn(message, error));
	const isNotFound = (error: unknown): boolean =>
		typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
	const dir = options.subscriptionsDir ?? resolveSubscriptionsDir();
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch (error) {
		if (!isNotFound(error)) warn(`Failed to scan wait subscriptions in '${dir}':`, error);
		return false; // 目录缺失 / 不可读 → 无证据
	}
	for (const file of files) {
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(path.join(dir, file), "utf-8"));
		} catch (error) {
			if (!isNotFound(error)) warn(`Failed to read wait subscription '${path.join(dir, file)}':`, error);
			continue; // 损坏 JSON → 无证据（fail-open）
		}
		const record = parseRecord(value);
		if (!record) continue; // 外部格式 → 无证据
		// 与 pi-subagents 的读取路径对齐（:154/:326）：文件名必须是
		// `<token>.json` —— 被重命名过的记录永远不会被上游消费，这里同样
		// 视为无证据（fail-open），保证与宿主行为一致。
		// Parity with pi-subagents: only files named `<token>.json` can ever
		// fire, so renamed records count as no evidence.
		if (path.basename(file) !== `${record.token}.json`) continue;
		if (record.sessionId !== sessionId) continue; // 别的会话
		if (record.expiresAt <= now()) continue; // 已过期 → 不再保留
		return true;
	}
	return false;
}

export interface ActiveSubagentScanOptions {
	/** 默认 resolveAsyncRunsDir()。测试可注入临时目录。 */
	asyncRunsDir?: string;
	now?: () => number;
	/** I/O 警告出口（测试可静音）。默认 console.warn。 */
	warn?: (message: string, error: unknown) => void;
}

/** 与 pi-subagents 的 DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS 对齐：24h。 */
export const STALE_ACTIVE_RUN_MARKER_MS = 24 * 60 * 60 * 1000;

/** 与 pi-subagents 的 isActiveAsyncState 对齐（active-run-index.ts:42）。 */
function isActiveAsyncState(state: string): boolean {
	return state === "queued" || state === "running";
}

/**
 * 磁盘扫描：pi-subagents 是否还有未失效的后台异步运行（active-run marker）。
 * Does pi-subagents have any live async subagent run (active-run marker on disk)?
 *
 * 布局：`<async-runs-root>/.active-runs/<runId>`（marker 文件名为 async 目录
 * basename，即 runId）。pi-subagents 0.64.0 的 marker 是空文件（状态在写入
 * 时判定：只有 queued/running 才创建 marker，终态会删除）；若 marker 带有
 * JSON 内容且含字符串 state 字段，则按 isActiveAsyncState 判定。
 * Marker mtime 超过 24h（STALE_ACTIVE_RUN_MARKER_MS，与上游
 * DEFAULT_STALE_TERMINAL_ACTIVE_MARKER_MS 一致）视为 crash 孤儿 → 无证据。
 *
 * 作用域权衡：marker 名即 async run 目录 basename，session 级保留需要逐
 * marker 读取 <async-runs-root>/<runId>/status.json（内含 sessionFile/
 * sessionId），但 queued 运行的 status.json 可能瞬时缺失，因此接受更粗
 * 的全局探针（任意未失效 active marker）。保留是自限的（24h staleness
 * + 上游终态即删 marker），全局安全，只是更粗。
 * The probe is intentionally GLOBAL (any unexpired active marker), not
 * session-scoped: session-scoped retention would require reading
 * <runId>/status.json per marker (the marker name is the async run dir
 * basename; status.json carries sessionFile/sessionId), which may be
 * transiently absent for queued runs. We accept the coarser global probe as
 * self-limiting (24h staleness cap + terminal-state marker deletion).
 *
 * fail-open 语义与 hasPendingWaitSubscription 一致：任何 I/O / 解析错误
 * （目录缺失、损坏 JSON）都按「无证据」处理；ENOENT 静默，其它错误
 * console.warn 一次。
 */
export function hasActiveSubagentRuns(options: ActiveSubagentScanOptions = {}): boolean {
	const now = options.now ?? Date.now;
	const warn = options.warn ?? ((message: string, error: unknown) => console.warn(message, error));
	const isNotFound = (error: unknown): boolean =>
		typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
	const dir = path.join(options.asyncRunsDir ?? resolveAsyncRunsDir(), ".active-runs");
	let markers: string[];
	try {
		markers = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name); // 仅文件：跳过永久子目录（如 tool-calls/）
	} catch (error) {
		if (!isNotFound(error)) warn(`Failed to scan active-run markers in '${dir}':`, error);
		return false; // 目录缺失 / 不可读 → 无证据
	}
	for (const marker of markers) {
		const markerPath = path.join(dir, marker);
		try {
			// 先查 mtime：超过 24h 的 marker 是 crash 孤儿（上游同样按 mtime 清理），
			// 不构成保留证据，也无需再读内容。
			const age = now() - statSync(markerPath).mtimeMs;
			if (age > STALE_ACTIVE_RUN_MARKER_MS) continue;
			const content = readFileSync(markerPath, "utf-8").trim();
			if (content === "") return true; // 上游 0.64.0 写入的就是空 marker
			let value: unknown;
			try {
				value = JSON.parse(content);
			} catch {
				continue; // 损坏 JSON → 无证据（fail-open）
			}
			const state = (value as { state?: unknown })?.state;
			if (typeof state === "string" && isActiveAsyncState(state)) return true;
		} catch (error) {
			if (!isNotFound(error)) warn(`Failed to read active-run marker '${markerPath}':`, error);
			continue; // 单个 marker 读取失败 → 无证据（fail-open），继续看下一个
		}
	}
	return false;
}

/** displaceActive 决策的输入快照（纯数据，便于单测）。 */
export interface DisplacementDecisionInput {
	reviewing: boolean;
	wizardRunning: boolean;
	streaming: boolean;
	openTerminals: number;
	listed: boolean;
	promptedSinceActive: boolean;
	/**
	 * 磁盘扫描结果：存在未过期 wake 订阅。可传 thunk 延迟求值 —— 只在前面的
	 * 保留条件都不命中时才会被调用，避免每次置换都做同步磁盘 I/O。
	 * Pending-wake evidence; pass a thunk to defer the disk scan — it is only
	 * invoked at this precedence point, after the cheaper checks pass.
	 */
	hasPendingWake: boolean | (() => boolean);
	/**
	 * 磁盘扫描结果：存在未失效的 pi-subagents 后台异步运行（active-run
	 * marker）。可传 thunk 延迟求值 —— 只在前面的保留条件都不命中时才会被
	 * 调用，避免每次置换都做同步磁盘 I/O。
	 * Live async subagent work on disk; pass a thunk to defer the disk scan.
	 */
	hasActiveSubagentWork: boolean | (() => boolean);
}

/**
 * 纯函数版置换决策：true = 保留（不得 dispose），false = 调用方可释放。
 * Pure decision core of displaceActive(): true = retain, false = may dispose.
 * 顺序与 displaceActive 保持一致：review/wizard → streaming → terminals →
 * pending wake → active subagent runs → listed+continued（「打开后继续过」
 * 的会话也保留）。
 * Order: review/wizard → streaming → terminals → pending wake → live async
 * subagent runs → listed+continued.
 */
export function shouldRetainActive(input: DisplacementDecisionInput): boolean {
	if (input.reviewing || input.wizardRunning) return true;
	if (input.streaming) return true;
	if (input.openTerminals > 0) return true;
	const hasPendingWake = typeof input.hasPendingWake === "function"
		? input.hasPendingWake()
		: input.hasPendingWake;
	if (hasPendingWake) return true;
	const hasActiveSubagentWork = typeof input.hasActiveSubagentWork === "function"
		? input.hasActiveSubagentWork()
		: input.hasActiveSubagentWork;
	if (hasActiveSubagentWork) return true;
	if (input.listed && input.promptedSinceActive) return true;
	return false;
}
