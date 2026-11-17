/**
 * 桌面自动更新：主进程里的唯一状态机。
 *
 * 设计要点（参考 yetone/magpie 的 self-update 模型）：
 * 1. 单一事实源：更新状态只存在主进程，渲染层拿到的是**快照**而不是增量事件。
 *    旧实现在启动时 `checkForUpdates()` 广播 `available`，但网页要等几秒才挂载监听，
 *    事件丢掉后更新面板永远显示「检查更新」——快照 + `getState()` 从结构上避免这件事。
 * 2. 先判断「这份拷贝能不能替换自己」，再谈下载：便携包 / 解压包 / 开发模式没有
 *    `app-update.yml`，或者本身就不该被覆盖，一律走 manual 模式并把原因告诉用户，
 *    而不是等 electron-updater 抛一句英文错误。
 * 3. 失败要分类：网络 / feed 未就绪 / 无写权限 / 磁盘满 / 系统拒绝签名，前端据此给
 *    不同的下一步（重试 vs. 去下载页换包），原始信息只作为细节展示。
 * 4. 发布说明是更新体验的一部分：`fullChangelog` 让 electron-updater 把「从当前版本
 *    到目标版本」之间每个 release 的说明都给出来，落后多少个版本也由此可知。
 *
 * 本模块不 import electron / electron-updater 的运行时值（只 import type），
 * 因此可以在 vitest 里直接跑：主进程只负责把真实 autoUpdater 适配进来。
 */
import type { RuntimePlan, RuntimeUpdater, RuntimeUpdaterErrorCode, RuntimeUpdaterEvent } from "./runtime-updater.js";

export type UpdaterMode = "auto" | "manual";

/** 为什么是 manual：开发模式 / 便携版 / 这份拷贝没有更新配置 / 环境变量强制。 */
export type UpdaterModeReason = "ready" | "dev" | "portable" | "no-feed" | "forced";

export type UpdaterPhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "up-to-date" | "error";

/** 失败分类：决定前端给「重试」还是「去下载页换包」。 */
export type UpdaterErrorCode = "network" | "feed" | "permission" | "disk" | "signature" | "unknown";

export interface UpdaterReleaseNote {
	/** 版本号，不带 v。 */
	version: string;
	/** markdown 原文，已裁剪空白并限长。 */
	markdown: string;
}

export interface UpdaterState {
	mode: UpdaterMode;
	modeReason: UpdaterModeReason;
	phase: UpdaterPhase;
	/** 当前运行的版本（app.getVersion()），不带 v。 */
	currentVersion: string;
	/** 已发现的更新目标版本，没有则 null。 */
	targetVersion: string | null;
	/** 当前版本到目标版本之间有几个 release（发布说明条数），未知为 0。 */
	releasesBehind: number;
	/** 发布说明，新→旧。 */
	notes: UpdaterReleaseNote[];
	/** 发布说明被截断（只给了最近几段）。 */
	notesCut: boolean;
	percent: number;
	transferred: number;
	total: number;
	bytesPerSecond: number;
	/** 用户「忽略此版本」记下的版本，null 表示不忽略任何版本。 */
	skippedVersion: string | null;
	errorCode: UpdaterErrorCode | null;
	error: string | null;
	/** 最近一次检查结束的时间（epoch ms）。 */
	checkedAt: number | null;
	/** 目标版本的发布页。 */
	releasesUrl: string;
	/** 运行时通道（P2）：与壳更新同一份快照、同一条广播通道，面板分两段显示。 */
	runtime: RuntimeUpdaterState;
}

/** 运行时通道（双层模型的 L2）在面板里的样子：与壳更新并列，但状态各走各的。 */
export type RuntimeUpdaterPhase =
	| "disabled"
	| "idle"
	| "checking"
	| "available"
	| "downloading"
	| "staged"
	| "applying"
	| "done"
	| "up-to-date"
	| "error";

export interface RuntimeUpdaterState {
	/** 这份拷贝能不能更新运行时（打包态可用 / 开发态靠 PI_DESKTOP_UPDATE_FEED 打开）。 */
	enabled: boolean;
	phase: RuntimeUpdaterPhase;
	/** 当前在跑的运行时版本；包内自带那份时为 null。 */
	currentVersion: string | null;
	targetVersion: string | null;
	percent: number;
	transferred: number;
	total: number;
	errorCode: RuntimeUpdaterErrorCode | null;
	error: string | null;
	checkedAt: number | null;
}

export function initialRuntimeUpdaterState(input: {
	enabled: boolean;
	currentVersion?: string | null;
}): RuntimeUpdaterState {
	return {
		enabled: input.enabled,
		phase: input.enabled ? "idle" : "disabled",
		currentVersion: normalizeVersion(input.currentVersion ?? null),
		targetVersion: null,
		percent: 0,
		transferred: 0,
		total: 0,
		errorCode: null,
		error: null,
		checkedAt: null,
	};
}

/** 运行时通道的状态迁移（纯函数；engine 只发事件，不自己改状态）。 */
export function reduceRuntimeUpdater(
	state: RuntimeUpdaterState,
	event: RuntimeUpdaterEvent,
	now: number = Date.now(),
): RuntimeUpdaterState {
	switch (event.type) {
		case "checking":
			return { ...state, phase: "checking", error: null, errorCode: null, percent: 0, transferred: 0, total: 0 };
		case "available":
			return {
				...state,
				phase: "available",
				targetVersion: normalizeVersion(event.version),
				error: null,
				errorCode: null,
				checkedAt: now,
			};
		case "up-to-date":
			return { ...state, phase: "up-to-date", targetVersion: null, error: null, errorCode: null, checkedAt: now };
		case "progress":
			return {
				...state,
				phase: "downloading",
				percent: clampPercent(event.percent),
				transferred: nonNegative(event.transferred),
				total: nonNegative(event.total),
			};
		case "staged":
			return {
				...state,
				phase: "staged",
				targetVersion: normalizeVersion(event.version),
				percent: 100,
				error: null,
				errorCode: null,
			};
		case "applying":
			return {
				...state,
				phase: "applying",
				targetVersion: normalizeVersion(event.version),
				error: null,
				errorCode: null,
			};
		case "done":
			return {
				...state,
				phase: "done",
				currentVersion: normalizeVersion(event.version),
				targetVersion: null,
				percent: 100,
				error: null,
				errorCode: null,
			};
		case "cancelled":
			return {
				...state,
				phase: state.targetVersion ? "available" : "idle",
				percent: 0,
				transferred: 0,
				total: 0,
				error: null,
				errorCode: null,
			};
		case "error":
			return { ...state, phase: "error", errorCode: event.code, error: event.message, percent: 0 };
		default:
			return state;
	}
}

export type UpdaterEvent =
	| { type: "checking" }
	| { type: "available"; version: string; notes?: unknown }
	| { type: "up-to-date"; version?: string | null }
	| { type: "progress"; percent?: number; transferred?: number; total?: number; bytesPerSecond?: number }
	| { type: "downloaded"; version?: string | null }
	| { type: "error"; message?: string; code?: UpdaterErrorCode }
	| { type: "cancelled" }
	| { type: "skipped"; version: string | null }
	| { type: "runtime"; event: RuntimeUpdaterEvent };

/** 最多展示多少个 release 的说明；magpie 也做同样的上限（更新隔太久时是几页）。 */
export const MAX_NOTE_RELEASES = 20;
/** 单段说明的字符上限。 */
export const MAX_NOTE_CHARS = 3000;
/** 全部说明的总字符预算，避免一次性把几十 KB 塞进 IPC。 */
export const MAX_NOTES_CHARS = 40000;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function clampPercent(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function nonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function normalizeVersion(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim().replace(/^v/i, "");
	return v ? v : null;
}

/**
 * electron-updater 的 `releaseNotes`：`fullChangelog` 打开时是
 * `[{ version, note }]`（新→旧，覆盖 current..latest），否则是一段 markdown 字符串。
 * 这里统一成 `UpdaterReleaseNote[]`，并按条数 / 字符预算裁剪。
 */
export function normalizeReleaseNotes(
	raw: unknown,
	fallbackVersion: string | null = null,
): { notes: UpdaterReleaseNote[]; cut: boolean } {
	const notes: UpdaterReleaseNote[] = [];
	let cut = false;
	let budget = MAX_NOTES_CHARS;
	const push = (version: string, markdown: unknown) => {
		if (typeof markdown !== "string") return;
		const text = markdown.trim();
		if (!text) return;
		if (notes.length >= MAX_NOTE_RELEASES || budget <= 0) {
			cut = true;
			return;
		}
		const clipped = text.length > MAX_NOTE_CHARS ? text.slice(0, MAX_NOTE_CHARS) : text;
		// 总预算也要守住：单段再长也不能把整包 IPC 撑开。
		const limited = clipped.length > budget ? clipped.slice(0, budget) : clipped;
		if (limited.length !== text.length) cut = true;
		budget -= limited.length;
		notes.push({ version, markdown: limited });
	};
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			const record = asRecord(entry);
			if (!record) continue;
			const version = normalizeVersion(record.version) ?? fallbackVersion ?? "";
			push(version, record.note ?? record.notes);
		}
	} else if (typeof raw === "string") {
		push(fallbackVersion ?? "", raw);
	}
	return { notes, cut };
}

/**
 * 失败分类。electron-updater 的错误大多是「HttpError: 404」/「Cannot parse releases feed」
 * 这类字符串，没有稳定的错误码，只能按特征归类。
 */
export function classifyUpdaterError(error: unknown): UpdaterErrorCode {
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
	const text = message.toLowerCase();
	if (!text) return "unknown";
	if (/enospc|no space left|disk is full|磁盘空间/.test(text)) return "disk";
	if (/eacces|eperm|operation not permitted|permission denied|权限/.test(text)) return "permission";
	if (/code ?signature|not signed|signature (?:invalid|verification)|amfi|gatekeeper|squirrel/.test(text))
		return "signature";
	if (
		/enotfound|econnrefused|etimedout|eai_again|enetunreach|econnreset|socket hang up|getaddrinfo|internet disconnected|err_internet_disconnected|err_name_not_resolved|err_connection|err_network|network|timed? ?out/.test(
			text,
		)
	)
		return "network";
	if (
		/releases feed|latest\.ya?ml|latest-(?:mac|linux)\.yml|no published versions|channel file|404|403|invalid release|err_updater_/.test(
			text,
		)
	)
		return "feed";
	return "unknown";
}

export function releasesUrlFor(version: string | null | undefined, repo = "xing-shuyin/pi-web-ui"): string {
	const v = normalizeVersion(version);
	return v ? `https://github.com/${repo}/releases/tag/v${v}` : `https://github.com/${repo}/releases/latest`;
}

export function initialUpdaterState(input: {
	currentVersion: string;
	mode: UpdaterMode;
	modeReason: UpdaterModeReason;
	skippedVersion?: string | null;
	runtime?: RuntimeUpdaterState;
}): UpdaterState {
	return {
		mode: input.mode,
		modeReason: input.modeReason,
		phase: "idle",
		currentVersion: normalizeVersion(input.currentVersion) ?? input.currentVersion,
		targetVersion: null,
		releasesBehind: 0,
		notes: [],
		notesCut: false,
		percent: 0,
		transferred: 0,
		total: 0,
		bytesPerSecond: 0,
		skippedVersion: normalizeVersion(input.skippedVersion ?? null),
		errorCode: null,
		error: null,
		checkedAt: null,
		releasesUrl: releasesUrlFor(null),
		runtime: input.runtime ?? initialRuntimeUpdaterState({ enabled: false }),
	};
}

/** 纯状态迁移：主进程收到 autoUpdater 事件、或用户操作后，都只经过这里。 */
export function reduceUpdater(state: UpdaterState, event: UpdaterEvent, now: number = Date.now()): UpdaterState {
	switch (event.type) {
		case "runtime":
			return { ...state, runtime: reduceRuntimeUpdater(state.runtime, event.event, now) };
		case "checking":
			return { ...state, phase: "checking", error: null, errorCode: null };
		case "available": {
			const version = normalizeVersion(event.version) ?? state.targetVersion;
			const { notes, cut } = normalizeReleaseNotes(event.notes, version);
			return {
				...state,
				phase: "available",
				targetVersion: version,
				releasesBehind: notes.length,
				notes,
				notesCut: cut,
				percent: 0,
				transferred: 0,
				total: 0,
				bytesPerSecond: 0,
				error: null,
				errorCode: null,
				checkedAt: now,
				releasesUrl: releasesUrlFor(version),
			};
		}
		case "up-to-date":
			return {
				...state,
				phase: "up-to-date",
				currentVersion: normalizeVersion(event.version) ?? state.currentVersion,
				targetVersion: null,
				releasesBehind: 0,
				notes: [],
				notesCut: false,
				error: null,
				errorCode: null,
				checkedAt: now,
			};
		case "progress": {
			const total = nonNegative(event.total) || state.total;
			const transferred = nonNegative(event.transferred) || state.transferred;
			// electron-updater 的 percent 是 0-100 的浮点；没有就按字节算，别再显示上个阶段的残留值。
			const percent =
				typeof event.percent === "number" && Number.isFinite(event.percent)
					? clampPercent(event.percent)
					: total > 0
						? clampPercent((transferred / total) * 100)
						: state.percent;
			return {
				...state,
				phase: "downloading",
				percent,
				transferred,
				total,
				bytesPerSecond: nonNegative(event.bytesPerSecond),
			};
		}
		case "downloaded": {
			const version = normalizeVersion(event.version) ?? state.targetVersion;
			return {
				...state,
				phase: "downloaded",
				targetVersion: version,
				percent: 100,
				total: state.total || state.transferred,
				transferred: state.total || state.transferred,
				bytesPerSecond: 0,
				error: null,
				errorCode: null,
				checkedAt: now,
				releasesUrl: releasesUrlFor(version),
			};
		}
		case "error":
			return {
				...state,
				phase: "error",
				error: (event.message ?? "unknown error").slice(0, 2000),
				errorCode: event.code ?? classifyUpdaterError(event.message),
				percent: 0,
				transferred: 0,
				total: 0,
				bytesPerSecond: 0,
			};
		case "cancelled":
			return {
				...state,
				phase: state.targetVersion ? "available" : "idle",
				percent: 0,
				transferred: 0,
				total: 0,
				bytesPerSecond: 0,
				error: null,
				errorCode: null,
			};
		case "skipped":
			return { ...state, skippedVersion: normalizeVersion(event.version) };
		default:
			return state;
	}
}

export interface UpdaterModeInput {
	isPackaged: boolean;
	/** 便携版（便携目录 / 解压即用的 zip）不替换自身文件。 */
	portable: boolean;
	/** 打包产物里有没有 `app-update.yml`：没有就是解包 / 便携 / 手工拷贝的拷贝。 */
	hasUpdateFeed: boolean;
	/** PI_DESKTOP_UPDATE_MODE=auto|manual，用于支持与测试。 */
	override?: string | null;
}

/**
 * 「这份拷贝能不能自己换自己」。
 * magpie 在 macOS 上判断 App Translocation / 只读卷，Windows 上判断被系统拒绝启动；
 * 我们这边的等价判断是：有没有从安装包带来的更新配置、是不是便携布局、是不是开发模式。
 */
export function resolveUpdaterMode(input: UpdaterModeInput): { mode: UpdaterMode; reason: UpdaterModeReason } {
	const override = (input.override ?? "").trim().toLowerCase();
	if (override === "manual") return { mode: "manual", reason: "forced" };
	if (override === "auto") return { mode: "auto", reason: "ready" };
	if (!input.isPackaged) return { mode: "manual", reason: "dev" };
	if (input.portable) return { mode: "manual", reason: "portable" };
	if (!input.hasUpdateFeed) return { mode: "manual", reason: "no-feed" };
	return { mode: "auto", reason: "ready" };
}

export interface UpdaterPrefs {
	skipVersion: string | null;
}

export const DEFAULT_UPDATER_PREFS: UpdaterPrefs = { skipVersion: null };

/** 主进程注入的 electron-updater 表面（测试里用假体替换）。 */
export interface UpdaterAdapter {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	fullChangelog?: boolean;
	on(event: string, listener: (payload: unknown) => void): unknown;
	checkForUpdates(): Promise<unknown>;
	downloadUpdate(cancellationToken?: unknown): Promise<unknown>;
	quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterCancelToken {
	cancel(): void;
}

/** electron-updater 的 autoUpdater 表面：注入前不做运行时 import，测试与探针都能构造。 */
export interface AutoUpdaterLike {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	fullChangelog: boolean;
	on(event: string, listener: (payload: never) => void): unknown;
	checkForUpdates(): Promise<unknown>;
	downloadUpdate(cancellationToken?: unknown): Promise<unknown>;
	quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** 把真实 autoUpdater 包成状态机认的适配器；主进程与实机探针共用这一份接线。 */
export function autoUpdaterAdapter(autoUpdater: AutoUpdaterLike): UpdaterAdapter {
	return {
		get autoDownload() {
			return autoUpdater.autoDownload;
		},
		set autoDownload(value: boolean) {
			autoUpdater.autoDownload = value;
		},
		get autoInstallOnAppQuit() {
			return autoUpdater.autoInstallOnAppQuit;
		},
		set autoInstallOnAppQuit(value: boolean) {
			autoUpdater.autoInstallOnAppQuit = value;
		},
		get fullChangelog() {
			return autoUpdater.fullChangelog;
		},
		set fullChangelog(value: boolean) {
			autoUpdater.fullChangelog = value;
		},
		// electron-updater 的事件名与处理函数都是具体重载，这里统一按名字转发给状态机。
		on: (name, listener) => autoUpdater.on(name as never, listener as never),
		checkForUpdates: () => autoUpdater.checkForUpdates(),
		downloadUpdate: (token) => autoUpdater.downloadUpdate(token),
		quitAndInstall: (isSilent, isForceRunAfter) => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
	};
}

export interface UpdaterControllerOptions {
	adapter?: UpdaterAdapter | null;
	mode: { mode: UpdaterMode; reason: UpdaterModeReason };
	currentVersion: string;
	loadPrefs?: () => UpdaterPrefs;
	savePrefs?: (prefs: UpdaterPrefs) => void;
	/** 每次状态变化都回调：主进程用它广播快照。 */
	publish: (state: UpdaterState) => void;
	createCancelToken?: () => UpdaterCancelToken | null;
	now?: () => number;
	log?: (message: string) => void;
	/**
	 * 测试模式（本地 feed）下直接下载：实机验证「检查 → 下载」不需要点界面。
	 * 正常模式一直 false —— 只有用户点「下载更新」才动网络。
	 */
	autoDownload?: boolean;
	/** 启动后多久做第一次自检。 */
	initialCheckDelayMs?: number;
	/** 自检间隔；失败按 2 的幂退避到 maxCheckIntervalMs。 */
	checkIntervalMs?: number;
	maxCheckIntervalMs?: number;
	timers?: {
		setTimeout: (fn: () => void, ms: number) => unknown;
		clearTimeout: (handle: unknown) => void;
	};
	/** 运行时通道是否可用（false → 面板显示"这份拷贝不提供运行时更新"）。 */
	runtimeEnabled?: boolean;
	/** 当前在跑的运行时版本；切换成功后会重新读一次。 */
	runtimeCurrentVersion?: () => string | null;
}

/** 运行时通道（P2）：engine 负责网络与解包，applySwitch 由主进程注入（写指针 + 重启 + 健康检查 + 回滚）。 */
export interface RuntimeChannel {
	engine: RuntimeUpdater;
	applySwitch: (plan: RuntimePlan) => Promise<void>;
	currentVersion?: () => string | null;
}

export type UpdaterChannelName = "shell" | "runtime";

export interface UpdaterController {
	getState(): UpdaterState;
	/** 手动检查会无视「忽略此版本」，并允许在已是最新时重新检查；`channel` 选择壳还是运行时。 */
	check(options?: { manual?: boolean; channel?: UpdaterChannelName }): Promise<boolean>;
	download(options?: { channel?: UpdaterChannelName }): Promise<boolean>;
	cancelDownload(options?: { channel?: UpdaterChannelName }): boolean;
	skip(version: string | null): void;
	quitAndInstall(): boolean;
	/** 切换指针 + 重启服务 + 健康检查 + 失败回滚（面板「立即重启服务」）。 */
	applyRuntime(): Promise<boolean>;
	attach(adapter: UpdaterAdapter | null): void;
	attachRuntime(channel: RuntimeChannel | null): void;
	/** engine 的出口：事件只从这里进状态机，保证"更新状态只有一份"。 */
	pushRuntimeEvent(event: RuntimeUpdaterEvent): void;
	start(): void;
	dispose(): void;
}

/** electron-updater 的事件名 → 迁移输入。 */
function eventFor(name: string, payload: unknown): UpdaterEvent | null {
	const info = asRecord(payload);
	switch (name) {
		case "checking-for-update":
			return { type: "checking" };
		case "update-available":
			return {
				type: "available",
				version: normalizeVersion(info?.version) ?? "",
				notes: info?.releaseNotes ?? null,
			};
		case "update-not-available":
			return { type: "up-to-date", version: normalizeVersion(info?.version) };
		case "download-progress":
			return {
				type: "progress",
				percent: typeof info?.percent === "number" ? (info.percent as number) : undefined,
				transferred: info?.transferred as number | undefined,
				total: info?.total as number | undefined,
				bytesPerSecond: info?.bytesPerSecond as number | undefined,
			};
		case "update-downloaded":
			return { type: "downloaded", version: normalizeVersion(info?.version) };
		case "update-cancelled":
			return { type: "cancelled" };
		case "error": {
			const error = payload instanceof Error ? payload : asRecord(payload);
			const message =
				error instanceof Error ? error.message : typeof error?.message === "string" ? error.message : String(payload);
			return { type: "error", message };
		}
		default:
			return null;
	}
}

export function createUpdaterController(options: UpdaterControllerOptions): UpdaterController {
	const now = options.now ?? (() => Date.now());
	const log = options.log ?? (() => {});
	const timers = options.timers ?? {
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	const initialDelay = options.initialCheckDelayMs ?? 15_000;
	const interval = options.checkIntervalMs ?? 6 * 60 * 60 * 1000;
	const maxInterval = options.maxCheckIntervalMs ?? 24 * 60 * 60 * 1000;

	const prefs: UpdaterPrefs = { ...DEFAULT_UPDATER_PREFS, ...options.loadPrefs?.() };
	let adapter: UpdaterAdapter | null = options.adapter ?? null;
	let state = initialUpdaterState({
		currentVersion: options.currentVersion,
		mode: options.mode.mode,
		modeReason: options.mode.reason,
		skippedVersion: prefs.skipVersion,
		runtime: initialRuntimeUpdaterState({
			enabled: options.runtimeEnabled === true,
			currentVersion: options.runtimeCurrentVersion?.() ?? null,
		}),
	});
	let runtime: RuntimeChannel | null = null;
	let runtimeBusy = false;
	let cancelToken: UpdaterCancelToken | null = null;
	let timersRunning = false;
	let pendingTimer: unknown = null;
	let checkInFlight: Promise<boolean> | null = null;
	let downloadInFlight = false;
	let cancelRequested = false;
	let failures = 0;
	let disposed = false;

	const publish = () => {
		try {
			options.publish(state);
		} catch (error) {
			log(`[updater] 广播更新状态失败：${(error as Error).message}`);
		}
	};

	const apply = (event: UpdaterEvent) => {
		const next = reduceUpdater(state, event, now());
		if (next === state) return;
		state = next;
		publish();
	};

	const handleAdapterEvent = (name: string, payload: unknown) => {
		const event = eventFor(name, payload);
		if (!event) return;
		apply(event);
	};

	const persistPrefs = () => {
		try {
			options.savePrefs?.({ ...prefs });
		} catch (error) {
			log(`[updater] 保存更新偏好失败：${(error as Error).message}`);
		}
	};

	const scheduleNext = (delay: number) => {
		if (disposed || !timersRunning) return;
		if (pendingTimer !== null) timers.clearTimeout(pendingTimer);
		pendingTimer = timers.setTimeout(
			() => {
				pendingTimer = null;
				void controller.check({ manual: false }).finally(() => {
					if (disposed || !timersRunning) return;
					const wait = failures === 0 ? interval : Math.min(interval * 2 ** failures, maxInterval);
					scheduleNext(wait);
				});
			},
			Math.max(1000, delay),
		);
		// 定时器不该拦住进程退出（Electron 主进程里其实无所谓，Node CLI 里很关键）。
		const handle = pendingTimer as { unref?: () => void };
		handle?.unref?.();
	};

	const controller: UpdaterController = {
		getState: () => state,
		attach(next) {
			adapter = next;
			if (!adapter) return;
			// 注意：事件订阅只发生在这里。构造时传进来的 adapter 也必须走这条路径，
			// 否则状态机收不到 update-available / download-progress（真实缺陷，实机探针抓到的）。
			// 只检查元数据、不自动下载：用户点「下载更新」才动网络（本地 feed 测试模式除外）。
			adapter.autoDownload = options.autoDownload === true;
			adapter.autoInstallOnAppQuit = state.mode === "auto";
			// 让 electron-updater 把 current..latest 之间每个 release 的说明都给出来。
			adapter.fullChangelog = true;
			for (const name of [
				"checking-for-update",
				"update-available",
				"update-not-available",
				"download-progress",
				"update-downloaded",
				"update-cancelled",
				"error",
			]) {
				adapter.on(name, (payload: unknown) => handleAdapterEvent(name, payload));
			}
		},
		async check({ manual = false, channel = "shell" } = {}) {
			if (channel === "runtime") {
				if (!runtime) return false;
				if (runtimeBusy) return false;
				runtimeBusy = true;
				try {
					return await runtime.engine.check();
				} finally {
					runtimeBusy = false;
				}
			}
			if (state.mode === "manual") return false;
			if (!adapter) {
				// 记为 auto 却拿不到 autoUpdater：包里的 electron-updater 没加载起来，别让面板一直停在 idle。
				apply({ type: "error", message: "electron-updater 未加载", code: "unknown" });
				return false;
			}
			if (downloadInFlight || state.phase === "downloading" || state.phase === "downloaded") return false;
			if (checkInFlight) return checkInFlight;
			// 手动检查就是「现在就查」：清掉退避计数，失败也从下一个正常间隔重新算。
			if (manual) failures = 0;
			apply({ type: "checking" });
			const task = (async () => {
				try {
					await adapter.checkForUpdates();
					failures = 0;
					return true;
				} catch (error) {
					failures += 1;
					// autoUpdater 通常已经发过 error 事件；这里只补上「事件没来」的情况。
					if (state.phase === "checking" || state.phase === "idle") {
						apply({
							type: "error",
							message: error instanceof Error ? error.message : String(error),
							code: classifyUpdaterError(error),
						});
					} else {
						log(`[updater] 检查失败：${(error as Error).message}`);
					}
					return false;
				} finally {
					checkInFlight = null;
					if (manual && state.phase === "checking") apply({ type: "up-to-date" });
				}
			})();
			checkInFlight = task;
			return task;
		},
		async download({ channel = "shell" } = {}) {
			if (channel === "runtime") {
				if (!runtime) return false;
				if (runtimeBusy) return false;
				runtimeBusy = true;
				try {
					return await runtime.engine.download();
				} finally {
					runtimeBusy = false;
				}
			}
			if (state.mode === "manual" || !adapter) return false;
			if (downloadInFlight || state.phase === "downloading") return false;
			if (!state.targetVersion) return false;
			downloadInFlight = true;
			cancelRequested = false;
			cancelToken = options.createCancelToken?.() ?? null;
			apply({ type: "progress", percent: 0 });
			try {
				await adapter.downloadUpdate(cancelToken ?? undefined);
				if (state.phase !== "downloaded") apply({ type: "downloaded", version: state.targetVersion });
				return true;
			} catch (error) {
				// 用户自己取消导致的 rejection 不是错误：别把面板染成红字。
				if (!cancelRequested && state.phase !== "downloaded") {
					apply({ type: "error", message: error instanceof Error ? error.message : String(error) });
				}
				return false;
			} finally {
				downloadInFlight = false;
				cancelRequested = false;
				cancelToken = null;
			}
		},
		cancelDownload({ channel = "shell" } = {}) {
			if (channel === "runtime") return runtime?.engine.cancel() ?? false;
			if (!cancelToken) return false;
			const token = cancelToken;
			cancelToken = null;
			cancelRequested = true;
			apply({ type: "cancelled" });
			token.cancel();
			return true;
		},
		async applyRuntime() {
			if (!runtime) return false;
			if (runtimeBusy) return false;
			runtimeBusy = true;
			try {
				const ok = await runtime.engine.apply(runtime.applySwitch);
				// 切换成功后 current 已写进状态机（done 事件），这里只补一次实时读，防指针被别人改过。
				if (ok) {
					const current = runtime.currentVersion?.() ?? state.runtime.currentVersion;
					state = { ...state, runtime: { ...state.runtime, currentVersion: normalizeVersion(current) } };
					publish();
				}
				return ok;
			} finally {
				runtimeBusy = false;
			}
		},
		attachRuntime(channel) {
			runtime = channel;
			const current = channel?.currentVersion?.() ?? options.runtimeCurrentVersion?.() ?? null;
			state = {
				...state,
				runtime: {
					...state.runtime,
					enabled: Boolean(channel),
					phase: channel ? (state.runtime.phase === "disabled" ? "idle" : state.runtime.phase) : "disabled",
					currentVersion: normalizeVersion(current),
				},
			};
			publish();
		},
		pushRuntimeEvent(event) {
			apply({ type: "runtime", event });
		},
		skip(version) {
			prefs.skipVersion = normalizeVersion(version);
			persistPrefs();
			apply({ type: "skipped", version: prefs.skipVersion });
		},
		quitAndInstall() {
			if (!adapter || state.phase !== "downloaded") return false;
			adapter.quitAndInstall(false, true);
			return true;
		},
		start() {
			if (disposed || timersRunning) return;
			timersRunning = true;
			scheduleNext(initialDelay);
		},
		dispose() {
			disposed = true;
			timersRunning = false;
			if (pendingTimer !== null) timers.clearTimeout(pendingTimer);
			pendingTimer = null;
		},
	};
	// 构造时就给了 adapter 的调用方（探针 / 测试）不该再有一次「忘了 attach」的坑。
	if (adapter) controller.attach(adapter);
	return controller;
}
