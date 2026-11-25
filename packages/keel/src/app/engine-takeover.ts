import type { Conversation } from "../kernel/conversation/index.js";
import type { ServerMessage } from "../protocol.js";
import type { ClientRuntime } from "./client-runtime.js";
import type { AskUserWaiter } from "../domains/interactions/questions.js";

export interface TakeoverDeps {
	runtimes: Map<string, ClientRuntime>;
	takeoverFlights: Map<string, Promise<void>>;
	notifyExternalRunning: (changedClientId?: string) => void;
	sendNotice: (clientId: string, notice: ServerMessage) => void;
	askWaiters?: Map<string, AskUserWaiter>;
	subagentsRegistry?: import("../domains/subagents/registry.js").SubagentRegistry;
}

function isSubagentDescendant(candidate: Conversation, rootId: string, all: readonly Conversation[]): boolean {
	let cur: string | undefined = candidate.meta.parentId;
	const seen = new Set<string>();
	while (cur && !seen.has(cur)) {
		if (cur === rootId) return true;
		seen.add(cur);
		const parent = all.find((c) => c.id === cur);
		cur = parent?.meta.parentId;
	}
	return false;
}

/**
 * 跨客户端会话过户：将某客户端持有的主会话（连同其在跑的子代理）事务性移交给目标客户端。
 * 顺序：准备 → 插入 → 提交移除 → 激活目标。出错时完整回退来源持有权。
 */
export async function executeTakeOverConversation(
	deps: TakeoverDeps,
	targetId: string,
	ownerId: string,
	convId: string,
): Promise<void> {
	const target = deps.runtimes.get(targetId);
	if (!target) return;
	const fail = (text: string, textEn: string): void => {
		deps.sendNotice(targetId, { type: "notice", level: "warning", text, textEn });
	};

	if (!ownerId || !convId) {
		fail("过户目标不明确（缺 owner/id），请重试", "Takeover target unclear (missing owner/id), please retry.");
		return;
	}
	if (ownerId === targetId) {
		try {
			target.registry.activate(convId);
			target.pushConversations();
			target.publisher.flush({ forceFull: true });
		} catch {}
		return;
	}
	if (ownerId.startsWith("scheduler:")) {
		fail(
			"定时任务会话不支持过户 —— 报告会自动落回绑定的对话，可在后台任务面板查看进度",
			"Scheduler sessions cannot be taken over — reports are saved to the bound conversation automatically; check progress in the Background Tasks panel.",
		);
		return;
	}

	const flightKey = `${ownerId}:${convId}`;
	if (deps.takeoverFlights.has(flightKey)) {
		deps.sendNotice(targetId, {
			type: "notice",
			level: "info",
			text: "这条对话正在接管中，请稍候（不要重复点击）。",
			textEn: "This conversation is already being taken over; please wait (do not click again).",
		});
		return;
	}
	deps.takeoverFlights.set(flightKey, Promise.resolve());

	try {
		const source = deps.runtimes.get(ownerId);
		if (!source) {
			fail("对方会话已不存在，可从历史对话里直接打开", "The source session is gone; reopen it from History instead.");
			deps.notifyExternalRunning();
			return;
		}

		const conv = source.registry.get(convId);
		if (!conv) {
			fail(
				"对方已经没有这条对话（刚结束或被关闭），左栏稍后自动刷新",
				"That conversation is gone on the other side; the list refreshes shortly.",
			);
			deps.notifyExternalRunning();
			return;
		}
		if (conv.meta.kind === "subagent") {
			fail(
				"只能过户主对话（子代理随主对话一起搬）",
				"Only main conversations can be taken over (subagents move with their parent).",
			);
			return;
		}

		const allSourceConvs = source.registry.list();
		const descendants = allSourceConvs.filter(
			(c) => c.meta.kind === "subagent" && isSubagentDescendant(c, convId, allSourceConvs),
		);
		const moveConvs = [conv, ...descendants];
		const moveIds = new Set(moveConvs.map((c) => c.id));

		const originalIds = new Map<Conversation, string>();
		const originalParentIds = new Map<Conversation, string | undefined>();
		for (const c of moveConvs) {
			originalIds.set(c, c.id);
			originalParentIds.set(c, c.meta.parentId);
		}

		// 第一步：如果来源当前正处于被搬走的对话，先换到其他对话
		if (moveIds.has(source.registry.activeId())) {
			const remaining =
				allSourceConvs.find((c) => !moveIds.has(c.id) && c.meta.kind !== "subagent") ??
				allSourceConvs.find((c) => !moveIds.has(c.id));
			if (remaining) {
				source.registry.activate(remaining.id);
				source.publisher.switchConversation(remaining.id);
			} else {
				const newBlank = source.createConversation();
				source.registry.activate(newBlank.id);
				source.publisher.switchConversation(newBlank.id);
			}
			source.publisher.flush({ forceFull: true });
		}

		// 第二步：撞号重编与提问移出
		const sourceWaiter = deps.askWaiters?.get(ownerId);
		const targetWaiter = deps.askWaiters?.get(targetId);
		const transferredAsks = sourceWaiter ? sourceWaiter.transferOut(moveIds) : [];

		const remap = new Map<string, string>();
		const reserved = new Set([...target.registry.list().map((c) => c.id), ...moveConvs.map((c) => c.id)]);
		for (const c of moveConvs) {
			if (target.registry.has(c.id)) {
				let next: string;
				do next = "c-" + target.registry.nextSeq();
				while (reserved.has(next));
				reserved.add(next);
				remap.set(c.id, next);
			}
		}
		const fixId = (id: string): string => remap.get(id) ?? id;
		const remappedAsks = transferredAsks.map((ask) => ({
			...ask,
			conversationId: fixId(ask.conversationId),
		}));

		try {
			if (process.env.PI_WEB_TEST_TAKEOVER_FAIL_INSERT === "1") {
				throw new Error("injected takeover insert failure");
			}

			if (targetWaiter && remappedAsks.length > 0) {
				targetWaiter.transferIn(remappedAsks);
			}

			for (const c of moveConvs) {
				const oldId = originalIds.get(c)!;
				const newId = fixId(oldId);
				if (c.meta.parentId) {
					c.meta.parentId = fixId(c.meta.parentId);
				}
				if (remap.has(oldId)) {
					c.meta.id = newId;
					deps.subagentsRegistry?.remap(oldId, newId, c.meta.parentId);
				}
				if (c.meta.kind !== "subagent" && remap.has(oldId)) {
					deps.subagentsRegistry?.updateParentId(oldId, newId);
				}
				c.meta.clientId = target.options.clientId;
				target.registry.add(c);
				target.surface().conversations().markListed(newId);
				if (source.options.sessions && target.options.sessions) {
					target.options.sessions.transferFrom(source.options.sessions, oldId, newId);
				}
			}

			// 第三步：从来源移除
			for (const c of moveConvs) {
				const oldId = originalIds.get(c)!;
				source.registry.remove(oldId);
			}
			source.pushConversations();

			// 第四步：在目标激活主会话
			const mainNewId = fixId(convId);
			target.registry.activate(mainNewId);
			target.publisher.switchConversation(mainNewId);
			target.surface().conversations().markListed(mainNewId);
			target.pushConversations();
			target.publisher.flush({ forceFull: true });
			target.pushQuestionQueue();
			source.pushQuestionQueue();

			deps.sendNotice(ownerId, {
				type: "notice",
				level: "info",
				text: `「${conv.meta.title}」已过户到另一处接管，本页不再持有它。`,
				textEn: `"${conv.meta.title}" was taken over by another page and is no longer held here.`,
			});
			deps.sendNotice(targetId, {
				type: "notice",
				level: "info",
				text: `已将「${conv.meta.title}」过户到当前页面，可直接继续查看与操作。`,
				textEn: `"${conv.meta.title}" was moved to this page — pick up right where it left off.`,
			});
			deps.notifyExternalRunning();
		} catch (err) {
			console.error("[takeover] takeover failed, rolling back:", err);
			if (targetWaiter && remappedAsks.length > 0) {
				const returnedAsks = targetWaiter.transferOut(new Set(moveConvs.map((c) => c.id)));
				const restoredAsks = returnedAsks.map((ask) => ({
					...ask,
					conversationId: originalIds.get(moveConvs.find((c) => c.id === ask.conversationId)!) ?? ask.conversationId,
				}));
				sourceWaiter?.transferIn(restoredAsks);
			}
			// 回滚到来源
			for (const c of moveConvs) {
				const curId = c.id;
				if (target.registry.has(curId)) target.registry.remove(curId);
				const origId = originalIds.get(c)!;
				c.meta.id = origId;
				c.meta.clientId = ownerId;
				c.meta.parentId = originalParentIds.get(c);
				if (!source.registry.has(origId)) source.registry.add(c);
				if (target.options.sessions && source.options.sessions) {
					source.options.sessions.transferFrom(target.options.sessions, curId, origId);
				}
			}
			source.registry.activate(convId);
			source.publisher.switchConversation(convId);
			source.publisher.flush({ forceFull: true });
			source.pushConversations();
			target.pushConversations();
			source.pushQuestionQueue();
			target.pushQuestionQueue();

			deps.sendNotice(ownerId, {
				type: "notice",
				level: "info",
				text: `对方的过户未完成，「${conv.meta.title}」已退回本页，可直接继续。`,
				textEn: `The takeover did not complete on the other side — "${conv.meta.title}" is back on this page.`,
			});
			fail(
				`过户失败（${(err as Error).message}）——对话已退回原页面，可直接重试`,
				`Takeover failed (${(err as Error).message}) — the conversation is back on the source page; retry there.`,
			);
			deps.notifyExternalRunning();
		}
	} finally {
		deps.takeoverFlights.delete(flightKey);
	}
}

export function peekElsewhereQuestion(deps: TakeoverDeps, targetId: string, ownerId: string, convId: string): void {
	const source = deps.runtimes.get(ownerId);
	const target = deps.runtimes.get(targetId);
	if (!source || !target) return;
	const waiter = deps.askWaiters?.get(ownerId);
	const q = waiter?.pendingForSnapshot(convId)[0];
	if (!q) {
		deps.sendNotice(targetId, {
			type: "notice",
			level: "warning",
			text: "那张问卷已不在（对方刚回答/取消或对话已结束）",
			textEn: "That question is gone (just answered/cancelled there, or the run ended).",
		});
		return;
	}
	target.options.transport.send({
		type: "elsewhere_question",
		owner: ownerId,
		convId,
		id: q.id,
		questions: q.questions,
		...(source.registry.get(convId)?.meta.title ? { conversationTitle: source.registry.get(convId)!.meta.title } : {}),
	});
}

export async function navigateQuestion(deps: TakeoverDeps, targetId: string, id: string): Promise<void> {
	const target = deps.runtimes.get(targetId);
	if (!target) return;
	const localWaiter = deps.askWaiters?.get(targetId);
	const localQ = localWaiter?.list().find((q) => q.id === id);
	if (localQ && target.registry.has(localQ.conversationId)) {
		target.registry.activate(localQ.conversationId);
		target.pushConversations();
		target.publisher.flush({ forceFull: true });
		return;
	}
	for (const [ownerId, waiter] of deps.askWaiters ?? []) {
		if (ownerId === targetId) continue;
		const found = waiter.list().find((q) => q.id === id);
		if (found) {
			const source = deps.runtimes.get(ownerId);
			const conv = source?.registry.get(found.conversationId);
			if (conv && conv.meta.cwd === target.cwd) {
				const rootId = conv.meta.parentId ?? conv.id;
				await executeTakeOverConversation(deps, targetId, ownerId, rootId);
				return;
			}
		}
	}
	deps.sendNotice(targetId, {
		type: "notice",
		level: "warning",
		text: "问卷已结束，无法定位来源",
		textEn: "The question has ended; its source is no longer available.",
	});
}

export function answerElsewhereQuestion(
	deps: TakeoverDeps,
	targetId: string,
	ownerId: string,
	id: string,
	answers: { id: string; selected: string[]; custom?: string }[],
	cancelled?: boolean,
	cancelReason?: string,
): void {
	const target = deps.runtimes.get(targetId);
	if (!target) return;
	let ok = false;
	const sourceWaiter = ownerId ? deps.askWaiters?.get(ownerId) : undefined;
	if (sourceWaiter?.answer(id, answers, cancelled, cancelReason)) {
		ok = true;
	} else if (deps.askWaiters) {
		for (const [oid, waiter] of deps.askWaiters) {
			if (oid !== ownerId && waiter.answer(id, answers, cancelled, cancelReason)) {
				ok = true;
				break;
			}
		}
	}
	if (!ok) {
		deps.sendNotice(targetId, {
			type: "notice",
			level: "warning",
			text: "那张问卷已不在（对方刚回答/取消或对话已结束），你的回答没有送出",
			textEn:
				"That question is gone (just answered/cancelled there, or the run ended) — your answer was not delivered.",
		});
		target.pushConversations();
	}
}

export function resolveGlobalQuestion(
	askWaiters: ReadonlyMap<string, AskUserWaiter>,
	id: string,
	answers: { id: string; selected: string[]; custom?: string }[],
	cancelled?: boolean,
	cancelReason?: string,
): boolean {
	for (const waiter of askWaiters.values()) {
		if (waiter.answer(id, answers, cancelled, cancelReason)) return true;
	}
	return false;
}

export function collectQueuedQuestions(
	runtimes: ReadonlyMap<string, ClientRuntime>,
	askWaiters: ReadonlyMap<string, AskUserWaiter>,
	forClientId: string,
): import("../protocol.js").UiQueuedQuestion[] {
	const current = runtimes.get(forClientId);
	if (!current) return [];
	const list: import("../protocol.js").UiQueuedQuestion[] = [];
	for (const [ownerId, waiter] of askWaiters) {
		const own = ownerId === forClientId;
		const ownerRuntime = runtimes.get(ownerId);
		if (!ownerRuntime) continue;
		for (const q of waiter.list()) {
			const conv = ownerRuntime.registry.get(q.conversationId);
			if (!conv) continue;
			if (!own && conv.meta.cwd !== current.cwd) continue;
			let root = conv;
			const seen = new Set<string>();
			while (root.meta.parentId && !seen.has(root.id)) {
				seen.add(root.id);
				const parent = ownerRuntime.registry.get(root.meta.parentId);
				if (!parent || parent.meta.cwd !== conv.meta.cwd) break;
				root = parent;
			}
			list.push({
				id: q.id,
				questions: q.questions,
				owner: ownerId,
				conversationId: conv.id,
				conversationTitle: conv.meta.title,
				rootConversationId: root.id,
				cwd: conv.meta.cwd,
				createdAt: q.createdAt,
				audience: "user",
			});
		}
	}
	list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	return list;
}
