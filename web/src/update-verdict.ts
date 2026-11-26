import type { DesktopRuntimeUpdaterState, DesktopUpdaterState } from "./desktop-updater";
import type { MessageKey } from "./i18n/catalog";
import type { UpdateAllItem } from "./use-chat";

/**
 * 更新中心的**唯一结论源**。
 *
 * 背景（issue 起源）：旧面板把「哪些东西可以更新」和「它们各自归谁维护」当成一件事，
 * 于是桌面壳里同时出现「已是最新 v0.122.0」和「pi-web-ui v0.121.3 → v0.122.0」——
 * 因为壳版本（主进程）、内核版本（`getAppVersion()`，即运行时载荷）、npm registry
 * 是**三条版本轴**，却只渲染了一个结论。
 *
 * 本模块把它们拆成互斥的通道：
 * - `shell`   应用（Electron 安装包，主进程）
 * - `runtime` 运行时（**就是这份 pi-web-ui**：服务端 + 前端；桌面壳下走 L2 通道）
 * - `webui`   Web 界面（网页 / CLI 形态下的 npm 全局包；与 runtime 互斥，永不同屏）
 * - `core`    pi 引擎（@earendil-works/pi-coding-agent）
 * - 其余 `updatesAll` 项 → 组件（插件 / 全局包 / Git 扩展）
 *
 * 规则：**pi-web-ui 只出现一次**。桌面壳下它只占 runtime 轴，`updatesAll` 里那条
 * `kind: "webui"` 只作为版本兜底输入，不进入组件列表。
 */

export type UpdateTone = "ok" | "warn" | "err" | "muted";

export type UpdateAxisState =
	| "idle"
	| "checking"
	| "available"
	| "downloading"
	| "ready"
	| "applying"
	| "latest"
	| "error"
	| "manual"
	| "bundled"
	| "disabled";

export type UpdateAxisId = "shell" | "runtime" | "webui" | "core";

export interface UpdateAxis {
	id: UpdateAxisId;
	/** 标题 key（`updatesAxis*`）。 */
	labelKey: MessageKey;
	/** 说明 key：告诉用户这条通道归谁维护。 */
	noteKey: MessageKey;
	current: string | null;
	target: string | null;
	state: UpdateAxisState;
	tone: UpdateTone;
	percent: number;
	transferred: number;
	total: number;
	bytesPerSecond: number;
	/** 运行时 / 壳专有：错误码（由组件按 `updateDesktopErr*` / `updateDesktopRuntimeErr*` 取文案）。 */
	errorCode: string | null;
	error: string | null;
	checkedAt: number | null;
	/** 该轴当前可执行的动作；`null` = 只能看，不能点。 */
	action: UpdateAxisAction | null;
	/** 用户已「忽略此版本」：仍显示状态，但不计入 badge / 小黄点。 */
	skipped?: boolean;
}

export type UpdateAxisAction =
	| "check"
	| "check-runtime"
	| "download"
	| "download-runtime"
	| "cancel"
	| "cancel-runtime"
	| "install"
	| "install-runtime"
	| "manual"
	| "npm";

export interface UpdateCenter {
	/** 整体结论（顶部一句话）。 */
	tone: UpdateTone;
	titleKey: MessageKey;
	titleVars?: Record<string, string | number>;
	subKey: MessageKey;
	subVars?: Record<string, string | number>;
	/** 主按钮；`null` 表示当前没有可执行的一步（比如正在检查）。`axisId` 把动作绑回具体通道。 */
	primary: {
		key: MessageKey;
		vars?: Record<string, string | number>;
		action: UpdateAxisAction;
		axisId?: UpdateAxisId;
	} | null;
	/** 通道轴，按「优先级 = 用户最该先处理的」排序。 */
	axes: UpdateAxis[];
	/** 组件（插件 / 全局包 / Git 扩展），已剔除 webui 与 pi-core。 */
	components: UpdateAllItem[];
	/** 可操作的更新项数量：顶栏 badge 与弹窗结论必须同源。 */
	pendingCount: number;
	/** 有任意「可下载 / 待安装 / 可更新」项时为 true：顶栏小黄点用它。 */
	hasPending: boolean;
}

export interface UpdateCenterInput {
	/** `isDesktopShell()`：形态判定只认这一个来源。 */
	inDesktopShell: boolean;
	/** 主进程快照；非桌面壳 / 桥不存在时 null。 */
	desktop: DesktopUpdaterState | null;
	/** IPC 通道本身失败（与主进程 error 状态分开）。 */
	desktopActionError?: string | null;
	/** npm 通道的 pi-web-ui 自查结果（`chat.update`）。 */
	update: { current: string; latest: string | null; upToDate: boolean; error?: string } | null;
	/** 全量组件清单（`chat.updatesAll`）。 */
	updatesAll: UpdateAllItem[] | null;
	/** pi 引擎的运行时信息（随包自带 / 全局更新的那份）。 */
	updatesSdk: { running: string; bundledInUse: boolean; newerInstalled: string | null } | null;
}

/** 不是「组件」的 kind：webui 归轴（避免与运行时重复），pi-core 单独成轴。 */
const NON_COMPONENT_KINDS = new Set<UpdateAllItem["kind"]>(["webui", "pi-core"]);

export function isComponentItem(item: UpdateAllItem): boolean {
	return !NON_COMPONENT_KINDS.has(item.kind);
}

/** 组件是否有可执行的更新（出错 / 最新都不算）。 */
export function componentActionable(item: UpdateAllItem): boolean {
	return !item.error && !item.upToDate && Boolean(item.latest);
}

function axisTone(state: UpdateAxisState): UpdateTone {
	switch (state) {
		case "available":
		case "downloading":
		case "ready":
		case "applying":
			return "warn";
		case "error":
			return "err";
		case "manual":
		case "bundled":
		case "disabled":
		case "idle":
		case "checking":
			return "muted";
		default:
			return "ok";
	}
}

function shellAxis(desktop: DesktopUpdaterState | null): UpdateAxis | null {
	if (!desktop) return null;
	const base: Omit<UpdateAxis, "state" | "tone" | "action"> = {
		id: "shell",
		labelKey: "updatesAxisShell",
		noteKey: "updatesAxisShellNote",
		current: desktop.currentVersion || null,
		target: desktop.targetVersion,
		percent: desktop.percent,
		transferred: desktop.transferred,
		total: desktop.total,
		bytesPerSecond: desktop.bytesPerSecond,
		errorCode: desktop.errorCode,
		error: desktop.error,
		checkedAt: desktop.checkedAt,
	};
	// 便携版 / 开发态 / 无更新源：壳装不上，只能去发布页换包（不是「按钮禁用」，是根本没有按钮）。
	if (desktop.mode === "manual") {
		const state: UpdateAxisState = "manual";
		return { ...base, target: desktop.targetVersion, state, tone: axisTone(state), action: "manual" };
	}
	switch (desktop.phase) {
		case "checking":
			return { ...base, state: "checking", tone: axisTone("checking"), action: null };
		case "available": {
			const skipped = desktop.targetVersion !== null && desktop.targetVersion === desktop.skippedVersion;
			return {
				...base,
				state: "available",
				tone: axisTone("available"),
				// 被跳过的版本仍显示，但主按钮换成「重新检查」，由组件里给「取消跳过」。
				// 被跳过的版本仍显示（可以恢复提醒），但不能再算作「待处理」。
				action: skipped ? "check" : "download",
				skipped,
			};
		}
		case "downloading":
			return { ...base, state: "downloading", tone: axisTone("downloading"), action: "cancel" };
		case "downloaded":
			return { ...base, state: "ready", tone: axisTone("ready"), action: "install" };
		case "up-to-date":
			return { ...base, target: null, state: "latest", tone: axisTone("latest"), action: "check" };
		case "error":
			return { ...base, state: "error", tone: axisTone("error"), action: "check" };
		default:
			return { ...base, state: "idle", tone: axisTone("idle"), action: "check" };
	}
}

function runtimeAxis(runtime: DesktopRuntimeUpdaterState | undefined, input: UpdateCenterInput): UpdateAxis | null {
	if (!runtime) return null;
	const base: Omit<UpdateAxis, "state" | "tone" | "action"> = {
		id: "runtime",
		labelKey: "updateDesktopRuntimeTitle",
		noteKey: "updatesAxisRuntimeNote",
		current: runtime.currentVersion,
		target: runtime.targetVersion,
		percent: runtime.percent,
		transferred: runtime.transferred,
		total: runtime.total,
		bytesPerSecond: 0,
		errorCode: runtime.errorCode,
		error: runtime.error,
		checkedAt: runtime.checkedAt,
	};
	if (!runtime.enabled) {
		// npm-global 权威链下，桌面壳不再自更新 `<userData>/runtime`，运行时轴直接投影全局 npm 包的更新状态。
		const globalPkg = webuiAxis(input);
		if (globalPkg) {
			return {
				...globalPkg,
				id: "runtime",
				labelKey: "updateDesktopRuntimeTitle",
			};
		}
		return { ...base, target: null, state: "bundled", tone: axisTone("bundled"), action: null };
	}
	switch (runtime.phase) {
		case "checking":
			return { ...base, state: "checking", tone: axisTone("checking"), action: null };
		case "available":
			return { ...base, state: "available", tone: axisTone("available"), action: "download-runtime" };
		case "downloading":
			return { ...base, state: "downloading", tone: axisTone("downloading"), action: "cancel-runtime" };
		case "staged":
			return { ...base, state: "ready", tone: axisTone("ready"), action: "install-runtime" };
		case "applying":
			return { ...base, state: "applying", tone: axisTone("applying"), action: null };
		case "done":
		case "up-to-date":
			return { ...base, target: null, state: "latest", tone: axisTone("latest"), action: "check-runtime" };
		case "error":
			return { ...base, state: "error", tone: axisTone("error"), action: "check-runtime" };
		case "disabled":
			return { ...base, target: null, state: "disabled", tone: axisTone("disabled"), action: null };
		default:
			return { ...base, target: null, state: "idle", tone: axisTone("idle"), action: "check-runtime" };
	}
}

/** 网页 / CLI 形态：pi-web-ui 的更新走 npm，它就是「Web 界面」这条轴。 */
function webuiAxis(input: UpdateCenterInput): UpdateAxis | null {
	const update = input.update;
	const item = input.updatesAll?.find((entry) => entry.kind === "webui");
	const current = update?.current ?? item?.current ?? null;
	if (!current) return null;
	const base: Omit<UpdateAxis, "state" | "tone" | "action"> = {
		id: "webui",
		labelKey: "updatesAxisWebui",
		noteKey: "updatesAxisWebuiNote",
		current,
		target: update?.latest ?? item?.latest ?? null,
		percent: 0,
		transferred: 0,
		total: 0,
		bytesPerSecond: 0,
		errorCode: null,
		error: update?.error ?? item?.error ?? null,
		checkedAt: null,
	};
	if (base.error) return { ...base, state: "error", tone: axisTone("error"), action: "check" };
	if (update === null && !item) return { ...base, state: "checking", tone: axisTone("checking"), action: null };
	if (update && !update.upToDate && update.latest) {
		return { ...base, state: "available", tone: axisTone("available"), action: "npm" };
	}
	return { ...base, target: null, state: "latest", tone: axisTone("latest"), action: "check" };
}

function coreAxis(input: UpdateCenterInput): UpdateAxis | null {
	const item = input.updatesAll?.find((entry) => entry.kind === "pi-core");
	const sdk = input.updatesSdk;
	// 引擎有三种“该看一眼”的情形：清单里有新版；机器上装了比运行中更新的全局 pi；
	// 当前用的是随包自带那份（可以装个全局引擎跟上）。
	const split = sdk?.newerInstalled ?? null;
	const bundledNoRow = !item && sdk?.bundledInUse === true;
	if (!item && !split && !bundledNoRow) return null;
	const current = item?.current ?? sdk?.running ?? null;
	const target = item && !item.error && !item.upToDate ? item.latest : null;
	const base: Omit<UpdateAxis, "state" | "tone" | "action"> = {
		id: "core",
		labelKey: "updatesAxisCore",
		noteKey: "updatesAxisCoreNote",
		current,
		// 只有真能装的版本才当 target；“装了更新的全局 pi”只是提示，不变成一个可点按钮
		// （`npm i -g pi@latest` 修不了服务正在跑的那份）。
		target,
		percent: 0,
		transferred: 0,
		total: 0,
		bytesPerSecond: 0,
		errorCode: null,
		error: item?.error ?? null,
		checkedAt: null,
	};
	if (item?.error) return { ...base, state: "error", tone: axisTone("error"), action: null };
	if (target) return { ...base, state: "available", tone: axisTone("available"), action: "npm" };
	// 没有 pi-core 行但有随包自带的引擎：给一个「安装全局引擎」入口（否则这条信息无处可点）。
	const installEntry = !item && sdk?.bundledInUse ? "npm" : null;
	return {
		...base,
		target: null,
		state: "latest",
		// split（装了更新的全局 pi）虽然是最新，但仍然是「需要处理」的 warn
		tone: split ? "warn" : axisTone("latest"),
		action: installEntry,
	};
}

/**
 * 三份数据源（壳快照 / npm 自查 / 组件清单）→ 一个结论 + 一组轴。
 *
 * 这里是「唯一判定点」：顶栏 badge、顶栏小黄点、弹窗标题、弹窗主按钮全部读它，
 * 任何一处要改结论都只改这里，不再让组件各自算一遍。
 */
export function resolveUpdateCenter(input: UpdateCenterInput): UpdateCenter {
	const axes: UpdateAxis[] = [];
	const shell = input.inDesktopShell ? shellAxis(input.desktop) : null;
	if (shell) axes.push(shell);
	if (input.inDesktopShell) {
		const runtime = runtimeAxis(input.desktop?.runtime, input);
		if (runtime) axes.push(runtime);
	} else {
		const webui = webuiAxis(input);
		if (webui) axes.push(webui);
	}
	const core = coreAxis(input);
	if (core) axes.push(core);

	const components = (input.updatesAll ?? []).filter(isComponentItem);
	const componentPending = components.filter(componentActionable).length;
	// 轴上的「可操作」：可下载 / 待安装 / 可 npm 更新。错误与「手动」不算 badge 计数（没有可点的下一步）。
	const axisPending = axes.filter(
		(axis) =>
			!axis.skipped &&
			(axis.state === "available" ||
				axis.state === "downloading" ||
				axis.state === "ready" ||
				axis.state === "applying"),
	).length;
	const pendingCount = axisPending + componentPending;

	// 主表面 = 用户最先看到的那条轴（壳 / Web 界面）：它的错误才顶到总标题。
	const main = axes[0] ?? null;
	const mainError = main?.state === "error";
	const manual = main?.state === "manual";

	let tone: UpdateTone = "ok";
	let titleKey: MessageKey = "updatesVerdictLatest";
	let subKey: MessageKey = "updatesVerdictLatestSub";
	let titleVars: Record<string, string | number> | undefined;
	let subVars: Record<string, string | number> | undefined = { n: axes.length + components.length };
	let primary: UpdateCenter["primary"] = null;

	if (manual) {
		tone = "muted";
		titleKey = "updatesVerdictManual";
		subKey = componentPending > 0 ? "updatesVerdictManualComponentsSub" : "updatesVerdictManualSub";
		primary =
			componentPending > 0
				? { key: "updatesActionUpdateComponents", action: "npm" }
				: { key: "updateDesktopManual", action: "manual" };
	} else if (mainError) {
		tone = "err";
		titleKey = "updatesVerdictError";
		subKey = "updatesVerdictErrorSub";
		primary = { key: "updateDesktopRetry", action: "check" };
	} else if (axes.some((axis) => axis.state === "downloading" || axis.state === "applying")) {
		// 「正在下载」优先于「有 N 项可更新」：否则一按下载，标题又退回「有更新可用」。
		tone = "warn";
		const busy = axes.find((axis) => axis.state === "downloading" || axis.state === "applying")!;
		titleKey = "updatesVerdictWorking";
		titleVars = { percent: busy.percent };
		subKey = "updatesVerdictWorkingSub";
		primary = { key: "cancel", action: busy.action ?? "cancel", axisId: busy.id };
	} else if (pendingCount > 0) {
		tone = "warn";
		titleKey = "updatesVerdictAvailable";
		titleVars = { n: pendingCount };
		subKey = input.inDesktopShell ? "updatesVerdictAvailableSubShell" : "updatesVerdictAvailableSubWeb";
		subVars = input.inDesktopShell ? undefined : { n: componentPending };
		// 主按钮落到第一个「有下一步」的轴：壳优先，其次运行时，再其次组件。
		const first =
			axes.find(
				(axis) =>
					!axis.skipped &&
					(axis.state === "available" ||
						axis.state === "ready" ||
						axis.state === "downloading" ||
						axis.state === "applying"),
			) ?? null;
		primary = first
			? {
					key:
						first.action === "install"
							? "updateDesktopInstall"
							: first.action === "install-runtime"
								? "updatesActionInstallRuntime"
								: first.action === "npm"
									? "updateBtn"
									: first.action === "download-runtime" || first.action === "download"
										? "updateBtn"
										: first.action === "cancel" || first.action === "cancel-runtime"
											? "cancel"
											: "updateBtn",
					action: first.action as UpdateAxisAction,
					axisId: first.id,
				}
			: componentPending > 0
				? { key: "updatesActionUpdateComponents", action: "npm" }
				: null;
	} else if (axes.some((axis) => axis.state === "checking")) {
		tone = "muted";
		titleKey = "updatesVerdictChecking";
		subKey = "updatesVerdictCheckingSub";
	}

	return {
		tone,
		titleKey,
		titleVars,
		subKey,
		subVars,
		primary,
		axes,
		components,
		pendingCount,
		hasPending: pendingCount > 0,
	};
}
