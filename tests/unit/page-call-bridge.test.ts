import { describe, expect, it } from "vitest";
import type { UiBridgeCallResult } from "../../packages/keel/src/contracts/ui-bridge.js";
import { bridgeHarness, frames } from "../helpers/ui-bridge.js";

/** 三类必测：①回包兑现 ②会话归属不对 ③超时 / 断开清理不留 Promise。 */
describe("页面调用挂起表（pageCall / resolvePageCall）", () => {
	it("① 回包兑现：出 `page_request` 帧，按 id 拿回结果", async () => {
		const harness = bridgeHarness({ activeConversation: "c-1" });
		const promise = harness.handlers.pageCall(
			{ op: "read", args: { what: "text" }, target: "t-1", timeoutMs: 5_000 },
			{},
			"c-1",
		);

		const [request] = frames(harness.transport.sent, "page_request");
		expect(request).toMatchObject({ op: "read", args: { what: "text" }, target: "t-1", timeoutMs: 5_000 });
		expect(request.id).toBe("p-1");

		harness.handlers.resolvePageCall(request.id, true, { text: "hello" });
		await expect(promise).resolves.toEqual({ ok: true, result: { text: "hello" } });
		// 兑现后定时器也撤了（否则每次调用都会留一个空转的定时器）
		expect(harness.clock.pendingTimers()).toBe(0);
	});

	it("① 失败回包带原因；没给原因就用固定文案（老实现同口径）", async () => {
		const harness = bridgeHarness();
		const a = harness.handlers.pageCall({ op: "click" }, {});
		const b = harness.handlers.pageCall({ op: "click" }, {});
		const [ra, rb] = frames(harness.transport.sent, "page_request");

		harness.handlers.resolvePageCall(ra.id, false, undefined, "  no page  ");
		harness.handlers.resolvePageCall(rb.id, false);
		await expect(a).resolves.toEqual({ ok: false, error: "no page" });
		await expect(b).resolves.toEqual({ ok: false, error: "浏览器操作失败（no error message from the page）" });
	});

	it("① 重复回包 / 未知 id 是空操作（只有第一次兑现）", async () => {
		const harness = bridgeHarness();
		const promise = harness.handlers.pageCall({ op: "read" }, {});
		const [request] = frames(harness.transport.sent, "page_request");

		harness.handlers.resolvePageCall(request.id, true, "first");
		harness.handlers.resolvePageCall(request.id, true, "second");
		harness.handlers.resolvePageCall("p-999", true, "ghost");
		await expect(promise).resolves.toEqual({ ok: true, result: "first" });
	});

	it("② 会话归属不对：对话已关时不把结果送进去，改成结算成失败", async () => {
		const harness = bridgeHarness({ activeConversation: "c-1" });
		const promise = harness.handlers.pageCall({ op: "read" }, {}, "c-1");
		const [request] = frames(harness.transport.sent, "page_request");

		// 对话被关掉（注册表里没了），浏览器这时才回包
		harness.alive.delete("c-1");
		harness.handlers.resolvePageCall(request.id, true, "late");

		const result = (await promise) as Extract<UiBridgeCallResult, { ok: false }>;
		expect(result.ok).toBe(false);
		expect(result.error).toContain("会话已关闭");
	});

	it("② 会话归属不对：已关闭的对话发起调用直接失败，不出帧", async () => {
		const harness = bridgeHarness();
		const result = await harness.handlers.pageCall({ op: "read" }, {}, "c-gone");
		expect(result.ok).toBe(false);
		expect(frames(harness.transport.sent, "page_request")).toEqual([]);
		expect(harness.clock.pendingTimers()).toBe(0);
	});

	it("② 会话归属不对：另一个客户端的回包碰不到这一份挂起表", async () => {
		const mine = bridgeHarness();
		const other = bridgeHarness();
		const promise = mine.handlers.pageCall({ op: "read" }, {});
		const [request] = frames(mine.transport.sent, "page_request");

		// 别的客户端收到自己的 `p-1` 回包：两份表互不相干
		const otherPending = other.handlers.pageCall({ op: "read" }, {});
		other.handlers.resolvePageCall(request.id, true, "not-yours");
		await expect(otherPending).resolves.toEqual({ ok: true, result: "not-yours" });

		mine.handlers.resolvePageCall(request.id, true, "mine");
		await expect(promise).resolves.toEqual({ ok: true, result: "mine" });
	});

	it("③ 超时：到点自己结算成失败文案，表与定时器都清掉", async () => {
		const harness = bridgeHarness();
		const promise = harness.handlers.pageCall({ op: "read", timeoutMs: 3_000 }, {});
		expect(harness.clock.pendingTimers()).toBe(1);

		harness.clock.advance(3_000);
		const result = (await promise) as Extract<UiBridgeCallResult, { ok: false }>;
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/秒内没有收到浏览器响应（timeout 3000ms）/);
		expect(harness.clock.pendingTimers()).toBe(0);

		// 超时之后再回包：空操作，不会二次兑现
		const [request] = frames(harness.transport.sent, "page_request");
		harness.handlers.resolvePageCall(request.id, true, "too-late");
		expect(result.ok).toBe(false);
		expect(harness.clock.pendingTimers()).toBe(0);
	});

	it("③ 超时：没给 timeoutMs 走默认 30s（钳制在 timeout.ts 单源）", async () => {
		const harness = bridgeHarness();
		void harness.handlers.pageCall({ op: "read" }, {});
		const [request] = frames(harness.transport.sent, "page_request");
		expect(request.timeoutMs).toBe(30_000);
		harness.clock.advance(29_999);
		expect(harness.clock.pendingTimers()).toBe(1);
		harness.clock.advance(1);
		expect(harness.clock.pendingTimers()).toBe(0);
	});

	it("③ 断开清理：dispose 把每条挂起都结算成失败，不留 Promise / 定时器", async () => {
		const harness = bridgeHarness();
		harness.alive.add("c-1");
		harness.alive.add("c-2");
		const a = harness.handlers.pageCall({ op: "read" }, {}, "c-1");
		const b = harness.handlers.pageCall({ op: "read" }, {}, "c-2");
		expect(harness.clock.pendingTimers()).toBe(2);

		harness.handlers.dispose();
		for (const promise of [a, b]) {
			const result = (await promise) as Extract<UiBridgeCallResult, { ok: false }>;
			expect(result.ok).toBe(false);
			expect(result.error).toContain("连接已断开");
		}
		expect(harness.clock.pendingTimers()).toBe(0);
	});

	it("③ 会话停止：只结算这条对话的挂起，别的对话不受影响", async () => {
		const harness = bridgeHarness();
		harness.alive.add("c-1");
		harness.alive.add("c-2");
		const mine = harness.handlers.pageCall({ op: "read" }, {}, "c-1");
		const other = harness.handlers.pageCall({ op: "read" }, {}, "c-2");

		expect(harness.handlers.settleConversationCalls("c-1")).toBe(1);
		const result = (await mine) as Extract<UiBridgeCallResult, { ok: false }>;
		expect(result.error).toContain("会话已重置或停止");

		const [, second] = frames(harness.transport.sent, "page_request");
		harness.handlers.resolvePageCall(second.id, true, "fine");
		await expect(other).resolves.toEqual({ ok: true, result: "fine" });
	});

	it("连接已断 / 已中止：立刻失败，不挂表也不出帧", async () => {
		const harness = bridgeHarness();
		harness.transport.close();
		const noClient = await harness.handlers.pageCall({ op: "read" }, {});
		expect(noClient.ok).toBe(false);
		expect((noClient as Extract<UiBridgeCallResult, { ok: false }>).error).toContain("没有已连接的 pi-web-ui 页面");

		harness.transport.reopen();
		const aborted = await harness.handlers.pageCall({ op: "read" }, { aborted: true });
		expect((aborted as Extract<UiBridgeCallResult, { ok: false }>).error).toContain("已中止");
		expect(frames(harness.transport.sent, "page_request")).toEqual([]);
		expect(harness.clock.pendingTimers()).toBe(0);
	});
});
