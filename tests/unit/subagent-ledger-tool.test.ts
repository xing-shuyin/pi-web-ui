import { describe, expect, it, vi } from "vitest";
import { makeSubagentTool, type SubagentSnapshot, type SubagentToolHost } from "../../server/subagents.js";
import type { LedgerRunRecord } from "../../server/subagent-ledger.js";
import { testSettleWaiter } from "../helpers/subagent-settle.js";

function ledgerRecord(overrides: Partial<LedgerRunRecord> = {}): LedgerRunRecord {
	return {
		runId: "exec-old",
		cwd: "/repo",
		type: "worker",
		title: "Refactor parser",
		prompt: "Refactor the parser",
		state: "interrupted",
		bootId: "boot-1",
		createdAt: 1,
		updatedAt: 2,
		persisted: false,
		...overrides,
	};
}

function setup(overrides: Partial<SubagentToolHost> = {}, seed: LedgerRunRecord[] = []) {
	const children = new Map<string, SubagentSnapshot>();
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async (prompt: string) => {
			const id = `sa-${prompt.slice(0, 6)}`;
			children.set(id, {
				convId: id,
				executionId: `exec-${id}`,
				type: "worker",
				title: prompt,
				prompt,
				state: "running",
				streaming: true,
				output: "",
				messageCount: 1,
			});
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
		listLedgerRuns: vi.fn(async () => seed),
		getLedgerRun: vi.fn(async (runId: string) => seed.find((r) => r.runId === runId)),
		getLedgerEvents: vi.fn(async () => [
			{ ts: Date.UTC(2026, 0, 1, 12, 0, 0), event: "spawned" },
			{ ts: Date.UTC(2026, 0, 1, 12, 0, 5), event: "turn_end" },
			{ ts: Date.UTC(2026, 0, 1, 12, 0, 9), event: "interrupted" },
		]),
		resumeLedgerRun: vi.fn(async (_self: string, runId: string) => ({
			ok: true as const,
			runId,
			convId: "sa-resumed",
			executionId: "exec-sa-resumed",
			mode: "relaunch" as const,
			previousState: "interrupted" as const,
			sessionFile: "/sessions/old.jsonl",
		})),
		...overrides,
	};
	const tool = makeSubagentTool(
		host,
		() => "en",
		() => "parent",
	);
	const call = (params: unknown) => tool.execute!("call", params as never, undefined, undefined, { cwd: "." } as any);
	return { host, call };
}

describe("conversation ledger surface", () => {
	it("list 把账本里不在进程中的运行追加进来", async () => {
		const { call } = setup({}, [ledgerRecord(), ledgerRecord({ runId: "exec-live", state: "running" })]);
		const result = await call({ action: "list" });
		const body = (result.content[0] as { text: string }).text;
		expect(body).toContain("ledger exec-old");
		expect(body).toContain("interrupted");
		expect(body).toContain("Run ledger");
	});

	it("list 跳过已移出与仍在进程里的记录", async () => {
		const { call } = setup({}, [ledgerRecord({ state: "dismissed" })]);
		const result = await call({ action: "list" });
		const body = (result.content[0] as { text: string }).text;
		expect(body).not.toContain("exec-old");
		expect(body).toContain("empty too");
	});

	it("get_result 在进程里查不到时回落账本（带证据、尾部与续跑提示）", async () => {
		const record = ledgerRecord({
			state: "interrupted",
			outputTail: "half way there",
			sessionFile: "/sessions/x.jsonl",
			evidence: {
				verdict: "partial",
				matchedFiles: 1,
				files: 2,
				matchedCommands: 0,
				commands: 1,
				none: false,
				issues: [],
				warnings: ["declared file not seen in this run's edits: a.ts"],
			},
		});
		const { call } = setup({}, [record]);
		const result = await call({ action: "get_result", runId: "exec-old" });
		const body = (result.content[0] as { text: string }).text;
		expect(body).toContain("no longer in process");
		expect(body).toContain("half way there");
		expect(body).toContain("1/2 files");
		expect(body).toContain("/sessions/x.jsonl");
		expect(body).toContain('conversation(action="resume"');
		expect(body).toContain("Lifecycle (last 3)");
		expect(body).toContain("12:00:09 interrupted");
	});

	it("get_result 查不到账本时仍给出未找到提示", async () => {
		const { call } = setup();
		const result = await call({ action: "get_result", runId: "exec-missing" });
		expect((result.content[0] as { text: string }).text).toContain("not found");
	});

	it("resume 成功时回报旧/新运行与转录归属", async () => {
		const { call, host } = setup({}, [ledgerRecord()]);
		const result = await call({ action: "resume", runId: "exec-old", message: "also run tests" });
		expect(host.resumeLedgerRun).toHaveBeenCalledWith("parent", "exec-old", "also run tests");
		const body = (result.content[0] as { text: string }).text;
		expect(body).toContain("Resumed: exec-old (interrupted) → new run exec-sa-resumed");
		expect(body).toContain("/sessions/old.jsonl");
		expect(result.details).toMatchObject({ ok: true, mode: "relaunch" });
	});

	it("resume 失败按原因给出可执行提示", async () => {
		const cases: Array<[string, string]> = [
			["not_found", "run ledger"],
			["running", "still live"],
			["already_resumed", "do not resume twice"],
			["parent_missing", "Spawn from this conversation"],
		];
		for (const [error, expected] of cases) {
			const { call } = setup({
				resumeLedgerRun: vi.fn(async () => ({ ok: false as const, error, runId: "exec-next" })),
			});
			const result = await call({ action: "resume", runId: "exec-old" });
			expect((result.content[0] as { text: string }).text).toContain(expected);
		}
	});

	it("没有账本能力的引擎拒绝 resume，但 list/get_result 仍可用", async () => {
		const host: SubagentToolHost = {
			spawnSubagent: vi.fn(async () => "sa-1"),
			getSubagent: () => undefined,
			listSubagents: () => [],
			steerSubagent: vi.fn(async () => {}),
			stopSubagent: vi.fn(async () => {}),
			handoffSubagent: vi.fn(async () => {}),
			listTemplates: () => [],
			isTemplateUsable: () => false,
			waitForSubagentSettle: testSettleWaiter(),
		};
		const tool = makeSubagentTool(
			host,
			() => "en",
			() => "parent",
		);
		const call = (params: unknown) => tool.execute!("c", params as never, undefined, undefined, { cwd: "." } as any);
		await expect(call({ action: "resume", runId: "exec-old" })).rejects.toThrow("unavailable");
		const listed = await call({ action: "list" });
		expect((listed.content[0] as { text: string }).text).toContain("No managed conversations");
	});
});
