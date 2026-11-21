import { describe, expect, it } from "vitest";
import { waitForPidGone } from "../../server/process-utils.js";

describe("waitForPidGone", () => {
	it("已经不在的 pid 立刻返回 true", async () => {
		expect(await waitForPidGone(999_999, 200, () => false)).toBe(true);
	});

	it("退出有窗口期：轮询到进程消失就返回 true，不等满超时", async () => {
		let probes = 0;
		const startedAt = Date.now();
		const gone = await waitForPidGone(4242, 2000, () => ++probes < 3);
		expect(gone).toBe(true);
		expect(probes).toBe(3);
		expect(Date.now() - startedAt).toBeLessThan(600);
	});

	it("始终存活：到超时返回 false", async () => {
		expect(await waitForPidGone(4242, 120, () => true)).toBe(false);
	});
});
