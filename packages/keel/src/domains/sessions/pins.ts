import { resolve } from "node:path";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { SettingsStorePort } from "../../contracts/settings-store.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";
import { restoreWorkspaceUriFromSessionDir } from "../../remote-workspace.js";
import { readCwdFromSessionHeader } from "../../session-search.js";
import type { RebindFrames } from "./rebind.js";

export interface SessionPinsOptions {
	registry: ConversationRegistry<Conversation>;
	/** 会话钉住的持久化（`client-state` 按会话自身 cwd 记账）；缺省 = 该能力未接。 */
	store?: () => SettingsStorePort | undefined;
	frames: RebindFrames;
	cwd(): string;
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
	/** 按「会话自己的 cwd」刷历史列表：在 A 项目里给 B 的会话点钉子要刷那一边。 */
	refreshSessionsFor?(cwd: string): Promise<void> | void;
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
 * 磁盘上的钉子（历史行 📌）由设置存储负责，刷列表按归属 cwd 推；内存里的「运行列表钉住」
 * 属于左栏行的可见面，本引擎还没有 `conversations` 帧生产者，所以这里不假装有状态。
 */
export function createSessionPins(options: SessionPinsOptions): SessionPinsHandlers {
	const storeOf = (what: string): SettingsStorePort => {
		const store = options.store?.();
		if (!store) throw new CoreEngineNotReadyError(what);
		return store;
	};

	/** 钉 / 取消钉：写设置存储 → 刷归属项目的历史列表 → 出快照。 */
	const pin = async (store: SettingsStorePort, sessionFile: string, pinned: boolean): Promise<void> => {
		const pinCwd = await ownerCwdOf(sessionFile, options.cwd());
		store.setSessionPinned(pinCwd, resolve(sessionFile), pinned);
		await options.refreshSessionsFor?.(pinCwd);
		options.frames.pushSessions?.();
		options.frames.flush(false);
	};

	return {
		pinSession(path: string, pinned: boolean): Promise<void> {
			const store = storeOf("pinSession");
			const target = resolve(path);
			return pin(store, target, pinned).catch((error: unknown) => {
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
			try {
				await pin(store, resolve(sessionFile), pinned);
			} catch (error) {
				const message = (error as Error).message;
				options.notice("error", `置顶会话失败：${message}`, `Failed to pin session: ${message}`);
			}
		},
	};
}
