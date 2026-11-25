import { unlink } from "node:fs/promises";
import { isInsideRoots } from "../../path-boundary.js";
import type { ConversationId } from "../../contracts/ids.js";
import {
	type Conversation,
	type ConversationRegistry,
	isTerminal,
	normalizeTitle,
} from "../../kernel/conversation/index.js";

export interface SessionAdminDeps {
	registry: ConversationRegistry<Conversation>;
	/** 删文件；返回是否真的删了 */
	removeFile?: (path: string) => Promise<boolean>;
	now: () => number;
	/** 路径是否在允许范围内（缺省用 path-boundary 的单源函数；测试可注） */
	isAllowedPath?: (path: string) => boolean;
}

export type SessionFileDeletionReason = "not-allowed" | "missing";

export interface SessionFileDeletion {
	deleted: boolean;
	reason?: SessionFileDeletionReason;
}

export interface RenameConversationInput {
	registry: ConversationRegistry<Conversation>;
	conversationId: ConversationId;
	title: string;
	now: number;
}

export interface RenameConversationResult {
	renamed: boolean;
	title?: string;
}

export interface DismissConversationInput extends SessionAdminDeps {
	conversationId: ConversationId;
	withFinishedSubagents?: boolean;
	closeSession?: (id: string) => void;
}

export interface DismissConversationResult {
	dismissed: boolean;
	closedSubagents: string[];
}

function sessionsRootsFromEnv(): string[] {
	const root = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
	return root ? [root] : [];
}

/**
 * 缺省只认 `PI_CODING_AGENT_SESSION_DIR` 之内的路径，且判的是真实路径（链接穿透 / `..` 都算越界）；
 * 没配根目录就一律判越界。装配层手里有 agentDir 时按它算出根再注入 `isAllowedPath`。
 */
function defaultIsAllowedPath(path: string): boolean {
	return isInsideRoots(path, sessionsRootsFromEnv());
}

/** 删转录的越界判定（`deleteSession` 与 `deleteSessionFile` 共用同一份：注入优先，缺省按环境根）。 */
export function canDeleteSessionPath(path: string, isAllowedPath?: (path: string) => boolean): boolean {
	return (isAllowedPath ?? defaultIsAllowedPath)(path);
}

async function removeFileFromDisk(path: string): Promise<boolean> {
	try {
		await unlink(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/**
 * 删一份磁盘会话记录：越界一律不碰文件；删成功后只把绑着它的对话解绑（对话本体的清理由 dismiss 负责，
 * 这里不替它退役，免得把「记录没了」和「对话关了」两件事混成一件）。
 */
export async function deleteSessionFile(
	input: SessionAdminDeps & { sessionFile: string },
): Promise<SessionFileDeletion> {
	const allowed = input.isAllowedPath ?? defaultIsAllowedPath;
	if (!allowed(input.sessionFile)) return { deleted: false, reason: "not-allowed" };
	const removed = await (input.removeFile ?? removeFileFromDisk)(input.sessionFile);
	if (!removed) return { deleted: false, reason: "missing" };
	const holder = input.registry.bySessionFile(input.sessionFile);
	if (holder) input.registry.unbindSessionFile(holder.id);
	return { deleted: true };
}

/** 历史行重命名只交回归一后的标题（写盘由调用方拿着 `sessionFile` 自己落）。 */
export function renameSession(name: { sessionFile: string; title: string }): { title: string } {
	return { title: normalizeTitle(name.title) };
}

/** 内存对话重命名：不存在就静默失败（左栏可能带着已关掉的行），成功只改标题 + 记一次活动时间。 */
export function renameConversation(input: RenameConversationInput): RenameConversationResult {
	const conversation = input.registry.get(input.conversationId);
	if (!conversation) return { renamed: false };
	conversation.rename(input.title, input.now);
	return { renamed: true, title: conversation.meta.title };
}

/** 退役是单向闸：已经 `retired` 的不再动（否则相位转换会抛），`retiring` 的补最后一脚。 */
function retireConversation(conversation: Conversation): void {
	if (isTerminal(conversation.phase)) return;
	conversation.retire();
	conversation.finishRetire();
}

/** 已结束 = 不在 `running`：还在跑的子代理不连带关，跑完的（含退役中的）都算。 */
function finishedSubagentsOf(input: DismissConversationInput): Conversation[] {
	return input.registry
		.list()
		.filter(
			(conversation) =>
				conversation.meta.kind === "subagent" &&
				conversation.meta.parentId === input.conversationId &&
				conversation.phase !== "running",
		);
}

/**
 * 关闭对话：先按需连带关掉已结束的子代理，再退役主对话并摘出注册表，最后对每个关掉的 id 收一次会话资源。
 * 幂等：不存在或已退役的一律返回 `dismissed: false` 且不改动任何状态。
 */
export async function dismissConversation(input: DismissConversationInput): Promise<DismissConversationResult> {
	const conversation = input.registry.get(input.conversationId);
	if (!conversation || isTerminal(conversation.phase)) return { dismissed: false, closedSubagents: [] };
	const closeSession = input.closeSession ?? (() => {});
	const closedSubagents: string[] = [];
	if (input.withFinishedSubagents) {
		for (const subagent of finishedSubagentsOf(input)) {
			retireConversation(subagent);
			input.registry.remove(subagent.id);
			closeSession(subagent.id);
			closedSubagents.push(subagent.id);
		}
	}
	retireConversation(conversation);
	input.registry.remove(conversation.id);
	closeSession(conversation.id);
	return { dismissed: true, closedSubagents };
}
