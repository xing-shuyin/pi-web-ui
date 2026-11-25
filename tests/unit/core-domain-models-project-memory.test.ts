import { describe, expect, it, vi } from "vitest";
import type { ModelAdminPort, ModelMemoryPort } from "../../packages/keel/src/contracts/model-admin.js";
import type { TurnCapableSession } from "../../packages/keel/src/contracts/session.js";
import {
	createProjectMemory,
	modelKeyOf,
	parseModelId,
	type ProjectMemory,
} from "../../packages/keel/src/domains/models/project-memory.js";

const A = "/work/proj-a";
const B = "/work/proj-b";

const MODEL = { provider: "demo", id: "m1" };

function fakeMemory(
	seed: { projectModel?: string; defaultModel?: string; projectKeys?: Record<string, Record<string, string>> } = {},
): ModelMemoryPort & { calls: [string, ...unknown[]][] } {
	const calls: [string, ...unknown[]][] = [];
	const projectKeys = seed.projectKeys ?? {};
	const memory: ModelMemoryPort & { calls: [string, ...unknown[]][] } = {
		calls,
		getProjectModel: (clientId, cwd, engine) => {
			calls.push(["getProjectModel", clientId, cwd, engine]);
			return seed.projectModel;
		},
		saveProjectModel: (...args) => void calls.push(["saveProjectModel", ...args]),
		getProjectProviderKey: (clientId, cwd, provider) => {
			calls.push(["getProjectProviderKey", clientId, cwd, provider]);
			return projectKeys[cwd]?.[provider];
		},
		saveProjectProviderKey: (...args) => void calls.push(["saveProjectProviderKey", ...args]),
		deleteProjectProviderKey: (...args) => void calls.push(["deleteProjectProviderKey", ...args]),
		getDefaultModel: (engine) => {
			calls.push(["getDefaultModel", engine]);
			return seed.defaultModel;
		},
		saveDefaultModel: (...args) => void calls.push(["saveDefaultModel", ...args]),
		getDefaultProviderKey: (provider) => {
			calls.push(["getDefaultProviderKey", provider]);
			return undefined;
		},
		saveDefaultProviderKey: (...args) => void calls.push(["saveDefaultProviderKey", ...args]),
		getProjectProviderKeys: (clientId, cwd) => {
			calls.push(["getProjectProviderKeys", clientId, cwd]);
			return projectKeys[cwd];
		},
		repointDeletedKeyEverywhere: (...args) => void calls.push(["repointDeletedKeyEverywhere", ...args]),
		repointDeletedKeyInDefault: (...args) => void calls.push(["repointDeletedKeyInDefault", ...args]),
	};
	return memory;
}

function fakeAdmin(state: { active?: string | null; existing?: string[]; ok?: boolean } = {}): ModelAdminPort {
	const active = state.active ?? "key-a";
	const existing = new Set(state.existing ?? ["key-a", "key-b"]);
	return {
		activateProviderKey: vi.fn(async () => state.ok ?? true),
		getActiveKeyName: () => active,
		hasProviderKey: (_provider: string, keyName: string) => existing.has(keyName),
	} as unknown as ModelAdminPort;
}

function makeProject(
	memory: ModelMemoryPort,
	admin?: ModelAdminPort,
): ProjectMemory & { memory: ModelMemoryPort; admin?: ModelAdminPort } {
	return {
		...createProjectMemory({ clientId: "c1", memory, ...(admin ? { admin } : {}) }),
		memory,
		...(admin ? { admin } : {}),
	};
}

// 会话假体按契约给全（`dispose` 是 `TurnCapableSession` 的必备项）：只补本用例要用的那一格。
function fakeSession(model: unknown, messages: readonly unknown[] = []): TurnCapableSession {
	return {
		sessionId: "s1",
		sessionFile: "/agent/sessions/--w--/s1.jsonl",
		messages,
		isStreaming: false,
		dispose: () => {},
		model,
		setModel: vi.fn(async () => {}),
	} as unknown as TurnCapableSession;
}

describe("项目记忆 · provider key", () => {
	it("rememberActiveKey / forgetKey 只写「客户端 + 项目 + provider」这一格", () => {
		const memory = fakeMemory();
		const project = makeProject(memory, fakeAdmin());
		project.rememberActiveKey(A, "demo", "key-b");
		project.forgetKey(A, "demo");
		expect(memory.calls).toContainEqual(["saveProjectProviderKey", "c1", A, "demo", "key-b"]);
		expect(memory.calls).toContainEqual(["deleteProjectProviderKey", "c1", A, "demo"]);
	});

	it("restoreKeysForProject：与当前 active 不同的全部静默激活，已相同的不动", async () => {
		const memory = fakeMemory({ projectKeys: { [A]: { demo: "key-b", other: "key-a" } } });
		const admin = fakeAdmin({ active: "key-a", existing: ["key-a", "key-b"] });
		await makeProject(memory, admin).restoreKeysForProject(A);
		expect(admin.activateProviderKey).toHaveBeenCalledTimes(1);
		expect(admin.activateProviderKey).toHaveBeenCalledWith("demo", "key-b", { silent: true });
	});

	it("restoreKeysForProject：记忆里的 key 已经不在了 → 删掉那条记忆，不激活、不报错", async () => {
		const memory = fakeMemory({ projectKeys: { [A]: { demo: "gone" } } });
		const admin = fakeAdmin({ active: "key-a", existing: ["key-a"] });
		await makeProject(memory, admin).restoreKeysForProject(A);
		expect(admin.activateProviderKey).not.toHaveBeenCalled();
		expect(memory.calls).toContainEqual(["deleteProjectProviderKey", "c1", A, "demo"]);
	});

	it("restoreKeysForProject：激活失败（端口回 false）也把记忆删掉", async () => {
		const memory = fakeMemory({ projectKeys: { [A]: { demo: "key-b" } } });
		const admin = fakeAdmin({ active: "key-a", existing: ["key-a", "key-b"], ok: false });
		await makeProject(memory, admin).restoreKeysForProject(A);
		expect(memory.calls).toContainEqual(["deleteProjectProviderKey", "c1", A, "demo"]);
	});

	it("restoreKeysForProject：没有枚举口 / 没有凭据面 = 什么都不做（不抛）", async () => {
		const memory = fakeMemory();
		delete (memory as { getProjectProviderKeys?: unknown }).getProjectProviderKeys;
		await expect(makeProject(memory, fakeAdmin()).restoreKeysForProject(A)).resolves.toBeUndefined();
		await expect(makeProject(fakeMemory(), undefined).restoreKeysForProject(A)).resolves.toBeUndefined();
	});

	it("restoreKeyForModel：项目 pin 优先，其次全局 pin；项目 pin 失效就自愈删除", async () => {
		const withPin = fakeMemory({ projectKeys: { [A]: { demo: "key-b" } } });
		const admin = fakeAdmin({ active: "key-a" });
		await makeProject(withPin, admin).restoreKeyForModel(A, "demo/m1");
		expect(admin.activateProviderKey).toHaveBeenCalledWith("demo", "key-b", { silent: true });

		const stale = fakeMemory({ projectKeys: { [A]: { demo: "gone" } } });
		const staleAdmin = fakeAdmin({ active: "key-a", existing: ["key-a"] });
		await makeProject(stale, staleAdmin).restoreKeyForModel(A, "demo/m1");
		expect(staleAdmin.activateProviderKey).not.toHaveBeenCalled();
		expect(stale.calls).toContainEqual(["deleteProjectProviderKey", "c1", A, "demo"]);
	});

	it("repointDeletedKey：项目记忆与全局默认各改一次（老 repointDeletedKeyEverywhere/InDefault）", () => {
		const memory = fakeMemory();
		makeProject(memory, fakeAdmin()).repointDeletedKey("demo", "key-b", "key-a");
		expect(memory.calls).toContainEqual(["repointDeletedKeyEverywhere", "demo", "key-b", "key-a"]);
		expect(memory.calls).toContainEqual(["repointDeletedKeyInDefault", "demo", "key-b", "key-a"]);
	});
});

describe("项目记忆 · 模型", () => {
	it("rememberModel：项目模型 + 该 provider 当前 active key 一起记（老 rememberProjectModel）", () => {
		const memory = fakeMemory();
		makeProject(memory, fakeAdmin({ active: "key-b" })).rememberModel(A, "demo/m1");
		expect(memory.calls).toContainEqual(["saveProjectModel", "c1", A, "demo/m1", "pi"]);
		expect(memory.calls).toContainEqual(["saveProjectProviderKey", "c1", A, "demo", "key-b"]);
	});

	it("rememberedModel：项目记忆优先，其次全局默认", () => {
		expect(makeProject(fakeMemory({ projectModel: "demo/m1", defaultModel: "demo/m2" })).rememberedModel(A)).toBe(
			"demo/m1",
		);
		expect(makeProject(fakeMemory({ defaultModel: "demo/m2" })).rememberedModel(A)).toBe("demo/m2");
		expect(makeProject(fakeMemory()).rememberedModel(A)).toBeUndefined();
	});

	it("restoreModelForProject：空会话套上项目模型，并先恢复该 provider 的 key", async () => {
		const memory = fakeMemory({ projectModel: "demo/m1", projectKeys: { [A]: { demo: "key-b" } } });
		const admin = fakeAdmin({ active: "key-a" });
		const project = makeProject(memory, admin);
		const session = fakeSession({ provider: "demo", id: "m0" });
		const onModelChanged = vi.fn();
		const applied = await project.restoreModelForProject({
			cwd: A,
			session,
			resolveModel: async () => MODEL,
			onModelChanged,
		});
		expect(applied).toBe(true);
		expect(admin.activateProviderKey).toHaveBeenCalledWith("demo", "key-b", { silent: true });
		expect(session.setModel).toHaveBeenCalledWith(MODEL);
		expect(onModelChanged).toHaveBeenCalledTimes(1);
	});

	it("restoreModelForProject：会话已经有消息 = 保留它自己的模型（切回在跑的对话不改写）", async () => {
		const memory = fakeMemory({ projectModel: "demo/m1" });
		const session = fakeSession({ provider: "demo", id: "m0" }, [{ role: "user" }]);
		const applied = await makeProject(memory, fakeAdmin()).restoreModelForProject({
			cwd: A,
			session,
			resolveModel: async () => MODEL,
		});
		expect(applied).toBe(false);
		expect(session.setModel).not.toHaveBeenCalled();
	});

	it("restoreModelForProject：项目没有记忆就回落到全局默认；都没有 = 不动会话", async () => {
		const globalSession = fakeSession({ provider: "demo", id: "m0" });
		const applied = await makeProject(fakeMemory({ defaultModel: "demo/m1" })).restoreModelForProject({
			cwd: B,
			session: globalSession,
			resolveModel: async () => MODEL,
		});
		expect(applied).toBe(true);
		expect(globalSession.setModel).toHaveBeenCalledWith(MODEL);

		const untouched = fakeSession({ provider: "demo", id: "m0" });
		expect(
			await makeProject(fakeMemory()).restoreModelForProject({
				cwd: B,
				session: untouched,
				resolveModel: async () => MODEL,
			}),
		).toBe(false);
		expect(untouched.setModel).not.toHaveBeenCalled();
	});

	it("restoreModelForProject：模型已不在目录里就静默不动（不抛、不换）", async () => {
		const session = fakeSession({ provider: "demo", id: "m0" });
		const applied = await makeProject(fakeMemory({ projectModel: "demo/gone" })).restoreModelForProject({
			cwd: A,
			session,
			resolveModel: async () => undefined,
		});
		expect(applied).toBe(false);
		expect(session.setModel).not.toHaveBeenCalled();
	});

	it("restoreModelForProject：会话本来就是那个模型 = 不重复 setModel", async () => {
		const session = fakeSession({ provider: "demo", id: "m1" });
		const applied = await makeProject(fakeMemory({ projectModel: "demo/m1" })).restoreModelForProject({
			cwd: A,
			session,
			resolveModel: async () => MODEL,
		});
		expect(applied).toBe(false);
		expect(session.setModel).not.toHaveBeenCalled();
	});
});

describe("模型 id 解析（记忆键的单源）", () => {
	it("parseModelId 只认 provider/id，空段与无斜杠都算无效", () => {
		expect(parseModelId("demo/m1")).toEqual({ provider: "demo", id: "m1" });
		expect(parseModelId("demo/m1/x")).toEqual({ provider: "demo", id: "m1/x" });
		expect(parseModelId("/m1")).toBeUndefined();
		expect(parseModelId("demo/")).toBeUndefined();
		expect(parseModelId("m1")).toBeUndefined();
	});

	it("modelKeyOf 从 SDK 模型对象里取同一组键", () => {
		expect(modelKeyOf({ provider: "demo", id: "m1", name: "Demo" })).toEqual({ provider: "demo", id: "m1" });
		expect(modelKeyOf(undefined)).toBeUndefined();
		expect(modelKeyOf({ provider: "demo" })).toBeUndefined();
	});
});
