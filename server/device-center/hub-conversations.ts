import { randomUUID } from "node:crypto";
import {
	isTerminal,
	taskPending,
	taskHasImmutableEvidence,
	type HubState,
	type HubTask,
	type HubConversation,
} from "./store.js";

export const CLOSED_CONVERSATION_RETENTION = 200;
export const ROOM_RECEIPT_RETENTION = 2000;
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function conversationStale(state: HubState, conversation: HubConversation): boolean {
	const bot = state.bots.find((b) => b.id === conversation.botId && b.accountId === conversation.accountId);
	if (!bot || !bot.enabled || bot.revision !== conversation.botRevision || bot.deviceId !== conversation.deviceId)
		return true;
	const room = state.rooms.find((r) => r.id === conversation.roomId && r.accountId === conversation.accountId);
	return !room || !room.botIds.includes(bot.id);
}

export function conversationHasAuditRecords(state: HubState, conversationId: string): boolean {
	return (
		state.deliveries.some((delivery) => delivery.conversationId === conversationId) ||
		state.reviews.some((review) => review.conversationId === conversationId) ||
		state.integrations.some((integration) => integration.conversationId === conversationId) ||
		state.tasks.some((task) => task.conversationId === conversationId && taskHasImmutableEvidence(task))
	);
}

export function dropConversationRecords(state: HubState, conversationId: string): void {
	const taskIds = new Set(state.tasks.filter((task) => task.conversationId === conversationId).map((task) => task.id));
	state.conversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
	state.tasks = state.tasks.filter((task) => !taskIds.has(task.id));
	state.conversationMessages = state.conversationMessages.filter(
		(message) => message.conversationId !== conversationId,
	);
	state.deliveryReceipts = state.deliveryReceipts.filter((receipt) => receipt.conversationId !== conversationId);
	state.integrations = state.integrations.filter((integration) => integration.conversationId !== conversationId);
}

export function trimClosedConversations(state: HubState, roomId: string, limit = CLOSED_CONVERSATION_RETENTION): void {
	const closed = state.conversations
		.filter((conversation) => conversation.roomId === roomId && conversation.closed)
		.sort((a, b) => a.updatedAt - b.updatedAt);
	if (closed.length <= limit) return;
	for (const conversation of closed.slice(0, closed.length - limit))
		if (
			!conversationHasAuditRecords(state, conversation.id) &&
			!state.tasks.some((task) => task.conversationId === conversation.id && taskPending(task))
		)
			dropConversationRecords(state, conversation.id);
}

export function trimRoomReceipts(state: HubState, roomId: string, limit = ROOM_RECEIPT_RETENTION): void {
	const cutoff = Date.now() - RECEIPT_TTL_MS;
	const stale = new Set(
		state.receipts
			.filter((receipt) => receipt.roomId === roomId && receipt.createdAt !== undefined && receipt.createdAt < cutoff)
			.map((receipt) => receipt.key),
	);
	if (stale.size)
		state.receipts = state.receipts.filter((receipt) => !(receipt.roomId === roomId && stale.has(receipt.key)));
	const room = state.receipts.filter((receipt) => receipt.roomId === roomId);
	if (room.length <= limit) return;
	const drop = new Set(room.slice(0, room.length - limit));
	state.receipts = state.receipts.filter((receipt) => !drop.has(receipt));
}

export function trimConversationHistory(state: HubState, roomId: string, limit = 500) {
	const protectedIds = new Set<string>();
	for (const task of state.tasks.filter(
		(t) => t.roomId === roomId && (taskPending(t) || taskHasImmutableEvidence(t)),
	)) {
		protectedIds.add(task.id);
		if (task.rootTaskId) protectedIds.add(task.rootTaskId);
		let ancestor = task.parentTaskId;
		while (ancestor && !protectedIds.has(ancestor)) {
			protectedIds.add(ancestor);
			ancestor = state.tasks.find((t) => t.id === ancestor && t.roomId === roomId)?.parentTaskId;
		}
	}
	const terminal = state.tasks.filter((t) => t.roomId === roomId && !taskPending(t) && !protectedIds.has(t.id));
	const remove = new Set(terminal.slice(0, -limit).map((t) => t.id));
	state.tasks = state.tasks.filter((t) => !remove.has(t.id));
	state.conversationMessages = state.conversationMessages.filter((m) => !remove.has(m.taskId));
}

export function conversationPage(state: HubState, conversationId: string, before?: string) {
	const all = state.conversationMessages.filter((m) => m.conversationId === conversationId);
	const end = before === undefined ? all.length : all.findIndex((m) => m.id === before);
	if (end < 0) throw Object.assign(new Error("Invalid conversation cursor"), { status: 400 });
	const messages: typeof all = [];
	const tasks: HubTask[] = [];
	let bytes = 0;
	let truncated = false;
	for (let i = end - 1; i >= 0 && messages.length < 100; i--) {
		let message = all[i];
		let task = state.tasks.find((t) => t.id === message.taskId);
		const taskId = task?.id;
		const includeTask = !!taskId && !tasks.some((t) => t.id === taskId);
		let size = Buffer.byteLength(JSON.stringify({ message, task: includeTask ? task : undefined }));
		if (!messages.length && size > 60 * 1024) {
			message = { ...message, text: message.text.slice(0, 1024) };
			if (task)
				task = {
					...task,
					text: task.text.slice(0, 1024),
					report: task.report?.slice(0, 1024),
					handoff: undefined,
					contract: undefined,
					contextManifest: undefined,
					artifact: undefined,
				};
			truncated = true;
			size = Buffer.byteLength(JSON.stringify({ message, task: includeTask ? task : undefined }));
		}
		if (messages.length && bytes + size > 60 * 1024) break;
		bytes += size;
		messages.unshift(message);
		if (includeTask && task) tasks.unshift(task);
	}
	return {
		messages,
		tasks,
		hasMore: end > messages.length,
		truncated: truncated || end > messages.length,
		nextBefore: end > messages.length ? messages[0]?.id : undefined,
	};
}

export function nextConversationTask(state: HubState, conversationId: string): HubTask | undefined {
	const conversation = state.conversations.find((entry) => entry.id === conversationId);
	if (!conversation || conversation.closed) return;
	const pending = state.tasks.filter((task) => task.conversationId === conversationId && taskPending(task));
	if (pending.some((task) => task.status !== "queued" || task.cancelRequested)) return;
	return pending[0];
}

export function advanceConversationTask(state: HubState, conversation: HubConversation, task: HubTask) {
	const current = state.tasks.find((entry) => entry.id === conversation.latestTaskId);
	if (current && current.id !== task.id && taskPending(current)) return;
	conversation.latestTaskId = task.id;
}

export function conversationStatus(state: HubState, conversation: HubConversation) {
	if (conversation.closed) return "closed";
	return state.tasks.find((task) => task.id === conversation.latestTaskId)?.status ?? "interrupted";
}

export function establishConversation(state: HubState, task: HubTask): HubConversation {
	const conversation: HubConversation = {
		id: randomUUID(),
		accountId: task.accountId,
		roomId: task.roomId,
		botId: task.botId,
		deviceId: task.deviceId,
		botRevision: task.botRevision,
		...(task.sourceBotId ? { sourceBotId: task.sourceBotId } : {}),
		...(task.sourceConversationId ? { sourceConversationId: task.sourceConversationId } : {}),
		...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
		name: task.text.slice(0, 80),
		rootTaskId: task.rootTaskId ?? task.id,
		dispatchDepth: task.dispatchDepth ?? 0,
		latestTaskId: task.id,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
	};
	task.conversationId = conversation.id;
	task.resume = false;
	state.conversations.push(conversation);
	return conversation;
}

export function recordConversationTurn(state: HubState, task: HubTask, key?: string, fingerprint?: string) {
	if (!task.conversationId) return;
	state.conversationMessages.push({
		id: randomUUID(),
		conversationId: task.conversationId,
		taskId: task.id,
		kind: task.kind ?? "message",
		text: task.text,
		sourceBotId: task.sourceBotId,
		requestId: task.requestId,
		idempotencyKey: key,
		fingerprint,
		createdAt: task.createdAt,
	});
}

export function queueParentResult(
	state: HubState,
	child: HubTask,
	limits?: { maxDispatchDepth?: number; maxDispatchBudget?: number },
): HubTask | undefined {
	if (
		child.cancelRequested ||
		!isTerminal(child.status) ||
		child.kind === "result" ||
		child.kind === "reply" ||
		!child.parentTaskId ||
		!child.report
	)
		return;
	if (state.tasks.some((task) => task.resultOfTaskId === child.id)) return;
	if (
		child.kind === "request" &&
		state.tasks.some(
			(task) => task.kind === "reply" && task.requestId === child.requestId && task.roomId === child.roomId,
		)
	)
		return;
	const parent = state.tasks.find((task) => task.id === child.parentTaskId);
	const conversation = state.conversations.find((entry) => entry.id === parent?.conversationId);
	const root = state.tasks.find((task) => task.id === child.rootTaskId);
	const bot =
		conversation &&
		state.bots.find((entry) => entry.id === conversation.botId && entry.enabled && entry.accountId === child.accountId);
	if (
		!parent ||
		!conversation ||
		conversation.closed ||
		!root ||
		!bot ||
		bot.deviceId !== conversation.deviceId ||
		bot.revision !== conversation.botRevision ||
		!state.rooms.some((room) => room.id === child.roomId && room.botIds.includes(bot.id)) ||
		(root.dispatchCount ?? 0) >= (limits?.maxDispatchBudget ?? 16) ||
		(child.dispatchDepth ?? 0) >= (limits?.maxDispatchDepth ?? 8)
	)
		return;
	root.dispatchCount = (root.dispatchCount ?? 0) + 1;
	const now = Date.now();
	const task: HubTask = {
		id: randomUUID(),
		attemptId: randomUUID(),
		accountId: child.accountId,
		roomId: child.roomId,
		botId: bot.id,
		botRevision: bot.revision,
		deviceId: bot.deviceId,
		sourceBotId: child.botId,
		conversationId: conversation.id,
		resume: true,
		kind: "result",
		resultOfTaskId: child.id,
		requestId: child.requestId,
		parentTaskId: child.id,
		rootTaskId: root.id,
		dispatchDepth: (child.dispatchDepth ?? 0) + 1,
		text: child.report,
		status: "queued",
		createdAt: now,
		updatedAt: now,
		...(parent.attenuatedTools ? { attenuatedTools: [...parent.attenuatedTools] } : {}),
	};
	state.tasks.push(task);
	advanceConversationTask(state, conversation, task);
	conversation.updatedAt = now;
	recordConversationTurn(state, task);
	return task;
}
