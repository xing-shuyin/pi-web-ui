import type { NativeCliPort, NativeCliTarget } from "../../contracts/native-cli.js";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { Conversation, ConversationInit, ConversationRegistry } from "../../kernel/conversation/index.js";
import type { NativeCliConfig, NativeCliConversation, ServerMessage } from "../../protocol.js";
import { validateNativeCliConfig } from "../../native-cli-meta.js";
import { defaultNativeCliTitle, deriveNativeCliTitleFromInput, isDefaultNativeCliTitle } from "./title.js";
import { NativeCliConversations, type NativeCliBinding } from "./state.js";

export interface NativeCliHandlersOptions {
	/** 缺省 = 未接：每个 handler 调到时同步抛 `CoreEngineNotReadyError`（thunk 是防循环装配）。 */
	nativeCli?: () => NativeCliPort | undefined;
	registry: ConversationRegistry<Conversation>;
	/** 建对话实体（内核侧的激活与出帧基线由运行时负责）。 */
	createConversation(init: Partial<ConversationInit>): Conversation;
	/** 当前工作区（`newCliChat` 没带 cwd 时的兜底）。 */
	cwd(): string;
	activeConversationId(): string | undefined;
	/** 推一帧 `conversations`：CLI 行与它的标题从这一帧出去。 */
	pushConversations(): void;
	/** 出一帧快照（状态/标题/归属变了都要）。 */
	flushSnapshot(): void;
	emit(msg: ServerMessage): void;
	isClosed(): boolean;
}

/** 原生 CLI 会话面的 4 个 handler：签名与 `DispatchSession` 的同名成员一致（契约里都是可选成员）。 */
export interface NativeCliHandlers {
	newCliChat(
		config: NativeCliConfig,
		cwd?: string,
		onReady?: (id: string) => void,
		initialTitle?: string,
	): Promise<boolean>;
	updateNativeCliTitleFromInput(conversationId: string, text: string): void;
	controlNativeCli(conversationId: string, terminalId: string, action: "detach" | "reconnect" | "stop"): Promise<void>;
	getNativeCliConversation(conversationId?: string): NativeCliConversation | undefined;
}

/**
 * 4 个 handler 的内核实现：**身份 + 标题 + 归属 + 出帧**在这里，进程/PTY/hook/远程文件全在 `NativeCliPort` 后面。
 *
 * - `newCliChat`：校验配置（`native-cli-meta` 单源）→ 定标题（显式名 or 自动名）→ 宿主起 CLI → 建会话实体 →
 *   记归属 → 出 `conversations` + 快照 → `onReady`。失败发 error notice 并回 `false`（老实现同口径，不抛）。
 * - `updateNativeCliTitleFromInput`：用户改过名就**永不**自动覆盖（`isDefaultNativeCliTitle` 闸），
 *   否则从首行派生 → 改聚合根 → 让宿主补会话文件与 SDK 会话名 → 出帧。
 * - `controlNativeCli`：归属按内核这份账判定（老实现同一句错误文案），三个动作各自真做、reject 冒泡。
 * - `getNativeCliConversation`：如实投影；没有这条 CLI 就是 `undefined`，不发明默认值。
 */
export function createNativeCliHandlers(options: NativeCliHandlersOptions): NativeCliHandlers {
	const state = new NativeCliConversations();

	const port = (what: string): NativeCliPort => {
		const target = options.nativeCli?.();
		if (!target) throw new CoreEngineNotReadyError(what);
		return target;
	};

	/** 宿主需要的整套事实：配置与标题内核是唯一所有者，这里现取（用户改名后标题必须是最新值）。 */
	const targetOf = (conversationId: string, binding: NativeCliBinding): NativeCliTarget => {
		const conv = options.registry.get(conversationId);
		return {
			conversationId,
			terminalId: binding.terminalId,
			config: binding.config,
			cwd: conv?.meta.cwd ?? options.cwd(),
			title: conv?.meta.title ?? "",
		};
	};

	/** 三个动作共用：做完出一帧快照（老实现 `scheduleSnapshot()`）。失败不吞，reject 冒到 wire 层。 */
	const run = async (work: () => void | Promise<void>): Promise<void> => {
		await work();
		options.flushSnapshot();
	};

	const launch = async (
		target: NativeCliPort,
		config: NativeCliConfig,
		cwd: string | undefined,
		onReady: ((id: string) => void) | undefined,
		initialTitle: string | undefined,
	): Promise<boolean> => {
		try {
			const checked = validateNativeCliConfig(config);
			// 身份必须在起进程前就有：宿主把事件、绑定、终端 id 全挂在这个 id 上。
			const conversationId = `c-${options.registry.nextSeq()}`;
			const title = initialTitle?.trim() || defaultNativeCliTitle(checked);
			const started = await target.launch({
				conversationId,
				config: checked,
				cwd: cwd ?? options.cwd(),
				title,
			});
			const conv = options.createConversation({ id: conversationId, cwd: started.cwd, title, kind: "cli" });
			state.bind(conv.id, checked, started.terminalId);
			options.pushConversations();
			options.flushSnapshot();
			onReady?.(conv.id);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!options.isClosed())
				options.emit({
					type: "notice",
					level: "error",
					text: `新建 CLI 对话失败：${message}`,
					textEn: `Failed to create CLI conversation: ${message}`,
				});
			return false;
		}
	};

	return {
		// 同步成员/异步成员都写成方法体：端口解析发生在**调用时**（写成 async 就变 rejected promise，注册表口径就变了）。
		newCliChat(config, cwd, onReady, initialTitle) {
			const target = port("newCliChat");
			return launch(target, config, cwd, onReady, initialTitle);
		},

		updateNativeCliTitleFromInput(conversationId: string, text: string): void {
			const target = port("updateNativeCliTitleFromInput");
			const binding = state.get(conversationId);
			if (!binding) return;
			const conv = options.registry.get(conversationId);
			if (!conv) return;
			const { preset, executable } = binding.config;
			// 用户改名优先：标题一旦不是自动名，这条输入就再也改不动它。
			if (!isDefaultNativeCliTitle(conv.meta.title, preset, executable)) return;
			const title = deriveNativeCliTitleFromInput(text, preset, executable);
			if (!title) return;
			conv.rename(title);
			target.applyTitle({ ...targetOf(conversationId, binding), title });
			options.pushConversations();
			options.flushSnapshot();
		},

		controlNativeCli(conversationId: string, terminalId: string, action: "detach" | "reconnect" | "stop") {
			const target = port("controlNativeCli");
			const binding = state.get(conversationId);
			// 归属判定读内核这份账：别人的终端 id 一律不许操作（老实现同一句文案）。
			if (!binding || binding.terminalId !== terminalId)
				return Promise.reject(new Error("CLI terminal does not belong to this conversation"));
			const request = targetOf(conversationId, binding);
			if (action === "detach") return run(() => target.detach(request));
			if (action === "reconnect") return run(() => target.reconnect(request));
			return run(() => target.stop(request));
		},

		getNativeCliConversation(conversationId?: string): NativeCliConversation | undefined {
			const target = port("getNativeCliConversation");
			const id = conversationId ?? options.activeConversationId();
			if (!id) return undefined;
			const binding = state.get(id);
			// 没这条 CLI 就是没有：不拿活跃对话的配置顶替，也不补默认状态。
			if (!binding) return undefined;
			const status = target.statusOf(targetOf(id, binding));
			return { config: binding.config, terminalId: binding.terminalId, ...(status ? { status } : {}) };
		},
	};
}
