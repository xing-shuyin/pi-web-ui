import type { ServerMessage, SandboxInfo, UiState, WorktreeInfo } from "../../protocol.js";
import type { SnapshotConversationView, SnapshotEnvView, SnapshotView } from "../../contracts/snapshot-view.js";
import type { SnapshotBuilders, SnapshotDeltaFrame, SnapshotFrame } from "./publisher.js";

const EMPTY_STATS: UiState["stats"] = {
	totalMessages: 0,
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	cost: 0,
	contextUsage: { tokens: null, contextWindow: 0, percent: null },
};

/** 空对话也能出合法帧：域没接上的字段一律给「空值」而不是省略，客户端不用做缺字段兜底。 */
export function buildSnapshotState(rev: number, env: SnapshotEnvView, conv: SnapshotConversationView | null): UiState {
	const base: UiState = {
		clientId: env.clientId,
		cwd: env.cwd,
		sessionId: conv?.sessionId ?? "",
		conversationId: conv?.conversationId ?? "",
		rev,
		messages: [],
		streamingMessage: null,
		isStreaming: false,
		model: null,
		thinkingLevel: "off",
		availableThinkingLevels: [],
		queue: { steering: [], followUp: [] },
		tools: [],
		version: env.settingsVersion,
		piConfigured: env.piConfigured,
		piAgentInstalled: env.piAgentInstalled,
		stats: EMPTY_STATS,
	};
	if (!conv)
		return {
			...base,
			workspaceRoots: env.workspaceRoots ? [...env.workspaceRoots] : undefined,
			...sandboxAndWorktree(env),
		};
	return {
		...base,
		...(env.workspaceRoots ? { workspaceRoots: [...env.workspaceRoots] } : {}),
		...(env.homeDir ? { homeDir: env.homeDir } : {}),
		...(env.desktopDir ? { desktopDir: env.desktopDir } : {}),
		...(env.capabilities ? { engineCapabilities: env.capabilities } : {}),
		...(conv.sessionFile ? { sessionFile: conv.sessionFile } : {}),
		// 临时对话标记：老实现 `isEphemeral` 每帧都带（提示条据此渲染），缺省 `false` 不省略。
		isEphemeral: conv.isEphemeral === true,
		// 计数投影：视图给了就用（宿主认得分类 / 软上限），没给就回落空值（`EMPTY_STATS`）。
		stats: conv.stats ?? EMPTY_STATS,
		messages: [...conv.messages],
		streamingMessage: conv.streamingMessage,
		isStreaming: conv.isStreaming,
		model: conv.model,
		thinkingLevel: conv.thinkingLevel,
		availableThinkingLevels: [...conv.availableThinkingLevels],
		queue: {
			steering: [...conv.steering],
			followUp: [...conv.followUp],
			...(conv.queueEntries ? { entries: conv.queueEntries } : {}),
		},
		...(conv.errorMessage ? { errorMessage: conv.errorMessage } : {}),
		...(conv.agentPreset ? { agentPreset: conv.agentPreset } : {}),
		permission: conv.permission ?? null,
		planMode: conv.delegateMode !== undefined ? conv.planMode === true : false,
		delegateMode: conv.delegateMode === true,
		delegateConvId: conv.delegateConvId ?? null,
		...(conv.draft ? { draft: conv.draft } : {}),
		...(conv.pendingApprovals && conv.pendingApprovals.length > 0 ? { pendingApprovals: conv.pendingApprovals } : {}),
		...sandboxAndWorktree(env),
		tools: [...conv.tools],
	};
}

/** 沙盒 / 工作树：两个字段在协议里都是可空值，没值就不写键（旧帧形状逐字不变）。 */
function sandboxAndWorktree(env: SnapshotEnvView): { sandbox?: SandboxInfo | null; worktree?: WorktreeInfo | null } {
	return {
		...(env.sandbox !== undefined ? { sandbox: env.sandbox } : {}),
		...(env.worktree !== undefined ? { worktree: env.worktree } : {}),
	};
}

/**
 * 全量帧永远可出；增量帧要等消息窗口域接上才有 `appended`，
 * 在那之前降级为全量 `snapshot`（协议合法、不丢消息），不做「假装增量」。
 */
export function createSnapshotBuilders(getView: () => SnapshotView): SnapshotBuilders {
	const full = (frame: SnapshotFrame): ServerMessage => ({
		type: "snapshot",
		state: buildSnapshotState(frame.rev, getView().env, getView().conversation),
	});
	return {
		full,
		delta: (frame: SnapshotDeltaFrame): ServerMessage => full({ ...frame, reason: frame.reason }),
	};
}
