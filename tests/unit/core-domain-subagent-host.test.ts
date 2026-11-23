import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentTool } from "../../packages/keel/src/adapters/tools/subagent.js";
import {
	createSubagentToolHost,
	SubagentHostUnsupportedError,
	type SubagentHostInput,
	type SubagentSnapshotSource,
	type SubagentSpawnSpec,
} from "../../packages/keel/src/domains/subagents/host.js";
import { SubagentRegistry } from "../../packages/keel/src/domains/subagents/registry.js";
import type { SubagentSnapshot } from "../../server/subagents.js";
import { CONVERSATION_TOOL_NAME } from "../../server/tool-manager.js";

afterEach(() => {
	vi.useRealTimers();
});

function snapshot(over: Partial<SubagentSnapshot> & { convId: string }): SubagentSnapshot {
	return {
		type: "general",
		title: over.convId,
		prompt: "work",
		state: "done",
		streaming: false,
		messageCount: 1,
		output: "ok",
		...over,
	};
}

function registryOf(ids: string[] = []) {
	const registry = new SubagentRegistry({ now: () => 1_000 });
	for (const id of ids) registry.register({ id, parentId: "root", title: id, type: "general" });
	return registry;
}

/** 快照源按契约同时认对话 id 与执行身份（老树 `getSubagent` 同口径）。 */
function snapshotSourceOf(snapshots: SubagentSnapshot[] = []) {
	const get = vi.fn((id: string) => snapshots.find((item) => item.convId === id || item.executionId === id));
	const list = vi.fn(() => snapshots);
	const source: SubagentSnapshotSource = { get, list };
	return { source, get, list };
}

function hostInput(over: Partial<SubagentHostInput> = {}) {
	const spawn = vi.fn(async (_spec: SubagentSpawnSpec) => "child-1");
	const stop = vi.fn(async (_id: string) => {});
	const steer = vi.fn(async (_id: string, _message: string) => {});
	const templates = vi.fn(() => [{ name: "explore", description: "Read-only scout", model: "m/x" }]);
	const input: SubagentHostInput = {
		registry: registryOf(),
		snapshots: snapshotSourceOf().source,
		spawn,
		stop,
		steer,
		templates,
		now: () => 1_700_000_000_000,
		selfId: () => "self-1",
		...over,
	};
	return { input, spawn, stop, steer, templates };
}

describe("domains/subagents · 工具宿主", () => {
	it("spawnSubagent 把 13 个位置参数原样交给注入的 spawn，父级缺省取 selfId", async () => {
		const { input, spawn } = hostInput();
		const host = createSubagentToolHost(input);
		const signal = new AbortController().signal;
		const extra = { securityMode: "readonly" as const };
		const id = await host.spawnSubagent(
			"do it",
			"explore",
			"/work",
			"explore",
			"m/x",
			undefined,
			true,
			"high",
			"manual",
			"worktree",
			extra,
			signal,
		);
		expect(id).toBe("child-1");
		expect(spawn).toHaveBeenCalledWith({
			prompt: "do it",
			type: "explore",
			cwd: "/work",
			templateName: "explore",
			model: "m/x",
			parentId: "self-1",
			persist: true,
			thinking: "high",
			notifyOnDone: "manual",
			isolation: "worktree",
			extra,
			signal,
		});
	});

	it("spawnSubagent 不覆盖显式父级（调用者点名谁就是谁）", async () => {
		const { input, spawn } = hostInput();
		await createSubagentToolHost(input).spawnSubagent("do it", "general", "/work", undefined, undefined, "parent-9");
		expect(spawn.mock.calls[0][0].parentId).toBe("parent-9");
	});

	it("getSubagent 一律问快照源：拿得到就给快照，拿不到就是 undefined", () => {
		const child = snapshot({ convId: "c1", executionId: "exec-c1", parentId: "self-1" });
		const source = snapshotSourceOf([child]);
		const host = createSubagentToolHost(hostInput({ snapshots: source.source }).input);
		expect(host.getSubagent("c1")?.convId).toBe("c1");
		expect(host.getSubagent("exec-c1")?.convId).toBe("c1");
		expect(host.getSubagent("nobody")).toBeUndefined();
		expect(source.get).toHaveBeenCalledWith("exec-c1");
	});

	it("stopSubagent / steerSubagent 把执行身份归一成对话 id 再下发", async () => {
		const child = snapshot({ convId: "c1", executionId: "exec-c1" });
		const { input, stop, steer } = hostInput({ snapshots: snapshotSourceOf([child]).source });
		const host = createSubagentToolHost(input);
		await host.stopSubagent("exec-c1");
		await host.steerSubagent("exec-c1", "go left");
		expect(stop).toHaveBeenCalledWith("c1");
		expect(steer).toHaveBeenCalledWith("c1", "go left");
	});

	it("listSubagents 无 forSelfId 时全量返回并把 scope 透传给快照源", () => {
		const source = snapshotSourceOf([snapshot({ convId: "c1" }), snapshot({ convId: "c2" })]);
		const host = createSubagentToolHost(hostInput({ snapshots: source.source }).input);
		expect(host.listSubagents()).toHaveLength(2);
		host.listSubagents("subagent");
		expect(source.list).toHaveBeenCalledWith("subagent");
	});

	it("listSubagents 按 parentId 族谱过滤：只留后代（含孙辈），去掉无关分支与自己", () => {
		const self = snapshot({ convId: "self-1", executionId: "exec-self" });
		const child = snapshot({
			convId: "c1",
			executionId: "exec-c1",
			parentId: "self-1",
			parentExecutionId: "exec-self",
		});
		const grandchild = snapshot({ convId: "g1", executionId: "exec-g1", parentId: "c1", parentExecutionId: "exec-c1" });
		const stranger = snapshot({ convId: "x1", parentId: "other-1" });
		const source = snapshotSourceOf([self, child, grandchild, stranger]);
		const host = createSubagentToolHost(hostInput({ snapshots: source.source }).input);
		expect(host.listSubagents(undefined, "self-1").map((item) => item.convId)).toEqual(["c1", "g1"]);
		expect(host.listSubagents(undefined, "exec-self").map((item) => item.convId)).toEqual(["c1", "g1"]);
		expect(host.listSubagents(undefined, "c1").map((item) => item.convId)).toEqual(["g1"]);
		expect(host.listSubagents(undefined, "x1")).toEqual([]);
	});

	it("waitForSubagentSettle 把账本出口翻译成工具侧唤醒原因（结算 / 已终态 / 超时 / 中止）", async () => {
		vi.useFakeTimers();
		const registry = registryOf(["c1"]);
		const host = createSubagentToolHost(hostInput({ registry }).input);
		const settled = host.waitForSubagentSettle(["c1"], { timeoutMs: 30_000 });
		registry.settle("c1", { state: "done" });
		expect(await settled).toBe("changed");
		expect(await host.waitForSubagentSettle(["c1"], { timeoutMs: 30_000 })).toBe("changed");
		const timedOut = host.waitForSubagentSettle(["c2"], { timeoutMs: 5_000 });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await timedOut).toBe("timeout");
		const controller = new AbortController();
		controller.abort();
		expect(await host.waitForSubagentSettle(["c3"], { timeoutMs: 5_000, signal: controller.signal })).toBe("aborted");
	});

	it("listTemplates 透传注入的模板表", () => {
		const { input, templates } = hostInput();
		expect(createSubagentToolHost(input).listTemplates()).toEqual([
			{ name: "explore", description: "Read-only scout", model: "m/x" },
		]);
		expect(templates).toHaveBeenCalled();
	});

	it("isTemplateUsable 命中存在且启用的模板名，未命中一律 false", () => {
		const host = createSubagentToolHost(hostInput().input);
		expect(host.isTemplateUsable("explore")).toBe(true);
		expect(host.isTemplateUsable("review")).toBe(false);
		expect(host.isTemplateUsable("")).toBe(false);
	});

	it("getActiveConversationId 只报宿主绑定的会话", () => {
		expect(createSubagentToolHost(hostInput().input).getActiveConversationId?.()).toBe("self-1");
		expect(createSubagentToolHost(hostInput({ selfId: undefined }).input).getActiveConversationId?.()).toBeUndefined();
	});

	it("未实现的动作类成员逐个拒绝，并在错误里点名成员", async () => {
		const host = createSubagentToolHost(hostInput().input);
		const members: Array<[string, () => Promise<unknown>]> = [
			["completeSubagent", async () => host.completeSubagent!("self-1", "done")],
			["handoffSubagent", async () => host.handoffSubagent("c1", "c2", "payload")],
			["consultParent", async () => host.consultParent!("self-1", [])],
			["answerConsult", async () => host.answerConsult!("self-1", "c1", "r1")],
			["escalateConsult", async () => host.escalateConsult!("self-1", "c1", "r1")],
			["dismissSubagent", async () => host.dismissSubagent!("c1")],
			["listLedgerRuns", async () => host.listLedgerRuns!()],
			["getLedgerRun", async () => host.getLedgerRun!("r1")],
			["getLedgerEvents", async () => host.getLedgerEvents!("r1")],
			["resumeLedgerRun", async () => host.resumeLedgerRun!("self-1", "r1")],
		];
		for (const [member, call] of members) {
			const error = await call().then(
				() => undefined,
				(err: unknown) => err,
			);
			expect(error, member).toBeInstanceOf(SubagentHostUnsupportedError);
			expect((error as SubagentHostUnsupportedError).member).toBe(member);
			expect((error as Error).message).toContain(member);
		}
	});

	it("观测类成员刻意留空，不去毒化 wait_all 这类已实现的动作", () => {
		const host = createSubagentToolHost(hostInput().input);
		expect(host.getPendingConsults).toBeUndefined();
		expect(host.setConsultWaiting).toBeUndefined();
		expect(host.isRequestSteering).toBeUndefined();
		expect(host.markSubagentsConsumed).toBeUndefined();
		expect(host.finalizeSubagentWorktree).toBeUndefined();
		expect(host.getWatchdogTimeoutMs).toBeUndefined();
		expect(host.lang).toBeUndefined();
	});

	it("适配器工具沿用叶子的名字与 schema（不重写描述）", () => {
		const tool = createSubagentTool(createSubagentToolHost(hostInput().input));
		expect(tool.name).toBe(CONVERSATION_TOOL_NAME);
		expect(typeof tool.execute).toBe("function");
		expect(tool.description.length).toBeGreaterThan(0);
		expect((tool.parameters as any).properties.action).toBeTruthy();
	});

	it("工具 execute 的 spawn 走宿主落到注入的 spawn，父级为调用方会话", async () => {
		const { input, spawn } = hostInput();
		const tool = createSubagentTool(createSubagentToolHost(input), "self-1");
		const result = await tool.execute(
			"call-1",
			{ action: "spawn", prompt: "do it", type: "explore" },
			undefined,
			undefined,
			{ cwd: "/work" } as any,
		);
		expect(result.content[0].type).toBe("text");
		expect(spawn).toHaveBeenCalledTimes(1);
		const spec = spawn.mock.calls[0][0];
		expect(spec).toMatchObject({ prompt: "do it", type: "explore", cwd: "/work", parentId: "self-1" });
	});
});
