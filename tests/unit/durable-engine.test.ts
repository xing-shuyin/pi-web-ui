import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_DURABLE_CAPABILITIES, resolveEngineCapabilities } from "../../server/engine-capabilities.js";
import { ENGINE_PACKAGES, probeDurable } from "../../server/engine-probe.js";
import { DurableAgentService } from "../../server/durable/durable-agent-service.js";
import { DurableAgentDriver } from "../../server/durable/durable-driver.js";
import { calculateSupportedThinkingLevels } from "../../server/durable/durable-models.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("Pi Durable 独立引擎接入规范", () => {
	it("DEFAULT_DURABLE_CAPABILITIES 具备原生自愈、任务图与插话支持", () => {
		expect(DEFAULT_DURABLE_CAPABILITIES.steer).toBe(true);
		expect(DEFAULT_DURABLE_CAPABILITIES.subagents).toBe(true);
		expect(DEFAULT_DURABLE_CAPABILITIES.ephemeralChat).toBe(true);
		expect(DEFAULT_DURABLE_CAPABILITIES.treeFork).toBe(true);
		expect(DEFAULT_DURABLE_CAPABILITIES.presentFiles).toBe(true);

		const resolved = resolveEngineCapabilities(null, DEFAULT_DURABLE_CAPABILITIES);
		expect(resolved.steer).toBe(true);
	});

	it("ENGINE_PACKAGES 包含 durable 引擎元数据与官方安装命令", () => {
		const meta = ENGINE_PACKAGES.durable;
		expect(meta).toBeDefined();
		expect(meta.id).toBe("durable");
		expect(meta.packageName).toBe("@earendil-works/pi-durable");
		expect(meta.installCommand).toContain("@earendil-works/pi-durable");
	});

	it("probeDurable 探针在未安装时不崩溃且返回标准结构", async () => {
		const status = await probeDurable();
		expect(status.id).toBe("durable");
		expect(typeof status.installed).toBe("boolean");
		expect(status.packageName).toBe("@earendil-works/pi-durable");
	});

	it("DurableAgentDriver 具备标准能力且支持安全退避", async () => {
		const driver = new DurableAgentDriver(process.cwd());
		try {
			expect(driver.id).toBe("durable");
			expect(driver.capabilities.supportsTreeFork).toBe(true);
			expect(driver.capabilities.supportsAskUser).toBe(true);

			// 验证引擎完整能力事实源正确接线（非通用全 false 默认）
			const engineCaps = driver.getEngineCapabilities();
			expect(engineCaps).toEqual(DEFAULT_DURABLE_CAPABILITIES);
			expect(engineCaps.workspaceRoots).toBe(true);
			expect(engineCaps.presentFiles).toBe(true);
			expect(engineCaps.treeFork).toBe(true);
			expect(engineCaps.subagents).toBe(true);

			const sessionId = await driver.createSession();
			expect(sessionId).toBeTruthy();

			// 测试事件发射与安装引导回退
			let textOutput = "";
			let completed = false;
			await driver.sendPrompt("测试输入", undefined, {
				onTextDelta: (delta) => {
					textOutput += delta;
				},
				onThinkingDelta: () => {},
				onToolStart: () => {},
				onToolEnd: () => {},
				onError: () => {},
				onTurnComplete: () => {
					completed = true;
				},
			});

			expect(textOutput.length).toBeGreaterThan(0);
			expect(completed).toBe(true);
		} finally {
			driver.dispose();
		}
	}, 30000);

	it("DurableAgentService 生命周期与完整客户端挂载（160+ UI 契约）", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-durable-test-"));
		try {
			const svc = new DurableAgentService({
				cwd: tempDir,
				dataDir: tempDir,
			});

			expect(svc.isQuiesced()).toBe(false);
			svc.quiesce();
			expect(svc.isQuiesced()).toBe(true);
			svc.unquiesce();
			expect(svc.isQuiesced()).toBe(false);

			const messages: ServerMessage[] = [];
			const session = await svc.attach("test-client", (msg) => {
				messages.push(msg);
			});

			expect(session).toBeDefined();
			expect(svc.get("test-client")).toBe(session);

			// 快照下发
			session.flushSnapshot(true);
			expect(messages.some((m) => m.type === "snapshot")).toBe(true);

			// 后台刷新与语言切换契约
			svc.refreshBackgroundServers();
			await svc.setLocale("test-client", "zh");

			// 断开与清理
			svc.detach("test-client", () => {});
			await svc.disposeAll();
		} finally {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("Durable 思考强度能力计算与动态过滤（支持 xhigh / max 与模型 mapping）", () => {
		// 1. 无配置或未知模型：兜底开放全部 7 档
		expect(calculateSupportedThinkingLevels()).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

		// 2. 明确不支持思考的模型：仅 off
		expect(calculateSupportedThinkingLevels({ reasoning: false })).toEqual(["off"]);

		// 3. 普通 reasoning 模型（未显式配置 xhigh/max）：返回基础 5 档
		expect(calculateSupportedThinkingLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);

		// 4. 具备 thinkingLevelMap 的高级模型（如 Beam Free / Muse Spark）：
		// 严格遵循 mapping，支持 xhigh / max，剔除 mapped: null
		const beamFreeMap = {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		};
		const beamFreeLevels = calculateSupportedThinkingLevels({
			reasoning: true,
			thinkingLevelMap: beamFreeMap,
		});
		expect(beamFreeLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(beamFreeLevels.includes("xhigh")).toBe(true);
		expect(beamFreeLevels.includes("max")).toBe(true);
		expect(beamFreeLevels.includes("off")).toBe(false);

		// 5. Driver getSupportedThinkingLevels 动态感知
		const driver = new DurableAgentDriver(process.cwd());
		try {
			driver.setThinkingLevel("xhigh");
			// 未指定模型时返回全部可用档位，绝不硬编码为 4 档阉割版
			const levels = driver.getSupportedThinkingLevels();
			expect(levels).toContain("xhigh");
			expect(levels).toContain("max");
			expect(levels).toContain("minimal");
		} finally {
			driver.dispose();
		}
	});
});
