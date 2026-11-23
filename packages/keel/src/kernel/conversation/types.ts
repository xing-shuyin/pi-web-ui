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
}
