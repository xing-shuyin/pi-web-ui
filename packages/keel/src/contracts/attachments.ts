import type { PromptAttachment, ServerMessage, TerminalInfo } from "../protocol.js";
import type { TurnCustomMessage } from "./turns.js";
import type { ClientSettings } from "../settings-schema.js";

/**
 * 附件 asides 需要的、只有内核才知道的现场：**在调用点递进来**，端口不持有连接状态。
 *
 * 这些值全是「这一次 prompt 的现场」：换了对话 / 换了工作区 / 换了客户端都得跟着变，
 * 端口若在构造期把它们记下来就会串台（一个客户端的上传落到另一个客户端目录里）。
 */
export interface AttachmentContext {
	/** 这条连接是谁：上传落盘目录、按客户端归组的回执都按它算。 */
	clientId: string;
	/** 目标对话的 cwd（相对路径基准；远程工作区是 URI，会话目录分离是宿主知识）。 */
	cwd: string;
	/** 发一帧给这个客户端（端口内部的告警 notice 走它）。 */
	emit(msg: ServerMessage): void;
	/** 客户端设置（视觉桥接 / 上传上限读它）：设置存储的唯一写者是宿主，读口由内核递进来。 */
	settings: ClientSettings;
	/** 语言（提示词片段与 notice 的中英选择）。 */
	getLang?(): string;
	/** 目标会话（图片/视觉桥接要看当前模型：只有内核拿得到会话实体）。 */
	session?: unknown;
	/** 终端引用：按 id 现场拿这个 tab 的真相（宿主没接就不支持 `mode: "terminal"` 的附件）。 */
	resolveTerminal?(terminalId: string): TerminalInfo | undefined;
}

/**
 * 附件面（宿主能力）。
 *
 * 附件不是「把文件读成文本」这么简单：相对/绝对/远程路径归一、大小与图片上限、上传落盘、
 * 引用区间、`<terminal-ref>`、视觉桥接（用另一个模型描述图片）全在宿主叶子
 * `server/attachments.ts`（约 900 行）。内核不重写它，只在这个窄面上按一下：
 * 「把这一组附件变成一组 aside 消息」，然后由内核把它们落进会话（`deliverAs: "nextTurn"`）。
 *
 * 宿主侧适配器：`server/core-attachments-adapter.ts`。
 */
export interface AttachmentsPort {
	/**
	 * `attachments` → aside 消息（`customType: "file"` 等，与老实现 `buildAttachmentMessages` 逐字同形）。
	 * 一条附件一条（图片可能是多条）；返回空数组 = 这一组附件没有可下发的内容（实现自己发过告警）。
	 */
	build(ctx: AttachmentContext, attachments: readonly PromptAttachment[]): Promise<readonly TurnCustomMessage[]>;
}
