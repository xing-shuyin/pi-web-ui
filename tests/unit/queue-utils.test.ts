import { describe, expect, it } from "vitest";
import {
	removeFirstOccurrence,
	removeQueuedByIndexOrText,
	removeQueuedEntry,
	rollbackQueuedEntry,
	reconcileQueuedEntries,
	createQueuedEntry,
	toQueuedPromptItems,
	type QueuedMessageEntry,
} from "../../server/queue-utils.js";

describe("removeFirstOccurrence", () => {
	it("移除唯一匹配项", () => {
		expect(removeFirstOccurrence(["a", "b", "c"], "b")).toEqual(["a", "c"]);
	});

	it("重复文本只移除第一条（✕ 对应一条消息）", () => {
		expect(removeFirstOccurrence(["dup", "x", "dup"], "dup")).toEqual(["x", "dup"]);
		expect(removeFirstOccurrence(["dup", "dup"], "dup")).toEqual(["dup"]);
	});

	it("找不到时原样返回（拷贝，不是同一引用）", () => {
		const list = ["a", "b"];
		const out = removeFirstOccurrence(list, "zzz");
		expect(out).toEqual(["a", "b"]);
		expect(out).not.toBe(list);
	});

	it("空列表与空字符串", () => {
		expect(removeFirstOccurrence([], "a")).toEqual([]);
		expect(removeFirstOccurrence(["", "a"], "")).toEqual(["a"]);
	});

	it("不修改入参", () => {
		const list = ["a", "b", "a"];
		removeFirstOccurrence(list, "a");
		expect(list).toEqual(["a", "b", "a"]);
	});

	it("保持其余项顺序（重新入队依赖原顺序）", () => {
		expect(removeFirstOccurrence(["1", "2", "3", "4"], "3")).toEqual(["1", "2", "4"]);
	});
});

describe("removeQueuedByIndexOrText", () => {
	it("重复文本按气泡下标移除第二条（点第二个 ✕ 不删第一个）", () => {
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", 2)).toEqual(["dup", "x"]);
		expect(removeQueuedByIndexOrText(["dup", "dup"], "dup", 1)).toEqual(["dup"]);
	});

	it("下标 0 移除第一条", () => {
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", 0)).toEqual(["x", "dup"]);
	});

	it("不传下标回落到第一处文本匹配（旧客户端）", () => {
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup")).toEqual(["x", "dup"]);
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", undefined)).toEqual(["x", "dup"]);
	});

	it("下标越界/负数/非整数回落到文本匹配", () => {
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", 5)).toEqual(["x", "dup"]);
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", -1)).toEqual(["x", "dup"]);
		expect(removeQueuedByIndexOrText(["dup", "x", "dup"], "dup", 1.5)).toEqual(["x", "dup"]);
	});

	it("下标处文本已变化（队列在点击后移位）回落到文本匹配", () => {
		// 点击时第二个气泡是 "dup"，执行时该位置已变成 "new"（有条消息刚送达）。
		expect(removeQueuedByIndexOrText(["gone", "new"], "dup", 1)).toEqual(["gone", "new"]);
		expect(removeQueuedByIndexOrText(["dup", "new", "dup"], "dup", 1)).toEqual(["new", "dup"]);
	});

	it("文本不存在时原样返回（拷贝）", () => {
		const list = ["a", "b"];
		const out = removeQueuedByIndexOrText(list, "zzz", 0);
		expect(out).toEqual(["a", "b"]);
		expect(out).not.toBe(list);
	});

	it("不修改入参", () => {
		const list = ["dup", "x", "dup"];
		removeQueuedByIndexOrText(list, "dup", 2);
		expect(list).toEqual(["dup", "x", "dup"]);
	});
});

describe("removeQueuedEntry (跨引擎统一排队契约)", () => {
	const imgA = [{ type: "image" as const, data: "dataA", mimeType: "image/png" }];
	const imgB = [{ type: "image" as const, data: "dataB", mimeType: "image/png" }];

	it("优先按唯一 id 精准移除，免疫下标漂移与文本重复", () => {
		const list: QueuedMessageEntry[] = [
			createQueuedEntry("同名文本", { id: "item-1", images: imgA }),
			createQueuedEntry("同名文本", { id: "item-2", images: imgB }),
		];
		// 即使传入了错误的 index=0，只要提供了 id="item-2"，就精准移除 item-2
		const result = removeQueuedEntry(list, { id: "item-2", text: "同名文本", index: 0 });
		expect(result.length).toBe(1);
		expect(result[0]!.id).toBe("item-1");
		expect(result[0]!.images).toBe(imgA);
	});

	it("无 id 时回落到按 index 匹配（必须校验文本一致）", () => {
		const list: QueuedMessageEntry[] = [createQueuedEntry("文本1"), createQueuedEntry("文本2")];
		const result = removeQueuedEntry(list, { text: "文本2", index: 1 });
		expect(result.length).toBe(1);
		expect(result[0]!.text).toBe("文本1");
	});

	it("index 文本不匹配或越界时，回退到首处文本匹配", () => {
		const list: QueuedMessageEntry[] = [createQueuedEntry("重复"), createQueuedEntry("重复")];
		// index 99 越界，回落到删第一条
		const result = removeQueuedEntry(list, { text: "重复", index: 99 });
		expect(result.length).toBe(1);
	});

	it("toQueuedPromptItems 转换为对外快照结构", () => {
		const list = [createQueuedEntry("测试", { id: "test-id", attachments: [{ path: "a.ts" }] })];
		const items = toQueuedPromptItems(list);
		expect(items).toEqual([
			{
				id: "test-id",
				text: "测试",
				attachments: [{ path: "a.ts" }],
				createdAt: expect.any(Number),
			},
		]);
	});
});

describe("rollbackQueuedEntry (prompt 异常时从尾部回滚)", () => {
	const imgA = [{ type: "image" as const, data: "dataA", mimeType: "image/png" }];
	const imgB = [{ type: "image" as const, data: "dataB", mimeType: "image/png" }];

	it("同文本连续入队时，只弹出末尾最新入队的一条，前面的同名条目完整保留", () => {
		const list: QueuedMessageEntry[] = [
			createQueuedEntry("重试", { images: imgA }),
			createQueuedEntry("重试", { images: imgB }),
		];
		const rolledBack = rollbackQueuedEntry(list, "重试");
		expect(rolledBack.length).toBe(1);
		expect(rolledBack[0]!.images).toBe(imgA);
	});

	it("找不到匹配时原样返回拷贝", () => {
		const list: QueuedMessageEntry[] = [createQueuedEntry("a")];
		const out = rollbackQueuedEntry(list, "b");
		expect(out.length).toBe(1);
		expect(out[0]!.text).toBe("a");
		expect(out).not.toBe(list);
	});
});

describe("reconcileQueuedEntries (queue_update 对账)", () => {
	const imgA = [{ type: "image" as const, data: "dataA", mimeType: "image/png" }];
	const imgB = [{ type: "image" as const, data: "dataB", mimeType: "image/png" }];
	const imgC = [{ type: "image" as const, data: "dataC", mimeType: "image/png" }];

	it("空队列处理", () => {
		expect(reconcileQueuedEntries([], [])).toEqual([]);
		expect(reconcileQueuedEntries([createQueuedEntry("a")], [])).toEqual([]);
		const out = reconcileQueuedEntries([], ["x", "y"]);
		expect(out.length).toBe(2);
		expect(out[0]!.text).toBe("x");
		expect(out[1]!.text).toBe("y");
		expect(out[0]!.id).toBeDefined();
	});

	it("FIFO 头部出队：同文本不同图，第 0 条消费后，幸存的第 1 条正确保留自己的图片 (imgB)", () => {
		const current: QueuedMessageEntry[] = [
			createQueuedEntry("继续", { id: "c1", images: imgA }),
			createQueuedEntry("继续", { id: "c2", images: imgB }),
		];
		// SDK 头部消费了第一条 "继续"，最新队列只剩一条 "继续"
		const newTexts = ["继续"];
		const reconciled = reconcileQueuedEntries(current, newTexts);
		expect(reconciled.length).toBe(1);
		expect(reconciled[0]!.id).toBe("c2");
		expect(reconciled[0]!.text).toBe("继续");
		expect(reconciled[0]!.images).toBe(imgB);
	});

	it("多条不同文本 FIFO 头部出队", () => {
		const current: QueuedMessageEntry[] = [
			createQueuedEntry("任务1", { images: imgA }),
			createQueuedEntry("任务2", { images: imgB }),
			createQueuedEntry("任务3", { images: imgC }),
		];
		// 任务1 出队完成
		const reconciled = reconcileQueuedEntries(current, ["任务2", "任务3"]);
		expect(reconciled.length).toBe(2);
		expect(reiled(0, reconciled).text).toBe("任务2");
		expect(reiled(0, reconciled).images).toBe(imgB);
		expect(reiled(1, reconciled).text).toBe("任务3");
		expect(reiled(1, reconciled).images).toBe(imgC);
	});

	it("队列尾部增长时保留既有图片并在末尾补全纯文本项", () => {
		const current: QueuedMessageEntry[] = [createQueuedEntry("任务1", { images: imgA })];
		const reconciled = reconcileQueuedEntries(current, ["任务1", "外部插入2"]);
		expect(reconciled.length).toBe(2);
		expect(reconciled[0]!.images).toBe(imgA);
		expect(reconciled[1]!.text).toBe("外部插入2");
		expect(reconciled[1]!.images).toBeUndefined();
	});
});

function reiled(idx: number, list: QueuedMessageEntry[]): QueuedMessageEntry {
	return list[idx]!;
}
