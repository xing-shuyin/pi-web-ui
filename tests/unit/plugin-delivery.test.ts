import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLedgerStore } from "../../server/plugin-ledger.js";
import { DeliveryQueue } from "../../server/plugin-delivery.js";
import { PluginInbox } from "../../server/plugin-inbox.js";

describe("DeliveryQueue（出站投递：快路径 + 退避 + 死信）", () => {
	let dir: string;
	let now: number;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-delivery-test-"));
		now = 1_000_000;
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function make() {
		const ledger = new PluginLedgerStore({
			dataDir: dir,
			pluginId: "qq",
			flushDelayMs: 0,
			now: () => now,
		});
		const queue = new DeliveryQueue({ ledger, backoffMs: [1_000], ttlMs: 10_000, sendTimeoutMs: 5_000 });
		const inbox = new PluginInbox({ dataDir: dir, pluginId: "qq", ledger, stallMs: 1_000 });
		return { ledger, queue, inbox };
	}

	it("成功：status=sent，账本记 done，可观测到", async () => {
		const { queue } = make();
		const send = vi.fn(async () => {});
		queue.registerSender("qq", send);
		const r = await queue.sendNow({ channel: "qq", target: { user: "u1" }, payload: { content: "hi" }, key: "out:1" });
		expect(r).toEqual({ status: "sent" });
		expect(send).toHaveBeenCalledTimes(1);
		expect(queue.stats()).toMatchObject({ queued: 0, dead: 0, done: 1 });
	});

	it("幂等：同 key 只真正发一次", async () => {
		const { queue } = make();
		const send = vi.fn(async () => {});
		queue.registerSender("qq", send);
		await queue.sendNow({ channel: "qq", target: {}, payload: {}, key: "out:dup" });
		const second = await queue.sendNow({ channel: "qq", target: {}, payload: {}, key: "out:dup" });
		expect(second).toEqual({ status: "duplicate" });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("可重试失败（network）→ 入队；到点前 pump 不发，到点后发成功", async () => {
		const { queue } = make();
		let fail = true;
		const send = vi.fn(async () => {
			if (fail) throw Object.assign(new Error("socket hang up"), { deliveryClass: "network" });
		});
		queue.registerSender("qq", send);
		const r = await queue.sendNow({ channel: "qq", target: {}, payload: {}, key: "out:retry" });
		expect(r).toMatchObject({ status: "queued", attempts: 1 });
		expect(queue.stats()).toMatchObject({ queued: 1, due: 0 });

		await queue.pump(); // 未到退避时间
		expect(send).toHaveBeenCalledTimes(1);

		now += 1_000;
		fail = false;
		const res = await queue.pump();
		expect(res).toMatchObject({ sent: 1, retried: 0, dead: 0 });
		expect(send).toHaveBeenCalledTimes(2);
		expect(queue.stats()).toMatchObject({ queued: 0, done: 1 });
	});

	it("不可重试（rejected）→ 立即抛错并记死信，pump 不再重试", async () => {
		const { queue } = make();
		const send = vi.fn(async () => {
			throw Object.assign(new Error("content rejected by platform"), { deliveryClass: "rejected" });
		});
		queue.registerSender("qq", send);
		await expect(
			queue.sendNow({ channel: "qq", target: {}, payload: {}, key: "out:bad", classify: () => "rejected" }),
		).rejects.toThrow(/rejected/);
		expect(queue.stats()).toMatchObject({ queued: 0, dead: 1 });
		const dead = queue.dead();
		expect(dead).toHaveLength(1);
		expect(dead[0]?.errorClass).toBe("rejected");
		now += 60_000;
		await queue.pump();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("TTL 过期：pump 直接死信，不再发", async () => {
		const { queue } = make();
		const send = vi.fn(async () => {
			throw Object.assign(new Error("timeout"), { deliveryClass: "network" });
		});
		queue.registerSender("qq", send);
		await queue.sendNow({ channel: "qq", target: {}, payload: {}, key: "out:ttl" });
		expect(send).toHaveBeenCalledTimes(1);
		now += 20_000; // 超过 ttlMs=10s
		const res = await queue.pump();
		expect(res).toMatchObject({ dead: 1 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(queue.dead()[0]?.errorClass).toBe("expired");
	});

	it("重试次数到达上限 → 死信", async () => {
		const { queue, ledger } = make();
		const send = vi.fn(async () => {
			throw Object.assign(new Error("flaky network"), { deliveryClass: "network" });
		});
		queue.registerSender("qq", send);
		await queue.sendNow({ channel: "qq", target: {}, payload: {}, key: "out:max" });
		for (let i = 0; i < ledger.maxAttempts + 2; i++) {
			now += 1_000;
			await queue.pump();
		}
		expect(queue.stats().queued).toBe(0);
		expect(queue.stats().dead).toBe(1);
	});

	it("sender 缺失时抛错（不静默吞掉）", async () => {
		const { queue } = make();
		await expect(queue.sendNow({ channel: "nobody", target: {}, payload: {} })).rejects.toThrow(/未注册渠道/);
	});

	it("unregisterSender 后 pump 跳过旧渠道（反激活不留悬挂重试）", async () => {
		const { queue } = make();
		const send = vi.fn(async () => {
			throw Object.assign(new Error("net"), { deliveryClass: "network" });
		});
		queue.registerSender("qq", send);
		await queue.sendNow({ channel: "qq", target: {}, payload: {}, key: "out:gone" });
		queue.unregisterSender("qq");
		now += 1_000;
		const res = await queue.pump();
		expect(res).toMatchObject({ sent: 0, retried: 0, dead: 0 });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("与入站共用同一个账本：两个方向的记录互不干扰", async () => {
		const { queue, inbox } = make();
		queue.registerSender("qq", async () => {});
		expect(inbox.claim("msg:1")).toMatchObject({ status: "new" });
		await queue.sendNow({ channel: "qq", target: {}, payload: {}, key: "out:1" });
		expect(inbox.claim("msg:1")).toMatchObject({ status: "duplicate", reason: "in-flight" });
		inbox.complete("msg:1");
		expect(inbox.snapshot()).toHaveLength(1);
		expect(queue.stats()).toMatchObject({ done: 1 });
		// 跨重启：同一个文件里两个方向都能读回
		const reopened = new PluginLedgerStore({ dataDir: dir, pluginId: "qq", flushDelayMs: 0, now: () => now });
		expect(reopened.byDirection("in")).toHaveLength(1);
		expect(reopened.byDirection("out")).toHaveLength(1);
	});
});
