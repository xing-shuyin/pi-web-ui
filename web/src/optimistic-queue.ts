import type { PromptAttachment, UiContentBlock, UiMessage, UiState } from "./types";
import { removeQueuedByIndexOrText } from "../../server/queue-utils.js";
import { formatStreamingPrompt, readTextQuote, splitQuotedPrompt } from "../../server/text-quote.js";

export const OPTIMISTIC_ADD_TTL_MS = 15_000;
export const OPTIMISTIC_REMOVE_TTL_MS = 3_000;
export const OPTIMISTIC_ECHO_TTL_MS = 15_000;
export const OPTIMISTIC_ECHO_ID_PREFIX = "echo-";

export function makeEchoMessageId(seq: number): string {
	return `${OPTIMISTIC_ECHO_ID_PREFIX}${seq}`;
}

export function isEchoMessageId(id: string | undefined): boolean {
	return typeof id === "string" && id.startsWith(OPTIMISTIC_ECHO_ID_PREFIX);
}

export interface PendingQueueAdd {
	conversationId: string;
	kind: "steer" | "followUp";
	rawText: string;
	formattedText: string;
	baselineQueueMatches: number;
	baselineUserMsgMatches: number;
	createdAt: number;
}

export interface PendingQueueRemove {
	conversationId: string;
	kind: "steer" | "followUp";
	text: string;
	index?: number;
	expectedRemainingMatches: number;
	createdAt: number;
}

export interface PendingPromptEcho {
	conversationId: string;
	rawText: string;
	messageId: string;
	baselineUserMsgMatches: number;
	createdAt: number;
}

export interface OptimisticQueueTracker {
	adds: PendingQueueAdd[];
	removes: PendingQueueRemove[];
	echoes: PendingPromptEcho[];
}

export function createOptimisticQueueTracker(): OptimisticQueueTracker {
	return { adds: [], removes: [], echoes: [] };
}

function escapeXmlAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatOptimisticQueuedPrompt(text: string, attachments?: readonly PromptAttachment[]): string {
	const quotes = (attachments ?? [])
		.filter((a) => a.mode === "quote")
		.map((a) => readTextQuote(a.quote))
		.filter((q) => q !== null);
	const imageNames: string[] = [];
	const textAsides: string[] = [];

	for (const att of attachments ?? []) {
		if (att.mode === "quote") continue;
		if (att.imageData) {
			imageNames.push(att.name || "image.png");
			continue;
		}
		if (att.fileData) {
			const name = att.name || "file";
			textAsides.push(`<file path="${escapeXmlAttr(name)}" />`);
			continue;
		}
		if (att.mode === "page") {
			const url = att.path || "";
			const title = att.name || url;
			textAsides.push(`<browser-page url="${escapeXmlAttr(url)}" title="${escapeXmlAttr(title)}"></browser-page>`);
			continue;
		}
		if (att.mode === "canvas") {
			textAsides.push(
				`<canvas-ref id="${escapeXmlAttr(att.path)}" title="${escapeXmlAttr(att.name || att.path)}"></canvas-ref>`,
			);
			continue;
		}
		if (att.mode === "conversation") {
			const title = att.name || att.conversationId || att.sessionPath || "conversation";
			textAsides.push(`<conversation-ref title="${escapeXmlAttr(title)}"></conversation-ref>`);
			continue;
		}
		if (att.path) {
			const linesAttr = att.lines ? ` lines="${att.lines.start}-${att.lines.end}"` : "";
			textAsides.push(`<file path="${escapeXmlAttr(att.path)}"${linesAttr} />`);
		}
	}

	return formatStreamingPrompt(text, textAsides, quotes, imageNames);
}

export function normalizeQueuedPromptKey(value: string): string {
	const parsed = splitQuotedPrompt(value);
	const body = parsed.text.trim();
	const quoteSig = parsed.quotes.map((q) => `${q.role}:${q.messageId}:${q.text.trim()}`).join("|");
	return `${body}\u0000${quoteSig}`;
}

export function isSameQueuedPrompt(a: string, b: string): boolean {
	if (a === b) return true;
	return normalizeQueuedPromptKey(a) === normalizeQueuedPromptKey(b);
}

export function countMatchingInQueue(list: readonly string[], target: string): number {
	let count = 0;
	for (const item of list) {
		if (isSameQueuedPrompt(item, target)) count += 1;
	}
	return count;
}

export function countMatchingUserMessages(messages: readonly UiMessage[], rawText: string): number {
	const norm = rawText.trim();
	let count = 0;
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		if (isEchoMessageId(msg.id)) continue;
		const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
		const msgText = (textBlock?.text ?? "").trim();
		if (msgText === norm) count += 1;
	}
	return count;
}

export function shouldOptimisticallyQueuePrompt(opts: {
	state: UiState | null;
	text: string;
	attachments?: readonly PromptAttachment[];
	queue?: boolean;
	goalReviewing?: boolean;
}): boolean {
	const { state, text, attachments, queue = false, goalReviewing = false } = opts;
	if (!state || !state.isStreaming) return false;
	if (state.delegateMode === true) return false;
	const trimmed = (text ?? "").trim();
	const hasAttach = Boolean(attachments && attachments.length > 0);
	if (!trimmed && !hasAttach) return false;
	if (trimmed.startsWith("/")) return false;
	if (goalReviewing && !queue) return false;
	return true;
}

export function shouldOptimisticallyEchoPrompt(opts: {
	state: UiState | null;
	text: string;
	attachments?: readonly PromptAttachment[];
}): boolean {
	const { state, text, attachments } = opts;
	if (!state || state.isStreaming) return false;
	if (state.delegateMode === true) return false;
	const trimmed = (text ?? "").trim();
	const hasAttach = Boolean(attachments && attachments.length > 0);
	if (!trimmed && !hasAttach) return false;
	if (trimmed.startsWith("/")) return false;
	return true;
}

export function recordOptimisticPromptEcho(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
	opts: {
		text: string;
		attachments?: readonly PromptAttachment[];
		now?: number;
	},
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	const now = opts.now ?? Date.now();
	if (!state || !shouldOptimisticallyEchoPrompt({ state, text: opts.text, attachments: opts.attachments })) {
		return { tracker, state };
	}

	const rawText = (opts.text ?? "").trim();
	const seq = nextEchoSeq(tracker);
	const entry: PendingPromptEcho = {
		conversationId: state.conversationId,
		rawText,
		messageId: makeEchoId(seq),
		baselineUserMsgMatches: countMatchingUserMessages(state.messages, rawText),
		createdAt: now,
	};
	const echoMessage = buildEchoMessage(entry, now);

	return {
		tracker: { ...tracker, echoes: [...echoesOf(tracker), entry] },
		state: { ...state, messages: [...state.messages, echoMessage] },
	};
}

function echoesOf(tracker: OptimisticQueueTracker): PendingPromptEcho[] {
	return tracker.echoes ?? [];
}

function nextEchoSeq(tracker: OptimisticQueueTracker): number {
	let max = 0;
	for (const e of echoesOf(tracker)) {
		const n = Number.parseInt(e.messageId.slice(OPTIMISTIC_ECHO_ID_PREFIX.length), 10);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max + 1;
}

function makeEchoId(seq: number): string {
	return makeEchoMessageId(seq);
}

function buildEchoMessage(entry: PendingPromptEcho, createdAt: number): UiMessage {
	const content: UiContentBlock[] = [];
	if (entry.rawText) content.push({ type: "text", text: entry.rawText });
	return {
		id: entry.messageId,
		role: "user",
		content,
		timestamp: createdAt,
	};
}

export function recordOptimisticQueueAdd(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
	opts: {
		text: string;
		attachments?: readonly PromptAttachment[];
		queue?: boolean;
		engine?: string;
		goalReviewing?: boolean;
		now?: number;
	},
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	const now = opts.now ?? Date.now();
	if (
		!shouldOptimisticallyQueuePrompt({
			state,
			text: opts.text,
			attachments: opts.attachments,
			queue: opts.queue,
			goalReviewing: opts.goalReviewing,
		}) ||
		!state
	) {
		return { tracker, state };
	}

	const steerSupported = state?.engineCapabilities?.steer !== false && opts.engine !== "dsh";
	const kind: "steer" | "followUp" = opts.queue || !steerSupported ? "followUp" : "steer";
	const formattedText = formatOptimisticQueuedPrompt(opts.text, opts.attachments);
	const rawText = splitQuotedPrompt(formattedText).text.trim();
	const currentList = kind === "steer" ? state.queue.steering : state.queue.followUp;

	const unconfirmedSameCount = tracker.adds.filter(
		(a) =>
			a.conversationId === state.conversationId &&
			a.kind === kind &&
			isSameQueuedPrompt(a.formattedText, formattedText),
	).length;
	const currentTotalMatches = countMatchingInQueue(currentList, formattedText);
	const baselineQueueMatches = Math.max(0, currentTotalMatches - unconfirmedSameCount);
	const baselineUserMsgMatches = countMatchingUserMessages(state.messages, rawText);

	const addEntry: PendingQueueAdd = {
		conversationId: state.conversationId,
		kind,
		rawText,
		formattedText,
		baselineQueueMatches,
		baselineUserMsgMatches,
		createdAt: now,
	};

	const nextQueue =
		kind === "steer"
			? { ...state.queue, steering: [...state.queue.steering, formattedText] }
			: { ...state.queue, followUp: [...state.queue.followUp, formattedText] };

	return {
		tracker: {
			adds: [...tracker.adds, addEntry],
			removes: tracker.removes,
			echoes: echoesOf(tracker),
		},
		state: {
			...state,
			queue: nextQueue,
		},
	};
}

export function recordOptimisticQueueRemove(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
	opts: {
		kind: "steer" | "followUp";
		text: string;
		index?: number;
		now?: number;
	},
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	if (!state) return { tracker, state };
	const now = opts.now ?? Date.now();
	const { kind, text, index } = opts;
	const currentList = kind === "steer" ? state.queue.steering : state.queue.followUp;
	const nextList = removeQueuedByIndexOrText(currentList, text, index);

	let nextAdds = tracker.adds;
	const pendingAddIdx = nextAdds.findIndex(
		(a) => a.conversationId === state.conversationId && a.kind === kind && isSameQueuedPrompt(a.formattedText, text),
	);
	if (pendingAddIdx >= 0) {
		nextAdds = [...nextAdds.slice(0, pendingAddIdx), ...nextAdds.slice(pendingAddIdx + 1)];
	}

	const expectedRemainingMatches = countMatchingInQueue(nextList, text);
	const removeEntry: PendingQueueRemove = {
		conversationId: state.conversationId,
		kind,
		text,
		index,
		expectedRemainingMatches,
		createdAt: now,
	};

	const nextQueue = kind === "steer" ? { ...state.queue, steering: nextList } : { ...state.queue, followUp: nextList };

	return {
		tracker: {
			adds: nextAdds,
			removes: [...tracker.removes, removeEntry],
			echoes: echoesOf(tracker),
		},
		state: {
			...state,
			queue: nextQueue,
		},
	};
}

export function reconcileOptimisticQueue(
	tracker: OptimisticQueueTracker,
	incomingState: UiState,
	now = Date.now(),
): { tracker: OptimisticQueueTracker; state: UiState } {
	if (tracker.adds.length === 0 && tracker.removes.length === 0) {
		return { tracker, state: incomingState };
	}

	const convId = incomingState.conversationId;
	if (!incomingState.isStreaming) {
		const keptAdds = tracker.adds.filter(
			(a) => a.conversationId !== convId && now - a.createdAt < OPTIMISTIC_ADD_TTL_MS,
		);
		const keptRemoves = tracker.removes.filter(
			(r) => r.conversationId !== convId && now - r.createdAt < OPTIMISTIC_REMOVE_TTL_MS,
		);
		if (keptAdds.length === tracker.adds.length && keptRemoves.length === tracker.removes.length) {
			return { tracker, state: incomingState };
		}
		return {
			tracker: { ...tracker, adds: keptAdds, removes: keptRemoves },
			state: incomingState,
		};
	}

	let steering = [...incomingState.queue.steering];
	let followUp = [...incomingState.queue.followUp];
	let queueMutated = false;

	const nextRemoves: PendingQueueRemove[] = [];
	for (const rem of tracker.removes) {
		if (now - rem.createdAt >= OPTIMISTIC_REMOVE_TTL_MS) continue;
		if (rem.conversationId !== convId) {
			nextRemoves.push(rem);
			continue;
		}
		const targetList = rem.kind === "steer" ? steering : followUp;
		const serverMatches = countMatchingInQueue(targetList, rem.text);
		if (serverMatches > rem.expectedRemainingMatches) {
			let stripped = removeQueuedByIndexOrText(targetList, rem.text, rem.index);
			if (stripped.length === targetList.length) {
				const fallbackIdx = targetList.findIndex((item) => isSameQueuedPrompt(item, rem.text));
				if (fallbackIdx >= 0) {
					stripped = [...targetList.slice(0, fallbackIdx), ...targetList.slice(fallbackIdx + 1)];
				}
			}
			if (rem.kind === "steer") steering = stripped;
			else followUp = stripped;
			queueMutated = true;
			nextRemoves.push(rem);
		}
	}

	const nextAdds: PendingQueueAdd[] = [];
	const claimedServerExtras = new Map<string, number>();

	for (const add of tracker.adds) {
		if (now - add.createdAt >= OPTIMISTIC_ADD_TTL_MS) continue;
		if (add.conversationId !== convId) {
			nextAdds.push(add);
			continue;
		}
		const targetList = add.kind === "steer" ? steering : followUp;
		const key = `${add.kind}:${normalizeQueuedPromptKey(add.formattedText)}`;
		const claimed = claimedServerExtras.get(key) ?? 0;

		const serverQueueMatches = countMatchingInQueue(targetList, add.formattedText);
		const serverUserMsgMatches = countMatchingUserMessages(incomingState.messages, add.rawText);

		const confirmedInQueue = serverQueueMatches > add.baselineQueueMatches + claimed;
		const confirmedInMessages = serverUserMsgMatches > add.baselineUserMsgMatches;

		if (confirmedInQueue) {
			claimedServerExtras.set(key, claimed + 1);
			continue;
		}
		if (confirmedInMessages) {
			continue;
		}

		if (add.kind === "steer") {
			steering.push(add.formattedText);
		} else {
			followUp.push(add.formattedText);
		}
		claimedServerExtras.set(key, claimed + 1);
		queueMutated = true;
		nextAdds.push(add);
	}

	const nextTracker =
		nextAdds.length === tracker.adds.length && nextRemoves.length === tracker.removes.length
			? tracker
			: { ...tracker, adds: nextAdds, removes: nextRemoves };

	if (!queueMutated) {
		return { tracker: nextTracker, state: incomingState };
	}

	return {
		tracker: nextTracker,
		state: {
			...incomingState,
			queue: { steering, followUp },
		},
	};
}

export function rollbackUnconfirmedOptimisticAdds(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	if (!state) return { tracker, state };
	const convId = state.conversationId;
	const toRollback = tracker.adds.filter((a) => a.conversationId === convId);
	const echoesToRollback = echoesOf(tracker).filter((e) => e.conversationId === convId);
	if (toRollback.length === 0 && echoesToRollback.length === 0) return { tracker, state };

	let steering = [...state.queue.steering];
	let followUp = [...state.queue.followUp];
	for (const item of toRollback) {
		if (item.kind === "steer") {
			steering = removeQueuedByIndexOrText(steering, item.formattedText);
		} else {
			followUp = removeQueuedByIndexOrText(followUp, item.formattedText);
		}
	}

	const echoIds = new Set(echoesToRollback.map((e) => e.messageId));
	const nextMessages = echoIds.size > 0 ? state.messages.filter((m) => !echoIds.has(m.id)) : state.messages;

	return {
		tracker: {
			adds: tracker.adds.filter((a) => a.conversationId !== convId),
			removes: tracker.removes,
			echoes: echoesOf(tracker).filter((e) => e.conversationId !== convId),
		},
		state: {
			...state,
			queue: { steering, followUp },
			messages: nextMessages,
		},
	};
}

export function reconcileOptimisticPromptEchoes(
	tracker: OptimisticQueueTracker,
	incomingState: UiState,
	now = Date.now(),
): { tracker: OptimisticQueueTracker; state: UiState } {
	if (echoesOf(tracker).length === 0) return { tracker, state: incomingState };
	if (incomingState.isStreaming) {
		const staleIds = new Set<string>();
		const kept: PendingPromptEcho[] = [];
		for (const e of echoesOf(tracker)) {
			if (now - e.createdAt >= OPTIMISTIC_ECHO_TTL_MS) {
				if (e.conversationId === incomingState.conversationId) staleIds.add(e.messageId);
				continue;
			}
			if (e.conversationId === incomingState.conversationId) staleIds.add(e.messageId);
			else kept.push(e);
		}
		const nextTracker = kept.length === echoesOf(tracker).length ? tracker : { ...tracker, echoes: kept };
		if (staleIds.size === 0) return { tracker: nextTracker, state: incomingState };
		return {
			tracker: nextTracker,
			state: { ...incomingState, messages: incomingState.messages.filter((m) => !staleIds.has(m.id)) },
		};
	}

	const convId = incomingState.conversationId;
	const keptEchoes: PendingPromptEcho[] = [];
	const staleEchoIds = new Set<string>();
	const appendEchoes: UiMessage[] = [];

	for (const echo of echoesOf(tracker)) {
		if (now - echo.createdAt >= OPTIMISTIC_ECHO_TTL_MS) {
			if (echo.conversationId === convId) staleEchoIds.add(echo.messageId);
			continue;
		}
		if (echo.conversationId !== convId) {
			keptEchoes.push(echo);
			continue;
		}
		const serverMatches = countMatchingUserMessages(incomingState.messages, echo.rawText);
		if (serverMatches > echo.baselineUserMsgMatches) {
			staleEchoIds.add(echo.messageId);
			continue;
		}
		keptEchoes.push(echo);
		if (!incomingState.messages.some((m) => m.id === echo.messageId)) {
			appendEchoes.push(buildEchoMessage(echo, echo.createdAt));
		}
	}

	const nextTracker =
		keptEchoes.length === echoesOf(tracker).length
			? tracker
			: { adds: tracker.adds, removes: tracker.removes, echoes: keptEchoes };
	if (staleEchoIds.size === 0 && appendEchoes.length === 0) {
		return { tracker: nextTracker, state: incomingState };
	}

	const messages =
		staleEchoIds.size > 0 ? incomingState.messages.filter((m) => !staleEchoIds.has(m.id)) : [...incomingState.messages];
	const nextState: UiState = {
		...incomingState,
		messages: appendEchoes.length > 0 ? [...messages, ...appendEchoes] : messages,
	};
	return { tracker: nextTracker, state: nextState };
}
