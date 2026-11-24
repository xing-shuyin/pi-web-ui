import type { AttachmentContext, AttachmentsPort } from "../../contracts/attachments.js";
import type { MessageEditSession } from "../../contracts/turns.js";
import type { PromptAttachment } from "../../protocol.js";

export interface AttachmentAsideInput {
	/** 附件端口；缺省 = 这条连接没有附件通道（调用方据此不静默丢）。 */
	port?: AttachmentsPort;
	/** 目标会话的编辑窄面（`sendCustomMessage` 只有它有）。 */
	editor?: MessageEditSession;
	ctx: AttachmentContext;
	attachments?: readonly PromptAttachment[];
	/** 附件没发出去时的说明口（缺省 = 不说话；调用方通常接 notice）。 */
	notice?(level: "warning", text: string, textEn: string): void;
}

/**
 * 把附件变成 aside 条目并**先落进会话**，再喂本轮提示词（老实现 `prompt()` 的顺序：
 * `asides` → `sendCustomMessage(deliverAs: "nextTurn")` → `runTurn(text)`）。
 *
 * 为什么必须 `deliverAs: "nextTurn"`：`<file>` 引用要进**这一轮**的上下文，但附件本身不是用户消息
 * （它是 `customType: "file"` 的旁注）。落成同一轮的旁注，模型看得见、转录里也是老形状；
 * 落成独立回合则会多跑一次模型请求。
 *
 * 顺序也不能反：先喂轮后落旁注，这一轮就看不到附件，旁注还会串到下一轮（回合中止时更明显）。
 */
export async function appendAttachmentAsides(input: AttachmentAsideInput): Promise<number> {
	const attachments = input.attachments ?? [];
	if (attachments.length === 0) return 0;
	if (!input.port || !input.editor) {
		// fail-closed 地说话：附件没有静默消失，用户知道正文发了、附件没发。
		input.notice?.(
			"warning",
			"附件未随这条消息发出：这条连接的附件通道未接线（消息正文已发送）。",
			"Attachments were not sent with this message: the attachment channel is not wired (the text was sent).",
		);
		return 0;
	}
	const asides = await input.port.build(input.ctx, attachments);
	for (const aside of asides) await input.editor.sendCustomMessage(aside, { deliverAs: "nextTurn" });
	return asides.length;
}
