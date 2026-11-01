import type { GroupHistoryMessage, GroupTaskContext } from "./group-context.js";
import { planGroupContext } from "./group-context-delta.js";

export const GROUP_CONTEXT_CUSTOM_TYPE = "device-group-context";

/** Counts history chunks, not unique IDs. All byte sizes are UTF-8, never tokens.
 * source/delivered/omitted bytes measure row.text only; payloadBytes measures the
 * exact injected JSON, including metadata. Repair sizes cover request-only injection.
 */
export interface GroupContextMetrics {
	version: 1;
	sourceMessages: number;
	sourceBytes: number;
	deliveredMessages: number;
	deliveredBytes: number;
	omittedDuplicateMessages: number;
	omittedDuplicateBytes: number;
	payloadBytes: number;
	mode: "snapshot" | "delta" | "none";
	requestOnly: boolean;
	repairMessages: number;
	repairBytes: number;
}

/** Pure measurement of a planner result; does not change coverage or drop rows. */
export function extractGroupContextMetrics(
	current: Readonly<GroupTaskContext>,
	delivered: readonly GroupHistoryMessage[],
	payload: string,
	mode: GroupContextMetrics["mode"],
	requestOnly = false,
): GroupContextMetrics {
	const sourceBytes = current.messages.reduce((bytes, row) => bytes + Buffer.byteLength(row.text, "utf8"), 0);
	const deliveredBytes = delivered.reduce((bytes, row) => bytes + Buffer.byteLength(row.text, "utf8"), 0);
	const payloadBytes = Buffer.byteLength(payload, "utf8");
	return {
		version: 1,
		sourceMessages: current.messages.length,
		sourceBytes,
		deliveredMessages: delivered.length,
		deliveredBytes,
		omittedDuplicateMessages: current.messages.length - delivered.length,
		omittedDuplicateBytes: sourceBytes - deliveredBytes,
		payloadBytes,
		mode,
		requestOnly,
		repairMessages: requestOnly ? delivered.length : 0,
		repairBytes: requestOnly ? payloadBytes : 0,
	};
}

const METRIC_SESSION_LIMIT = 50;
const METRIC_SAMPLE_LIMIT = 100;
const metricSessions = new Map<string, GroupContextMetrics[]>();

/** Process-local bounded diagnostics only; never used as delivery evidence. */
export function recordGroupContextMetrics(sessionId: string, metrics: GroupContextMetrics): void {
	const samples = metricSessions.get(sessionId) ?? [];
	// Explicit scalar projection prevents extra caller properties retaining content/credentials.
	samples.push({
		version: 1,
		sourceMessages: metrics.sourceMessages,
		sourceBytes: metrics.sourceBytes,
		deliveredMessages: metrics.deliveredMessages,
		deliveredBytes: metrics.deliveredBytes,
		omittedDuplicateMessages: metrics.omittedDuplicateMessages,
		omittedDuplicateBytes: metrics.omittedDuplicateBytes,
		payloadBytes: metrics.payloadBytes,
		mode: metrics.mode,
		requestOnly: metrics.requestOnly,
		repairMessages: metrics.repairMessages,
		repairBytes: metrics.repairBytes,
	});
	if (samples.length > METRIC_SAMPLE_LIMIT) samples.shift();
	metricSessions.delete(sessionId);
	metricSessions.set(sessionId, samples);
	if (metricSessions.size > METRIC_SESSION_LIMIT) metricSessions.delete(metricSessions.keys().next().value!);
}

/** Detached chronological snapshot; old sessions/samples may have been evicted. */
export function getGroupContextMetrics(sessionId: string) {
	return {
		version: 1 as const,
		processLocal: true as const,
		sampleLimit: METRIC_SAMPLE_LIMIT,
		sampleCount: metricSessions.get(sessionId)?.length ?? 0,
		durableDeliveries: (metricSessions.get(sessionId) ?? []).filter((sample) => !sample.requestOnly).length,
		requests: (metricSessions.get(sessionId) ?? []).filter((sample) => sample.requestOnly).length,
		// Inspection stays small enough for tool receipts; counters cover the retained 100 samples.
		lastSample: metricSessions.get(sessionId)?.at(-1) ? { ...metricSessions.get(sessionId)!.at(-1)! } : null,
		samples: (metricSessions.get(sessionId) ?? []).slice(-10).map((sample) => ({ ...sample })),
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}
function position(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function historyMessage(value: unknown): value is GroupHistoryMessage {
	if (!record(value) || !record(value.sender)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.text === "string" &&
		(value.sender.type === "human" || value.sender.type === "bot") &&
		typeof value.sender.id === "string" &&
		typeof value.sender.name === "string" &&
		typeof value.createdAt === "number" &&
		Number.isFinite(value.createdAt) &&
		(value.targetBotIds === undefined ||
			(Array.isArray(value.targetBotIds) && value.targetBotIds.every((id) => typeof id === "string"))) &&
		position(value.textStart) &&
		position(value.textEnd) &&
		position(value.fullTextLength) &&
		value.textStart <= value.textEnd &&
		value.textEnd <= value.fullTextLength &&
		value.text.length === value.textEnd - value.textStart
	);
}
function taskContext(value: unknown): value is GroupTaskContext {
	return (
		record(value) &&
		typeof value.roomId === "string" &&
		typeof value.roomName === "string" &&
		(value.primaryBotId === undefined || typeof value.primaryBotId === "string") &&
		Array.isArray(value.members) &&
		value.members.every(
			(member) => record(member) && typeof member.id === "string" && typeof member.name === "string",
		) &&
		nullableString(value.throughMessageId) &&
		nullableString(value.nextBefore) &&
		typeof value.truncated === "boolean" &&
		position(value.retentionLimit) &&
		value.retentionLimit > 0 &&
		Array.isArray(value.messages) &&
		value.messages.every(historyMessage)
	);
}

function parseContext(content: unknown): GroupTaskContext | undefined {
	// Custom messages can store either a string or text blocks. Images and other blocks
	// cannot establish exact JSON delivery evidence; details never reach the model.
	if (Array.isArray(content)) {
		if (!content.every((block) => record(block) && block.type === "text" && typeof block.text === "string"))
			return undefined;
		content = content.map((block) => block.text).join("");
	}
	if (typeof content !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(content);
		return taskContext(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function metadata(context: Readonly<GroupTaskContext>): string {
	return JSON.stringify([
		context.roomId,
		context.roomName,
		context.primaryBotId,
		context.members.map((member) => [member.id, member.name]),
		context.throughMessageId,
		context.nextBefore,
		context.truncated,
		context.retentionLimit,
	]);
}

function coverage(current: Readonly<GroupTaskContext>, messages: readonly unknown[], botId?: string, request = false) {
	let previous: GroupTaskContext | undefined;
	let metadataPresent = false;
	const retained = new Set<GroupHistoryMessage>();
	const currentIds = new Set(current.messages.map((message) => message.id));
	for (const message of messages) {
		if (!record(message) || message.role !== "custom" || message.customType !== GROUP_CONTEXT_CUSTOM_TYPE) continue;
		// Request repairs are never durable delivery evidence.
		if (!request && record(message.details) && message.details.requestOnly === true) continue;
		if (
			botId !== undefined &&
			(!record(message.details) || message.details.version !== 1 || message.details.botId !== botId)
		)
			continue;
		const context = parseContext(message.content);
		if (!context || context.roomId !== current.roomId) continue;
		if (metadata(context) === metadata(current)) metadataPresent = true;
		// Keep at most the current window's exact chunks, rather than accumulating the
		// full session history. Let the planner define chunk equality in one place.
		const candidates = context.messages.filter((row) => currentIds.has(row.id));
		const missing = new Set(
			planGroupContext(current, { ...context, throughMessageId: null, messages: candidates }).messages,
		);
		for (const row of current.messages) if (!missing.has(row)) retained.add(row);
		previous = { ...context, messages: [...retained] };
	}
	return { previous, metadataPresent };
}

/** Only active projected custom-message content establishes durable delivery coverage. */
export function groupContextMessage(current: Readonly<GroupTaskContext>, messages: readonly unknown[], botId?: string) {
	const planned = planGroupContext(current, coverage(current, messages, botId).previous);
	const content = JSON.stringify(planned);
	return {
		customType: GROUP_CONTEXT_CUSTOM_TYPE,
		content,
		display: false,
		details: {
			version: 1,
			...(botId === undefined ? {} : { botId }),
			metrics: extractGroupContextMetrics(current, planned.messages, content, planned.delivery.mode),
		},
	};
}

/** Repair the final request after SDK compaction/routing, without altering the transcript.
 * Anchor continuity is irrelevant here: actual exact chunk coverage determines missing rows.
 */
export function repairGroupContextRequest<T>(
	current: Readonly<GroupTaskContext>,
	messages: T[],
	botId: string,
): T[] | (T | ReturnType<typeof requestMessage>)[] {
	const { previous, metadataPresent } = coverage(current, messages, botId, true);
	const missing = planGroupContext(current, previous && { ...previous, throughMessageId: null }).messages;
	if (missing.length === 0 && metadataPresent) return messages;
	return [...messages, requestMessage(current, missing, botId, previous ? "delta" : "snapshot")];
}

function requestMessage(
	current: Readonly<GroupTaskContext>,
	missing: GroupHistoryMessage[],
	botId: string,
	mode: "snapshot" | "delta",
) {
	const content = JSON.stringify({ ...current, messages: missing, delivery: { mode } });
	return {
		role: "custom" as const,
		customType: GROUP_CONTEXT_CUSTOM_TYPE,
		content,
		display: false,
		timestamp: Date.now(),
		details: {
			version: 1,
			botId,
			requestOnly: true,
			metrics: extractGroupContextMetrics(current, missing, content, mode, true),
		},
	};
}
