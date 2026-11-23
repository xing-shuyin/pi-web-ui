import { describe, expect, it } from "vitest";
import { CoreEngine, CoreEngineNotReadyError } from "../../server/core/app/core-engine.js";
import { PI_ENGINE_ENV, resolvePiEngineMode } from "../../server/core/app/engine-mode.js";

describe("core/app · 引擎开关", () => {
	it("只认 core，其余一律 legacy（未知值不能把用户带到未完成的实现上）", () => {
		expect(resolvePiEngineMode({})).toBe("legacy");
		expect(resolvePiEngineMode({ [PI_ENGINE_ENV]: "" })).toBe("legacy");
		expect(resolvePiEngineMode({ [PI_ENGINE_ENV]: "legacy" })).toBe("legacy");
		expect(resolvePiEngineMode({ [PI_ENGINE_ENV]: " COR " })).toBe("legacy");
		expect(resolvePiEngineMode({ [PI_ENGINE_ENV]: " CORE " })).toBe("core");
	});
});

describe("core/app · CoreEngine 生命周期", () => {
	it("quiesce / unquiesce 与 serviceStatus 自洽", async () => {
		const engine = new CoreEngine("/work");
		expect(engine.isQuiesced()).toBe(false);
		engine.quiesce();
		expect(engine.isQuiesced()).toBe(true);
		expect(engine.quiesceInfo().quiesced).toBe(true);
		const status = engine.serviceStatus();
		expect(status.quiesced).toBe(true);
		expect(status.cwd).toBe("/work");
		expect(status.activeConversations).toBe(0);
		expect(status.pendingMessages).toBe(0);
		engine.unquiesce();
		expect(engine.isQuiesced()).toBe(false);
		await engine.disposeAll();
		expect(engine.serviceStatus().connectedClients).toBe(0);
	});

	it("socket 计数不为负", () => {
		const engine = new CoreEngine("/work");
		engine.noteSocketClose();
		expect(engine.serviceStatus().connectedClients).toBe(0);
		engine.noteSocketOpen();
		engine.noteSocketOpen();
		expect(engine.serviceStatus().connectedClients).toBe(2);
		engine.noteSocketClose();
		expect(engine.serviceStatus().connectedClients).toBe(1);
	});

	it("W0 骨架：attach 明确报「尚未接入」，不静默降级", async () => {
		const engine = new CoreEngine("/work");
		await expect(engine.attach("c1", () => {})).rejects.toBeInstanceOf(CoreEngineNotReadyError);
		expect(engine.get("c1")).toBeUndefined();
	});
});
