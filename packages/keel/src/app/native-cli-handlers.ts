import type { NativeCliPort } from "../contracts/native-cli.js";
import type { TransportPort } from "../contracts/ports.js";
import type { Conversation, ConversationInit, ConversationRegistry } from "../kernel/conversation/index.js";
import {
	createNativeCliHandlers,
	type NativeCliConversations,
	type NativeCliHandlers,
} from "../domains/native-cli/index.js";

export type { NativeCliHandlers };

/** 运行时里与 CLI 面有关的那几件现成东西：CLI 域不认识 `ClientRuntime`，只认这张窄面。 */
export interface NativeCliRuntime {
	/** 宿主能力只在选项里（`nativeCli` 是 thunk：装配期宿主还没建好 CLI 运行时）。 */
	readonly options: {
		readonly transport: TransportPort;
		readonly nativeCli?: () => NativeCliPort | undefined;
	};
	readonly registry: ConversationRegistry<Conversation>;
	readonly publisher: { request(): void };
	/** 当前工作区（`newCliChat` 没带 cwd 时的兜底）。 */
	readonly cwd: string;
	/** 推一帧 `conversations`（CLI 行与标题都从这一帧出去）。 */
	readonly pushConversations: () => void;
	/** CLI 转录落盘了：会话目录的根由它定（历史列表的重扫依据）。 */
	noteSessionFile?(file: string): void;
	/** 重扫历史列表（新转录落盘后）。 */
	refreshSessions?(): void;
	/** 内核这份 CLI 账（由运行时持有：`conversations` 帧按同一份账投影状态）。 */
	readonly nativeCliState?: NativeCliConversations;
	activeConversationId(): string | undefined;
	createConversation(init?: Partial<ConversationInit>): Conversation;
}

/**
 * 原生 CLI 面的装配：把运行时现成的四件事（对话注册表、建对话、帧出口、工作区）接到 CLI 域上。
 *
 * 这里不写业务：配置校验、标题语意、归属判定、三个动作的分派都在 `domains/native-cli/`，
 * 进程/PTY/hook/远程文件在宿主 `NativeCliPort` 后面（`server/core-native-cli-adapter.ts`）。
 */
export function createNativeCliHandlersFor(runtime: NativeCliRuntime): NativeCliHandlers {
	return createNativeCliHandlers({
		nativeCli: () => runtime.options.nativeCli?.(),
		registry: runtime.registry,
		createConversation: (init) => runtime.createConversation(init),
		cwd: () => runtime.cwd,
		activeConversationId: () => runtime.activeConversationId(),
		pushConversations: () => runtime.pushConversations(),
		...(runtime.noteSessionFile ? { noteSessionFile: (file: string) => runtime.noteSessionFile?.(file) } : {}),
		...(runtime.refreshSessions ? { refreshSessions: () => runtime.refreshSessions?.() } : {}),
		...(runtime.nativeCliState ? { state: runtime.nativeCliState } : {}),
		flushSnapshot: () => runtime.publisher.request(),
		emit: (msg) => runtime.options.transport.send(msg),
		isClosed: () => runtime.options.transport.isClosed(),
	});
}
