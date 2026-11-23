import type { ServerLang } from "../../i18n.js";
import type { ServerMessage } from "../../protocol.js";
import { TerminalManager } from "../../../../../server/terminals.js";
import type { TransportPort } from "../../contracts/ports.js";

export interface TerminalHostInput {
	/** 这条客户端连接的上行通道：终端帧只从这里出去，宿主不再自己攒 sink。 */
	transport: TransportPort;
	/** 对话工作目录：叶子每次用的时候现取，切目录不必重建管理器。 */
	cwdOf: (conversationId: string) => string;
	/** 终端提示语语言（叶子的 `lang` 入参）。 */
	lang: () => ServerLang;
}

export interface TerminalHost {
	/** 某个对话的终端管理器（懒建，同一对话复用同一份） */
	managerFor(conversationId: string, cwd: string): TerminalManager;
	disposeConversation(conversationId: string): void;
	disposeAll(): void;
	managers(): string[];
}

/**
 * 终端的持有者是叶子 `TerminalManager`（每对话一份），本宿主只管「谁是有主的、帧往哪走」：
 * 不复制叶子的终端表，也不代它 emit —— 叶子自己会发 `terminal_output` / `terminal_exit` / `terminal_list`。
 */
export function createTerminalHost(input: TerminalHostInput): TerminalHost {
	const byConversation = new Map<string, TerminalManager>();

	const emit = (msg: ServerMessage): void => {
		if (input.transport.isClosed()) return;
		input.transport.send(msg);
	};

	const createManager = (conversationId: string, cwd: string): TerminalManager =>
		new TerminalManager(emit, () => input.cwdOf(conversationId) || cwd, input.lang);

	/** 活终端从叶子的清单里读（`running` 才算活），宿主不维护第二份 id 表。 */
	const killLive = (manager: TerminalManager): void => {
		for (const terminal of manager.list()) {
			if (!terminal.running) continue;
			try {
				manager.kill(terminal.id);
			} catch {
				// 单个终端收不掉（远端 CLI 停不下来、pty 已死）不能拖住其余终端与整轮清理。
			}
		}
	};

	const disposeConversation = (conversationId: string): void => {
		const manager = byConversation.get(conversationId);
		if (!manager) return;
		// 先摘牌再收终端：清理过程中的回调不会再摸到这份半死的管理器。
		byConversation.delete(conversationId);
		killLive(manager);
	};

	return {
		managerFor(conversationId: string, cwd: string): TerminalManager {
			const existing = byConversation.get(conversationId);
			if (existing) return existing;
			const manager = createManager(conversationId, cwd);
			byConversation.set(conversationId, manager);
			return manager;
		},
		disposeConversation,
		disposeAll(): void {
			for (const conversationId of Array.from(byConversation.keys())) disposeConversation(conversationId);
		},
		managers(): string[] {
			return [...byConversation.keys()];
		},
	};
}
