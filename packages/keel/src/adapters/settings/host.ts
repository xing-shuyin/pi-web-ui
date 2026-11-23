import type { ClientStateStore } from "../../../../../server/client-state.js";
import type { ServerMessage } from "../../../../../server/protocol.js";
import type { SettingsHost } from "../../../../../server/settings-service.js";

export interface SettingsHostInput {
	clientId: string;
	stateStore: ClientStateStore;
	emit: (msg: ServerMessage) => void;
	cwd: string;
	agentDir: string;
	isDisposed: boolean;
	isStreaming: boolean;
	getSession: () => unknown;
	/** 设置变更后要刷新的对话帧；新树的快照域在 W5 接上，缺省不发。 */
	flushSnapshot?: () => void;
}

/** 会话句柄类型从 `SettingsHost` 推导，避免适配器直接依赖 SDK（边界守卫只允许 turns/feed 与 adapters/sdk 碰它）。 */
type HostSession = ReturnType<SettingsHost["getSession"]>;

/**
 * 把 `SettingsHost` 收窄成「只认注入值」的适配器：设置叶子（`SettingsService`）不认识新树的会话实体，
 * 只拿到这里如实投影出来的成员。apply* / reload* 一律走空实现——对应域还没接，抛错会让 `push()` 炸。
 */
export function createSettingsHost(input: SettingsHostInput): SettingsHost {
	// 新树对应域未接，待 W5：apply* / reloadSession / promptSnapshot 只回安全空值，绝不抛。
	const notWired = (): void => {};
	return {
		clientId: input.clientId,
		stateStore: input.stateStore,
		emit: input.emit,
		flushSnapshot: () => input.flushSnapshot?.(),
		isDisposed: () => input.isDisposed,
		getSession: () => input.getSession() as HostSession,
		cwd: () => input.cwd,
		agentDir: () => input.agentDir,
		isStreaming: () => input.isStreaming,
		reloadSession: async () => {},
		applyRetryOverrides: notWired,
		applyQueueModes: notWired,
		applyCompactionOverrides: notWired,
		applyCodemodeOverrides: notWired,
		applySessionOverrides: notWired,
		applyToolGating: notWired,
		onGoalModeDisabled: notWired,
		onSessionsFilterChanged: notWired,
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
		getMcpServers: () => ({ servers: [], globalPath: "", projectPath: "" }),
	};
}
