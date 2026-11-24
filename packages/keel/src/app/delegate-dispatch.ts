import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TurnRunner } from "../domains/turns/index.js";
import type { ChatModeState } from "../domains/tools/index.js";
import type { SnapshotPublisher } from "../domains/snapshots/index.js";
import type { TransportPort } from "../contracts/ports.js";

export interface DelegateDispatchHost {
	readonly registry: ConversationRegistry<Conversation>;
	readonly sessions?: SessionRegistry;
	readonly turns: TurnRunner;
	readonly chatModes?: ChatModeState;
	readonly publisher: SnapshotPublisher;
	readonly transport: TransportPort;
	getLang(): string;
	isQuiesced?(): boolean;
	openChildConversation(init: { parentId: string; title: string; cwd?: string }): Conversation;
}

/**
 * 审查者模式的派活路由：主对话只审阅，用户请求转给唯一的常驻执行对话。
 *
 * 1. 计划模式同时开启时，计划模式优先（不派活，主对话自己出计划）；
 * 2. 首次派活创建不激活的常驻执行对话，后续轮次复用；
 * 3. 派活发出后给主对话回执，主对话自身不跑模型；
 * 4. 派活成功返回 true，通知出快照。
 */
export async function dispatchToDelegate(host: DelegateDispatchHost, text: string): Promise<boolean> {
	const conv = host.registry.activeConv();
	if (!conv) return false;
	const chatModes = host.chatModes;
	if (!chatModes || !chatModes.delegateModeOf(conv.id)) return false;
	if (chatModes.planModeOf(conv.id)) return false;
	if (host.isQuiesced?.()) return false;
	const trimmed = text.trim();
	if (!trimmed) return false;

	const sessions = host.sessions;
	if (!sessions) throw new Error("core: session registry is not wired");

	let execId = chatModes.delegateConvIdOf(conv.id);
	if (execId && (!host.registry.get(execId)?.acceptsTurns || !sessions.get(execId))) {
		execId = null;
	}

	const lang = host.getLang();
	const firstTurn = !execId;
	if (firstTurn) {
		try {
			const title = lang.startsWith("zh") ? "委派执行" : "Delegate executor";
			const child = host.openChildConversation({
				parentId: conv.id,
				title,
				cwd: conv.meta.cwd,
			});
			execId = child.id;
			chatModes.setDelegateConvId(conv.id, execId);
			const opened = await sessions.ensure(child);

			// 继承主会话模型（若有）
			const parentSession = sessions.get(conv.id)?.session as { model?: unknown } | undefined;
			if (parentSession?.model && opened.session.setModel) {
				try {
					await opened.session.setModel(parentSession.model);
				} catch {}
			}

			void host.turns.start(child, opened.session, trimmed).then(
				() => {
					const last = (opened.session as { getLastAssistantText?: () => string }).getLastAssistantText?.() ?? "";
					if (last && !host.transport.isClosed()) {
						host.transport.send({
							type: "notice",
							level: "info",
							text: `🔎 执行对话已完成：${last.slice(0, 120)}${last.length > 120 ? "…" : ""}`,
							textEn: `🔎 Executor finished: ${last.slice(0, 120)}${last.length > 120 ? "…" : ""}`,
						});
						host.publisher.request();
					}
				},
				(err) => {
					console.error("[core] delegate executor turn failed:", err);
				},
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!host.transport.isClosed()) {
				host.transport.send({
					type: "notice",
					level: "error",
					text: `审查者模式：无法创建执行对话（${msg}）。请关闭审查者模式，或先释放一些对话名额。`,
					textEn: `Reviewer mode: could not create the executor conversation (${msg}). Turn reviewer mode off, or free up some conversation slots first.`,
				});
				host.publisher.request();
			}
			return false;
		}
	} else {
		const execConv = host.registry.get(execId as string);
		if (!execConv || !execConv.acceptsTurns) return false;
		try {
			const opened = await sessions.ensure(execConv);
			if (execConv.phase === "running") {
				await host.turns.steer(execConv, opened.session, trimmed);
			} else {
				void host.turns.start(execConv, opened.session, trimmed).then(
					() => {
						const last = (opened.session as { getLastAssistantText?: () => string }).getLastAssistantText?.() ?? "";
						if (last && !host.transport.isClosed()) {
							host.transport.send({
								type: "notice",
								level: "info",
								text: `🔎 执行对话已完成：${last.slice(0, 120)}${last.length > 120 ? "…" : ""}`,
								textEn: `🔎 Executor finished: ${last.slice(0, 120)}${last.length > 120 ? "…" : ""}`,
							});
							host.publisher.request();
						}
					},
					(err) => {
						console.error("[core] delegate executor turn failed:", err);
					},
				);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!host.transport.isClosed()) {
				host.transport.send({
					type: "notice",
					level: "error",
					text: `审查者模式：派活失败（${msg}）`,
					textEn: `Reviewer mode: dispatch failed (${msg})`,
				});
				host.publisher.request();
			}
			return false;
		}
	}

	if (!host.transport.isClosed()) {
		host.transport.send({
			type: "notice",
			level: "info",
			text: `🔎 已派给执行对话：${trimmed.slice(0, 120)}${trimmed.length > 120 ? "…" : ""}（本对话只审阅）`,
			textEn: `🔎 Dispatched to the executor conversation: ${trimmed.slice(0, 120)}${trimmed.length > 120 ? "…" : ""} (this conversation reviews only)`,
		});
		host.publisher.flush({ forceFull: false });
	}
	return true;
}
