import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ClockPort } from "../../contracts/ports.js";
import type {
	UiBridgeCallResult,
	UiBridgePort,
	UiDialogValue,
	UiPhoneCallRequest,
	UiPageCallRequest,
} from "../../contracts/ui-bridge.js";
import type { ServerMessage } from "../../protocol.js";
import { ENGINE_CATALOG } from "../../engine-catalog.js";
import { PendingCallTable } from "./pending-calls.js";
import { normalizePageCallTimeoutMs, normalizePhoneBridgeTimeoutMs } from "./timeout.js";

const PAGE_ABORTED = "页面调用已中止（browser_page aborted）。";
const PHONE_ABORTED = "手机操控已中止（phone aborted）。";
const PAGE_NO_CLIENT =
	"没有已连接的 pi-web-ui 页面（no browser connected）。请打开 pi-web-ui 页面，并确认 page-picker 扩展已启用且已与该页面配对。";
const PHONE_NO_CLIENT = "没有已连接的手机客户端（no phone connected）。请在手机上打开 pi，并确认无障碍服务已开启。";
const PAGE_FAILED = "浏览器操作失败（no error message from the page）";
const PHONE_FAILED = "手机操作失败（no error message）";
const PAGE_DISCONNECTED = "连接已断开，挂起中的页面调用已取消（connection closed）。";
const PHONE_DISCONNECTED = "连接已断开，挂起中的手机操控已取消（connection closed）。";
const PAGE_CONVERSATION_CLOSED = "会话已关闭，页面调用已取消（conversation closed）。";
const PHONE_CONVERSATION_CLOSED = "会话已关闭，手机操控已取消（conversation closed）。";

const pageTimeout = (ms: number): string =>
	`${Math.round(ms / 1000)} 秒内没有收到浏览器响应（timeout ${ms}ms）。请确认 pi-web-ui 页面已打开且 page-picker 扩展已启用。`;
const phoneTimeout = (ms: number): string =>
	`${Math.round(ms / 1000)} 秒内没有收到手机响应（timeout ${ms}ms）。请确认 pi 手机端在前台且无障碍服务已开启。`;

export interface UiBridgeHandlersOptions {
	/** 宿主 UI 桥（dialog/overlay 挂起表 + CLI 安装 + 探针）；缺省 = 该能力未接（5 个 handler 同步抛）。 */
	uiBridge?: () => UiBridgePort | undefined;
	/** 帧出口（`page_request` / `phone_request` / notice / `install_result`）。 */
	emit(msg: ServerMessage): void;
	/** 连接是否已断：断了就没人在页面上执行（等价老实现的 `sinks.size === 0`）。 */
	isClosed(): boolean;
	/** 定时器端口（挂起表的超时）。 */
	clock: ClockPort;
	/** 这条对话还在不在：回包晚到时按它判归属，不把结果送进已关闭的对话。 */
	isConversationAlive(conversationId: string): boolean;
	/** 当前对话（调用方没给归属时的兜底）。 */
	activeConversationId(): string | undefined;
	/** 出完帧后刷新快照（装完 CLI 时 `env.piAgentInstalled` 已变）。 */
	flushSnapshot(): void;
}

/**
 * UI 桥的 8 个分发面成员。签名与 `DispatchSession` 的同名成员一致；
 * `phoneCall` / `settleConversationCalls` / `dispose` 是**面外**成员（给接线方与工具用）。
 */
export interface UiBridgeHandlers {
	resolveDialog(id: number, value: UiDialogValue): void;
	handleTuiOverlayInput(id: number, data: string): void;
	handleTuiOverlayResize(id: number, cols: number, rows: number): void;
	handleTuiOverlayCancel(id: number): void;
	installPiAgent(): Promise<void>;
	pageCall(req: UiPageCallRequest, signal: { aborted?: boolean }, conversationId?: string): Promise<UiBridgeCallResult>;
	resolvePageCall(id: string, ok: boolean, result?: unknown, error?: string): void;
	resolvePhoneCall(id: string, ok: boolean, result?: unknown, error?: string): void;
	/** 面外：手机操控的**发起端**（`DispatchSession` 没有这个成员，谁的 phone 工具谁调它）。 */
	phoneCall(
		req: UiPhoneCallRequest,
		signal: { aborted?: boolean },
		conversationId?: string,
	): Promise<UiBridgeCallResult>;
	/** 面外：会话被停止 / 关闭时定点结算它的挂起（老实现 `settlePendingsForConv` 同一口径）。 */
	settleConversationCalls(conversationId: string, reason?: string): number;
	/** 面外：断开 / 运行时 dispose —— 挂起表全清，dialog 与 overlay 全取消。 */
	dispose(): void;
}

/**
 * UI 桥的内核实现。**分三类，边界要认准**：
 *
 * 1. **dialog / overlay（4 个）**：挂起表在宿主（`server/webui-context.ts` 用的就是内核这两张表的实例，
 *    扩展通过 SDK 面开出来的 dialog 与浏览器回包因此是**同一份表**）。内核 handler 只按 id 转发，
 *    所以这里出现的错误只有一种：宿主没注入端口 → `CoreEngineNotReadyError`。
 * 2. **页面 / 手机调用（3 个）**：挂起表**归内核**（超时 / 断开 / 会话停止三道闸都在内核，
 *    见 `PendingCallTable`），不需要宿主端口 —— 帧直接发给这个客户端的连接。
 * 3. **`installPiAgent`**：跑 `npm i -g` 的进程、Windows `cmd.exe` 包装、探针失效全在宿主端口后面；
 *    内核只出 notice + `install_result` + 刷新快照。
 */
export function createUiBridgeHandlers(options: UiBridgeHandlersOptions): UiBridgeHandlers {
	const pages = new PendingCallTable({ prefix: "p-", clock: options.clock, timeoutError: pageTimeout });
	const phones = new PendingCallTable({ prefix: "ph-", clock: options.clock, timeoutError: phoneTimeout });

	const port = (member: string): UiBridgePort => {
		const target = options.uiBridge?.();
		if (!target) throw new CoreEngineNotReadyError(`dispatch.${member}`);
		return target;
	};

	/** 归属：调用方显式给的对话优先，否则挂到当前对话上（会话停止时才有得定点结算）。 */
	const ownerOf = (conversationId?: string): string | undefined => conversationId ?? options.activeConversationId();

	const alive = (conversationId: string | undefined): boolean =>
		conversationId === undefined || options.isConversationAlive(conversationId);

	/** 回包：归属不对（对话已关）时**不**把结果送进去，改成把它结算成失败。 */
	const settleCall = (table: PendingCallTable, id: string, result: UiBridgeCallResult, ownerClosed: string): void => {
		const owner = table.conversationOf(id);
		if (owner !== undefined && !options.isConversationAlive(owner)) {
			table.settle(id, { ok: false, error: ownerClosed });
			return;
		}
		table.settle(id, result);
	};

	/**
	 * 安装：**端口在第一个 await 之前解析**（所以这里不是 `async` 方法：未注入时必须同步抛，
	 * 而不是变成一个 rejected promise —— wire 层的 `CoreEngineNotReadyError` 兜底是靠同步抛的）。
	 */
	const installPiAgentWith = async (target: UiBridgePort): Promise<void> => {
		options.emit({
			type: "notice",
			level: "info",
			text: `正在安装 pi agent CLI（${ENGINE_CATALOG.pi.installCommand}）…`,
			textEn: `Installing pi agent CLI (${ENGINE_CATALOG.pi.installCommand})…`,
		});
		try {
			const result = await target.installCli();
			const output = result.output;
			if (result.ok) {
				options.emit({
					type: "notice",
					level: "info",
					text: "✅ pi agent CLI 安装完成。填入 API 密钥即可开始，或在终端运行 pi 完成登录。",
					textEn: "✅ pi agent CLI installed. Enter an API key to start, or run pi in a terminal to log in.",
				});
				options.emit({ type: "install_result", ok: true, detail: "" });
			} else {
				options.emit({
					type: "notice",
					level: "error",
					text: `pi agent 安装失败（${result.code ?? "timeout"}）：${output.slice(0, 400)}`,
					textEn: `pi agent install failed (${result.code ?? "timeout"}): ${output.slice(0, 400)}`,
				});
				options.emit({ type: "install_result", ok: false, detail: output.slice(0, 600) });
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			options.emit({
				type: "notice",
				level: "error",
				text: `pi agent 安装失败：${detail}`,
				textEn: `pi agent install failed: ${detail}`,
			});
			options.emit({ type: "install_result", ok: false, detail: detail.slice(0, 600) });
		}
		// 探针失效是宿主端口的事（缓存归它）；这里只把「装完了」这件事推给快照。
		options.flushSnapshot();
	};

	return {
		resolveDialog(id: number, value: UiDialogValue): void {
			port("resolveDialog").dialogs.resolve(id, value);
		},

		handleTuiOverlayInput(id: number, data: string): void {
			port("handleTuiOverlayInput").overlays.input(id, data);
		},

		handleTuiOverlayResize(id: number, cols: number, rows: number): void {
			port("handleTuiOverlayResize").overlays.resize(id, cols, rows);
		},

		handleTuiOverlayCancel(id: number): void {
			port("handleTuiOverlayCancel").overlays.cancel(id);
		},

		installPiAgent(): Promise<void> {
			return installPiAgentWith(port("installPiAgent"));
		},

		pageCall(req: UiPageCallRequest, signal: { aborted?: boolean }, conversationId?: string) {
			if (signal?.aborted) return Promise.resolve<UiBridgeCallResult>({ ok: false, error: PAGE_ABORTED });
			if (options.isClosed()) return Promise.resolve<UiBridgeCallResult>({ ok: false, error: PAGE_NO_CLIENT });
			const owner = ownerOf(conversationId);
			if (!alive(owner)) return Promise.resolve<UiBridgeCallResult>({ ok: false, error: PAGE_CONVERSATION_CLOSED });
			return new Promise<UiBridgeCallResult>((resolve) => {
				const timeoutMs = normalizePageCallTimeoutMs(req.timeoutMs);
				const id = pages.arm({ timeoutMs, ...(owner === undefined ? {} : { conversationId: owner }), resolve });
				options.emit({ type: "page_request", id, op: req.op, args: req.args, target: req.target, timeoutMs });
			});
		},

		resolvePageCall(id: string, ok: boolean, result?: unknown, error?: string): void {
			settleCall(
				pages,
				id,
				ok ? { ok: true, result } : { ok: false, error: error?.trim() || PAGE_FAILED },
				PAGE_CONVERSATION_CLOSED,
			);
		},

		resolvePhoneCall(id: string, ok: boolean, result?: unknown, error?: string): void {
			settleCall(
				phones,
				id,
				ok ? { ok: true, result } : { ok: false, error: error?.trim() || PHONE_FAILED },
				PHONE_CONVERSATION_CLOSED,
			);
		},

		phoneCall(req: UiPhoneCallRequest, signal: { aborted?: boolean }, conversationId?: string) {
			if (signal?.aborted) return Promise.resolve<UiBridgeCallResult>({ ok: false, error: PHONE_ABORTED });
			if (options.isClosed()) return Promise.resolve<UiBridgeCallResult>({ ok: false, error: PHONE_NO_CLIENT });
			const owner = ownerOf(conversationId);
			if (!alive(owner)) return Promise.resolve<UiBridgeCallResult>({ ok: false, error: PHONE_CONVERSATION_CLOSED });
			return new Promise<UiBridgeCallResult>((resolve) => {
				const timeoutMs = normalizePhoneBridgeTimeoutMs(req.timeoutMs);
				const id = phones.arm({ timeoutMs, ...(owner === undefined ? {} : { conversationId: owner }), resolve });
				options.emit({ type: "phone_request", id, op: req.op, args: req.args, timeoutMs });
			});
		},

		settleConversationCalls(conversationId: string, reason?: string): number {
			const pageError = reason ?? "会话已重置或停止，挂起中的页面调用已取消。";
			const phoneError = reason ?? "会话已重置或停止，挂起中的手机操控已取消。";
			return (
				pages.settleForConversation(conversationId, pageError) +
				phones.settleForConversation(conversationId, phoneError)
			);
		},

		dispose(): void {
			pages.settleAll(PAGE_DISCONNECTED);
			phones.settleAll(PHONE_DISCONNECTED);
			const target = options.uiBridge?.();
			// 断开时不制造新错误：端口没接就没有 dialog/overlay 可清。
			if (!target) return;
			target.dialogs.cancelAll();
			target.overlays.cancelAll();
		},
	};
}
