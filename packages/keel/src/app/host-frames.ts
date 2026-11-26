import { resolve as resolveFsPath } from "node:path";
import type { TransportPort } from "../contracts/ports.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { ProjectSource } from "../adapters/state/index.js";
import { pushProjects } from "../domains/projects/index.js";
import { refreshSessions, sessionListLimitOf } from "../domains/history/index.js";
import type { ModelPusher } from "../domains/models/index.js";
import type { Conversation } from "../kernel/conversation/index.js";
import type { NativeCliPort } from "../contracts/native-cli.js";
import type { MobileNotificationEvent } from "../mobile-notification-events.js";
import type { TerminalHost } from "../domains/terminals/index.js";
import type { ClientFrames, ClientRuntime } from "./client-runtime.js";

/** Build the `ClientFrames` push surface for a connected `ClientRuntime`. */
export function buildClientFrames(opts: {
	transport: TransportPort;
	stateStore: SettingsStorePort;
	clientId: string;
	runtime: ClientRuntime;
	projectSource: ProjectSource;
	modelPusher: ModelPusher;
}): ClientFrames {
	const { transport, stateStore, clientId, runtime, projectSource, modelPusher } = opts;
	let settingsFramePush: (() => void) | undefined;
	const pushSessionsFor = async (targetCwd: string, root: string | undefined): Promise<void> => {
		if (!root) {
			if (!transport.isClosed()) transport.send({ type: "sessions", sessions: [], cwd: targetCwd });
			return;
		}
		const pinned = { isPinned: (owner: string, file: string) => stateStore.isSessionPinned(owner, file) };
		// 条数是前端 `list_sessions.limit` 按项目设的（`setSessionListLimit`）：帧出口只按它截断，`hasMore` 跟着算。
		const limit = sessionListLimitOf(runtime.sessionLimits, targetCwd);
		await refreshSessions({ root, cwd: targetCwd, transport, state: runtime.historyState(), limit, ...pinned });
	};
	const frames: ClientFrames = {
		pushSettings: () => settingsFramePush?.(),
		pushDefaultModel: () => {
			const modelId = stateStore.getDefaultModel("pi") ?? null;
			if (!transport.isClosed()) transport.send({ type: "default_model", modelId });
		},
		pushProjects: async () => {
			await pushProjects({ transport, clientId, cwd: runtime.cwd, source: projectSource });
		},
		refreshSessions: async () => {
			await pushSessionsFor(runtime.cwd, runtime.historyRoot());
		},
		// 侧栏展开非当前项目或钉子落在目标项目时，按 targetCwd 扫对应的会话目录并推帧。
		refreshSessionsFor: async (targetCwd: string) => {
			if (resolveFsPath(targetCwd) === resolveFsPath(runtime.cwd)) {
				await frames.refreshSessions();
				return;
			}
			await pushSessionsFor(targetCwd, runtime.historyRootFor(targetCwd));
		},
		listModels: () => {
			void modelPusher.push();
		},
	};
	return Object.assign(frames, {
		bindSettingsPush: (push: (() => void) | undefined) => {
			settingsFramePush = push;
		},
	});
}

/** Auto-title a newly created conversation from the first user prompt line. */
export function applyPromptAutoTitle(conv: Conversation, text: string): void {
	if ((conv.meta.title === "新对话" || conv.meta.title === "New Chat") && text.trim()) {
		const first = text.trim().split("\n")[0].trim();
		const clean = first.length > 30 ? `${first.slice(0, 30)}…` : first;
		if (clean) conv.rename(clean, Date.now());
	}
}

/** Flush the owning runtime and any cross-client peer holding the conversation. */
export function flushConversationAndPeer(
	runtime: ClientRuntime,
	conv: Conversation,
	findRuntime?: (clientId: string) => ClientRuntime | undefined,
): void {
	runtime.publisher.flush({ forceFull: true });
	runtime.pushConversations();
	const currentClientId = conv.meta.clientId;
	if (currentClientId && currentClientId !== runtime.clientId) {
		const target = findRuntime?.(currentClientId);
		if (target) {
			target.publisher.flush({ forceFull: true });
			target.pushConversations();
		}
	}
}

/** Build the optional `nativeCli` host port for a `ClientRuntime`. */
export function buildNativeCliPort(opts: {
	factory:
		| ((deps: {
				terminalOf: (conversationId: string, cliCwd?: string) => ReturnType<TerminalHost["managerFor"]>;
				emit: (msg: any) => void;
				publish: () => void;
				refreshSessions: () => void;
				renameConversation: (conversationId: string, title: string) => void;
				inheritModel: (preset: string) => { provider: string; id: string } | undefined;
				notifyMobile?: (event: Omit<MobileNotificationEvent, "clientId">) => void;
		  }) => NativeCliPort)
		| undefined;
	terminalHost: TerminalHost;
	cwd: string;
	transport: TransportPort;
	runtime: ClientRuntime;
	frames: ClientFrames;
	stateStore: SettingsStorePort;
	clientId: string;
	activeSessionModel: () => { provider: string; id: string } | undefined;
	notifyMobile?: (event: MobileNotificationEvent) => void;
}): NativeCliPort | undefined {
	const {
		factory,
		terminalHost,
		cwd,
		transport,
		runtime,
		frames,
		stateStore,
		clientId,
		activeSessionModel,
		notifyMobile,
	} = opts;
	return factory?.({
		terminalOf: (conversationId, cliCwd) => terminalHost.managerFor(conversationId, cliCwd ?? cwd),
		emit: (msg) => {
			if (!transport.isClosed()) transport.send(msg);
		},
		publish: () => {
			if (runtime.isDisposed()) return;
			runtime.publisher.request();
			runtime.pushConversations();
		},
		refreshSessions: () => void frames.refreshSessions(),
		renameConversation: (conversationId, title) => runtime.registry.get(conversationId)?.rename(title),
		inheritModel: (preset) => {
			const inherit = stateStore.getSettingsSnapshot(clientId).nativeCliInheritModel as
				Record<string, boolean | undefined> | undefined;
			if (!inherit?.[preset]) return undefined;
			return activeSessionModel();
		},
		...(notifyMobile
			? {
					notifyMobile: (event) => notifyMobile({ ...event, clientId }),
				}
			: {}),
	});
}
