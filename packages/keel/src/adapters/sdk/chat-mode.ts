import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ServerLang } from "../../i18n.js";
import { withDelegationGate, withPlanModeGate } from "../../tool-guards.js";
import type { OpenedSession } from "./session-opener.js";

/**
 * 模式开关在内核侧要的那两件东西，都长在 SDK 上，所以收在这一个适配器里（宿主不认 SDK）：
 * - **转录句柄**：会话转录里 `plan/mode` / `delegate/mode` 条目是重启后唯一能读回来的真值，
 *   而写它要 `SessionManager`；宿主只拿到这个窄面，不拿整份 `AgentSession`。
 * - **写工具门禁**：`withPlanModeGate` / `withDelegationGate` 的类型是 SDK `ToolDefinition`，
 *   只有这一层能碰；调用方（app）拿到的仍是 `unknown[]`。
 *
 * 门禁的判定是**执行期**的 thunk（不是构造期常量）：模式开关翻一次，已经注册好的工具下一次
 * 调用立刻按新值拦/放行——这正是「只改状态不出门禁」的反面。
 */
export interface ChatModeTranscript {
	/** SDK `SessionManager`：`readPlanModeFromSession` / `appendModeEntry` 的入参形状。 */
	readonly manager: unknown;
	/** 让 SDK 重新组装系统提示词（模式正文由宿主的 composer 决定，内核只负责触发）。 */
	reload?(): Promise<void>;
}

/** 会话 → 转录窄面；会话还没开 / 已退役 / 拿不到条目树时返回 `undefined`（调用方按失败处理）。 */
export function chatModeTranscriptOf(
	opened: OpenedSession | undefined,
	/** reload 之后跑一次（SDK 重载会把全部自定义工具重新激活，门控必须在这之后重放）。 */
	afterReload?: () => void,
): ChatModeTranscript | undefined {
	const session = opened?.session as unknown as Partial<Pick<AgentSession, "sessionManager" | "reload">> | undefined;
	const manager = session?.sessionManager;
	if (!manager || typeof manager.appendCustomEntry !== "function") return undefined;
	const reload = session?.reload;
	if (typeof reload !== "function") return { manager };
	return {
		manager,
		reload: async () => {
			try {
				await reload.call(session);
			} finally {
				afterReload?.();
			}
		},
	};
}

export interface ChatModeGateOptions {
	/** 本条对话现在是不是计划模式（执行期求值）。 */
	planMode(): boolean;
	/** 本条对话现在是不是审查者模式（执行期求值）。 */
	delegateMode(): boolean;
	getLang(): ServerLang;
}

/**
 * 给一批工具定义套上两层模式门禁。顺序与老树逐字一致（外 delegate、内 plan）：
 * 审查者模式的拒绝文案先出，计划模式在里层兜底。
 */
export function withChatModeGates(tools: readonly unknown[], options: ChatModeGateOptions): unknown[] {
	return tools.map((tool) =>
		withDelegationGate(
			withPlanModeGate(tool as ToolDefinition, options.planMode, options.getLang),
			options.delegateMode,
			options.getLang,
		),
	);
}
