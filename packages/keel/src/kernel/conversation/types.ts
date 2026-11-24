import type { ClientId, ConversationId, SessionFile } from "../../contracts/ids.js";

export type ConversationKind = "user" | "subagent" | "cli" | "scheduled" | "bot";

/** 内存态。`retiring` 起不再接新回合（fail-closed），`retired` 为终态。 */
export type ConversationPhase = "idle" | "running" | "retiring" | "retired";

export interface ConversationMeta {
	id: ConversationId;
	clientId: ClientId;
	cwd: string;
	title: string;
	kind: ConversationKind;
	createdAt: number;
	lastActiveAt: number;
	parentId?: ConversationId;
	sessionFile?: SessionFile;
	/** 临时对话：会话开在内存里（不落 `.jsonl`），转正（`persist_conversation`）后才删掉标记。 */
	ephemeral?: boolean;
}
