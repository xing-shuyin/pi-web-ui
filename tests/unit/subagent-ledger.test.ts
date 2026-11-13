import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildResumePrompt, ledgerBootId, SubagentLedger, type LedgerRunRecord } from "../../server/subagent-ledger.js";

function dataDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-ledger-"));
}

function record(overrides: Partial<LedgerRunRecord> = {}): LedgerRunRecord {
	return {
		runId: "exec-abc",
		cwd: "/repo",
		type: "general",
		title: "Child",
		prompt: "Do the thing",
		state: "running",
		bootId: ledgerBootId(),
		createdAt: 1,
		updatedAt: 1,
		persisted: false,
		...overrides,
	};
}

describe("SubagentLedger", () => {
	it("写入 status.json 与事件流水，并能从内存读回", async () => {
		const dir = dataDir();
		const ledger = new SubagentLedger(dir, { now: () => 1000 });
		ledger.upsert(record());
		ledger.event("exec-abc", "spawned", { type: "general" });
		await ledger.flush();

		expect(ledger.read("exec-abc")).toMatchObject({ runId: "exec-abc", state: "running", prompt: "Do the thing" });
		const statusPath = join(dir, "subagent-runs", "exec-abc", "status.json");
		expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({ runId: "exec-abc", cwd: "/repo" });
		const events = readFileSync(join(dir, "subagent-runs", "exec-abc", "events.jsonl"), "utf8")
			.trim()
			.split("\n");
		expect(events).toHaveLength(1);
		expect(JSON.parse(events[0]!)).toMatchObject({ event: "spawned", detail: { type: "general" } });
		rmSync(dir, { recursive: true, force: true });
	});

	it("新实例能从磁盘恢复记录（进程重启后的读侧）", async () => {
		const dir = dataDir();
		const first = new SubagentLedger(dir);
		first.upsert(record({ runId: "exec-1", state: "done", outputTail: "all good" }));
		await first.flush();

		const second = new SubagentLedger(dir);
		await second.ready();
		expect(second.read("exec-1")).toMatchObject({ state: "done", outputTail: "all good" });
		rmSync(dir, { recursive: true, force: true });
	});

	it("recover 只把别的 boot 留下的 running 判成 interrupted", async () => {
		const dir = dataDir();
		const ledger = new SubagentLedger(dir);
		ledger.upsert(record({ runId: "exec-old", bootId: "boot-old" }));
		ledger.upsert(record({ runId: "exec-live", bootId: ledgerBootId() }));
		ledger.upsert(record({ runId: "exec-done", bootId: "boot-old", state: "done" }));
		await ledger.flush();

		const recovered = await ledger.recover();
		expect(recovered.map((r) => r.runId)).toEqual(["exec-old"]);
		expect(ledger.read("exec-old")?.state).toBe("interrupted");
		expect(ledger.read("exec-live")?.state).toBe("running");
		expect(ledger.read("exec-done")?.state).toBe("done");
		// 幂等：第二次没有可恢复的
		expect(await ledger.recover()).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("事件超过字节上限后只留一条截断标记", async () => {
		const dir = dataDir();
		const ledger = new SubagentLedger(dir, { eventBytesCap: 200 });
		ledger.upsert(record());
		for (let i = 0; i < 20; i++) ledger.event("exec-abc", "turn_end", { i });
		await ledger.flush();
		expect(ledger.read("exec-abc")?.eventsTruncated).toBe(true);
		const lines = readFileSync(join(dir, "subagent-runs", "exec-abc", "events.jsonl"), "utf8")
			.trim()
			.split("\n");
		expect(lines.length).toBeLessThan(20);
		expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({ event: "events_truncated" });
		rmSync(dir, { recursive: true, force: true });
	});

	it("超过 maxRuns 时优先淘汰最旧的已结束运行", async () => {
		const dir = dataDir();
		const ledger = new SubagentLedger(dir, { maxRuns: 2 });
		for (const [i, id] of ["exec-1", "exec-2", "exec-3"].entries()) {
			ledger.upsert(record({ runId: id, state: "done", updatedAt: 100 + i }));
		}
		await ledger.flush();
		expect(ledger.list()).toHaveLength(2);
		expect(ledger.read("exec-1")).toBeUndefined();
		// 目录删除是后台的：轮询等它落地，别用固定 sleep 赌时序。
		const removed = join(dir, "subagent-runs", "exec-1");
		for (let i = 0; i < 40 && existsSync(removed); i++) await new Promise((r) => setTimeout(r, 25));
		expect(existsSync(removed)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("maxRuns=0 时整本账关闭", async () => {
		const dir = dataDir();
		const ledger = new SubagentLedger(dir, { maxRuns: 0 });
		ledger.upsert(record());
		ledger.event("exec-abc", "spawned");
		await ledger.flush();
		expect(ledger.enabled).toBe(false);
		expect(ledger.read("exec-abc")).toBeUndefined();
		expect(ledger.list()).toEqual([]);
		expect(existsSync(join(dir, "subagent-runs"))).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("markResumed 记录续跑关系，避免重复续跑", async () => {
		const dir = dataDir();
		const ledger = new SubagentLedger(dir);
		ledger.upsert(record({ runId: "exec-old", state: "interrupted" }));
		ledger.upsert(record({ runId: "exec-stale", state: "running" }));
		ledger.markResumed("exec-old", "exec-new");
		ledger.markResumed("exec-stale", "exec-newer");
		await ledger.flush();
		expect(ledger.read("exec-old")).toMatchObject({ resumedBy: "exec-new", state: "interrupted" });
		// 上次没来得及收口的 running：续跑即按中断处理，别让列表永远挂着「在跑」。
		expect(ledger.read("exec-stale")).toMatchObject({ resumedBy: "exec-newer", state: "interrupted" });
		rmSync(dir, { recursive: true, force: true });
	});

	it("按 parentRunId 过滤与倒序列表", async () => {
		const dir = dataDir();
		const ledger = new SubagentLedger(dir);
		ledger.upsert(record({ runId: "exec-a", parentRunId: "exec-root", updatedAt: 10 }));
		ledger.upsert(record({ runId: "exec-b", parentRunId: "exec-root", updatedAt: 20 }));
		ledger.upsert(record({ runId: "exec-c", parentRunId: "exec-other", updatedAt: 30 }));
		await ledger.flush();
		expect(ledger.list({ parentRunId: "exec-root" }).map((r) => r.runId)).toEqual(["exec-b", "exec-a"]);
		expect(ledger.list({ live: true }).map((r) => r.runId)).toEqual(["exec-c", "exec-b", "exec-a"]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("event 先于 upsert 且事件超限时，不产生缺 state 的幽灵记录", async () => {
		const dir = dataDir();
		const ledger = new SubagentLedger(dir, { now: () => 1000, eventBytesCap: 0 });
		ledger.event("exec-ghost", "spawned"); // bytes(0) >= cap(0) → 命中超限分支，但 record 未建档
		expect(ledger.list()).toEqual([]); // 修复前：一条 {runId, eventsTruncated:true} 的缺 state stub
		expect(ledger.read("exec-ghost")).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("buildResumePrompt", () => {
	it("带原任务、已知进度、工作树与证据，并要求不重做", () => {
		const prompt = buildResumePrompt(
			record({
				runId: "exec-9",
				state: "interrupted",
				prompt: "Refactor the parser",
				outputTail: "half done",
				worktree: { path: "/wt/parser", branch: "pi-sub/x" },
				evidence: {
					verdict: "partial",
					matchedFiles: 1,
					files: 2,
					matchedCommands: 0,
					commands: 1,
					none: false,
					issues: [],
					warnings: [],
				},
				sessionFile: "/sessions/x.jsonl",
			}),
			"also run the tests",
		);
		expect(prompt).toContain("Refactor the parser");
		expect(prompt).toContain("half done");
		expect(prompt).toContain("/wt/parser");
		expect(prompt).toContain("partial");
		expect(prompt).toContain("/sessions/x.jsonl");
		expect(prompt).toContain("also run the tests");
		expect(prompt).toContain("do not redo finished work");
	});
});
