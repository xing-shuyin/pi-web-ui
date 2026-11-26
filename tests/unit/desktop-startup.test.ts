import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_DESKTOP_PORT,
	DEFAULT_HEALTH_TIMEOUT_MS,
	MIN_HEALTH_TIMEOUT_MS,
	buildDesktopLoadUrl,
	needsAgentReconnect,
	resolveHealthTimeoutMs,
	waitForHealth,
} from "../../desktop/startup.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("desktop/electron-builder.portable.yml & electron-builder.yml 打包清单守卫 (issue #583)", () => {
	const portableYml = readFileSync(join(repoRoot, "desktop", "electron-builder.portable.yml"), "utf8");
	const shellYml = readFileSync(join(repoRoot, "desktop", "electron-builder.yml"), "utf8");

	it("便携版包含插件安装器与内置市场所需的运行时资源（bin / plugins/catalog.json / plugin-sdk / dist/packages）", () => {
		for (const requiredEntry of [
			"bin",
			"plugins/catalog.json",
			"plugin-sdk",
			"dist/desktop",
			"dist/browser",
			"dist/server",
			"dist/packages",
			"web/dist",
			"themes",
			"package.json",
		]) {
			expect(portableYml).toMatch(
				new RegExp(`^\\s*-\\s+${requiredEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"),
			);
		}
		expect(existsSync(join(repoRoot, "bin", "keel.mjs"))).toBe(true);
		expect(existsSync(join(repoRoot, "plugins", "catalog.json"))).toBe(true);
		expect(existsSync(join(repoRoot, "plugin-sdk"))).toBe(true);
	});

	it("extraMetadata.main 仍指向 dist/desktop/main.js（避免以 CLI 当 Electron 主入口）", () => {
		expect(shellYml).toMatch(/extraMetadata:\s*\n\s*main:\s*dist\/desktop\/main\.js/);
		expect(portableYml).toMatch(/extraMetadata:\s*\n\s*main:\s*dist\/desktop\/main\.js/);
	});

	it("主进程 import 的运行时依赖都在名单里（jsqr：TOTP 扫码）", () => {
		for (const pkg of ["jsqr", "electron-chrome-extensions", "debug", "ms"]) {
			expect(shellYml).toContain(`node_modules/${pkg}/**`);
			expect(portableYml).toContain(`node_modules/${pkg}/**`);
		}
	});
});

describe("desktop/startup.ts 启动纯逻辑 (issue #584)", () => {
	it("DEFAULT_DESKTOP_PORT 常量定义为 8790（保持桌面与网页版 8787 隔离）", () => {
		expect(DEFAULT_DESKTOP_PORT).toBe(8790);
	});

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

		await expect(
			waitForHealth("http://127.0.0.1:59999", {
				timeoutMs: 10_000,
				pollIntervalMs: 10,
				shouldAbort: () => new Error("server 提前退出（code=1 signal=null）"),
				fetchFn: async () => ({ ok: false }),
			}),
		).rejects.toThrow("server 提前退出");

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

	it("needsAgentReconnect 在相同 URL 但未就绪或曾出错时返回 true (issue #1004)", () => {
		const target = "http://127.0.0.1:8790";
		expect(needsAgentReconnect(undefined, target)).toBe(true);
		expect(needsAgentReconnect(null, target)).toBe(true);
		expect(needsAgentReconnect({ agentUrl: "http://127.0.0.1:8787", agentReady: true }, target)).toBe(true);
		expect(needsAgentReconnect({ agentUrl: target, agentReady: false }, target)).toBe(true);
		expect(
			needsAgentReconnect(
				{ agentUrl: target, agentReady: false, agentError: "ERR_ABORTED (-3) loading 'http://127.0.0.1:8790/'" },
				target,
			),
		).toBe(true);
		expect(needsAgentReconnect({ agentUrl: target, agentReady: true, agentError: "stale error" }, target)).toBe(true);
		expect(needsAgentReconnect({ agentUrl: target, agentReady: true }, target)).toBe(false);

		const mainSrc = readFileSync(join(repoRoot, "desktop", "main.ts"), "utf8");
		expect(mainSrc).toContain("needsAgentReconnect(browserHost.getState(), target)");
	});
});
