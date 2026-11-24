import type { ServerMessage } from "../../protocol.js";
import type { BashKills } from "./bash-kills.js";

/**
 * 中止后补进对话的那句系统说明（老实现 `agent-service.ts` 逐字，中英各一份）。
 * 命令本身已经由 SDK 以「Command aborted」的结果回报模型，这句只是把「是用户手动停的」说清楚。
 */
export const ABORT_BASH_NOTE =
	"（系统：用户手动停止了刚才的 bash 命令——命令被中止，终止前已输出的内容在对应工具结果里。请据此继续，不要重跑被中止的命令，除非确实必要。）";

/** `abortBash` 用到的那几个现成东西：帧出口、快照、当前对话、唯一喂轮出口。 */
export interface AbortBashDeps {
	/** 出帧：两条 info notice（没有在跑的命令 / 已停止）。 */
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	/** 要中止哪条对话：`conversationId ?? 当前活跃对话`。 */
	activeConversationId(): string | undefined;
	/** 唯一喂轮出口（老实现 `deliverFromOutside`）：把系统说明交回这条对话。 */
	deliverNote(conversationId: string, text: string): Promise<void>;
}

/**
 * 停掉某条对话当前正在跑的 bash 命令（对话继续），逐字照搬老实现 `ClientSession.abortBash`：
 *
 * 1. 解析对话（`conversationId ?? 当前活跃对话`）→ 取该对话的中止桶；
 * 2. 桶空 = **info notice「当前没有正在运行的 bash 命令」** + flush 快照就结束（不是错、不假成功）；
 * 3. 桶非空 = 逐个 abort（SDK 在 signal 中止时杀进程树）→ info notice「已停止 bash 命令（对话继续）」
 *    → 走唯一喂轮出口投递系统说明 → flush 快照。
 *
 * 老实现只吞「投递系统说明」那一段异常（`try {} catch {}`），其余照常；这里保持同口径：
 * 投递失败不影响「命令已停」这个事实与那两条 notice。
 */
export async function abortBashCommand(kills: BashKills, deps: AbortBashDeps, conversationId?: string): Promise<void> {
	// 与老实现逐字同口径：`conversationId ?? 当前活跃对话`（空字符串不去猜主人）。
	const target = conversationId ?? deps.activeConversationId();
	if (kills.abort(target) === 0) {
		deps.emit({
			type: "notice",
			level: "info",
			text: "当前没有正在运行的 bash 命令",
			textEn: "No bash command is running",
		});
		deps.flushSnapshot();
		return;
	}
	deps.emit({
		type: "notice",
		level: "info",
		text: "已停止 bash 命令（对话继续）",
		textEn: "Bash command stopped (conversation continues)",
	});
	if (target) {
		try {
			await deps.deliverNote(target, ABORT_BASH_NOTE);
		} catch {
			// 老实现同口径：投递失败（对话已换代 / 轮次已收尾）不打断停止流程。
		}
	}
	deps.flushSnapshot();
}
