/**
 * 假体同步守卫（`tests/helpers/fake-session.ts`）—— 让「生产类加了成员 → 守卫测试
 * 运行时 TypeError」这类漂移变成**这里的一条红**。
 *
 * 背景：`ClientSession` / `AgentService` 的测试假体过去是手搓
 * `Object.assign(Object.create(原型), {...})`，实例字段全靠「谁用到谁补」。一次 CI
 * 复盘里 5 个新成员（`sharedViewers` / `sharedPendingMessages` / `parentExecution` /
 * `parentExecutionKey` / `conversationSettingsTargets`）同时打红 9 个文件 15 个用例，
 * 修法却是每处补一行——下个字段还会复发。
 *
 * 现在字段默认值由 `instanceFieldDefaults()` 从生产源码推导（字段初始化式 +
 * 构造器 `this.x = …`），本测试断言推导结果**可信**：
 *   1. 品类判定（含**多行泛型初始化式** `new Map<\n … >()`，这是最容易漏的一类）；
 *   2. 推导出的字段数量在合理区间（解析器被改坏 → 立刻红）；
 *   3. 关键集合类字段确实是集合（生产类改名/删字段 → 立刻红，逼着同步这里）；
 *   4. 工厂输出：原型真方法可用（`parentExecution` 不再「不是函数」）、覆写优先。
 */
import { describe, expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { AgentService } from "../../server/agent-service-daemon.js";
import {
	defaultFromInitializer,
	fakeAgentService,
	fakeClientSession,
	instanceFieldDefaults,
} from "../helpers/fake-session.js";

const kindOf = (value: unknown): string =>
	value instanceof Map
		? "Map"
		: value instanceof WeakMap
			? "WeakMap"
			: value instanceof Set
				? "Set"
				: value instanceof WeakSet
					? "WeakSet"
					: Array.isArray(value)
						? "Array"
						: value === null
							? "null"
							: typeof value;

describe("defaultFromInitializer — 初始化式品类", () => {
	it("集合 / 字面量 / 原始值 / 函数 / 调用式", () => {
		expect(kindOf(defaultFromInitializer("new Map<string, number>()"))).toBe("Map");
		expect(kindOf(defaultFromInitializer("new WeakMap<object, Set<string>>()"))).toBe("WeakMap");
		expect(kindOf(defaultFromInitializer("new Set<string>()"))).toBe("Set");
		expect(kindOf(defaultFromInitializer("new WeakSet()"))).toBe("WeakSet");
		expect(defaultFromInitializer("[]")).toEqual([]);
		expect(defaultFromInitializer("{}")).toEqual({});
		expect(defaultFromInitializer('""')).toBe("");
		expect(defaultFromInitializer("``")).toBe("");
		expect(defaultFromInitializer("0")).toBe(0);
		expect(defaultFromInitializer("false")).toBe(false);
		expect(defaultFromInitializer("null")).toBe(null);
		expect(kindOf(defaultFromInitializer("() => false"))).toBe("function");
		expect(kindOf(defaultFromInitializer("(a: string) => a"))).toBe("function");
		// 调用式/标识符初始化：认不出品类 → undefined（测试按需覆写，猜测比缺省更危险）
		expect(defaultFromInitializer("makeStore(dataDir)")).toBeUndefined();
		expect(defaultFromInitializer("cwd")).toBeUndefined();
	});
});

describe("instanceFieldDefaults — 从生产源码推导", () => {
	it("ClientSession：数量在合理区间（解析器坏掉会骤降）", () => {
		const fields = instanceFieldDefaults("ClientSession");
		expect(Object.keys(fields).length).toBeGreaterThan(60);
	});

	it("AgentService：数量在合理区间", () => {
		const fields = instanceFieldDefaults("AgentService");
		expect(Object.keys(fields).length).toBeGreaterThan(15);
	});

	it("ClientSession 关键字段品类正确", () => {
		const fields = instanceFieldDefaults("ClientSession");
		// 字段声明初始化式
		expect(kindOf(fields.convs)).toBe("Map");
		expect(kindOf(fields.roots)).toBe("Array");
		expect(fields.activeId).toBe(""); // 空串 = 未选会话
		expect(fields.disposed).toBe(false);
		expect(kindOf(fields.activeToolCalls ?? new Map())).toBe("Map");
	});

	it("AgentService 关键字段品类正确（含**多行泛型**初始化式）", () => {
		const fields = instanceFieldDefaults("AgentService");
		// sharedViewers 的初始化式跨多行：new Map<\n string,\n {...}\n >()
		// 单行正则解析器会静默漏掉它 —— 这正是 CI 上 `sharedViewers.get` 报错的形态。
		expect(kindOf(fields.sharedViewers)).toBe("Map");
		expect(kindOf(fields.clients)).toBe("Map");
		expect(kindOf(fields.pending)).toBe("Map");
		expect(kindOf(fields.pendingDetaches ?? new Map())).toBe("Map");
	});
});

describe("假体工厂", () => {
	it("fakeClientSession：原型真方法可用 + 字段自动带默认值", () => {
		const cs = fakeClientSession();
		// 曾经的 CI 失败：「owner.parentExecution is not a function」
		expect(typeof cs.parentExecution).toBe("function");
		expect(typeof cs.dispose).toBe("function");
		expect(kindOf((cs as unknown as Record<string, unknown>).convs)).toBe("Map");
	});

	it("fakeClientSession：覆写优先，且不影响别的实例", () => {
		const conv = { id: "c1" };
		const a = fakeClientSession({ convs: new Map([["c1", conv]]) });
		const b = fakeClientSession();
		expect((a as unknown as Record<string, unknown>).convs).toBeInstanceOf(Map);
		expect(((a as unknown as Record<string, unknown>).convs as Map<string, unknown>).get("c1")).toBe(conv);
		expect(((b as unknown as Record<string, unknown>).convs as Map<string, unknown>).size).toBe(0);
	});

	it("每次取默认值都是新实例：两个假体不共享集合（复发过的隐形 bug）", () => {
		// 踩过的坑：解析结果缓存后只在「首次」克隆，第二个假体就拿到了缓存里同一个
		// Map —— 过户类用例的 source/target 变成同一份 convs，报错却完全看不出「共享」。
		const a = fakeClientSession() as unknown as Record<string, unknown>;
		const b = fakeClientSession() as unknown as Record<string, unknown>;
		expect(a.convs).not.toBe(b.convs);
		expect((a.convs as Map<unknown, unknown>).size).toBe(0);
		(a.convs as Map<string, unknown>).set("c1", {});
		expect((b.convs as Map<unknown, unknown>).size).toBe(0);
		const s1 = fakeAgentService() as unknown as Record<string, unknown>;
		const s2 = fakeAgentService() as unknown as Record<string, unknown>;
		expect(s1.clients).not.toBe(s2.clients);
	});

	it("fakeAgentService：detach 等原型方法可用（曾经的「reading 'get'」失败）", () => {
		const service = fakeAgentService({ clients: new Map() });
		expect(typeof service.detach).toBe("function");
		expect(kindOf((service as unknown as Record<string, unknown>).sharedViewers)).toBe("Map");
		// detach 在空视图表上必须是安全的 no-op（不再抛 undefined.get）
		expect(() => service.detach("nobody", () => undefined)).not.toThrow();
	});

	it("工厂与生产类结构同步：每个原型**方法**都能在假体上取到函数", () => {
		const cs = fakeClientSession();
		const service = fakeAgentService();
		const missing: string[] = [];
		for (const [proto, target] of [
			[ClientSession.prototype, cs],
			[AgentService.prototype, service],
		] as const) {
			for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
				// 只查数据属性/方法；访问器（`get conv()`）需要真实字段才能读，不在假体范围
				if (name === "constructor" || typeof descriptor.value !== "function") continue;
				if (typeof (target as unknown as Record<string, unknown>)[name] !== "function") missing.push(name);
			}
		}
		expect(missing).toEqual([]);
	});
});
