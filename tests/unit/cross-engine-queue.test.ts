import { describe, expect, it } from "vitest";
import {
	createQueuedEntry,
	removeQueuedEntry,
	toQueuedPromptItems,
	type QueuedMessageEntry,
} from "../../server/queue-utils.js";
import type { UiState, QueuedPromptItem } from "../../server/protocol.js";

describe("跨引擎统一排队数据契约 (cross-engine-queue)", () => {
	it("QueuedPromptItem 数据契约完整包含 id, text, attachments, createdAt", () => {
		const attachment = { path: "server/index.ts", name: "index.ts" };
		const entry = createQueuedEntry("请优化这段代码", {
			id: "q-test-1",
			attachments: [attachment],
			createdAt: 1700000000000,
		});

		expect(entry.id).toBe("q-test-1");
		expect(entry.text).toBe("请优化这段代码");
		expect(entry.attachments).toEqual([attachment]);
		expect(entry.createdAt).toBe(1700000000000);

		const items: QueuedPromptItem[] = toQueuedPromptItems([entry]);
		expect(items).toEqual([
			{
				id: "q-test-1",
				text: "请优化这段代码",
				attachments: [attachment],
				createdAt: 1700000000000,
			},
		]);
	});

	it("快照 UiState.queue 同时提供向后兼容纯文本数组与结构化 entries", () => {
		const e1 = createQueuedEntry("任务1", { id: "q-1" });
		const e2 = createQueuedEntry("任务2", { id: "q-2" });

		const snapshotQueue: UiState["queue"] = {
			steering: [e1.text],
			followUp: [e2.text],
			entries: {
				steering: toQueuedPromptItems([e1]),
				followUp: toQueuedPromptItems([e2]),
			},
		};

		expect(snapshotQueue.steering).toEqual(["任务1"]);
		expect(snapshotQueue.followUp).toEqual(["任务2"]);

		expect(snapshotQueue.entries?.steering[0]?.id).toBe("q-1");
		expect(snapshotQueue.entries?.followUp[0]?.id).toBe("q-2");
	});

	it("Universal 引擎与 Pi 引擎统一按 ID 剔除：并发下标漂移时 100% 幂等精准", () => {
		const e1 = createQueuedEntry("重构", { id: "id-alpha" });
		const e2 = createQueuedEntry("重构", { id: "id-beta" });
		const e3 = createQueuedEntry("重构", { id: "id-gamma" });

		let queue: QueuedMessageEntry[] = [e1, e2, e3];

		queue = removeQueuedEntry(queue, { id: "id-beta", text: "重构", index: 1 });

		expect(queue.length).toBe(2);
		expect(queue.map((q) => q.id)).toEqual(["id-alpha", "id-gamma"]);
	});

	it("无 ID 时平滑回退到基于 index 与文本的剔除", () => {
		const e1 = createQueuedEntry("文本A", { id: "id-1" });
		const e2 = createQueuedEntry("文本B", { id: "id-2" });

		const queue = removeQueuedEntry([e1, e2], { text: "文本B", index: 1 });
		expect(queue.length).toBe(1);
		expect(queue[0]!.id).toBe("id-1");
	});
});
