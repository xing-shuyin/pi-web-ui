import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MessageEditSession, TurnAgentMessage, TurnCustomMessage, TurnEntry } from "../../contracts/turns.js";
import { uiMessageId, type AgentMessage } from "../../serialize.js";

/**
 * 包装所需的 SDK 面：条目树（`SessionManager`）+ 会话上那几个动作。宿主直接交出 `AgentSession`，
 * 单测只需给出这几项（不需要真的起一个 agent）。
 */
export type EditSessionHost = Pick<
	AgentSession,
	| "isStreaming"
	| "sessionFile"
	| "sessionManager"
	| "abort"
	| "clearQueue"
	| "reload"
	| "refreshContext"
	| "sendCustomMessage"
> &
	Partial<
		Pick<AgentSession, "messages" | "model" | "isRetrying" | "waitForIdle" | "thinkingLevel" | "setThinkingLevel">
	>;

function toTurnEntry(entry: SessionEntry): TurnEntry {
	const edit = entry as { targetId?: string; replacement?: unknown };
	return {
		id: entry.id,
		type: entry.type,
		parentId: entry.parentId,
		...(entry.type === "message" ? { message: entry.message } : {}),
		...("customType" in entry && typeof entry.customType === "string" ? { customType: entry.customType } : {}),
		...("display" in entry && typeof entry.display === "boolean" ? { display: entry.display } : {}),
		...(typeof edit.targetId === "string" ? { targetId: edit.targetId } : {}),
		...("replacement" in entry ? { replacement: edit.replacement } : {}),
	};
}

/**
 * 把 SDK 会话包成消息编辑窄面。条目树的能力（截断 / 隐藏 / 分叉 / 重算上下文）逐项对应
 * `SessionManager` 的公开方法；这里不写编排——删哪些条目、往哪儿分叉都在 `domains/turns/`。
 */
export function createSessionEditor(host: EditSessionHost): MessageEditSession {
	const manager = host.sessionManager;
	return {
		get sessionFile(): string | undefined {
			return host.sessionFile;
		},
		get isStreaming(): boolean {
			return host.isStreaming;
		},
		get model(): unknown {
			return host.model;
		},
		get thinkingLevel(): string {
			return host.thinkingLevel ?? "off";
		},
		abort: () => host.abort(),
		clearQueue: () => void host.clearQueue(),
		waitForIdle: () => host.waitForIdle?.() ?? Promise.resolve(),
		isRetrying: () => host.isRetrying === true,
		sessionToken: () => host,
		setThinkingLevel: (level) => host.setThinkingLevel?.(level as Parameters<AgentSession["setThinkingLevel"]>[0]),
		agentMessages: (): readonly TurnAgentMessage[] => host.messages ?? [],
		contextEntries: () => manager.buildContextEntries().map(toTurnEntry),
		branchEntries: () => manager.getBranch().map(toTurnEntry),
		entry: (id) => {
			const entry = manager.getEntry(id);
			return entry ? toTurnEntry(entry) : undefined;
		},
		leafId: () => manager.getLeafId(),
		/**
		 * 与出帧投影同源：`view.ts` 的 `projectSessionMessages()` 按 `session.messages` 的扁平下标出 id，
		 * 这里按同一条投影（`buildSessionProjection()`）的下标重算，两处编号不会漂。
		 */
		uiIds: () => {
			const ids = new Map<string, string>();
			let index = 0;
			for (const projected of manager.buildSessionProjection().entries) {
				for (const message of projected.messages) {
					ids.set(projected.sourceEntry.id, uiMessageId(message as AgentMessage, index));
					index += 1;
				}
			}
			return ids;
		},
		hideEntry: (targetId) => void manager.appendContextEdit(targetId, null),
		branch: (fromId) => manager.branch(fromId),
		resetLeaf: () => manager.resetLeaf(),
		appendCustomEntry: (customType, data) => void manager.appendCustomEntry(customType, data),
		rebuildMessages: () => host.refreshContext(),
		reload: () => host.reload(),
		// 只有真的有文件才谈得上「回滚」：没有文件时按老口径不动（不能把内存树当文件重读）。
		restoreSessionFile: (sessionFile) => {
			if (sessionFile) manager.setSessionFile(sessionFile);
		},
		sendCustomMessage: (message: TurnCustomMessage, options) =>
			host.sendCustomMessage(
				{
					customType: message.customType,
					content: message.content as Parameters<EditSessionHost["sendCustomMessage"]>[0]["content"],
					display: message.display,
					details: message.details,
				},
				// `deliverAs: "nextTurn"`（附件 asides）必须原样透过去：落成旁注而不是独立回合。
				options,
			),
	};
}
