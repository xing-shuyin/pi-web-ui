import { describe, expect, it } from "vitest";
import type { UiBridgeCallResult } from "../../packages/keel/src/contracts/ui-bridge.js";
import { bridgeHarness, frames } from "../helpers/ui-bridge.js";

const failure = (result: UiBridgeCallResult): Extract<UiBridgeCallResult, { ok: false }> => {
	if (result.ok) throw new Error("expected a failure result");
	return result;
};

/** 手机侧与页面侧同一套挂起表，但 id 前缀 / 超时 / 文案各自独立（`ph-` / 20s / 手机文案）。 */
describe("手机操控挂起表（phoneCall / resolvePhoneCall）", () => {
	it("① 回包兑现：出 `phone_request` 帧，按 id 拿回结果", async () => {
		const harness = bridgeHarness({ activeConversation: "c-1" });
		const promise = harness.handlers.phoneCall({ op: "dump", args: { maxNodes: 5 } }, {}, "c-1");

		const [request] = frames(harness.transport.sent, "phone_request");
		expect(request).toMatchObject({ op: "dump", args: { maxNodes: 5 }, timeoutMs: 20_000 });
		expect(request.id).toBe("ph-1");

		harness.handlers.resolvePhoneCall(request.id, true, { nodes: [] });
		await expect(promise).resolves.toEqual({ ok: true, result: { nodes: [] } });
		expect(harness.clock.pendingTimers()).toBe(0);
	});

	it("① 失败回包带原因；没给原因就用固定文案", async () => {
		const harness = bridgeHarness();
		const a = harness.handlers.phoneCall({ op: "tap" }, {});
		const b = harness.handlers.phoneCall({ op: "tap" }, {});
		const [ra, rb] = frames(harness.transport.sent, "phone_request");

		harness.handlers.resolvePhoneCall(ra.id, false, undefined, "无障碍服务未开启");
		harness.handlers.resolvePhoneCall(rb.id, false);
		await expect(a).resolves.toEqual({ ok: false, error: "无障碍服务未开启" });
		await expect(b).resolves.toEqual({ ok: false, error: "手机操作失败（no error message）" });
	});

	it("① 页面与手机两套表不共用 id（前缀分开，前端按前缀分流）", async () => {
		const harness = bridgeHarness();
		const page = harness.handlers.pageCall({ op: "read" }, {});
		const phone = harness.handlers.phoneCall({ op: "status" }, {});
		const [pageRequest] = frames(harness.transport.sent, "page_request");
		const [phoneRequest] = frames(harness.transport.sent, "phone_request");
		expect(pageRequest.id).toBe("p-1");
		expect(phoneRequest.id).toBe("ph-1");

		// 拿页面 id 去结算手机表：空操作（手机那条仍在等）
		harness.handlers.resolvePhoneCall(pageRequest.id, true, "wrong-table");
		expect(harness.clock.pendingTimers()).toBe(2);

		harness.handlers.resolvePhoneCall(phoneRequest.id, true, "ok");
		harness.handlers.resolvePageCall(pageRequest.id, true, "ok");
		await expect(phone).resolves.toEqual({ ok: true, result: "ok" });
		await expect(page).resolves.toEqual({ ok: true, result: "ok" });
	});

	it("② 会话归属不对：对话已关时会话判定优先于回包（结算成失败）", async () => {
		const harness = bridgeHarness({ activeConversation: "c-1" });
		const promise = harness.handlers.phoneCall({ op: "tap" }, {}, "c-1");
		const [request] = frames(harness.transport.sent, "phone_request");

		harness.alive.delete("c-1");
		harness.handlers.resolvePhoneCall(request.id, true, { tapped: true });
		expect(failure(await promise).error).toContain("会话已关闭");
	});

	it("② 会话归属不对：已关闭的对话发起操控直接失败，不出帧", async () => {
		const harness = bridgeHarness();
		const result = await harness.handlers.phoneCall({ op: "tap" }, {}, "c-gone");
		expect(failure(result).error).toContain("会话已关闭");
		expect(frames(harness.transport.sent, "phone_request")).toEqual([]);
	});

	it("② 会话归属不对：另一个客户端的回包碰不到这一份挂起表", async () => {
		const mine = bridgeHarness();
		const other = bridgeHarness();
		const promise = mine.handlers.phoneCall({ op: "dump" }, {});
		const [request] = frames(mine.transport.sent, "phone_request");

		const otherPending = other.handlers.phoneCall({ op: "dump" }, {});
		other.handlers.resolvePhoneCall(request.id, true, "not-yours");
		await expect(otherPending).resolves.toEqual({ ok: true, result: "not-yours" });

		mine.handlers.resolvePhoneCall(request.id, true, "mine");
		await expect(promise).resolves.toEqual({ ok: true, result: "mine" });
	});

	it("③ 超时：到点自己结算成失败文案，表与定时器都清掉", async () => {
		const harness = bridgeHarness();
		const promise = harness.handlers.phoneCall({ op: "dump", timeoutMs: 2_000 }, {});
		harness.clock.advance(2_000);
		expect(failure(await promise).error).toMatch(/秒内没有收到手机响应（timeout 2000ms）/);
		expect(harness.clock.pendingTimers()).toBe(0);
	});

	it("③ 超时：钳制上下限（第三方塞超长 timeoutMs 也拖不死一轮）", async () => {
		const harness = bridgeHarness();
		void harness.handlers.phoneCall({ op: "dump", timeoutMs: 10 * 60_000 }, {});
		void harness.handlers.phoneCall({ op: "dump", timeoutMs: 10 }, {});
		const [big, small] = frames(harness.transport.sent, "phone_request");
		expect(big.timeoutMs).toBe(60_000);
		expect(small.timeoutMs).toBe(1_000);
	});

	it("③ 断开清理：dispose 结算所有挂起（含 impl 之外尚未回包的）", async () => {
		const harness = bridgeHarness();
		harness.alive.add("c-1");
		harness.alive.add("c-2");
		const a = harness.handlers.phoneCall({ op: "tap" }, {}, "c-1");
		const b = harness.handlers.phoneCall({ op: "tap" }, {}, "c-2");
		harness.handlers.dispose();
		expect(failure(await a).error).toContain("连接已断开");
		expect(failure(await b).error).toContain("连接已断开");
		expect(harness.clock.pendingTimers()).toBe(0);
	});

	it("③ 会话停止：只结算这条对话的手机挂起", async () => {
		const harness = bridgeHarness();
		harness.alive.add("c-1");
		harness.alive.add("c-2");
		const mine = harness.handlers.phoneCall({ op: "tap" }, {}, "c-1");
		const other = harness.handlers.phoneCall({ op: "tap" }, {}, "c-2");

		expect(harness.handlers.settleConversationCalls("c-1")).toBe(1);
		expect(failure(await mine).error).toContain("会话已重置或停止");

		const [, second] = frames(harness.transport.sent, "phone_request");
		harness.handlers.resolvePhoneCall(second.id, true, "fine");
		await expect(other).resolves.toEqual({ ok: true, result: "fine" });
	});

	it("连接已断 / 已中止：立刻失败，不挂表也不出帧", async () => {
		const harness = bridgeHarness();
		harness.transport.close();
		expect(failure(await harness.handlers.phoneCall({ op: "tap" }, {})).error).toContain("没有已连接的手机客户端");

		harness.transport.reopen();
		expect(failure(await harness.handlers.phoneCall({ op: "tap" }, { aborted: true })).error).toContain("已中止");
		expect(frames(harness.transport.sent, "phone_request")).toEqual([]);
		expect(harness.clock.pendingTimers()).toBe(0);
	});
});
