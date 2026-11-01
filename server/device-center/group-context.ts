import type { Bot, Room, RoomMessage } from "./store.js";

export const GROUP_RETENTION_LIMIT = 500;
export const GROUP_CONTEXT_BYTES = 24 * 1024;
const PAGE_BYTES = 24 * 1024;

export interface GroupHistoryMessage {
	id: string;
	text: string;
	sender: { type: "human" | "bot"; id: string; name: string };
	createdAt: number;
	targetBotIds?: string[];
	textStart: number;
	textEnd: number;
	fullTextLength: number;
}
export interface GroupHistoryPage {
	roomId: string;
	messages: GroupHistoryMessage[];
	nextBefore: string | null;
	truncated: boolean;
	retentionLimit: number;
}
export interface GroupTaskContext extends GroupHistoryPage {
	roomName: string;
	primaryBotId?: string;
	members: { id: string; name: string }[];
	throughMessageId: string | null;
}

function project(message: RoomMessage, start = 0, end = message.text.length): GroupHistoryMessage {
	return {
		id: message.id,
		text: message.text.slice(start, end),
		sender: { type: message.sender.type, id: message.sender.id, name: message.sender.name },
		createdAt: message.createdAt,
		...(message.targetBotIds ? { targetBotIds: message.targetBotIds } : {}),
		textStart: start,
		textEnd: end,
		fullTextLength: message.text.length,
	};
}
function cursor(roomId: string, id: string, end: number): string {
	return Buffer.from(JSON.stringify([roomId, id, end])).toString("base64url");
}
function invalidCursor(): never {
	throw Object.assign(new Error("History cursor expired or invalid; read the latest page again"), { status: 409 });
}

/** Stable message anchors survive appends. Clear/retention makes old anchors fail explicitly.
 * Oversized messages are paged in reverse text chunks, without dropping their middle. */
export function groupHistoryPage(
	roomId: string,
	messages: readonly RoomMessage[],
	before?: string,
	budget = PAGE_BYTES,
): GroupHistoryPage {
	const rows = messages.filter((message) => message.roomId === roomId);
	let index = rows.length - 1;
	let end = rows[index]?.text.length ?? 0;
	if (before !== undefined) {
		let value: unknown;
		try {
			if (before.length > 256 || !/^[A-Za-z0-9_-]+$/.test(before)) invalidCursor();
			value = JSON.parse(Buffer.from(before, "base64url").toString("utf8"));
		} catch {
			invalidCursor();
		}
		if (
			!Array.isArray(value) ||
			value.length !== 3 ||
			value[0] !== roomId ||
			typeof value[1] !== "string" ||
			!Number.isSafeInteger(value[2])
		)
			invalidCursor();
		index = rows.findIndex((message) => message.id === value[1]);
		if (index < 0 || value[2] < 0 || value[2] > rows[index].text.length) invalidCursor();
		end = value[2];
		if (end === 0) {
			index--;
			end = rows[index]?.text.length ?? 0;
		}
	}
	const page: GroupHistoryPage = {
		roomId,
		messages: [],
		nextBefore: null,
		truncated: false,
		retentionLimit: GROUP_RETENTION_LIMIT,
	};
	const fits = (items: GroupHistoryMessage[]) =>
		Buffer.byteLength(JSON.stringify({ ...page, messages: items, nextBefore: "x".repeat(256), truncated: true })) <=
		budget;
	while (index >= 0) {
		const row = rows[index];
		const item = project(row, 0, end);
		if (fits([item, ...page.messages])) {
			page.messages.unshift(item);
			index--;
			end = rows[index]?.text.length ?? 0;
			continue;
		}
		if (page.messages.length) break;
		// Keep the latest suffix of a large row; subsequent pages return every earlier chunk.
		let low = 0,
			high = end;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (fits([project(row, mid, end)])) high = mid;
			else low = mid + 1;
		}
		let start = low;
		// Never divide a UTF-16 surrogate pair across chunks.
		if (start > 0 && /[\uDC00-\uDFFF]/.test(row.text[start] ?? "")) start++;
		if (start >= end || !fits([project(row, start, end)])) throw new Error("History metadata exceeds page budget");
		page.messages.unshift(project(row, start, end));
		end = start;
		break;
	}
	if (index >= 0) {
		page.nextBefore = cursor(roomId, rows[index].id, end);
		page.truncated = true;
	}
	return page;
}

/** Captured at dispatch, before any parallel recipient can publish a response. */
export function groupTaskContext(room: Room, bots: readonly Bot[], messages: readonly RoomMessage[]): GroupTaskContext {
	const members = room.botIds.map((id) => ({ id, name: bots.find((bot) => bot.id === id)?.name ?? id }));
	const metadata = {
		roomName: room.name,
		...(room.primaryBotId && room.botIds.includes(room.primaryBotId) ? { primaryBotId: room.primaryBotId } : {}),
		members,
		throughMessageId: messages.filter((message) => message.roomId === room.id).at(-1)?.id ?? null,
	};
	const page = groupHistoryPage(
		room.id,
		messages,
		undefined,
		GROUP_CONTEXT_BYTES - Buffer.byteLength(JSON.stringify(metadata)) - 64,
	);
	return { ...page, ...metadata };
}
