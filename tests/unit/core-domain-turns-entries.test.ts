import { describe, expect, it } from "vitest";
import type { TurnAgentMessage, TurnEntry } from "../../packages/keel/src/contracts/turns.js";
import {
	discardedScheduleCalls,
	findTurnBaseEntryId,
	isConversationTurnEntry,
	isPromptAsideEntry,
	isUserMessageEntry,
	lastAssistantFailed,
	messageDeletionTargets,
	resolveEntry,
	undeletedContextEntries,
} from "../../packages/keel/src/domains/turns/entries.js";

function message(
	id: string,
	role: string,
	extra: Partial<NonNullable<TurnEntry["message"]>> = {},
	parentId?: string | null,
): TurnEntry {
	return { id, type: "message", parentId, message: { role, ...extra } };
}

function edit(id: string, targetId: string, replacement: unknown, parentId?: string | null): TurnEntry {
	return { id, type: "context_edit", parentId, targetId, replacement };
}

describe("undeletedContextEntries", () => {
	it("最新一条编辑为 null 的条目被摘掉，其余照旧", () => {
		const entries = [message("u1", "user"), message("a1", "assistant"), edit("e1", "a1", null)];
		expect(undeletedContextEntries(entries).map((entry) => entry.id)).toEqual(["u1", "e1"]);
	});

	it("后一条编辑把替换内容改回来：条目重新可见", () => {
		const entries = [message("a1", "assistant"), edit("e1", "a1", null), edit("e2", "a1", { content: "x" })];
		expect(undeletedContextEntries(entries).map((entry) => entry.id)).toEqual(["a1", "e1", "e2"]);
	});

	it("没有编辑记录的条目一律保留", () => {
		const entries = [message("u1", "user"), message("a1", "assistant")];
		expect(undeletedContextEntries(entries)).toHaveLength(2);
	});
});

describe("messageDeletionTargets", () => {
	it("删用户消息连带它前面的附件旁注（老实现同口径）", () => {
		const aside: TurnEntry = { id: "f1", type: "custom_message", customType: "file", display: true };
		const entries = [aside, message("u1", "user", {}, "f1")];
		expect(messageDeletionTargets(entries, "u1")).toEqual(["u1", "f1"]);
	});

	it("旁注前还有别的消息/实体：停在那里，不越界继续收集", () => {
		const aside: TurnEntry = { id: "f1", type: "custom_message", customType: "file" };
		const entries = [message("u0", "user"), aside, message("u1", "user", {}, "f1")];
		expect(messageDeletionTargets(entries, "u1")).toEqual(["u1", "f1"]);
	});

	it("删 assistant 连带它所有工具调用的结果（不要求相邻）", () => {
		const entries = [
			message("u1", "user"),
			message("a1", "assistant", {
				content: [
					{ type: "toolCall", id: "c1", name: "read" },
					{ type: "toolCall", id: "c2", name: "bash" },
				],
			}),
			message("t1", "toolResult", { toolCallId: "c1" }),
			message("x1", "assistant", { content: [{ type: "text", text: "中间" }] }),
			message("t2", "toolResult", { toolCallId: "c2" }),
			message("u2", "user"),
		];
		expect(messageDeletionTargets(entries, "a1")).toEqual(["a1", "t1", "t2"]);
	});

	it("拒绝：不存在 / 非消息 / 不允许的角色（含已删过的）", () => {
		const entries = [message("u1", "user"), message("a1", "assistant"), message("t1", "toolResult")];
		expect(() => messageDeletionTargets(entries, "nope")).toThrow("Message is no longer available for deletion");
		expect(() => messageDeletionTargets(entries, "t1")).toThrow("Message is no longer available for deletion");
		expect(() => messageDeletionTargets([message("u1", "user"), edit("e1", "u1", null)], "u1")).toThrow(
			"Message is no longer available for deletion",
		);
	});
});

describe("findTurnBaseEntryId", () => {
	const entryOf = (entries: TurnEntry[]) => (id: string) => entries.find((entry) => entry.id === id);

	it("用户消息：往上找最近一个轮次实体（这里是上一条 assistant）", () => {
		const entries = [message("u1", "user"), message("a1", "assistant", {}, "u1"), message("u2", "user", {}, "a1")];
		expect(findTurnBaseEntryId(entryOf(entries), "u2")).toBe("a1");
	});

	it("首条用户消息：返回 null（调用方 resetLeaf）", () => {
		const entries = [message("u1", "user")];
		expect(findTurnBaseEntryId(entryOf(entries), "u1")).toBeNull();
	});

	it("非用户条目：直接取它的父条目", () => {
		const entries = [message("u1", "user"), message("a1", "assistant", {}, "u1")];
		expect(findTurnBaseEntryId(entryOf(entries), "a1")).toBe("u1");
	});

	it("目标不存在：返回 null 而不是抛", () => {
		expect(findTurnBaseEntryId(entryOf([]), "nope")).toBeNull();
	});
});

describe("discardedScheduleCalls", () => {
	it("只收基准之后的 schedule 调用（别的工具不算）", () => {
		const branch = [
			message("u1", "user"),
			message("a1", "assistant", {
				content: [
					{ type: "toolCall", id: "c1", name: "schedule" },
					{ type: "toolCall", id: "c2", name: "read" },
				],
			}),
			message("u2", "user"),
			message("a2", "assistant", { content: [{ type: "toolCall", id: "c3", name: "schedule" }] }),
		];
		expect(discardedScheduleCalls(branch, "a1")).toEqual(new Set(["c3"]));
		expect(discardedScheduleCalls(branch, null)).toEqual(new Set(["c1", "c3"]));
	});

	it("基准不在分支上：拒绝（转录已被别人改写）", () => {
		expect(() => discardedScheduleCalls([message("u1", "user")], "gone")).toThrow(
			"Reask base is no longer on the current branch",
		);
	});
});

describe("lastAssistantFailed", () => {
	const run = (messages: TurnAgentMessage[]): boolean => lastAssistantFailed(messages);

	it("最后一条 assistant 带错误信息 = 失败", () => {
		expect(run([{ role: "user" }, { role: "assistant", errorMessage: " boom " }])).toBe(true);
	});

	it("stopReason === error 也算（错误信息可能为空）", () => {
		expect(run([{ role: "assistant", stopReason: "error" }])).toBe(true);
	});

	it("只看最后一条 assistant：更早的失败不算", () => {
		expect(run([{ role: "assistant", stopReason: "error" }, { role: "user" }, { role: "assistant" }])).toBe(false);
	});

	it("空白错误信息 / 没有 assistant：不算失败", () => {
		expect(run([{ role: "assistant", errorMessage: "   " }])).toBe(false);
		expect(run([{ role: "user" }])).toBe(false);
		expect(run([])).toBe(false);
	});
});

describe("resolveEntry", () => {
	const entries = [message("u1", "user"), message("a1", "assistant")];
	const uiIds = new Map([
		["u1", "u-1-0"],
		["a1", "a-2-1"],
	]);

	it("原始条目 id 直命中优先", () => {
		expect(resolveEntry(entries, uiIds, "a1")?.id).toBe("a1");
	});

	it("按出帧投影的消息 id 命中", () => {
		expect(resolveEntry(entries, uiIds, "u-1-0")?.id).toBe("u1");
	});

	it("两边都不命中：undefined", () => {
		expect(resolveEntry(entries, uiIds, "u-9-9")).toBeUndefined();
	});
});

describe("条目谓词", () => {
	it("isPromptAsideEntry 只认 file / parallel-work-reminder", () => {
		expect(isPromptAsideEntry({ id: "f", type: "custom_message", customType: "file" })).toBe(true);
		expect(isPromptAsideEntry({ id: "p", type: "message", message: { role: "custom", customType: "file" } })).toBe(
			true,
		);
		expect(
			isPromptAsideEntry({
				id: "q",
				type: "message",
				message: { role: "custom", customType: "parallel-work-reminder" },
			}),
		).toBe(true);
		expect(isPromptAsideEntry({ id: "x", type: "custom_message", customType: "other" })).toBe(false);
		expect(isPromptAsideEntry(message("u1", "user"))).toBe(false);
	});

	it("isUserMessageEntry / isConversationTurnEntry", () => {
		expect(isUserMessageEntry(message("u1", "user"))).toBe(true);
		expect(isUserMessageEntry(message("a1", "assistant"))).toBe(false);
		expect(isConversationTurnEntry(message("a1", "assistant"))).toBe(true);
		expect(isConversationTurnEntry(message("t1", "toolResult"))).toBe(true);
		expect(isConversationTurnEntry({ id: "c1", type: "compaction" })).toBe(true);
		expect(isConversationTurnEntry({ id: "e1", type: "context_edit", targetId: "a1", replacement: null })).toBe(false);
	});
});
