import type { ClientTerminalManager } from "../../contracts/terminal.js";

/** 终端归属面里内核真的能回答的那几个成员（每对话一份的管理器在 `host.ts`）。 */
export interface TerminalHandlers {
	/** 客户端级（`ownerKind: "client"`）管理器：内核不持有，如实 `undefined`（理由见 `contracts/terminal.ts`）。 */
	getUserTerminalManager(): ClientTerminalManager;
}

/**
 * 终端的归属只有一份：每个对话一支管理器（`domains/terminals/host.ts` 的 `managerFor`）。
 *
 * 这里回答的是「有没有客户端级的那一支」——没有，且不伪造：宿主派发里每个
 * `getUserTerminalManager()` 调用点都有 `?? getTerminalManager(conversationId)` 兜底，
 * 所以返回 `undefined` 时用户终端落到当前对话的管理器，功能不丢（语义见 `contracts/terminal.ts`）。
 */
export function createTerminalHandlers(): TerminalHandlers {
	return {
		getUserTerminalManager: (): ClientTerminalManager => undefined,
	};
}
