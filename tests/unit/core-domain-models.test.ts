import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelInfo, ServerMessage } from "../../server/protocol.js";
import { createModelRuntimeFactory } from "../../packages/keel/src/adapters/models/index.js";
import {
	createModelPusher,
	loadModelCatalog,
	modelRuntimePaths,
	toWireModel,
	type CatalogModel,
	type ModelCatalogRuntime,
	type ModelRuntimeFactory,
	type ModelRuntimePaths,
} from "../../packages/keel/src/domains/models/index.js";

function model(over: Partial<CatalogModel> & { id: string }): CatalogModel {
	return { name: `M-${over.id}`, provider: "demo", reasoning: false, input: ["text"], ...over };
}

interface FakeRuntimeOptions {
	available?: CatalogModel[];
	refreshError?: Error;
	availableError?: Error;
	seen?: { allowNetwork: boolean; signal: AbortSignal }[];
}

function fakeRuntime(options: FakeRuntimeOptions = {}): ModelCatalogRuntime {
	return {
		async refresh(input) {
			options.seen?.push(input);
			if (options.refreshError) throw options.refreshError;
		},
		async getAvailable() {
			if (options.availableError) throw options.availableError;
			return options.available ?? [];
		},
	};
}

/** 记账用的工厂：`calls` 就是「建了几次运行时」，`invalidate()` 的效果直接看它。 */
function countingFactory(build: () => ModelCatalogRuntime = () => fakeRuntime()): {
	factory: ModelRuntimeFactory;
	calls: ModelRuntimePaths[];
} {
	const calls: ModelRuntimePaths[] = [];
	const factory: ModelRuntimeFactory = async (paths) => {
		calls.push(paths);
		return build();
	};
	return { factory, calls };
}

function fakeTransport(closed = false): {
	sent: ServerMessage[];
	transport: { send(msg: ServerMessage): void; isClosed(): boolean };
} {
	const sent: ServerMessage[] = [];
	return { sent, transport: { send: (msg) => void sent.push(msg), isClosed: () => closed } };
}

function modelsOf(msg: ServerMessage | undefined): ModelInfo[] {
	if (msg?.type !== "models") throw new Error(`不是 models 帧：${JSON.stringify(msg)}`);
	return msg.models;
}

describe("toWireModel：SDK 模型字段 → 协议 ModelInfo", () => {
	it("逐字段映射（id 拼 provider/、vision 由 input 推导）", () => {
		const wire = toWireModel({
			id: "gpt-4o",
			name: "GPT-4o",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
		});
		expect(wire).toEqual({
			id: "openai/gpt-4o",
			name: "GPT-4o",
			provider: "openai",
			reasoning: true,
			vision: true,
		});
	});

	it("input 不含 image、或干脆没有 input 时 vision 为 false", () => {
		expect(toWireModel(model({ id: "a", input: ["text"] })).vision).toBe(false);
		expect(toWireModel({ id: "b", name: "B", provider: "demo", reasoning: false }).vision).toBe(false);
	});

	it("name 去掉目录里标注的 (new)", () => {
		expect(toWireModel(model({ id: "c", name: "Nova 2 Lite (new)" })).name).toBe("Nova 2 Lite");
		expect(toWireModel(model({ id: "d", name: "Nova (NEW)" })).name).toBe("Nova");
	});

	it("不额外带 enabled（可选字段留空，不在域里猜账号设置）", () => {
		expect("enabled" in toWireModel(model({ id: "e" }))).toBe(false);
	});
});

describe("loadModelCatalog", () => {
	it("空目录（真 SDK 工厂）→ 空表且不抛", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-core-models-"));
		const models = await loadModelCatalog({
			agentDir,
			allowNetwork: false,
			runtimeFactory: createModelRuntimeFactory(),
		});
		expect(models).toEqual([]);
	});

	it("按 agentDir 建运行时（auth.json / models.json 都在该目录下）", async () => {
		expect(modelRuntimePaths("/agent")).toEqual({
			authPath: join("/agent", "auth.json"),
			modelsPath: join("/agent", "models.json"),
		});
		const { factory, calls } = countingFactory();
		await loadModelCatalog({ agentDir: "/agent", allowNetwork: true, runtimeFactory: factory });
		expect(calls).toEqual([{ authPath: join("/agent", "auth.json"), modelsPath: join("/agent", "models.json") }]);
	});

	it("可用模型映射成协议表（空运行时给空表）", async () => {
		const { factory } = countingFactory(() =>
			fakeRuntime({ available: [model({ id: "a", provider: "openai" }), model({ id: "b", provider: "anthropic" })] }),
		);
		const models = await loadModelCatalog({ agentDir: "/agent", allowNetwork: true, runtimeFactory: factory });
		expect(models).toEqual([
			{ id: "openai/a", name: "M-a", provider: "openai", reasoning: false, vision: false },
			{ id: "anthropic/b", name: "M-b", provider: "anthropic", reasoning: false, vision: false },
		]);
	});

	it("refresh 抛错仍返回 getAvailable 的表（刷新失败不丢整张表）", async () => {
		const { factory } = countingFactory(() =>
			fakeRuntime({ available: [model({ id: "a" })], refreshError: new Error("network down") }),
		);
		const models = await loadModelCatalog({ agentDir: "/agent", allowNetwork: true, runtimeFactory: factory });
		expect(models.map((m) => m.id)).toEqual(["demo/a"]);
	});

	it("allowNetwork 透传给 refresh，并带一个 AbortSignal", async () => {
		const seen: { allowNetwork: boolean; signal: AbortSignal }[] = [];
		const { factory } = countingFactory(() => fakeRuntime({ seen }));
		await loadModelCatalog({ agentDir: "/agent", allowNetwork: false, runtimeFactory: factory });
		await loadModelCatalog({ agentDir: "/agent", allowNetwork: true, runtimeFactory: factory });
		expect(seen.map((s) => s.allowNetwork)).toEqual([false, true]);
		expect(seen.every((s) => s.signal instanceof AbortSignal)).toBe(true);
	});

	it("运行时建不起来时往外抛（由 pusher 收口成空帧）", async () => {
		const factory: ModelRuntimeFactory = async () => {
			throw new Error("create failed");
		};
		await expect(loadModelCatalog({ agentDir: "/agent", allowNetwork: true, runtimeFactory: factory })).rejects.toThrow(
			"create failed",
		);
	});
});

describe("createModelPusher", () => {
	it('下发一帧 { type: "models", models }', async () => {
		const { factory } = countingFactory(() => fakeRuntime({ available: [model({ id: "a", provider: "openai" })] }));
		const { sent, transport } = fakeTransport();
		const pusher = createModelPusher({ transport, agentDir: "/agent", runtimeFactory: factory });
		const models = await pusher.push();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({ type: "models", models });
		expect(modelsOf(sent[0]).map((m) => m.id)).toEqual(["openai/a"]);
	});

	it("refresh 抛错仍出帧", async () => {
		const { factory } = countingFactory(() =>
			fakeRuntime({ available: [model({ id: "a" })], refreshError: new Error("network down") }),
		);
		const { sent, transport } = fakeTransport();
		await createModelPusher({ transport, agentDir: "/agent", runtimeFactory: factory }).push();
		expect(modelsOf(sent[0]).map((m) => m.id)).toEqual(["demo/a"]);
	});

	it("加载失败发空表且不抛", async () => {
		const { factory } = countingFactory(() => fakeRuntime({ availableError: new Error("no catalog") }));
		const { sent, transport } = fakeTransport();
		const models = await createModelPusher({ transport, agentDir: "/agent", runtimeFactory: factory }).push();
		expect(models).toEqual([]);
		expect(sent).toEqual([{ type: "models", models: [] }]);
	});

	it("通道已关零发送（但仍把表交回去）", async () => {
		const { factory } = countingFactory(() => fakeRuntime({ available: [model({ id: "a" })] }));
		const { sent, transport } = fakeTransport(true);
		const models = await createModelPusher({ transport, agentDir: "/agent", runtimeFactory: factory }).push();
		expect(sent).toEqual([]);
		expect(models.map((m) => m.id)).toEqual(["demo/a"]);
	});

	it("多次 push 复用同一个运行时（工厂只调一次）", async () => {
		const { factory, calls } = countingFactory();
		const { transport } = fakeTransport();
		const pusher = createModelPusher({ transport, agentDir: "/agent", runtimeFactory: factory });
		await pusher.push();
		await pusher.push();
		expect(calls).toHaveLength(1);
	});

	it("invalidate() 之后重建运行时（工厂被调两次）", async () => {
		const { factory, calls } = countingFactory();
		const { transport } = fakeTransport();
		const pusher = createModelPusher({ transport, agentDir: "/agent", runtimeFactory: factory });
		await pusher.push();
		pusher.invalidate();
		await pusher.push();
		expect(calls).toHaveLength(2);
	});

	it("建运行时失败不缓存：下一次 push 重试", async () => {
		const calls: ModelRuntimePaths[] = [];
		const factory: ModelRuntimeFactory = async (paths) => {
			calls.push(paths);
			if (calls.length === 1) throw new Error("create failed");
			return fakeRuntime({ available: [model({ id: "a" })] });
		};
		const { sent, transport } = fakeTransport();
		const pusher = createModelPusher({ transport, agentDir: "/agent", runtimeFactory: factory });
		expect(await pusher.push()).toEqual([]);
		expect((await pusher.push()).map((m) => m.id)).toEqual(["demo/a"]);
		expect(calls).toHaveLength(2);
		expect(sent.map((msg) => modelsOf(msg).length)).toEqual([0, 1]);
	});

	it("allowNetwork 缺省开、可关", async () => {
		const seenDefault: { allowNetwork: boolean; signal: AbortSignal }[] = [];
		const seenOff: { allowNetwork: boolean; signal: AbortSignal }[] = [];
		await createModelPusher({
			transport: fakeTransport().transport,
			agentDir: "/agent",
			runtimeFactory: countingFactory(() => fakeRuntime({ seen: seenDefault })).factory,
		}).push();
		await createModelPusher({
			transport: fakeTransport().transport,
			agentDir: "/agent",
			allowNetwork: false,
			runtimeFactory: countingFactory(() => fakeRuntime({ seen: seenOff })).factory,
		}).push();
		expect(seenDefault.map((s) => s.allowNetwork)).toEqual([true]);
		expect(seenOff.map((s) => s.allowNetwork)).toEqual([false]);
	});
});
