import { describe, expect, it, vi } from "vitest";
import type { ClientStateStore } from "../../server/client-state.js";
import type { ModelAdminPort, ModelMemoryPort } from "../../packages/keel/src/contracts/model-admin.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import type { SessionRegistry } from "../../packages/keel/src/app/session-registry.js";
import { ClientRuntime, type ClientFrames } from "../../packages/keel/src/app/client-runtime.js";
import { createModelMemory } from "../../packages/keel/src/adapters/state/model-memory.js";
import { conversationViewFromSession } from "../../packages/keel/src/adapters/sdk/view.js";

const MODEL = { provider: "demo", id: "m1", name: "Demo" };

function fakeTransport(): { port: TransportPort; sent: ServerMessage[] } {
	const sent: ServerMessage[] = [];
	return { sent, port: { send: (msg) => void sent.push(msg), isClosed: () => false } };
}

function fakeSession() {
	return {
		sessionId: "s1",
		model: { provider: "demo", id: "m0" },
		thinkingLevel: "off",
		dispose: () => {},
		getAvailableThinkingLevels: () => ["off", "high"],
		setModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(),
		settingsManager: {
			setDefaultModelAndProvider: vi.fn(),
			setModelThinkingLevel: vi.fn(),
		},
	};
}

function fakeMemory(): ModelMemoryPort & { calls: [string, ...unknown[]][] } {
	const calls: [string, ...unknown[]][] = [];
	const track =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push([name, ...args]);
			return undefined;
		};
	return {
		calls,
		getProjectModel: track("getProjectModel") as ModelMemoryPort["getProjectModel"],
		saveProjectModel: track("saveProjectModel") as ModelMemoryPort["saveProjectModel"],
		getProjectProviderKey: track("getProjectProviderKey") as ModelMemoryPort["getProjectProviderKey"],
		saveProjectProviderKey: track("saveProjectProviderKey") as ModelMemoryPort["saveProjectProviderKey"],
		deleteProjectProviderKey: track("deleteProjectProviderKey") as ModelMemoryPort["deleteProjectProviderKey"],
		getDefaultModel: track("getDefaultModel") as ModelMemoryPort["getDefaultModel"],
		saveDefaultModel: track("saveDefaultModel") as ModelMemoryPort["saveDefaultModel"],
		getDefaultProviderKey: track("getDefaultProviderKey") as ModelMemoryPort["getDefaultProviderKey"],
		saveDefaultProviderKey: track("saveDefaultProviderKey") as ModelMemoryPort["saveDefaultProviderKey"],
	};
}

function fakeModelAdmin(activeKey: string | null = "key-a"): ModelAdminPort {
	const stub = () => vi.fn(() => Promise.resolve());
	return {
		listProviderKeys: vi.fn(),
		setProviderApiKey: stub(),
		addProviderKey: stub(),
		activateProviderKey: vi.fn(async () => true),
		removeProviderKey: stub(),
		clearProviderApiKey: stub(),
		getActiveKeyName: () => activeKey,
		hasProviderKey: () => true,
		listProviders: stub(),
		listModelsConfig: stub(),
		reloadModelsConfig: stub(),
		saveModelConfig: stub(),
		deleteModelConfig: stub(),
		cloneProvider: stub(),
		fetchModelsList: stub(),
		testConnection: stub(),
		refreshProviderModels: stub(),
		refreshBuiltinModels: stub(),
		appendBuiltinModel: stub(),
		enrichModels: stub(),
		abortEnrichModels: vi.fn(),
		startProviderOAuth: () => "flow-1",
		replyProviderOAuth: vi.fn(),
		cancelProviderOAuth: vi.fn(),
		listProviderOAuthFlows: vi.fn(),
		logoutProviderOAuth: stub(),
	} as ModelAdminPort;
}

interface Harness {
	runtime: ClientRuntime;
	sent: ServerMessage[];
	session: ReturnType<typeof fakeSession>;
	memory: ReturnType<typeof fakeMemory>;
	admin: ModelAdminPort;
	frames: { calls: string[] };
}

function makeHarness(overrides: { resolveModel?: (provider: string, id: string) => Promise<unknown> } = {}): Harness {
	const transport = fakeTransport();
	const session = fakeSession();
	const memory = fakeMemory();
	const admin = fakeModelAdmin();
	const calls: string[] = [];
	const runtime = new ClientRuntime({
		clientId: "c1",
		cwd: "/work",
		env: { settingsVersion: 1, piConfigured: true, piAgentInstalled: true },
		clock: { now: () => 1, after: () => () => {} },
		transport: transport.port,
		sessions: {
			get: () => ({ session }),
			ensure: async () => ({ session }),
			close: () => {},
			closeAll: () => {},
		} as unknown as SessionRegistry,
		modelAdmin: admin,
		modelMemory: memory,
		resolveModel: overrides.resolveModel ?? (async () => MODEL),
		viewOf: (conv) => conversationViewFromSession(conv, session),
	});
	const frames: ClientFrames = {
		pushSettings: () => void calls.push("settings"),
		refreshSessions: async () => {},
		pushProjects: async () => {},
		listModels: () => void calls.push("models"),
		pushDefaultModel: () => void calls.push("defaultModel"),
	};
	runtime.attachFrames(frames);
	runtime.handlers().newChat();
	return { runtime, sent: transport.sent, session, memory, admin, frames: { calls } };
}

const notices = (sent: ServerMessage[]) => sent.filter((m) => m.type === "notice");

describe("选模型 / 思考档 / 全局默认模型（B1）", () => {
	it("setModel：解析 provider/id → 取模型对象 → 会话换模型 → 项目记忆落盘", async () => {
		const h = makeHarness();
		await h.runtime.handlers().setModel("demo/m1");
		expect(h.session.setModel).toHaveBeenCalledWith(MODEL);
		expect(h.memory.calls).toContainEqual(["saveProjectModel", "c1", "/work", "demo/m1", "pi"]);
		expect(h.memory.calls).toContainEqual(["saveProjectProviderKey", "c1", "/work", "demo", "key-a"]);
		expect(notices(h.sent)).toEqual([]);
	});

	it("setModel：无效 ID / 目录里没有该模型 → 发 notice 且不动会话", async () => {
		const bad = makeHarness();
		await bad.runtime.handlers().setModel("no-slash");
		expect(bad.session.setModel).not.toHaveBeenCalled();
		expect(notices(bad.sent).at(-1)).toMatchObject({ level: "error" });
		expect(notices(bad.sent).at(-1)?.text).toContain("无效的模型 ID");

		const missing = makeHarness({ resolveModel: async () => undefined });
		await missing.runtime.handlers().setModel("demo/nope");
		expect(missing.session.setModel).not.toHaveBeenCalled();
		expect(notices(missing.sent).at(-1)?.text).toContain("模型不存在");
	});

	it("setThinking：会话落盘 + 供应商级思考档记忆", () => {
		const h = makeHarness();
		h.runtime.handlers().setThinking("high");
		expect(h.session.setThinkingLevel).toHaveBeenCalledWith("high", { persist: true });
		expect(h.session.settingsManager.setModelThinkingLevel).toHaveBeenCalledWith("demo", "m0", "high");
	});

	it("setDefaultModel：落全局默认 + 当前 key + SDK 默认 + 推 default_model 帧", async () => {
		const h = makeHarness();
		const cs = h.runtime.handlers();
		expect(cs.setDefaultModel, "setDefaultModel 必须已注册").toBeDefined();
		await cs.setDefaultModel?.("demo/m1");
		expect(h.memory.calls).toContainEqual(["saveDefaultModel", "demo/m1", "pi"]);
		expect(h.memory.calls).toContainEqual(["saveDefaultProviderKey", "demo", "key-a"]);
		expect(h.session.settingsManager.setDefaultModelAndProvider).toHaveBeenCalledWith("demo", "m1");
		expect(h.frames.calls).toContain("defaultModel");
		expect(notices(h.sent).at(-1)).toMatchObject({ level: "info" });
	});

	it("clearDefaultModel：清空默认 + 推帧", () => {
		const h = makeHarness();
		const cs = h.runtime.handlers();
		expect(cs.clearDefaultModel, "clearDefaultModel 必须已注册").toBeDefined();
		cs.clearDefaultModel?.();
		expect(h.memory.calls).toContainEqual(["saveDefaultModel", "", "pi"]);
		expect(h.frames.calls).toContain("defaultModel");
	});

	it("换完模型会出快照（可见面里的 model 变了）", async () => {
		const h = makeHarness({
			resolveModel: async () => MODEL,
		});
		const before = h.sent.filter((m) => m.type === "snapshot").length;
		h.session.setModel = vi.fn(async () => {
			h.session.model = { provider: "demo", id: "m1" };
		});
		await h.runtime.handlers().setModel("demo/m1");
		h.runtime.handlers().flushSnapshot(true);
		const snaps = h.sent.filter((m) => m.type === "snapshot");
		expect(snaps.length).toBeGreaterThan(before);
		expect(JSON.stringify(snaps.at(-1))).toContain("m1");
	});
});

describe("模型记忆适配器", () => {
	it("九格窄面直接转发给 ClientStateStore，不自己缓存", () => {
		const store = {
			getProjectModel: vi.fn(() => "demo/m1"),
			saveProjectModel: vi.fn(),
			getProjectProviderKey: vi.fn(() => "key-a"),
			saveProjectProviderKey: vi.fn(),
			deleteProjectProviderKey: vi.fn(),
			getDefaultModel: vi.fn(() => "demo/m2"),
			saveDefaultModel: vi.fn(),
			getDefaultProviderKey: vi.fn(() => "key-b"),
			saveDefaultProviderKey: vi.fn(),
		} as unknown as ClientStateStore;
		const memory = createModelMemory(store);
		expect(memory.getProjectModel("c1", "/w", "pi")).toBe("demo/m1");
		memory.saveProjectModel("c1", "/w", "demo/m1", "pi");
		memory.saveDefaultProviderKey("demo", "key-b");
		expect(store.saveProjectModel).toHaveBeenCalledWith("c1", "/w", "demo/m1", "pi");
		expect(store.saveDefaultProviderKey).toHaveBeenCalledWith("demo", "key-b");
	});
});
