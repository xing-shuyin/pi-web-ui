/**
 * 桌面版打包清单（issue #583）与启动纯逻辑（issue #584）单测。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_HEALTH_TIMEOUT_MS,
	MIN_HEALTH_TIMEOUT_MS,
	buildDesktopLoadUrl,
	resolveHealthTimeoutMs,
	waitForHealth,
} from "../../desktop/startup.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("desktop/electron-builder.yml 打包清单守卫 (issue #583)", () => {
	const yml = readFileSync(join(repoRoot, "desktop", "electron-builder.yml"), "utf8");

	it("包含插件安装器与内置市场所需的运行时资源（bin / plugins/catalog.json / plugin-sdk）", () => {
		for (const requiredEntry of [
			"bin",
			"plugins/catalog.json",
			"plugin-sdk",
			"dist/desktop",
			"dist/server",
			"web/dist",
			"themes",
			"package.json",
		]) {
			expect(yml).toMatch(new RegExp(`^\\s*-\\s+${requiredEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"));
		}
		expect(existsSync(join(repoRoot, "bin", "pi-web-ui.mjs"))).toBe(true);
		expect(existsSync(join(repoRoot, "plugins", "catalog.json"))).toBe(true);
		expect(existsSync(join(repoRoot, "plugin-sdk"))).toBe(true);
	});

	it("extraMetadata.main 仍指向 dist/desktop/main.js（避免以 CLI 当 Electron 主入口）", () => {
		expect(yml).toMatch(/extraMetadata:\s*\n\s*main:\s*dist\/desktop\/main\.js/);
	});
});

describe("desktop/startup.ts 启动纯逻辑 (issue #584)", () => {
	it("resolveHealthTimeoutMs 默认 60s，支持 PI_WEB_HEALTH_TIMEOUT_MS 覆盖并夹紧下限", () => {
		expect(resolveHealthTimeoutMs({})).toBe(DEFAULT_HEALTH_TIMEOUT_MS);
		expect(resolveHealthTimeoutMs({ PI_WEB_HEALTH_TIMEOUT_MS: "" })).toBe(DEFAULT_HEALTH_TIMEOUT_MS);
		expect(resolveHealthTimeoutMs({ PI_WEB_HEALTH_TIMEOUT_MS: "abc" })).toBe(DEFAULT_HEALTH_TIMEOUT_MS);
		expect(resolveHealthTimeoutMs({ PI_WEB_HEALTH_TIMEOUT_MS: "0" })).toBe(DEFAULT_HEALTH_TIMEOUT_MS);
		expect(resolveHealthTimeoutMs({ PI_WEB_HEALTH_TIMEOUT_MS: "-5000" })).toBe(DEFAULT_HEALTH_TIMEOUT_MS);
		expect(resolveHealthTimeoutMs({ PI_WEB_HEALTH_TIMEOUT_MS: "200" })).toBe(MIN_HEALTH_TIMEOUT_MS);
		expect(resolveHealthTimeoutMs({ PI_WEB_HEALTH_TIMEOUT_MS: "90000" })).toBe(90_000);
	});

	it("buildDesktopLoadUrl 在设置 PI_WEB_TOKEN 时自动向窗口 URL 注入 ?token=", () => {
		expect(buildDesktopLoadUrl("http://127.0.0.1:54321", {})).toBe("http://127.0.0.1:54321");
		expect(buildDesktopLoadUrl("http://127.0.0.1:54321", { PI_WEB_TOKEN: "   " })).toBe("http://127.0.0.1:54321");
		expect(buildDesktopLoadUrl("http://127.0.0.1:54321", { PI_WEB_TOKEN: "sec ret&1" })).toBe(
			"http://127.0.0.1:54321/?token=sec+ret%261",
		);
		// 已带 token 时不重复覆盖
		expect(buildDesktopLoadUrl("http://127.0.0.1:54321/?token=existing", { PI_WEB_TOKEN: "other" })).toBe(
			"http://127.0.0.1:54321/?token=existing",
		);
	});

	it("waitForHealth 就绪后立即返回，超时或子进程提前退出时抛错", async () => {
		let attempts = 0;
		await waitForHealth("http://127.0.0.1:59999", {
			timeoutMs: 2_000,
			pollIntervalMs: 10,
			fetchFn: async () => {
				attempts++;
				return { ok: attempts >= 3 };
			},
		});
		expect(attempts).toBe(3);

		// 子进程提前退出：不傻等超时，立刻抛错
		await expect(
			waitForHealth("http://127.0.0.1:59999", {
				timeoutMs: 10_000,
				pollIntervalMs: 10,
				shouldAbort: () => new Error("server 提前退出（code=1 signal=null）"),
				fetchFn: async () => ({ ok: false }),
			}),
		).rejects.toThrow("server 提前退出");

		// 超时抛错
		await expect(
			waitForHealth("http://127.0.0.1:59999", {
				timeoutMs: 40,
				pollIntervalMs: 10,
				fetchFn: async () => ({ ok: false }),
			}),
		).rejects.toThrow(/server 未在 40ms 内就绪/);
	});

	it("desktop/main.ts 启动失败路径调用 app.exit 非零退出而非 app.quit(0)", () => {
		const mainSrc = readFileSync(join(repoRoot, "desktop", "main.ts"), "utf8");
		expect(mainSrc).toContain("app.exit(code)");
		expect(mainSrc).toContain("exitOnStartupFailure(1)");
	});
});
