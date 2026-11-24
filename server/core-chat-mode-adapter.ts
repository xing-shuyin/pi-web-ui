import type { ChatModePort } from "../packages/keel/src/contracts/goals.js";
import type { ChatModeTranscript } from "../packages/keel/src/adapters/sdk/chat-mode.js";
import type { ChatModeKind } from "../packages/keel/src/domains/tools/index.js";
import { delegateNoticeText } from "../packages/keel/src/delegate-mode.js";
import { planModeNoticeText } from "../packages/keel/src/plan-mode.js";
import type { ServerMessage } from "./protocol.js";
import {
	appendModeEntry,
	modeEntryReceipt,
	MODE_ENTRY_TYPES,
	readDelegateModeFromSession,
	readPlanModeFromSession,
	type ModeReceipt,
} from "./chat-mode-entries.js";

/**
 * 宿主侧 `ChatModePort`：计划模式 / 审查者模式的开关，三处真值一次落齐（少一处就是假开关）。
 *
 * 1. **转录模式条目**（重启后能恢复）：`appendModeEntry` 写 `plan/mode` / `delegate/mode`，
 *    会话（重新）打开时 `restore()` 把它读回运行态 —— 读写都是 `chat-mode-entries.ts` 那一份；
 * 2. **写工具门禁**（本适配器的 `setMode`）：内核 `ChatModeState` 是门禁 thunk 的唯一数据源，
 *    翻一次状态，已经注册好的 `bash` / `write` / `edit` 下一次调用立刻按新值拦/放行；
 * 3. **提示词重载**：`session.reload()` 让 SDK 重新组装系统提示词（模式正文由宿主的 composer 决定）。
 *
 * 顺序是硬约束（#968）：条目先落盘 → 再翻门禁 → 公告 → 刷快照 → 重载提示词。
 * 写不进去就**保持旧值**并如实告知：绝不出现「界面已切、写工具还放行」。
 * 本适配器不抛：`set_plan_mode` 的派发是 `void cs.setPlanMode?.(…)`，reject 只会变成没人接的告警。
 */
export interface CoreChatModeSinks {
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	/** 该对话已经开着的会话（同步；`restore()` 用，没开会话就什么都不做）。 */
	transcriptOf(conversationId?: string): ChatModeTranscript | undefined;
	/** 该对话的会话句柄（没开就开一个）：开关要写转录条目，所以必须先有会话。 */
	ensureTranscript(conversationId?: string): Promise<ChatModeTranscript | undefined>;
	/** 门禁 + 快照的唯一切换点（工具执行期读的就是它写进去的那一份）。 */
	setMode(kind: ChatModeKind, enabled: boolean, conversationId?: string): void;
}

export function createCoreChatModePort(sinks: CoreChatModeSinks): ChatModePort {
	const announce = (receipt: ModeReceipt): void => {
		sinks.emit({ type: "notice", level: receipt.level, text: receipt.text, textEn: receipt.textEn });
	};
	const switchedNotice = (kind: ChatModeKind, enabled: boolean): { text: string; textEn: string } =>
		kind === "plan" ? planModeNoticeText(enabled) : delegateNoticeText(enabled);

	const apply = async (kind: ChatModeKind, enabled: boolean, conversationId?: string): Promise<void> => {
		// 开会话失败（退役中 / 不可开）= 拿不到转录，按「写不进去」处理：不动内存。
		const transcript = await sinks.ensureTranscript(conversationId).catch(() => undefined);
		const persisted = appendModeEntry(transcript?.manager, MODE_ENTRY_TYPES[kind], { enabled });
		if (!transcript || persisted === "failed") {
			announce(modeEntryReceipt(kind, "failed"));
			sinks.flushSnapshot();
			return;
		}
		sinks.setMode(kind, enabled, conversationId);
		const notice = switchedNotice(kind, enabled);
		announce({ level: "info", text: notice.text, textEn: notice.textEn });
		if (persisted === "transient") announce(modeEntryReceipt(kind, "transient"));
		sinks.flushSnapshot();
		// 流式 / 压缩中 SDK 会拒绝 reload：老口径同样是尽力而为（模式状态与门禁已经生效）。
		try {
			await transcript.reload?.();
		} catch {}
	};

	return {
		setPlanMode: (enabled: boolean, conversationId?: string) => apply("plan", enabled, conversationId),
		setDelegateMode: (enabled: boolean, conversationId?: string) => apply("delegate", enabled, conversationId),
		restore(conversationId?: string): void {
			const transcript = sinks.transcriptOf(conversationId);
			if (!transcript) return;
			sinks.setMode("plan", readPlanModeFromSession(transcript.manager), conversationId);
			sinks.setMode("delegate", readDelegateModeFromSession(transcript.manager), conversationId);
		},
	};
}
