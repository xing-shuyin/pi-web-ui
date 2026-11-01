import { describe, expect, it } from "vitest";
import { planGroupContext } from "../../server/device-center/group-context-delta.js";
import type { GroupHistoryMessage, GroupTaskContext } from "../../server/device-center/group-context.js";

function chunk(id: string, overrides: Partial<GroupHistoryMessage> = {}): GroupHistoryMessage {
	return {
		id,
		text: id,
		textStart: 0,
		textEnd: id.length,
		fullTextLength: id.length,
		sender: { type: "human", id: "alice", name: "Alice" },
		createdAt: 1,
		...overrides,
	};
}
function context(messages: GroupHistoryMessage[], overrides: Partial<GroupTaskContext> = {}): GroupTaskContext {
	return {
		roomId: "room",
		roomName: "Team",
		members: [{ id: "bot", name: "Helper" }],
		primaryBotId: "bot",
		throughMessageId: messages.at(-1)?.id ?? null,
		messages,
		nextBefore: null,
		truncated: false,
		retentionLimit: 500,
		...overrides,
	};
}

describe("group context delivery planner", () => {
	it("sends a bounded snapshot without an active baseline or across rooms", () => {
		const current = context([chunk("new")], { truncated: true, nextBefore: "older" });
		for (const previous of [undefined, context([chunk("new")], { roomId: "other" })]) {
			expect(planGroupContext(current, previous)).toEqual({ ...current, delivery: { mode: "snapshot" } });
		}
	});

	it("sends only new chunks and deduplicates exact history across JSON key order", () => {
		const old = chunk("old", { targetBotIds: ["bot"] });
		const reordered = {
			...old,
			sender: { name: "Alice", id: "alice", type: "human" as const },
		};
		const current = context([reordered, chunk("new")]);
		expect(planGroupContext(current, context([old]))).toEqual({
			...current,
			messages: [chunk("new")],
			delivery: { mode: "delta", previousThroughMessageId: "old" },
		});
	});

	it("keeps fresh metadata even when every history chunk is already present", () => {
		const previous = context([chunk("same")]);
		const current = context([chunk("same")], {
			roomName: "Renamed",
			members: [{ id: "new-bot", name: "New helper" }],
			primaryBotId: "new-bot",
			nextBefore: "older-page",
			truncated: true,
			retentionLimit: 200,
		});
		expect(planGroupContext(current, previous)).toEqual({
			...current,
			messages: [],
			delivery: { mode: "delta", previousThroughMessageId: "same" },
		});
	});

	it("marks a retention gap and resends the entire current window despite partial overlap", () => {
		const previous = context([chunk("shared"), chunk("expired-anchor")]);
		const current = context([chunk("shared"), chunk("latest")], { truncated: true, nextBefore: "retained" });
		expect(planGroupContext(current, previous)).toEqual({
			...current,
			delivery: { mode: "snapshot", previousThroughMessageId: "expired-anchor", gap: true },
		});
		expect(planGroupContext(context([chunk("unrelated")]), previous).delivery.gap).toBe(true);
	});

	it("handles empty windows and actual empty message chunks without inventing overlap", () => {
		expect(planGroupContext(context([])).delivery).toEqual({ mode: "snapshot" });
		expect(planGroupContext(context([]), context([])).delivery).toEqual({
			mode: "delta",
			previousThroughMessageId: null,
		});
		const empty = chunk("empty", { text: "", textStart: 0, textEnd: 0, fullTextLength: 0 });
		expect(planGroupContext(context([empty]), context([])).messages).toEqual([empty]);
		expect(planGroupContext(context([empty]), context([empty])).messages).toEqual([]);
		expect(planGroupContext(context([]), context([empty]))).toEqual({
			...context([]),
			delivery: { mode: "snapshot", previousThroughMessageId: "empty", gap: true },
		});
	});

	it.each([
		{ text: "edited" },
		{ textStart: 1 },
		{ textEnd: 2 },
		{ fullTextLength: 100 },
		{ sender: { type: "bot" as const, id: "alice", name: "Alice" } },
		{ sender: { type: "human" as const, id: "bob", name: "Alice" } },
		{ sender: { type: "human" as const, id: "alice", name: "Renamed" } },
		{ createdAt: 2 },
		{ targetBotIds: [] },
		{ targetBotIds: ["another-bot"] },
	])("redelivers edited chunks when any history field changes: %j", (change) => {
		const previous = context([chunk("same")]);
		const changed = chunk("same", change);
		expect(planGroupContext(context([changed]), previous).messages).toEqual([changed]);
	});

	it("compares target arrays by JSON value including order", () => {
		const old = chunk("same", { targetBotIds: ["a", "b"] });
		expect(planGroupContext(context([chunk("same", { targetBotIds: ["a", "b"] })]), context([old])).messages).toEqual(
			[],
		);
		const changed = chunk("same", { targetBotIds: ["b", "a"] });
		expect(planGroupContext(context([changed]), context([old])).messages).toEqual([changed]);
	});

	it("redelivers changed oversized ranges in full instead of dropping their overlapping text", () => {
		const previous = context([chunk("large", { text: "efgh", textStart: 4, textEnd: 8, fullTextLength: 8 })]);
		const expanded = chunk("large", { text: "cdefgh", textStart: 2, textEnd: 8, fullTextLength: 8 });
		expect(planGroupContext(context([expanded]), previous).messages).toEqual([expanded]);
		const shortened = chunk("large", { text: "gh", textStart: 6, textEnd: 8, fullTextLength: 8 });
		expect(planGroupContext(context([shortened]), previous).messages).toEqual([shortened]);
	});

	it("omits only exact chunks present in the aggregate active context across repeated deltas", () => {
		const first = context([chunk("one")]);
		const second = context([chunk("one"), chunk("two")]);
		const delta = planGroupContext(second, first);
		const aggregate = { ...second, messages: [...first.messages, ...delta.messages] };
		const third = context([chunk("one"), chunk("two"), chunk("three")]);
		expect(planGroupContext(third, aggregate).messages).toEqual([chunk("three")]);
		// If compaction retained only the second chunk, the first must be sent again.
		expect(planGroupContext(third, { ...second, messages: delta.messages }).messages).toEqual([
			chunk("one"),
			chunk("three"),
		]);
	});

	it("matches all active chunks of a message without assuming another range was delivered", () => {
		const prefix = chunk("large", { text: "abcd", textStart: 0, textEnd: 4, fullTextLength: 8 });
		const suffix = chunk("large", { text: "efgh", textStart: 4, textEnd: 8, fullTextLength: 8 });
		expect(planGroupContext(context([prefix, suffix]), context([suffix])).messages).toEqual([prefix]);
		expect(planGroupContext(context([prefix, suffix]), context([suffix, prefix])).messages).toEqual([]);
	});

	it("leaves both input snapshots untouched", () => {
		const current = context([chunk("old"), chunk("new")]);
		const previous = context([chunk("old")]);
		const before = JSON.stringify({ current, previous });
		planGroupContext(current, previous);
		expect(JSON.stringify({ current, previous })).toBe(before);
	});
});
