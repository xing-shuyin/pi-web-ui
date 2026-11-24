import type { NativeCliConfig } from "../../protocol.js";

/** 一条 CLI 对话在内核侧的账：配置 + 终端 id。进程/PTY 的持有者是宿主，内核只认这两个值。 */
export interface NativeCliBinding {
	config: NativeCliConfig;
	terminalId: string;
}

/**
 * 按对话记的 CLI 账。**只做两件事**：绑一次、按 id 查一条。
 *
 * 不进 `Conversation` 聚合根：`kernel/conversation` 是身份与相位，CLI 是宿主进程的投影，
 * 混进去之后快照、行归属、退役都要跟着认识 CLI。也不落盘：绑定与事件游标住在会话文件里
 * （`NativeCliBinding`，宿主 `native-cli-state.ts`），内核这份账是运行态的镜像。
 */
export class NativeCliConversations {
	private readonly byConversation = new Map<string, NativeCliBinding>();

	bind(conversationId: string, config: NativeCliConfig, terminalId: string): NativeCliBinding {
		const binding: NativeCliBinding = { config, terminalId };
		this.byConversation.set(conversationId, binding);
		return binding;
	}

	get(conversationId: string): NativeCliBinding | undefined {
		return this.byConversation.get(conversationId);
	}
}
