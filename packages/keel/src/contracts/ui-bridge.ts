/**
 * UI 桥（dialog / 虚拟 TUI overlay / 页面调用 / 手机调用 / pi CLI 安装）的窄面。
 *
 * **这里只放 DTO**：SDK 的 `ExtensionUIContext`、`pi-tui` 的 `Component` / `OverlayHandle` 一律不进内核——
 * 内核认的是「挂起一条 → 按 id 兑现」「登记一个输入回路 → 按 id 喂键」这两件事，渲染与终端在宿主。
 * 挂起表的实现是内核的（`domains/ui-bridge/`），宿主的老实现 `server/webui-context.ts` 复用同一份。
 */

/** 一次挂起调用的结果：失败也带原因，工具侧直接把它当错误文案（老实现同口径）。 */
export type UiBridgeCallResult = { ok: true; result?: unknown } | { ok: false; error: string };

/** 页面调用请求（字段与 `page_request` 帧的载荷一致，去掉内核自己发的 `id`）。 */
export interface UiPageCallRequest {
	op: string;
	args?: Record<string, unknown>;
	target?: string;
	timeoutMs?: number;
}

/** 手机操控请求（字段与 `phone_request` 帧的载荷一致）。 */
export interface UiPhoneCallRequest {
	op: string;
	args?: Record<string, unknown>;
	timeoutMs?: number;
}

export type UiDialogKind = "select" | "confirm" | "input";

/** dialog 的回包：字符串（select / input）、布尔（confirm）、`null`（取消 / 断开）。 */
export type UiDialogValue = string | boolean | null;

/** dialog 附带的风险代码块（前端有折叠 + 高亮，内核只透传）。 */
export interface UiDialogCode {
	content: string;
	language?: string;
	hasRisk?: boolean;
}

export interface UiDialogOpenOptions {
	code?: UiDialogCode;
}

/**
 * 虚拟 TUI overlay 的宿主句柄窄面（SDK `OverlayHandle` 的最小子集）：
 * 内核只按 id 路由输入，句柄归宿主（`server/virtual-tui.ts` 的 `VirtualTuiBridge`）。
 */
export interface UiOverlayHandle {
	hide(): void;
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	unfocus(): void;
	isFocused(): boolean;
}

/** overlay 的输入回路：三条路由都按 id 打到宿主那个 bridge 上。 */
export interface UiOverlaySink {
	feedInput(data: string): void;
	resize(cols: number, rows: number): void;
	cancel(): void;
}

/**
 * dialog 挂起表。**一个客户端一份**（id 只在一份表里唯一，前端回包只带 id），
 * 生产端是扩展（`select` / `confirm` / `input`），回包端是 `resolveDialog`。
 */
export interface UiDialogSurface {
	/** 挂起一条并等回包；headless（子代理 / 后台会话）立刻 `null`，不依赖浏览器。 */
	open(
		kind: UiDialogKind,
		title: string,
		args: readonly unknown[],
		options?: UiDialogOpenOptions,
	): Promise<UiDialogValue>;
	/** 兑现并出 `dialog_closed`；没有这条 id 就是空操作（重复回包 / 已取消）。 */
	resolve(id: number, value: UiDialogValue): void;
	/** 断开 / 关对话：把所有挂起的 dialog 兑现成 `null`（漏一条就是一个永不 settle 的 Promise）。 */
	cancelAll(): number;
	pending(): readonly { id: number; kind: UiDialogKind }[];
}

/** overlay 路由表：id 分配 + 按 id 喂输入 / 改尺寸 / 取消。 */
export interface UiOverlaySurface {
	/** 分配 id 并登记输入回路（id 由内核发，宿主把它塞进 `tui_overlay_open` 帧）。 */
	register(sink: UiOverlaySink): number;
	/** 摘掉一条（宿主自己关闭时调；`cancel` 也会摘）。 */
	remove(id: number): boolean;
	input(id: number, data: string): void;
	resize(id: number, cols: number, rows: number): void;
	cancel(id: number): void;
	/** 会话结束 / 断开：把所有 overlay 取消掉（否则宿主的组件与监听会一直挂着）。 */
	cancelAll(): number;
	size(): number;
}

/** `npm i -g <pi 包名>`（包名单源：`engine-catalog.ts`）的结果：内核只出帧，进程与退出码归宿主。 */
export interface UiCliInstallResult {
	ok: boolean;
	/** 退出码；起不来 / 超时为 `null`。 */
	code: number | null;
	/** `stdout + stderr` 原文（截断由宿主决定，内核只按长度再切一次）。 */
	output: string;
}

/** `env.piConfigured` / `env.piAgentInstalled` 的真值：宿主探测（内核不读盘、不看 PATH）。 */
export interface UiCliProbe {
	piConfigured: boolean;
	piAgentInstalled: boolean;
}

/**
 * 宿主侧的 UI 桥端口。
 *
 * - `dialogs` / `overlays`：**内核实现、宿主复用**（`server/webui-context.ts` 里的 `pendingDialogs` /
 *   `activeTuiOverlays` 换成这两张表，SDK 面留在宿主）。内核的 4 个 handler 只是按 id 转发，
 *   所以扩展开出来的 dialog 与浏览器回包走的是**同一份表**。
 * - `installCli` / `probe`：真值是宿主环境（npm 全局目录、PATH、auth.json），内核不猜；
 *   装完的探针失效也归宿主（缓存是它自己的）。
 */
export interface UiBridgePort {
	readonly dialogs: UiDialogSurface;
	readonly overlays: UiOverlaySurface;
	installCli(): Promise<UiCliInstallResult>;
	probe(): UiCliProbe;
}
