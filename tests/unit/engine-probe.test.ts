import { describe, expect, it } from "vitest";
import {
	checkPackageLatest,
	collectInstalledEngineTargets,
	ENGINE_PACKAGES,
	enrichWithUpdateInfo,
	getCachedEngineStatuses,
	isEngineUpdating,
	isEngineUninstalling,
	probeAllEngines,
	probeClaude,
	probeDsh,
	probeEngine,
	probePi,
	updateEngineBackground,
	uninstallEngineBackground,
} from "../../server/engine-probe.js";
import type { EngineStatus } from "../../server/protocol.js";

describe("引擎探测与更新检测模块 (server/engine-probe.ts)", () => {
	it("元数据登记包含 pi、dsh 与 claude 三种引擎的包名与安装命令", () => {
		expect(ENGINE_PACKAGES.pi.packageName).toBe("@earendil-works/pi-coding-agent");
		expect(ENGINE_PACKAGES.dsh.packageName).toBe("@deepseek-ai/dsh");
		expect(ENGINE_PACKAGES.dsh.installCommand).toBe("npm i -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui");
		expect(ENGINE_PACKAGES.claude.packageName).toBe("@anthropic-ai/claude-code");
		expect(ENGINE_PACKAGES.claude.installCommand).toBe("npm i -g @anthropic-ai/claude-code");
		expect(ENGINE_PACKAGES.codex.packageName).toBe("@openai/codex");
		expect(ENGINE_PACKAGES.codex.installCommand).toBe("npm i -g @openai/codex");
	});

	it("probePi() 恒返回 installed: true 且带有包名和版本", () => {
		const res = probePi();
		expect(res.id).toBe("pi");
		expect(res.installed).toBe(true);
		expect(res.packageName).toBe("@earendil-works/pi-coding-agent");
		expect(typeof res.version).toBe("string");
		expect(res.version!.length).toBeGreaterThan(0);
	});

	it("probeDsh() 正确探测 DSH 引擎全局包/运行时状态", async () => {
		const res = await probeDsh();
		expect(res.id).toBe("dsh");
		expect(res.packageName).toBe("@deepseek-ai/dsh");
		expect(typeof res.installed).toBe("boolean");
	});

	it("probeClaude() 正确探测 Claude Code CLI 引擎状态", async () => {
		const res = await probeClaude();
		expect(res.id).toBe("claude");
		expect(res.packageName).toBe("@anthropic-ai/claude-code");
		expect(typeof res.installed).toBe("boolean");
	});

	it("probeEngine() 支持按 ID 独立探测或处理未知引擎", async () => {
		const pi = await probeEngine("pi");
		expect(pi.id).toBe("pi");
		expect(pi.installed).toBe(true);

		const dsh = await probeEngine("dsh");
		expect(dsh.id).toBe("dsh");
		expect(dsh.packageName).toBe("@deepseek-ai/dsh");

		const unknown = await probeEngine("some-fake-engine");
		expect(unknown.id).toBe("some-fake-engine");
		expect(unknown.installed).toBe(false);
	}, 15000);

	it("probeAllEngines() 批量获取全量引擎状态并支持缓存与同步获取", async () => {
		const list = await probeAllEngines(true);
		expect(list.length).toBeGreaterThanOrEqual(3);
		expect(list.some((e) => e.id === "pi" && e.installed)).toBe(true);
		expect(list.some((e) => e.id === "dsh")).toBe(true);
		expect(list.some((e) => e.id === "claude")).toBe(true);
		expect(list.some((e) => e.id === "codex" && e.packageName === "@openai/codex")).toBe(true);

		const cached = getCachedEngineStatuses();
		expect(cached).toEqual(list);
	}, 15000);

	it("checkPackageLatest() 能够正确查询包名远端版本（带缓存）", async () => {
		const latest = await checkPackageLatest("@earendil-works/pi-coding-agent");
		expect(typeof latest).toBe("string");
		expect(latest!.length).toBeGreaterThan(0);
	});

	it("enrichWithUpdateInfo() 正确比对并计算 hasUpdate 状态", async () => {
		const oldStatus: EngineStatus = {
			id: "dsh",
			installed: true,
			packageName: "@deepseek-ai/dsh",
			version: "0.0.1",
		};
		await enrichWithUpdateInfo(oldStatus);
		expect(oldStatus.latestVersion).toBeDefined();
		expect(oldStatus.hasUpdate).toBe(true);

		const freshStatus: EngineStatus = {
			id: "dsh",
			installed: true,
			packageName: "@deepseek-ai/dsh",
			version: "999.0.0",
		};
		await enrichWithUpdateInfo(freshStatus);
		expect(freshStatus.latestVersion).toBeDefined();
		expect(freshStatus.hasUpdate).toBe(false);

		const uninstalled: EngineStatus = {
			id: "fake",
			installed: false,
			packageName: "@nonexistent/package",
		};
		await enrichWithUpdateInfo(uninstalled);
		expect(uninstalled.latestVersion).toBeUndefined();
		expect(uninstalled.hasUpdate).toBeUndefined();
	});

	it("collectInstalledEngineTargets() 正确提取已安装的非 pi 引擎包供 update_status_all 消费", async () => {
		await probeAllEngines(true);
		const targets = collectInstalledEngineTargets();
		expect(Array.isArray(targets)).toBe(true);
		for (const t of targets) {
			expect(t.kind).toBe("engine");
			expect(t.name).not.toBe("@earendil-works/pi-coding-agent");
			expect(typeof t.version).toBe("string");
		}
	}, 15000);

	it("updateEngineBackground() 安全拦截未知引擎，且正确维护 isEngineUpdating 状态与 updating 标记", async () => {
		expect(isEngineUpdating("unknown-engine")).toBe(false);
		const unknownRes = await updateEngineBackground("unknown-engine");
		expect(unknownRes.ok).toBe(false);
		expect(unknownRes.error).toContain("unknown-engine");

		expect(isEngineUpdating("dsh")).toBe(false);
		expect(isEngineUpdating("claude")).toBe(false);
		const initialStatuses = getCachedEngineStatuses();
		for (const s of initialStatuses) {
			expect(s.updating).toBeFalsy();
		}
	});

	it("uninstallEngineBackground() 拒绝卸载内置核心引擎 pi 与未知引擎，且正确维护 isEngineUninstalling 状态", async () => {
		expect(isEngineUninstalling("pi")).toBe(false);
		const piRes = await uninstallEngineBackground("pi");
		expect(piRes.ok).toBe(false);
		expect(piRes.error).toContain("内置核心引擎");

		expect(isEngineUninstalling("unknown-engine")).toBe(false);
		const unknownRes = await uninstallEngineBackground("unknown-engine");
		expect(unknownRes.ok).toBe(false);
		expect(unknownRes.error).toContain("unknown-engine");

		expect(isEngineUninstalling("dsh")).toBe(false);
		expect(isEngineUninstalling("claude")).toBe(false);
		const initialStatuses = getCachedEngineStatuses();
		for (const s of initialStatuses) {
			expect(s.uninstalling).toBeFalsy();
		}
	});

	it("probeEngine() 单项探测与 probeAllEngines() 全量刷新具备联动 TTL 缓存防抖", async () => {
		const first = await probeEngine("claude", true);
		expect(first.id).toBe("claude");

		const second = await probeEngine("claude");
		expect(second.id).toBe("claude");
		expect(second.version).toBe(first.version);

		await probeAllEngines(true);
		const afterAll = await probeEngine("claude");
		expect(afterAll.id).toBe("claude");
	}, 15000);
});
