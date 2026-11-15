import { describe, expect, it } from "vitest";
import {
	activeTaskForBot,
	botQueuePriority,
	queuePositionOf,
	queuePriorityForCreation,
	queuedReasonText,
	rankBotQueue,
} from "../../server/device-center/bot-queue.js";
import type { HubTask } from "../../server/device-center/store.js";

const BOT = "bot-1";
const OTHER = "bot-2";

function task(patch: Partial<HubTask> & { id: string }): HubTask {
	return {
		attemptId: `a-${patch.id}`,
		roomId: "room-1",
		accountId: "acc-1",
		botId: BOT,
		deviceId: "dev-1",
		botRevision: 1,
		text: patch.id,
		status: "queued",
		blockReason: "bot_busy",
		createdAt: 1,
		updatedAt: 1,
		...patch,
	};
}

const none = new Set<string>();

describe("每 Bot 串行队列", () => {
	it("优先级：私聊 0 < 群内人 1 < 路由/WEBHOOK 2，同级按 FIFO", () => {
		const direct = task({ id: "d", queuePriority: 0, createdAt: 900 });
		const human = task({ id: "h", queuePriority: 1, createdAt: 500 });
		const router = task({ id: "r", origin: "router", createdAt: 100 });
		const webhook = task({ id: "w", queuePriority: 2, createdAt: 50 });
		// r 与 w 同为优先级 2（r 由 origin 推导，w 显式声明），因此按创建时间 FIFO：w(50) 先于 r(100)。
		expect(rankBotQueue([router, human, webhook, direct], none, BOT).map((entry) => entry.id)).toEqual([
			"d",
			"h",
			"w",
			"r",
		]);
		expect(botQueuePriority(router)).toBe(2);
		expect(botQueuePriority({ queuePriority: 0 })).toBe(0);
		expect(botQueuePriority({})).toBe(1);
		expect(queuePriorityForCreation({ direct: true })).toBe(0);
		expect(queuePriorityForCreation({ direct: false, origin: "webhook" })).toBe(2);
		expect(queuePriorityForCreation({ direct: false, origin: "human" })).toBe(1);
	});

	it("不排队的任务：已下发过、持租约、取消、依赖未满足、其他 Bot", () => {
		const dispatched = task({ id: "sent" });
		const leased = task({ id: "leased", leaseToken: "t" });
		const cancelled = task({ id: "cancelled", cancelRequested: true });
		const recovering = task({ id: "recovering", recoveryUntil: Date.now() + 1000 });
		const otherBot = task({ id: "other", botId: OTHER });
		const ready = task({ id: "ready" });
		// 非本闸门停放的 queued（例如依赖未满足、面板人工重试）不该被顺手派掉。
		const untouched = task({ id: "untouched", blockReason: "dependency" });
		const queue = rankBotQueue(
			[dispatched, leased, cancelled, recovering, otherBot, ready, untouched],
			new Set([dispatched.id]),
			BOT,
		);
		expect(queue.map((entry) => entry.id)).toEqual(["ready"]);
	});

	it("占用执行位的判定：running / waiting / 持租约 / 已下发", () => {
		const running = task({ id: "run", status: "running" });
		expect(activeTaskForBot([running], BOT, none)?.id).toBe("run");
		expect(activeTaskForBot([task({ id: "w", status: "waiting" })], BOT, none)?.id).toBe("w");
		expect(activeTaskForBot([task({ id: "l", leaseToken: "t" })], BOT, none)?.id).toBe("l");
		expect(activeTaskForBot([task({ id: "s" })], BOT, new Set(["s"]))?.id).toBe("s");
		expect(activeTaskForBot([task({ id: "done", status: "completed" })], BOT, none)).toBeUndefined();
		// 自己不算自己
		expect(activeTaskForBot([running], BOT, none, "run")).toBeUndefined();
	});

	it("排队位置与文案：第一个排队的人拿到'正在收尾'，后续给出确切数量", () => {
		const first = task({ id: "one", createdAt: 10 });
		const second = task({ id: "two", createdAt: 20 });
		expect(queuePositionOf([first, second], none, second)).toBe(1);
		expect(queuedReasonText(0, "running-task")).toContain("Bot is finishing the previous task");
		expect(queuedReasonText(2, "running-task")).toContain("前面还有 3 个任务");
		expect(queuedReasonText(2, "running-task")).toContain("queued behind 3 task(s)");
	});
});
