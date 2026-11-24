import { describe, expect, it } from "vitest";
import { bridgeHarness, frames } from "../helpers/ui-bridge.js";

describe("installPiAgent：进程归宿主端口，内核只出帧", () => {
	it("成功：进度 notice → 完成 notice → install_result(ok) → 刷一次快照", async () => {
		const harness = bridgeHarness();
		await harness.handlers.installPiAgent();

		expect(harness.port?.installs).toBe(1);
		const notices = frames(harness.transport.sent, "notice");
		expect(notices[0]).toMatchObject({ level: "info" });
		expect(notices[0].text).toContain("正在安装 pi agent CLI");
		expect(notices[1].text).toContain("安装完成");

		const results = frames(harness.transport.sent, "install_result");
		expect(results).toEqual([{ type: "install_result", ok: true, detail: "" }]);
		expect(harness.flushCount()).toBe(1);
	});

	it("失败：notice 带退出码与输出尾巴，install_result 带 detail", async () => {
		const harness = bridgeHarness();
		harness.port?.setInstallResult({ ok: false, code: 2, output: `npm ERR! boom ${"x".repeat(700)}` });
		await harness.handlers.installPiAgent();

		const notices = frames(harness.transport.sent, "notice");
		expect(notices.at(-1)).toMatchObject({ level: "error" });
		expect(notices.at(-1)?.text).toContain("（2）");
		// 输出按 400 截断进 notice，按 600 进 install_result（老实现同口径）
		expect(notices.at(-1)?.text.length).toBeLessThan(500);

		const [result] = frames(harness.transport.sent, "install_result");
		expect(result.ok).toBe(false);
		expect(result.detail.startsWith("npm ERR! boom")).toBe(true);
		expect(result.detail.length).toBe(600);
		expect(harness.flushCount()).toBe(1);
	});

	it("超时（code 为 null）也用 `timeout` 说明，而不是假装成功", async () => {
		const harness = bridgeHarness();
		harness.port?.setInstallResult({ ok: false, code: null, output: "" });
		await harness.handlers.installPiAgent();
		expect(frames(harness.transport.sent, "notice").at(-1)?.text).toContain("（timeout）");
		expect(frames(harness.transport.sent, "install_result")[0].ok).toBe(false);
	});

	it("端口抛错：也回一条 install_result（前端不会挂在进度条上）", async () => {
		const harness = bridgeHarness();
		const port = harness.port;
		expect(port).toBeDefined();
		if (!port) return;
		Object.defineProperty(port, "installCli", {
			value: async () => {
				throw new Error("spawn npm ENOENT");
			},
		});

		await expect(harness.handlers.installPiAgent()).resolves.toBeUndefined();
		const notices = frames(harness.transport.sent, "notice");
		expect(notices.at(-1)?.text).toContain("spawn npm ENOENT");
		const [result] = frames(harness.transport.sent, "install_result");
		expect(result).toMatchObject({ ok: false, detail: "spawn npm ENOENT" });
		expect(harness.flushCount()).toBe(1);
	});
});
