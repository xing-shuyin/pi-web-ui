import { randomUUID } from "node:crypto";
import { hashSecret, type RoomMessage } from "./store.js";

/**
 * 私聊 → 群投递的纯逻辑（消息体构建与幂等指纹）。
 * 路由层只负责鉴权 / 取数 / 写状态，见 `hub.ts` 的 `POST /api/bots/:id/share`。
 *
 * 硬约束：投递只产生一条带 `sharedFrom` 的群消息，不触发路由、不派活；
 * 「公布」与「派活」是两件事。
 */

export type ShareMode = "as_bot" | "as_forward";

export function shareContentFingerprint(input: {
	mode: ShareMode;
	note: string;
	sourceRoomId: string;
	targetRoomId: string;
	messageIds: readonly string[];
}): string {
	return hashSecret(
		JSON.stringify({
			mode: input.mode,
			note: input.note,
			sourceRoomId: input.sourceRoomId,
			targetRoomId: input.targetRoomId,
			messageIds: [...input.messageIds].sort(),
		}),
	);
}

export interface SharedMessageInput {
	mode: ShareMode;
	note: string;
	bot: { id: string; name: string };
	owner: { id: string; username: string };
	targetRoomId: string;
	sourceRoomId: string;
	messageIds: readonly string[];
	picked: readonly { sender: { name: string }; text: string }[];
	now?: number;
}

export function buildSharedMessage(input: SharedMessageInput): RoomMessage {
	let excerpt = input.picked
		.map((message) => `${message.sender.name}: ${message.text.replace(/\s+/g, " ").trim().slice(0, 1200)}`)
		.join("\n");
	if (Buffer.byteLength(excerpt, "utf8") > 8000) excerpt = `${excerpt.slice(0, 3800)}…`;
	const body = [
		...(input.mode === "as_forward" ? [`> 来自与 ${input.bot.name} 的私聊 / forwarded from a private chat`] : []),
		...(input.note ? [input.note] : []),
		excerpt,
	]
		.filter(Boolean)
		.join("\n");
	if (Buffer.byteLength(body, "utf8") > 16000)
		throw Object.assign(new Error("Shared message is too large"), { status: 413 });
	const now = input.now ?? Date.now();
	return {
		id: randomUUID(),
		roomId: input.targetRoomId,
		accountId: input.owner.id,
		text: body,
		sender:
			input.mode === "as_bot"
				? { type: "bot", id: input.bot.id, name: input.bot.name }
				: { type: "human", id: input.owner.id, name: input.owner.username },
		createdAt: now,
		taskIds: [],
		sharedFrom: {
			mode: input.mode,
			sourceRoomId: input.sourceRoomId,
			botId: input.bot.id,
			messageIds: [...input.messageIds],
		},
	};
}
