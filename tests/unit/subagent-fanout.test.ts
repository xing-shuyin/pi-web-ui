import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makeSubagentTool,
	SUBAGENT_FANOUT_MAX,
	type SubagentSnapshot,
	type SubagentToolHost,
} from "../../server/subagents.js";
import { testSettleWaiter } from "../helpers/subagent-settle.js";

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		convId: "sa-1",
		executionId: "exec-1",
		parentId: "parent",
		parentExecutionId: "exec-parent",
		type: "general",
		title: "Child",
		prompt: "Task",
		state: "done",
		streaming: false,
		output: "done",
		messageCount: 2,
		...overrides,
	};
}

function setup(options: { spawn?: (prompt: string) => Promise<string> } = {}) {
	const children = new Map<string, SubagentSnapshot>();
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async (prompt: string) => {
			const id = options.spawn ? await options.spawn(prompt) : `sa-${prompt.slice(0, 4)}`;
			children.set(id, snapshot({ convId: id, executionId: `exec-${id}`, title: prompt }));
			return id;
		}),
		getSubagent: (id) => children.get(id) ?? [...children.values()].find((c) => c.executionId === id),
		listSubagents: () => [...children.values()],
		steerSubagent: vi.fn(async () => ({ state: "queued" as const })),
		stopSubagent: vi.fn(async () => {}),
		handoffSubagent: vi.fn(async () => {}),
		completeSubagent: vi.fn(() => ({ ok: true })),
		markSubagentsConsumed: vi.fn(),
		finalizeSubagentWorktree: vi.fn(async () => {}),
		listTemplates: () => [],
		isTemplateUsable: () => false,
		waitForSubagentSettle: testSettleWaiter(),
	};
	const tool = makeSubagentTool(
		host,
		() => "en",
		() => "parent",
	);
	const call = (params: unknown, signal?: AbortSignal) =>
		tool.execute!("call", params as never, signal, undefined, { cwd: "." } as any);
	return { host, tool, call, children };
}

afterEach(() => vi.useRealTimers());

describe("conversation fan-out", () => {
	it("tasks[] 一次派发并在结果里给出 key → runId 映射", async () => {
		const { call, host } = setup();
		const result = await call({
			action: "spawn",
			tasks: [
				{ key: "api", prompt: "api work" },
				{ key: "ui", prompt: "ui work", type: "reviewer" },
			],
		});
		expect(host.spawnSubagent).toHaveBeenCalledTimes(2);
		expect(result.details).toMatchObject({ status: "spawned" });
		const tasks = (result.details as any).tasks;
		expect(tasks.map((t: any) => t.key)).toEqual(["api", "ui"]);
		expect(tasks.every((t: any) => t.ok)).toBe(true);
	});

	it("整批校验：一个 task 不合法就一个都不启动", async () => {
		const { call, host } = setup();
		const result = await call({
			action: "spawn",
			tasks: [
				{ key: "ok", prompt: "fine" },
				{ key: "bad key!", prompt: "nope" },
			],
		});
		expect(host.spawnSubagent).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ status: "rejected" });
	});

	it("重复 key 直接驳回", async () => {
		const { call, host } = setup();
		const result = await call({
			action: "spawn",
			tasks: [
				{ key: "dup", prompt: "a" },
				{ key: "dup", prompt: "b" },
			],
		});
		expect(host.spawnSubagent).not.toHaveBeenCalled();
		expect((result.details as any).problems.join("\n")).toContain("Duplicate key");
	});

	it("超过扇出上限直接驳回", async () => {
		const { call } = setup();
		const tasks = Array.from({ length: SUBAGENT_FANOUT_MAX + 1 }, (_, i) => ({ key: `t${i}`, prompt: `p${i}` }));
		const result = await call({ action: "spawn", tasks });
		expect(result.details).toMatchObject({ status: "rejected", reason: "fanout_limit" });
	});

	it("单个 task 失败不影响同批其它 task，并如实回报", async () => {
		let n = 0;
		const { call } = setup({
			spawn: async (prompt) => {
				n++;
				if (prompt === "boom") throw new Error("spawn exploded");
				return `sa-${n}`;
			},
		});
		const result = await call({
			action: "spawn",
			tasks: [
				{ key: "a", prompt: "boom" },
				{ key: "b", prompt: "fine" },
			],
		});
		const tasks = (result.details as any).tasks;
		expect(tasks[0]).toMatchObject({ key: "a", ok: false });
		expect(tasks[1]).toMatchObject({ key: "b", ok: true });
	});

	it("key 可以在 wait_all / get_result 里代替 runId", async () => {
		const { call } = setup();
		await call({ action: "spawn", tasks: [{ key: "solo", prompt: "solo work" }] });
		const waited = await call({ action: "wait_all", runIds: ["solo"] });
		expect((waited.content[0] as { text: string }).text).toContain("collected");
		const got = await call({ action: "get_result", runId: "solo" });
		expect((got.content[0] as { text: string }).text).toContain("done");
	});
});

describe("conversation completion evidence", () => {
	it("把归一化后的证据交给宿主", async () => {
		const { call, host } = setup();
		await call({
			action: "complete",
			summary: "Done",
			evidence: { files: ["./src/a.ts"], commands: [" npm   test "] },
		});
		expect(host.completeSubagent).toHaveBeenCalledWith("parent", "Done", {
			files: ["src/a.ts"],
			commands: ["npm test"],
			none: false,
			blocked: undefined,
		});
	});

	it("证据与转录矛盾时把驳回原因抛给子代理", async () => {
		const { call, host } = setup();
		vi.mocked(host.completeSubagent!).mockReturnValue({
			ok: false,
			issues: ["declared command was never run in this session: npm run build"],
		});
		await expect(
			call({ action: "complete", summary: "Done", evidence: { commands: ["npm run build"] } }),
		).rejects.toThrow(/never run/);
	});

	it("空证据对象直接判非法，不进入宿主", async () => {
		const { call, host } = setup();
		const result = await call({ action: "complete", summary: "Done", evidence: {} });
		expect(result.details).toMatchObject({ status: "evidence_invalid" });
		expect(host.completeSubagent).not.toHaveBeenCalled();
	});
});

describe("conversation steer receipt", () => {
	it("回执状态原样回给父代理", async () => {
		const { call } = setup();
		await call({ action: "spawn", prompt: "work" });
		const result = await call({ action: "steer", runId: "sa-work", message: "also check tests" });
		expect(result.details).toMatchObject({ state: "queued" });
		expect((result.content[0] as { text: string }).text).toContain("queued");
	});
});
