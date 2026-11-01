import { describe, expect, it } from "vitest";
import { groupHistoryPage, groupTaskContext, GROUP_CONTEXT_BYTES } from "../../server/device-center/group-context.js";
import type { RoomMessage } from "../../server/device-center/store.js";
const message = (id: string, text = id, roomId = "room"): RoomMessage => ({
	id,
	roomId,
	accountId: "account",
	text,
	sender: { type: "human", id: "human", name: "Alice", sourceDeviceId: "private-routing" },
	createdAt: 1,
	taskIds: [],
});
describe("group shared context", () => {
	it("paginates escaped unicode without losing any text or crossing room boundaries", () => {
		const original = '讨论😀\\"\n'.repeat(8000);
		const rows = [message("other", "SECRET", "other"), message("old"), message("huge", original), message("new")];
		const chunks: { textStart: number; text: string }[] = [];
		let before: string | undefined;
		let count = 0;
		do {
			const page = groupHistoryPage("room", rows, before, 1800);
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1800);
			expect(JSON.stringify(page)).not.toMatch(/SECRET|private-routing|accountId/);
			chunks.push(...page.messages.filter((row) => row.id === "huge"));
			before = page.nextBefore ?? undefined;
			expect(++count).toBeLessThan(1000);
		} while (before);
		expect(
			chunks
				.sort((a, b) => a.textStart - b.textStart)
				.map((row) => row.text)
				.join(""),
		).toBe(original);
	});
	it("uses stable anchors across appends and rejects expired and cross-room cursors", () => {
		const rows = [message("old"), message("large", "x".repeat(5000))];
		const first = groupHistoryPage("room", rows, undefined, 1500);
		expect(
			groupHistoryPage("room", [...rows, message("appended")], first.nextBefore!).messages.some(
				(row) => row.id === "appended",
			),
		).toBe(false);
		expect(() => groupHistoryPage("room", [], first.nextBefore!)).toThrow(/expired/);
		expect(() => groupHistoryPage("other", rows, first.nextBefore!)).toThrow(/invalid/);
		expect(() => groupHistoryPage("room", rows, "bad-cursor")).toThrow();
	});
	it("captures primary Bot membership at dispatch and excludes stale primary IDs", () => {
		const room = { id: "room", name: "Team", accountId: "account", botIds: ["bot"], primaryBotId: "bot", createdAt: 1 };
		const context = groupTaskContext(room, [], []);
		expect(context.primaryBotId).toBe("bot");
		room.primaryBotId = "removed";
		expect(context.primaryBotId).toBe("bot");
		expect(groupTaskContext(room, [], []).primaryBotId).toBeUndefined();
	});
	it("keeps recent discussion chronological, bounded, and independent of subsequent mutation", () => {
		const rows = Array.from({ length: 100 }, (_, index) => message(String(index), "内容".repeat(1000)));
		const context = groupTaskContext(
			{ id: "room", name: "Team", accountId: "account", botIds: ["bot"], createdAt: 1 },
			[],
			rows,
		);
		expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(GROUP_CONTEXT_BYTES);
		expect(context.throughMessageId).toBe("99");
		expect(context.messages.at(-1)?.id).toBe("99");
		expect(context.nextBefore).toBeTruthy();
		rows[99].text = "changed";
		expect(context.messages.at(-1)?.text).not.toBe("changed");
	});
});
