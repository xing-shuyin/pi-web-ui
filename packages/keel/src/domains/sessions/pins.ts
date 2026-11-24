import { resolve } from "node:path";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ConversationId } from "../../contracts/ids.js";
import type { SettingsStorePort } from "../../contracts/settings-store.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";
import { restoreWorkspaceUriFromSessionDir } from "../../remote-workspace.js";
import { readCwdFromSessionHeader } from "../../session-search.js";
import type { RebindFrames } from "./rebind.js";

/**
 * 左栏「运行列表」的内存态（老树挂在对话上的 `conv.pinned` / `conv.listed`）。
 *
 * 磁盘上的钉子（历史行 📌）归设置存储；这两个标志只描述**本进程**运行列表怎么排，谁都不落盘：
 * 重启后由转录头部 + 设置存储重新算出来（老实现是在打开会话时做同一件事）。
 */
export interface ConversationPinState {
	pinned: boolean;
	/** 已经进入运行列表：之后切换离开也继续占一行（老树 `conv.listed`）。 */
	listed: boolean;
}

/** 运行列表内存态的唯一持有者：按对话 id 记账，不塞进对话聚合（`kernel` 只认身份与相位）。 */
export class ConversationPinIndex {
	private readonly byConversation = new Map<ConversationId, ConversationPinState>();

	stateOf(id: ConversationId): ConversationPinState | undefined {
		return this.byConversation.get(id);
	}

	isPinned(id: ConversationId): boolean {
		return this.byConversation.get(id)?.pinned === true;
	}

	/** 钉住一定带上 `listed`：钉住的对话不该因为「切走了」而从运行列表消失。 */
	setPinned(id: ConversationId, pinned: boolean): void {
		const current = this.byConversation.get(id) ?? { pinned: false, listed: false };
		this.byConversation.set(id, { pinned, listed: pinned || current.listed });
	}

	markListed(id: ConversationId): void {
		const current = this.byConversation.get(id) ?? { pinned: false, listed: false };
		if (current.listed) return;
		this.byConversation.set(id, { pinned: current.pinned, listed: true });
	}

	/**
	 * 只留还活着的对话：退役 / 被换掉的对话不该继续占内存（出帧前顺手剪掉，这是唯一调用点）。
	 * 磁盘钉子不在这里：重开那份转录时由设置存储重新合流回来。
	 */
	retain(ids: ReadonlySet<ConversationId>): void {
		for (const id of this.byConversation.keys()) if (!ids.has(id)) this.byConversation.delete(id);
	}
}

/**
 * 内存态与磁盘钉子的合流：内存记过就以内存为准，否则问设置存储；钉住一律视为已列入运行列表
 * （老实现在打开会话时做同一件事：`conv.pinned = true; conv.listed = true`）。
 */
export function mergePinState(memory: ConversationPinState | undefined, storedPinned: boolean): ConversationPinState {
	const pinned = memory?.pinned ?? storedPinned;
	return { pinned, listed: pinned || memory?.listed === true };
}

export interface SessionPinsOptions {
	registry: ConversationRegistry<Conversation>;
	/** 会话钉住的持久化（`client-state` 按会话自身 cwd 记账）；缺省 = 该能力未接。 */
	store?: () => SettingsStorePort | undefined;
	frames: RebindFrames;
	cwd(): string;
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
	/** 按「会话自己的 cwd」刷历史列表：在 A 项目里给 B 的会话点钉子要刷那一边。 */
	refreshSessionsFor?(cwd: string): Promise<void> | void;
	/** 运行列表内存态；缺省 = 自己持一份（装配层把同一份交给 `conversations` 帧）。 */
	pins?: ConversationPinIndex;
	/** 钉住变了要重推 `conversations` 帧（左侧运行列表的 📌 来自这一帧）。 */
	pushConversations?(): void;
}

export interface SessionPinsHandlers {
	pinSession(path: string, pinned: boolean): Promise<void>;
	setConversationPinned(id: string, pinned: boolean): Promise<void>;
}

/**
 * 钉住的单一出口：**归属按转录 header 的 cwd 记账**（在 A 项目里给 B 项目的会话点钉子，
 * 记录必须落在 B 名下，否则刷新后会被当成 A 的置顶会话预打开——跨项目串台）。
 */
async function ownerCwdOf(sessionFile: string, fallback: string): Promise<string> {
	try {
		const headerCwd = restoreWorkspaceUriFromSessionDir((await readCwdFromSessionHeader(resolve(sessionFile))) ?? "");
		return headerCwd || fallback;
	} catch {
		return fallback;
	}
}

/**
 * 两个钉住入口共用一条路径：`setConversationPinned` 只是「按对话找到它的转录再钉」。
 *
 * 两件事必须一起成立：磁盘钉子（历史行 📌，归设置存储）与运行列表内存态（左侧 📌 + `listed`）。
 * 内存态只影响本进程怎么排「运行的对话」，重启后由转录 + 设置存储重新算；两者的合流只在
 * `mergePinState()` 一处，`conversations` 帧不自己猜。
 */
export function createSessionPins(options: SessionPinsOptions): SessionPinsHandlers {
	const pins = options.pins ?? new ConversationPinIndex();
	const storeOf = (what: string): SettingsStorePort => {
		const store = options.store?.();
		if (!store) throw new CoreEngineNotReadyError(what);
		return store;
	};

	/** 钉 / 取消钉：写设置存储 + 写运行列表内存态 → 刷归属项目的历史列表 → 出快照与 `conversations` 帧。 */
	const pin = async (store: SettingsStorePort, sessionFile: string, pinned: boolean): Promise<void> => {
		const pinCwd = await ownerCwdOf(sessionFile, options.cwd());
		store.setSessionPinned(pinCwd, resolve(sessionFile), pinned);
		await options.refreshSessionsFor?.(pinCwd);
		options.frames.pushSessions?.();
		options.frames.flush(false);
	};

	/** 同一份转录可能正开在某个对话上：内存态跟着刷到它（老实现同一个循环）。 */
	const syncMemory = (sessionFile: string, pinned: boolean): void => {
		const target = resolve(sessionFile);
		for (const conv of options.registry.list()) {
			if (!conv.meta.sessionFile || resolve(conv.meta.sessionFile) !== target) continue;
			pins.setPinned(conv.id, pinned);
		}
		options.pushConversations?.();
	};

	return {
		pinSession(path: string, pinned: boolean): Promise<void> {
			const store = storeOf("pinSession");
			const target = resolve(path);
			return pin(store, target, pinned)
				.then(() => syncMemory(target, pinned))
				.catch((error: unknown) => {
					const message = (error as Error).message;
					options.notice("error", `置顶会话失败：${message}`, `Failed to pin session: ${message}`);
				});
		},

		async setConversationPinned(id: string, pinned: boolean): Promise<void> {
			const store = storeOf("setConversationPinned");
			const conversation = options.registry.get(id);
			if (!conversation) {
				options.notice("warning", "该对话不存在或已关闭", "This conversation does not exist or is already closed");
				return;
			}
			if (conversation.meta.kind === "subagent") {
				options.notice(
					"info",
					"子代理对话始终保留在运行列表，无需钉住",
					"Subagent chats always stay in the running list — no need to pin",
				);
				return;
			}
			const sessionFile = conversation.meta.sessionFile;
			if (!sessionFile) {
				options.notice(
					"warning",
					"该对话还没有会话记录，先发一条消息再钉住",
					"This conversation has no transcript yet — send a message before pinning it",
				);
				return;
			}
			if (pinned === pins.isPinned(id)) {
				// 已是目标态：不重写存储，但帧照推（客户端可能刚重连，手上没有这一帧）。
				options.pushConversations?.();
				return;
			}
			try {
				// 先落盘再改内存：写存储失败就不该在运行列表里出现一个没记下来的钉子。
				await pin(store, resolve(sessionFile), pinned);
				pins.setPinned(id, pinned);
				options.pushConversations?.();
				options.notice(
					"info",
					pinned
						? `已钉住对话「${conversation.meta.title}」，切换其他对话不会将它移出运行列表`
						: `已取消钉住对话「${conversation.meta.title}」，下次切换离开时按常规规则处理`,
					pinned
						? `Pinned "${conversation.meta.title}" — switching away keeps it in the running list`
						: `Unpinned "${conversation.meta.title}" — it will be handled by the usual rules on the next switch`,
				);
			} catch (error) {
				const message = (error as Error).message;
				options.notice("error", `置顶会话失败：${message}`, `Failed to pin session: ${message}`);
			}
		},
	};
}
