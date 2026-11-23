import { DEFAULT_CONV_TITLE } from "../../../../../server/agent-formatters.js";
import type { ClientId, ConversationId, SessionFile } from "../../contracts/ids.js";
import { acceptsTurns, transition } from "./phase.js";
import { ConversationQueues } from "./queues.js";
import type { ConversationKind, ConversationMeta, ConversationPhase } from "./types.js";

export interface ConversationInit {
	id: ConversationId;
	clientId: ClientId;
	cwd: string;
	kind: ConversationKind;
	createdAt: number;
	title?: string;
	parentId?: ConversationId;
	sessionFile?: SessionFile;
}

/**
 * 对话聚合：身份 + 内存相位 + 两条排队。SDK 会话、UI 缓存、终端的持有者不在这里，
 * 它们各自是域；聚合只保证「相位与排队的语义」不被外部随手改写。
 */
export class Conversation {
	readonly meta: ConversationMeta;
	readonly queues = new ConversationQueues();
	private phaseState: ConversationPhase = "idle";

	constructor(init: ConversationInit) {
		this.meta = {
			id: init.id,
			clientId: init.clientId,
			cwd: init.cwd,
			title: normalizeTitle(init.title),
			kind: init.kind,
			createdAt: init.createdAt,
			lastActiveAt: init.createdAt,
			parentId: init.parentId,
			sessionFile: init.sessionFile,
		};
	}

	get id(): ConversationId {
		return this.meta.id;
	}

	get phase(): ConversationPhase {
		return this.phaseState;
	}

	get acceptsTurns(): boolean {
		return acceptsTurns(this.phaseState);
	}

	beginTurn(now: number): void {
		if (!acceptsTurns(this.phaseState)) throw new ConversationPhaseError(this);
		this.phaseState = transition(this.phaseState, "running");
		this.touch(now);
	}

	endTurn(now: number): void {
		this.phaseState = transition(this.phaseState, "idle");
		this.touch(now);
	}

	/** 退役第一步：立刻不再接新回合（fail-closed），资源释放留给 `finishRetire()`。 */
	retire(): void {
		this.phaseState = transition(this.phaseState, "retiring");
		this.queues.clear();
	}

	finishRetire(): void {
		this.phaseState = transition(this.phaseState, "retired");
	}

	rename(title: string, now?: number): void {
		this.meta.title = normalizeTitle(title);
		if (now !== undefined) this.touch(now);
	}

	touch(now: number): void {
		this.meta.lastActiveAt = now;
	}

	setSessionFile(file: SessionFile | undefined): void {
		if (file) this.meta.sessionFile = file;
		else delete this.meta.sessionFile;
	}
}

class ConversationPhaseError extends Error {
	constructor(conv: Conversation) {
		super(`conversation ${conv.meta.id} cannot start a turn in phase ${conv.phase}`);
		this.name = "ConversationPhaseError";
	}
}

export function normalizeTitle(title: string | undefined): string {
	const text = (title ?? "").trim();
	return text || DEFAULT_CONV_TITLE;
}
