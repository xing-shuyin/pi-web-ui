import { describe, expect, it } from "vitest";
import { acquireWithBusyWait, BOT_BUSY_WAIT_MS } from "../../server/device-center/bot-lease-wait.js";

/**
 * 「同一 Bot 不并发」：私聊回合持租约，群任务遇 BOT_BUSY 有界等待。
 * 这里守住四件事：等待后能拿到、非忙错误不吞、超时仍失败、取消能打断。
 */

const busy = () => Object.assign(new Error("Bot is busy"), { code: "BOT_BUSY" });

describe("acquireWithBusyWait", () => {
	it("先忙后空：等到空出来就返回，不是立刻失败", async () => {
		let calls = 0;
		const lease = await acquireWithBusyWait(
			async () => {
				calls += 1;
				if (calls < 3) throw busy();
				return { release: () => {} };
			},
			{ pollMs: 1 },
		);
		expect(lease).toBeTruthy();
		expect(calls).toBe(3);
	});

	it("其它错误（停用/不存在）立刻上抛，不等待", async () => {
		let calls = 0;
		await expect(
			acquireWithBusyWait(async () => {
				calls += 1;
				throw Object.assign(new Error("Bot is unavailable"), { code: "BOT_UNAVAILABLE" });
			}),
		).rejects.toMatchObject({ code: "BOT_UNAVAILABLE" });
		expect(calls).toBe(1);
	});

	it("等满上限仍是忙：按 BOT_BUSY 失败（不会无限挂）", async () => {
		let clock = 0;
		await expect(
			acquireWithBusyWait(
				async () => {
					clock += 30_000;
					throw busy();
				},
				{ waitMs: 60_000, pollMs: 1, now: () => clock },
			),
		).rejects.toMatchObject({ code: "BOT_BUSY" });
		expect(BOT_BUSY_WAIT_MS).toBe(120_000);
	});

	it("取消信号能打断等待", async () => {
		const controller = new AbortController();
		const pending = acquireWithBusyWait(
			async () => {
				controller.abort();
				throw busy();
			},
			{ pollMs: 10_000, signal: controller.signal },
		);
		await expect(pending).rejects.toThrow();
	});
});
