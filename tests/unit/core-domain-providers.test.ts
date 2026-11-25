import { describe, expect, expectTypeOf, it } from "vitest";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { ModelAdminPort, ModelMemoryPort } from "../../packages/keel/src/contracts/model-admin.js";
import { createProviderHandlers, type ProviderHandlers } from "../../packages/keel/src/domains/providers/handlers.js";
import { bindProjectKeyPins } from "../../packages/keel/src/domains/models/index.js";
import type { DispatchSession } from "../../packages/keel/src/engine-service.js";
import type { ServerLang } from "../../packages/keel/src/i18n.js";
import type { ServerMessage, UiModelConfigEntry, UiProviderConfig } from "../../server/protocol.js";

type Call = [name: string, ...args: unknown[]];

/** 期望里占位「第 N 位是 lang 读取器」：断言时换成「是函数且返回当前语言」。 */
const LANG = Symbol("lang");

const uiConfig: UiProviderConfig = {
	providerId: "acme",
	name: "Acme",
	api: "openai-completions",
	baseUrl: "https://api.acme.test/v1",
	models: [{ id: "acme-large" }],
};
const entry: UiModelConfigEntry = { id: "acme-small", name: "Acme Small" };
const hints: Record<string, string> = { "acme-large": "large" };

interface Case {
	member: keyof ProviderHandlers;
	invoke(handlers: ProviderHandlers): unknown;
	port: string;
	args: unknown[];
}

/** 24 个成员 × (端口方法名, 端口参数) 表：这是本批唯一的行为约定，改一行就是改契约。 */
const cases: Case[] = [
	{
		member: "setProviderApiKey",
		invoke: (h) => h.setProviderApiKey("acme", "sk-1"),
		port: "setProviderApiKey",
		args: ["acme", "sk-1"],
	},
	{
		member: "clearProviderApiKey",
		invoke: (h) => h.clearProviderApiKey("acme"),
		port: "clearProviderApiKey",
		args: ["acme"],
	},
	{
		member: "startProviderOAuth",
		invoke: (h) => h.startProviderOAuth("acme"),
		port: "startProviderOAuth",
		args: ["acme"],
	},
	{
		member: "replyProviderOAuth",
		invoke: (h) => h.replyProviderOAuth("flow-1", "prompt-1", "123456"),
		port: "replyProviderOAuth",
		args: ["flow-1", "prompt-1", "123456"],
	},
	{
		member: "cancelProviderOAuth",
		invoke: (h) => h.cancelProviderOAuth("flow-1"),
		port: "cancelProviderOAuth",
		args: ["flow-1"],
	},
	{
		member: "listProviderOAuthFlows",
		invoke: (h) => h.listProviderOAuthFlows(),
		port: "listProviderOAuthFlows",
		args: [],
	},
	{
		member: "logoutProviderOAuth",
		invoke: (h) => h.logoutProviderOAuth("acme"),
		port: "logoutProviderOAuth",
		args: ["acme"],
	},
	{ member: "listModelsConfig", invoke: (h) => h.listModelsConfig(), port: "listModelsConfig", args: [] },
	{ member: "reloadModelsConfig", invoke: (h) => h.reloadModelsConfig(), port: "reloadModelsConfig", args: [] },
	{
		member: "saveModelConfig",
		invoke: (h) => h.saveModelConfig("acme", uiConfig),
		port: "saveModelConfig",
		args: ["acme", uiConfig],
	},
	{
		member: "deleteModelConfig",
		invoke: (h) => h.deleteModelConfig("acme"),
		port: "deleteModelConfig",
		args: ["acme"],
	},
	{ member: "listProviders", invoke: (h) => h.listProviders(), port: "listProviders", args: [] },
	{ member: "listProviderKeys", invoke: (h) => h.listProviderKeys(), port: "listProviderKeys", args: [] },
	{
		member: "addProviderKey",
		invoke: (h) => h.addProviderKey("acme", "sk-2", "work"),
		port: "addProviderKey",
		args: ["acme", "sk-2", "work"],
	},
	{
		member: "activateProviderKey",
		invoke: (h) => h.activateProviderKey("acme", "work"),
		port: "activateProviderKey",
		args: ["acme", "work"],
	},
	{
		member: "removeProviderKey",
		invoke: (h) => h.removeProviderKey("acme", "work"),
		port: "removeProviderKey",
		args: ["acme", "work"],
	},
	{
		member: "fetchModelsList",
		invoke: (h) => h.fetchModelsList(7, "https://api.acme.test/v1", "sk-1", true, "openai", "acme"),
		port: "fetchModelsList",
		args: [7, "https://api.acme.test/v1", "sk-1", true, "openai", LANG, "acme"],
	},
	{
		member: "testModelConnection",
		invoke: (h) => h.testModelConnection(7, "https://api.acme.test/v1", "sk-1", true, "openai", "acme"),
		port: "testConnection",
		args: [7, "https://api.acme.test/v1", "sk-1", true, "openai", LANG, "acme"],
	},
	{
		member: "refreshProviderModels",
		invoke: (h) => h.refreshProviderModels("acme", 7),
		port: "refreshProviderModels",
		args: ["acme", 7, LANG],
	},
	{ member: "refreshBuiltinModels", invoke: (h) => h.refreshBuiltinModels(7), port: "refreshBuiltinModels", args: [7] },
	{
		member: "appendBuiltinModel",
		invoke: (h) => h.appendBuiltinModel("acme", entry, 7),
		port: "appendBuiltinModel",
		args: ["acme", entry, 7],
	},
	{ member: "cloneProvider", invoke: (h) => h.cloneProvider("acme", 7), port: "cloneProvider", args: ["acme", 7] },
	{
		member: "enrichModels",
		invoke: (h) => h.enrichModels(7, ["acme-large", "acme-small"], hints),
		port: "enrichModels",
		args: [7, ["acme-large", "acme-small"], hints, LANG],
	},
	{
		member: "abortEnrichModels",
		invoke: (h) => h.abortEnrichModels(7),
		port: "abortEnrichModels",
		args: [7],
	},
];

/** 记账型端口假体：`activateProviderKey`/`startProviderOAuth` 有返回值，其余全 `undefined`。 */
function fakePort(): { port: ModelAdminPort; calls: Call[] } {
	const calls: Call[] = [];
	const port = new Proxy(
		{},
		{
			get:
				(_target, name) =>
				(...args: unknown[]) => {
					calls.push([String(name), ...args]);
					const value = name === "activateProviderKey" ? true : name === "startProviderOAuth" ? "flow-1" : undefined;
					return Promise.resolve(value);
				},
		},
	) as unknown as ModelAdminPort;
	return { port, calls };
}

function expectArgs(actual: unknown[], expected: unknown[]): void {
	expect(actual, "端口参数个数").toHaveLength(expected.length);
	expected.forEach((want, index) => {
		if (want === LANG) {
			const thunk = actual[index];
			expect(typeof thunk, `第 ${index + 1} 个参数应是 lang 读取器`).toBe("function");
			expect((thunk as () => ServerLang)()).toBe("en");
			return;
		}
		expect(actual[index], `第 ${index + 1} 个参数`).toEqual(want);
	});
}

describe("domains/providers · 24 个 handler 纯转发到 ModelAdminPort", () => {
	it("表里正好 24 个成员，且覆盖 DispatchSession 的全部供应商成员", () => {
		expect(cases).toHaveLength(24);
		expect(new Set(cases.map((c) => c.member)).size).toBe(24);
	});

	it.each(cases)("$member → $port（参数顺序逐位对齐）", async (c) => {
		const { port, calls } = fakePort();
		await c.invoke(createProviderHandlers({ modelAdmin: port, getLang: () => "en" }));
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toBe(c.port);
		expectArgs(calls[0].slice(1), c.args);
	});

	it("lang 是惰性读取器：调用时取当前语言，而不是建 handler 时抓快照", async () => {
		const { port, calls } = fakePort();
		let lang: ServerLang = "zh";
		const handlers = createProviderHandlers({ modelAdmin: port, getLang: () => lang });
		await handlers.fetchModelsList(1, "https://api.acme.test/v1", undefined, undefined, undefined, undefined);
		const thunk = calls[0][6] as () => ServerLang;
		expect(thunk()).toBe("zh");
		lang = "zh-TW";
		expect(thunk()).toBe("zh-TW");
	});

	it("saveModelConfig / appendBuiltinModel 只做窄强制转换：原样透传引用（不校验、不补默认值）", async () => {
		const { port, calls } = fakePort();
		const handlers = createProviderHandlers({ modelAdmin: port, getLang: () => "en" });
		const loose: unknown = { providerId: "acme", models: [] };
		await handlers.saveModelConfig("acme", loose);
		await handlers.appendBuiltinModel("acme", loose, 3);
		expect(calls[0][2]).toBe(loose);
		expect(calls[1][2]).toBe(loose);
	});

	it("addProviderKey 不传 name 时把 undefined 老老实实交给端口", async () => {
		const { port, calls } = fakePort();
		await createProviderHandlers({ modelAdmin: port, getLang: () => "en" }).addProviderKey("acme", "sk-3");
		expect(calls).toEqual([["addProviderKey", "acme", "sk-3", undefined]]);
	});

	it("abortEnrichModels 不带 reqId 时同样原样转发", async () => {
		const { port, calls } = fakePort();
		createProviderHandlers({ modelAdmin: port, getLang: () => "en" }).abortEnrichModels();
		expect(calls).toEqual([["abortEnrichModels", undefined]]);
	});
});

describe("domains/providers · 返回值与出帧口径", () => {
	it("activateProviderKey 丢弃端口的 boolean，也不自己补一帧（帧只来自端口）", async () => {
		const sent: ServerMessage[] = [];
		const transport = { send: (msg: ServerMessage) => void sent.push(msg), isClosed: () => false };
		const calls: Call[] = [];
		const port = new Proxy(
			{},
			{
				get:
					(_target, name) =>
					(...args: unknown[]) => {
						calls.push([String(name), ...args]);
						// 真端口内部 emit notice：handler 若再补一帧，下面就会变成 2。
						transport.send({ type: "notice", level: "info", text: "已切换供应商密钥" });
						return Promise.resolve(name === "activateProviderKey" ? true : undefined);
					},
			},
		) as unknown as ModelAdminPort;
		const handlers = createProviderHandlers({ modelAdmin: port, getLang: () => "zh" });
		await expect(handlers.activateProviderKey("acme", "work")).resolves.toBeUndefined();
		expect(calls).toEqual([["activateProviderKey", "acme", "work"]]);
		expect(sent).toHaveLength(1);
	});

	it("startProviderOAuth 丢弃端口的 flowId（协议是 void）", () => {
		const { port, calls } = fakePort();
		const handlers = createProviderHandlers({ modelAdmin: port, getLang: () => "zh" });
		expect(handlers.startProviderOAuth("acme")).toBeUndefined();
		expect(calls).toEqual([["startProviderOAuth", "acme"]]);
	});
});

describe("domains/providers · modelAdmin 缺省 = 未接", () => {
	it("代表性成员同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const handlers = createProviderHandlers({ getLang: () => "zh" });
		expect(() => handlers.setProviderApiKey("acme", "sk-1")).toThrow(CoreEngineNotReadyError);
		expect(() => handlers.setProviderApiKey("acme", "sk-1")).toThrow(/setProviderApiKey/);
		expect(() => handlers.saveModelConfig("acme", uiConfig)).toThrow(CoreEngineNotReadyError);
		expect(() => handlers.activateProviderKey("acme", "work")).toThrow(CoreEngineNotReadyError);
	});

	it("24 个成员逐个调用都同步抛（彻底不留「返回空 promise」的口子）", () => {
		const handlers = createProviderHandlers({ getLang: () => "zh" });
		for (const c of cases) {
			expect(() => c.invoke(handlers), `${c.member} 应同步抛`).toThrow(CoreEngineNotReadyError);
		}
	});
});

describe("domains/providers · 项目级 key 记忆（老 agent-service.ts:9538-9548）", () => {
	/** 记忆假体：只记真正落盘的那几格，其余不动。 */
	function fakeMemory(): ModelMemoryPort & { calls: Call[] } {
		const calls: Call[] = [];
		const track =
			(name: string) =>
			(...args: unknown[]) =>
				void calls.push([name, ...args]);
		return {
			calls,
			getProjectModel: () => undefined,
			saveProjectModel: track("saveProjectModel") as ModelMemoryPort["saveProjectModel"],
			getProjectProviderKey: () => undefined,
			saveProjectProviderKey: track("saveProjectProviderKey") as ModelMemoryPort["saveProjectProviderKey"],
			deleteProjectProviderKey: track("deleteProjectProviderKey") as ModelMemoryPort["deleteProjectProviderKey"],
			getDefaultModel: () => undefined,
			saveDefaultModel: track("saveDefaultModel") as ModelMemoryPort["saveDefaultModel"],
			getDefaultProviderKey: () => undefined,
			saveDefaultProviderKey: track("saveDefaultProviderKey") as ModelMemoryPort["saveDefaultProviderKey"],
			repointDeletedKeyEverywhere: track(
				"repointDeletedKeyEverywhere",
			) as ModelMemoryPort["repointDeletedKeyEverywhere"],
			repointDeletedKeyInDefault: track("repointDeletedKeyInDefault") as ModelMemoryPort["repointDeletedKeyInDefault"],
		};
	}

	function projectAdmin(ok: boolean, active: string | null = "work") {
		const calls: Call[] = [];
		const port = new Proxy(
			{},
			{
				get:
					(_target, name) =>
					(...args: unknown[]) => {
						calls.push([String(name), ...args]);
						if (name === "getActiveKeyName") return active;
						return Promise.resolve(name === "activateProviderKey" ? ok : undefined);
					},
			},
		) as unknown as ModelAdminPort;
		return { port, calls };
	}

	/** 凭据域只认这三格：项目记忆的真身由模型域绑定（`bindProjectKeyPins`），这里同样走绑定器。 */
	const pins = (memory: ModelMemoryPort) =>
		bindProjectKeyPins({
			clientId: () => "c1",
			cwd: () => "/work/proj-a",
			memory: () => memory,
			admin: () => undefined,
		});

	it("activateProviderKey 成功：把这个项目的选择记下来", async () => {
		const memory = fakeMemory();
		const { port } = projectAdmin(true);
		const handlers = createProviderHandlers({ modelAdmin: port, projectKeys: pins(memory), getLang: () => "zh" });
		await handlers.activateProviderKey("acme", "work");
		expect(memory.calls).toEqual([["saveProjectProviderKey", "c1", "/work/proj-a", "acme", "work"]]);
	});

	it("activateProviderKey 失败（key 不存在）：把那条记忆删掉，下次进项目不去激活它", async () => {
		const memory = fakeMemory();
		const { port } = projectAdmin(false);
		const handlers = createProviderHandlers({ modelAdmin: port, projectKeys: pins(memory), getLang: () => "zh" });
		await handlers.activateProviderKey("acme", "gone");
		expect(memory.calls).toEqual([["deleteProjectProviderKey", "c1", "/work/proj-a", "acme"]]);
	});

	it("removeProviderKey：删完把项目/全局引用改指新的 active", async () => {
		const memory = fakeMemory();
		const { port, calls } = projectAdmin(false, "other");
		const handlers = createProviderHandlers({ modelAdmin: port, projectKeys: pins(memory), getLang: () => "zh" });
		await handlers.removeProviderKey("acme", "work");
		expect(calls.map((c) => c[0])).toEqual(["removeProviderKey", "getActiveKeyName"]);
		expect(memory.calls).toEqual([
			["repointDeletedKeyEverywhere", "acme", "work", "other"],
			["repointDeletedKeyInDefault", "acme", "work", "other"],
		]);
	});

	it("没接 projectKeys（或记忆未接）：只动凭据，不写项目记忆", async () => {
		const memory = fakeMemory();
		const { port } = projectAdmin(true);
		await createProviderHandlers({ modelAdmin: port, getLang: () => "zh" }).activateProviderKey("acme", "work");
		await createProviderHandlers({
			modelAdmin: port,
			projectKeys: bindProjectKeyPins({
				clientId: () => "c1",
				cwd: () => "/work/proj-a",
				memory: () => undefined,
			}),
			getLang: () => "zh",
		}).removeProviderKey("acme", "work");
		expect(memory.calls).toEqual([]);
	});
});

type SessionSlice = Pick<DispatchSession, keyof ProviderHandlers>;
type MissingInSession = Exclude<keyof ProviderHandlers, keyof DispatchSession>;

describe("domains/providers · 与 DispatchSession 的签名对齐（类型层）", () => {
	it("每个成员都在 DispatchSession 里同名存在，且签名可赋值", () => {
		expectTypeOf<MissingInSession>().toEqualTypeOf<never>();
		expectTypeOf<ProviderHandlers>().toMatchTypeOf<SessionSlice>();
	});
});
