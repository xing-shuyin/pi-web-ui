import { describe, expect, it } from "vitest";
import { CoreEngine, CoreEngineNotReadyError } from "../../packages/keel/src/app/core-engine.js";
import { createFakeSettingsStore } from "../helpers/fake-settings-store.js";

/** 装配参数里唯一必需的能力：设置存储端口（宿主在 core 模式下注入真 store）。 */
function options(extra: { attach?: boolean } = {}) {
	return { version: "test-version", stateStore: createFakeSettingsStore(), ...extra };
}

describe("core/app · CoreEngine 生命周期", () => {
	it("quiesce / unquiesce 与 serviceStatus 自洽", async () => {
		const engine = new CoreEngine("/work", options());
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
		const engine = new CoreEngine("/work", options());
		engine.noteSocketClose();
		expect(engine.serviceStatus().connectedClients).toBe(0);
		engine.noteSocketOpen();
		engine.noteSocketOpen();
		expect(engine.serviceStatus().connectedClients).toBe(2);
		engine.noteSocketClose();
		expect(engine.serviceStatus().connectedClients).toBe(1);
	});

	it("attach 默认关闭：明确报「尚未接入」，不静默降级", async () => {
		const engine = new CoreEngine("/work", options({ attach: false }));
		await expect(engine.attach("c1", () => {})).rejects.toBeInstanceOf(CoreEngineNotReadyError);
		expect(engine.get("c1")).toBeUndefined();
	});

	it("显式打开 attach：接客户端并保持同一份运行时", async () => {
		const engine = new CoreEngine("/work", options({ attach: true }));
		const sent: unknown[] = [];
		const cs = await engine.attach("c1", (msg) => void sent.push(msg));
		expect(cs.cwd).toBe("/work");
		expect(engine.get("c1")).toBe(cs);
		expect(engine.serviceStatus().connectedClients).toBe(0);
		engine.detach("c1", () => {});
		// 期望变（P6）：最后一个 socket 走了只标离线、运行时留宽限期供重连 / 认领
		//（老 `agent-service-daemon.ts` 的 `detach()` 同口径：非 canvas / device-task 不真拆），所以还是同一份运行时。
		expect(engine.get("c1")).toBe(cs);
	});

	it("activeConversations / pendingMessages 汇总各客户端运行时", async () => {
		const engine = new CoreEngine("/work", options({ attach: true }));
		const a = await engine.attach("a", () => {});
		await engine.attach("b", () => {});
		expect(engine.activeConversations()).toBe(0);
		expect(engine.pendingMessages()).toBe(0);
		// 连接期先建一条空白对话（老 `ClientSession.create` 的第一条）：活动对话不为空，但在跑/排队的计数仍是 0。
		expect(a.activeConversationId?.()).toBe("c-1");
	});
});
