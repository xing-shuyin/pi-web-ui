import { useCallback, useEffect, useRef, useState } from "react";
import { isDesktopShell, type DesktopShellWindow } from "./desktop.js";

const DESKTOP_REPO = "xing-shuyin/pi-web-ui";

/** 运行时通道（双层模型的 L2）在渲染层的样子；旧壳没这个字段 → 面板不显示这一段。 */
export interface DesktopRuntimeUpdaterState {
	enabled: boolean;
	phase:
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
	currentVersion: string | null;
	targetVersion: string | null;
	percent: number;
	transferred: number;
	total: number;
	errorCode: string | null;
	error: string | null;
	checkedAt: number | null;
}

/** 主进程更新状态机的快照（desktop/updater.ts 的 UpdaterState，字段一一对应）。 */
export interface DesktopUpdaterState {
	mode: "auto" | "manual";
	modeReason: "ready" | "dev" | "portable" | "no-feed" | "forced";
	phase: "idle" | "checking" | "available" | "downloading" | "downloaded" | "up-to-date" | "error";
	currentVersion: string;
	targetVersion: string | null;
	releasesBehind: number;
	notes: { version: string; markdown: string }[];
	notesCut: boolean;
	percent: number;
	transferred: number;
	total: number;
	bytesPerSecond: number;
	skippedVersion: string | null;
	errorCode: "network" | "feed" | "permission" | "disk" | "signature" | "unknown" | null;
	error: string | null;
	checkedAt: number | null;
	releasesUrl: string;
	runtime?: DesktopRuntimeUpdaterState;
}

/** 旧桌面壳广播的增量事件形状：新渲染层照样认，避免「壳没更新、界面先更新」时面板失灵。 */
export interface LegacyDesktopUpdaterEvent {
	state: "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "error";
	version?: string | null;
	percent?: number;
	message?: string;
}

export interface DesktopUpdaterBridge {
	getState?: () => Promise<unknown>;
	check: (options?: { manual?: boolean; channel?: "shell" | "runtime" }) => Promise<unknown>;
	download: (channel?: "shell" | "runtime") => Promise<unknown>;
	cancel?: (channel?: "shell" | "runtime") => Promise<unknown>;
	skip?: (version: string | null) => Promise<unknown>;
	quitAndInstall: () => Promise<unknown>;
	applyRuntime?: () => Promise<unknown>;
	/** MSI 本地安装（FilesInUse 绕行）：旧壳没有该方法时面板不显示按钮。 */
	installLocalMsi?: () => Promise<unknown>;
	onEvent: (cb: (msg: unknown) => void) => () => void;
}

/** 主进程 `pi-desktop:update-install-local-msi` 的返回：ok 时应用随即退出，无需处理后续状态。 */
export interface MsiQuitInstallResult {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
}

/** 主进程返回校验：形状不对（旧壳 / 半截数据）一律按失败处理。 */
export function parseMsiQuitInstallResult(raw: unknown): MsiQuitInstallResult {
	if (!raw || typeof raw !== "object") return { ok: false, error: "bad-response" };
	const record = raw as Record<string, unknown>;
	if (record.ok === true) return { ok: true };
	return {
		ok: false,
		cancelled: record.cancelled === true ? true : undefined,
		error: typeof record.error === "string" ? record.error : "unknown error",
	};
}

const PHASES = new Set(["idle", "checking", "available", "downloading", "downloaded", "up-to-date", "error"]);
const RUNTIME_PHASES = new Set([
	"disabled",
	"idle",
	"checking",
	"available",
	"downloading",
	"staged",
	"applying",
	"done",
	"up-to-date",
	"error",
]);
const ERROR_CODES = new Set(["network", "feed", "permission", "disk", "signature", "unknown"]);
const MODE_REASONS = new Set(["ready", "dev", "portable", "no-feed", "forced"]);

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim().replace(/^v/i, "") : null;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function notes(value: unknown): { version: string; markdown: string }[] {
	if (!Array.isArray(value)) return [];
	const out: { version: string; markdown: string }[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const record = item as { version?: unknown; markdown?: unknown };
		if (typeof record.markdown !== "string" || !record.markdown.trim()) continue;
		out.push({
			version: typeof record.version === "string" ? record.version.replace(/^v/i, "") : "",
			markdown: record.markdown,
		});
	}
	return out;
}

/** 运行时通道快照：字段不全（旧壳）就整段不显示，不做半截渲染。 */
export function parseRuntimeUpdaterState(raw: unknown): DesktopRuntimeUpdaterState | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const phase = typeof record.phase === "string" && RUNTIME_PHASES.has(record.phase) ? record.phase : null;
	if (!phase) return null;
	return {
		enabled: record.enabled === true,
		phase: phase as DesktopRuntimeUpdaterState["phase"],
		currentVersion: str(record.currentVersion),
		targetVersion: str(record.targetVersion),
		percent: Math.max(0, Math.min(100, Math.round(num(record.percent)))),
		transferred: num(record.transferred),
		total: num(record.total),
		errorCode: typeof record.errorCode === "string" ? record.errorCode : null,
		error: typeof record.error === "string" ? record.error : null,
		checkedAt: typeof record.checkedAt === "number" && Number.isFinite(record.checkedAt) ? record.checkedAt : null,
	};
}

/** 把主进程快照校验成渲染层类型；形状不对（旧壳 / 半截数据）返回 null。 */
export function parseUpdaterState(raw: unknown): DesktopUpdaterState | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const phase = typeof record.phase === "string" && PHASES.has(record.phase) ? record.phase : null;
	const currentVersion = str(record.currentVersion);
	if (!phase || !currentVersion) return null;
	const mode = record.mode === "manual" ? "manual" : "auto";
	const modeReason =
		typeof record.modeReason === "string" && MODE_REASONS.has(record.modeReason)
			? (record.modeReason as DesktopUpdaterState["modeReason"])
			: "ready";
	const errorCode =
		typeof record.errorCode === "string" && ERROR_CODES.has(record.errorCode)
			? (record.errorCode as DesktopUpdaterState["errorCode"])
			: null;
	return {
		mode,
		modeReason,
		phase: phase as DesktopUpdaterState["phase"],
		currentVersion,
		targetVersion: str(record.targetVersion),
		releasesBehind: num(record.releasesBehind),
		notes: notes(record.notes),
		notesCut: record.notesCut === true,
		percent: Math.max(0, Math.min(100, Math.round(num(record.percent)))),
		transferred: num(record.transferred),
		total: num(record.total),
		bytesPerSecond: num(record.bytesPerSecond),
		skippedVersion: str(record.skippedVersion),
		errorCode,
		error: typeof record.error === "string" ? record.error : null,
		checkedAt: typeof record.checkedAt === "number" && Number.isFinite(record.checkedAt) ? record.checkedAt : null,
		releasesUrl: typeof record.releasesUrl === "string" ? record.releasesUrl : desktopReleasesUrl(null),
		runtime: parseRuntimeUpdaterState(record.runtime) ?? undefined,
	};
}

/** 旧壳的增量事件 → 新快照字段（只补出该事件能确定的那些字段）。 */
export function legacyUpdaterPatch(event: unknown): Partial<DesktopUpdaterState> | null {
	if (!event || typeof event !== "object") return null;
	const record = event as Partial<LegacyDesktopUpdaterEvent>;
	switch (record.state) {
		case "checking":
			return { phase: "checking", error: null, errorCode: null };
		case "available":
			return {
				phase: "available",
				targetVersion: str(record.version),
				percent: 0,
				error: null,
				errorCode: null,
				releasesUrl: desktopReleasesUrl(str(record.version)),
			};
		case "up-to-date":
			return { phase: "up-to-date", percent: 0, error: null, errorCode: null };
		case "downloading":
			return { phase: "downloading", percent: Math.max(0, Math.min(100, Math.round(num(record.percent)))) };
		case "downloaded":
			return { phase: "downloaded", percent: 100, error: null, errorCode: null };
		case "error":
			return { phase: "error", percent: 0, error: record.message ?? "unknown error", errorCode: "unknown" };
		default:
			return null;
	}
}

export function getDesktopUpdaterBridge(win?: unknown): DesktopUpdaterBridge | null {
	if (!isDesktopShell(win)) return null;
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	const updater = (w as { piDesktop?: { updater?: DesktopUpdaterBridge } } | undefined)?.piDesktop?.updater;
	if (!updater || typeof updater.check !== "function" || typeof updater.download !== "function") return null;
	return updater;
}

export function desktopReleasesUrl(version: string | null | undefined): string {
	const v = str(version ?? null) ?? "";
	return v
		? `https://github.com/${DESKTOP_REPO}/releases/tag/v${v}`
		: `https://github.com/${DESKTOP_REPO}/releases/latest`;
}

/** 快照是否还有该提示的更新（忽略的版本不算）。 */
export function hasPendingUpdate(state: DesktopUpdaterState | null): boolean {
	if (!state) return false;
	if (state.phase !== "available" && state.phase !== "downloading" && state.phase !== "downloaded") return false;
	const target = state.targetVersion;
	return !target || target !== state.skippedVersion;
}

export interface DesktopUpdaterController {
	state: DesktopUpdaterState | null;
	/** 桥不存在 / 壳太旧时为 null。 */
	bridge: DesktopUpdaterBridge | null;
	/** 本次前端调用本身失败（IPC 通道挂了），与主进程的 error 状态分开。 */
	actionError: string | null;
	check: (options?: { manual?: boolean; channel?: "shell" | "runtime" }) => void;
	download: (channel?: "shell" | "runtime") => void;
	cancel: (channel?: "shell" | "runtime") => void;
	skip: (version: string | null) => void;
	quitAndInstall: () => void;
	/** 「立即重启服务」：切换指针 + 重启 + 健康检查（失败自动回滚）。 */
	applyRuntime: () => void;
	/** 「退出并安装本地 MSI」：用户取消选包时返回 {ok:false, cancelled:true}；ok 时应用随即退出。 */
	installLocalMsi: () => Promise<MsiQuitInstallResult>;
	refresh: () => void;
}

export function useDesktopUpdater(): DesktopUpdaterController {
	const [bridge] = useState<DesktopUpdaterBridge | null>(() => getDesktopUpdaterBridge());
	const [state, setState] = useState<DesktopUpdaterState | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	/** 拉一次快照：面板打开、窗口重新加载后都能立刻回到「已发现 / 已下载」的真实状态。 */
	const refresh = useCallback(() => {
		if (!bridge?.getState) return;
		bridge
			.getState()
			.then((raw) => {
				const snapshot = parseUpdaterState(raw);
				// 只用快照补「还没有状态」的情况：慢网络下 getState 可能比广播晚到，
				// 让它覆盖已经推进到 downloaded 的状态就成了回退。
				if (snapshot && mounted.current) setState((prev) => prev ?? snapshot);
			})
			.catch(() => {});
	}, [bridge]);

	useEffect(() => {
		if (!bridge) return;
		refresh();
		return bridge.onEvent((msg) => {
			const snapshot = parseUpdaterState(msg);
			if (snapshot) {
				setActionError(null);
				setState(snapshot);
				return;
			}
			const patch = legacyUpdaterPatch(msg);
			if (!patch) return;
			setState((prev) => (prev ? { ...prev, ...patch } : null));
		});
	}, [bridge, refresh]);

	const run = useCallback(
		(fn: (bridge: DesktopUpdaterBridge) => Promise<unknown>) => {
			if (!bridge) return;
			setActionError(null);
			const pending = fn(bridge);
			if (!pending || typeof pending.catch !== "function") return;
			pending.catch((err: unknown) => {
				if (!mounted.current) return;
				setActionError(err instanceof Error ? err.message : String(err));
			});
		},
		[bridge],
	);

	// 下面这些只负责「发出去」：状态一律等主进程广播回来。
	// 本地先乐观改 phase 会出事——比如 main 因为正在下载而拒绝这次检查，就没人再广播，
	// 面板会永远停在「正在检查」。渲染层不猜业务状态。
	const check = useCallback(
		(options: { manual?: boolean; channel?: "shell" | "runtime" } = {}) => run((b) => b.check(options)),
		[run],
	);
	const download = useCallback((channel: "shell" | "runtime" = "shell") => run((b) => b.download(channel)), [run]);
	const cancel = useCallback(
		(channel: "shell" | "runtime" = "shell") => run((b) => b.cancel?.(channel) ?? Promise.resolve(false)),
		[run],
	);
	const skip = useCallback((version: string | null) => run((b) => b.skip?.(version) ?? Promise.resolve(false)), [run]);
	const quitAndInstall = useCallback(() => run((b) => b.quitAndInstall()), [run]);
	const applyRuntime = useCallback(() => run((b) => b.applyRuntime?.() ?? Promise.resolve(false)), [run]);
	// MSI 安装走返回值（ok 即退出），不走广播状态：失败才有文案，成功直接显示「正在退出并安装」。
	const installLocalMsi = useCallback(async (): Promise<MsiQuitInstallResult> => {
		if (!bridge?.installLocalMsi) return { ok: false, error: "no-bridge" };
		try {
			return parseMsiQuitInstallResult(await bridge.installLocalMsi());
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}, [bridge]);

	return {
		state,
		bridge,
		actionError,
		check,
		download,
		cancel,
		skip,
		quitAndInstall,
		applyRuntime,
		installLocalMsi,
		refresh,
	};
}
