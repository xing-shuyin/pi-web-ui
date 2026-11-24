import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AttachmentsPort } from "../packages/keel/src/contracts/attachments.js";
import type { TurnCustomMessage } from "../packages/keel/src/contracts/turns.js";
import type { ServerLang } from "./i18n.js";
import type { PromptAttachment } from "./protocol.js";
import { buildAttachmentMessages } from "./attachments.js";

/**
 * 宿主侧适配器：把 `server/attachments.ts` 的 `buildAttachmentMessages` 按 `AttachmentsPort` 的窄面交给内核。
 *
 * 结构直通：路径归一、大小/图片上限、上传落盘、引用区间、`<terminal-ref>`、视觉桥接全在宿主叶子里，
 * 内核只决定「什么时候落这批 aside」（`deliverAs: "nextTurn"`，见 `domains/turns/attachments.ts`）。
 *
 * 会话 / cwd / 设置**按调用取**（`ctx`）：同一个客户端换对话 / 换工作区之后，端口若记着构造期的旧值
 * 就会把附件发到错的对话里（`uploads` 目录也按 clientId 归组），所以这条端口连构造参数都不需要。
 *
 * 未接的一项：`resolveTerminal`（`mode: "terminal"` 的终端引用）需要**该对话的终端管理器**，
 * 那是组合根按对话持有的东西；没注入时这类附件按老实现的缺省分支处理（提示条已关闭/不存在）。
 */
export function createCoreAttachments(): AttachmentsPort {
	return {
		build: async (ctx, attachments): Promise<readonly TurnCustomMessage[]> => {
			const session = ctx.session as AgentSession | undefined;
			// 附件 asides 需要真会话（图片/视觉桥接要看当前模型）：没有就不伪造。
			if (!session) return [];
			const asides = await buildAttachmentMessages(
				{
					cwd: ctx.cwd,
					clientId: ctx.clientId,
					emit: (msg) => ctx.emit(msg),
					settings: ctx.settings,
					session,
					getLang: () => (ctx.getLang?.() ?? "zh") as ServerLang,
					...(ctx.resolveTerminal ? { resolveTerminal: (id: string) => ctx.resolveTerminal?.(id) } : {}),
				},
				attachments as PromptAttachment[],
			);
			return asides.map((one) => one.message as TurnCustomMessage);
		},
	};
}
