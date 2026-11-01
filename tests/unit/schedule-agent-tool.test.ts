/**
 * issue #193：schedule 单 action 工具（create/list/cancel）。
 * 时间解析纯函数 + 工具 execute 直调（真 SchedulerStore 落临时 dataDir，
 * 不起 server、不调模型）：建任务默认绑定发起对话＋单次，列表/取消闭环。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService, sameCwd } from "../../server/agent-service.js";
import { SchedulerStore, sameSessionFile } from "../../server/scheduler-tasks.js";
import { makeScheduleTool, parseScheduleSpec, type ScheduleToolHost } from "../../server/schedule-agent-tool.js";
import { normalizeSchedulerInput } from "../../server/scheduler-tasks.js";

const CTX: any = { cwd: "/tmp" };

function resultText(r: { content: { type: string; text?: string }[] }): string {
	return r.content.map((c) => c.text ?? "").join("\n");
}

describe("parseScheduleSpec", () => {
	it("5 字段走 cron（原样单空格）", () => {
		expect(parseScheduleSpec("0  *  * * *")).toEqual({ kind: "cron", spec: "0 * * * *" });
		expect(parseScheduleSpec("*/30 9 * * 1-5")).toEqual({ kind: "cron", spec: "*/30 9 * * 1-5" });
	});
	it("相对时间与裸时长走 interval（毫秒字符串）", () => {
		expect(parseScheduleSpec("in 30m")).toEqual({ kind: "interval", spec: String(30 * 60_000) });
		expect(parseScheduleSpec("in 1h")).toEqual({ kind: "interval", spec: String(3_600_000) });
		expect(parseScheduleSpec("in 2d")).toEqual({ kind: "interval", spec: String(2 * 86_400_000) });
		expect(parseScheduleSpec("45m")).toEqual({ kind: "interval", spec: String(45 * 60_000) });
		expect(parseScheduleSpec("in 90s")).toEqual({ kind: "interval", spec: String(90_000) });
		expect(parseScheduleSpec("30")).toEqual({ kind: "interval", spec: String(30 * 60_000) }); // 裸数字按分钟
	});
	it("非法写法抛错", () => {
		expect(() => parseScheduleSpec("")).toThrow();
		expect(() => parseScheduleSpec("明天早上")).toThrow();
		expect(() => parseScheduleSpec("0 0")).toThrow();
		expect(() => parseScheduleSpec("61 25 * * *")).toThrow(); // 5 段但非法 cron
	});
});

describe("normalizeSchedulerInput 新字段", () => {
	const base = { name: "t", cwd: "/tmp", kind: "interval" as const, spec: "600000", prompt: "hi" };
	it("conversationId/oneShot 透传（缺省 空/false）", () => {
		const t = normalizeSchedulerInput(base);
		expect(t.conversationId).toBe("");
		expect(t.sessionFile).toBe("");
		expect(t.oneShot).toBe(false);
		const t2 = normalizeSchedulerInput({ ...base, conversationId: "  c9 ", oneShot: true });
		expect(t2.conversationId).toBe("c9");
		expect(t2.oneShot).toBe(true);
	});
	it("sessionFile 透传（去空白；缺省空串；老任务兼容）", () => {
		expect(normalizeSchedulerInput(base).sessionFile).toBe("");
		const t = normalizeSchedulerInput({ ...base, sessionFile: "  /tmp/s.jsonl  " });
		expect(t.sessionFile).toBe("/tmp/s.jsonl");
	});
});

describe("AgentService.wakeConversation（无持有方路径）", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sched-wake-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});
	it("找不到对话回 ok:false；空参回错；quiesce 直接拒绝", async () => {
		const svc = new AgentService(dir, join(dir, "client-state.json"));
		const miss = await svc.wakeConversation("c-nope", "hi");
		expect(miss.ok).toBe(false);
		expect(miss.error).toContain("不在运行中");
		expect(await svc.wakeConversation("", "hi")).toMatchObject({ ok: false });
		// issue #231：带稳定键也找不到 → 同样 miss（不 busy），调用方走视口回退
		const miss2 = await svc.wakeConversation("c-nope", "hi", {
			sessionFile: "/tmp/nope.jsonl",
			cwd: dir,
		});
		expect(miss2.ok).toBe(false);
		expect(miss2.busy).not.toBe(true);
		// 视口回退：同项目无存活对话 → miss（不抛错）
		const vp = await svc.wakeViewportInCwd(dir, "hi");
		expect(vp.ok).toBe(false);
		svc.quiesce();
		const q = await svc.wakeConversation("c-nope", "hi");
		expect(q.ok).toBe(false);
		expect(q.error).toContain("quiesced");
		expect(await svc.wakeViewportInCwd(dir, "hi")).toMatchObject({ ok: false });
	});
});

describe("schedule 工具闭环（单 action：create/list/cancel）", () => {
	let dir: string;
	let store: SchedulerStore;
	let tool: ReturnType<typeof makeScheduleTool>;
	let host: ScheduleToolHost;

	const call = async (params: Record<string, unknown>) =>
		tool.execute("call-1", params as never, undefined, undefined, CTX);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sched-tool-test-"));
		store = new SchedulerStore(dir);
		host = {
			store: () => store,
			cwd: () => dir,
			activeConversationId: () => "c7",
		};
		tool = makeScheduleTool(host, "c7", () => "zh");
	});

	afterEach(() => {
		store.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("建单次任务：默认绑定发起对话＋oneShot，返回下次触发与取消方式", async () => {
		const r = await call({ action: "create", schedule: "in 30m", prompt: "检查训练日志并汇报" });
		const text = resultText(r);
		expect(text).toContain("定时任务已创建");
		expect(text).toContain("单次，触发后自动删除");
		expect(text).toContain('schedule(action="cancel"');
		const tasks = store.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.conversationId).toBe("c7");
		expect(tasks[0]!.oneShot).toBe(true);
		expect(tasks[0]!.kind).toBe("interval");
		expect(tasks[0]!.cwd).toBe(dir);
	});

	it("graphId 创建单次画布任务，空 prompt 使用图输入且不绑定对话", async () => {
		host.conversationInfo = () => ({ cwd: "/other-project", sessionFile: "/conversation" });
		const r = await call({ action: "create", schedule: "in 30m", graphId: "graph-1" });
		expect(resultText(r)).toContain("目标：画布 graph-1");
		expect(resultText(r)).toContain("图自带输入");
		expect(store.list()[0]).toMatchObject({
			target: "canvas",
			graphId: "graph-1",
			cwd: dir,
			prompt: "",
			conversationId: "",
			sessionFile: "",
			oneShot: true,
		});
		expect(resultText(await call({ action: "list" }))).toContain("画布→graph-1");
	});

	it("周期画布支持输入覆盖、英文目标回执和列表", async () => {
		tool = makeScheduleTool(host, "c7", () => "en");
		const r = await call({
			action: "create",
			schedule: "0 * * * *",
			graphId: "graph-1",
			prompt: "canvas input",
			recurring: true,
		});
		expect(resultText(r)).toContain("Target: canvas graph-1");
		expect(resultText(r)).toContain("supplied instruction");
		expect(store.list()[0]).toMatchObject({ oneShot: false, prompt: "canvas input" });
		expect(resultText(await call({ action: "list" }))).toContain("canvas→graph-1");
	});

	it("空或非法画布 id 和不存在的工程都不能创建任务", async () => {
		for (const graphId of ["", "../escape"]) {
			expect(resultText(await call({ action: "create", schedule: "in 30m", graphId }))).toContain("画布工程 id");
		}
		store = new SchedulerStore(dir, {
			validateTask: () => {
				throw new Error("Canvas graph not found");
			},
		});
		expect(resultText(await call({ action: "create", schedule: "in 30m", graphId: "missing" }))).toContain(
			"Canvas graph not found",
		);
		expect(store.list()).toEqual([]);
	});

	it("recurring=true 建周期 cron 任务", async () => {
		const r = await call({
			action: "create",
			schedule: "0 * * * *",
			prompt: "每小时巡检",
			label: "巡检",
			recurring: true,
		});
		expect(resultText(r)).toContain("周期");
		const tasks = store.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.oneShot).toBe(false);
		expect(tasks[0]!.kind).toBe("cron");
		expect(tasks[0]!.name).toBe("巡检");
	});

	it("非法输入给中文报错：坏时间/超短间隔/空 prompt", async () => {
		expect(resultText(await call({ action: "create", schedule: "明天", prompt: "x" }))).toContain("非法");
		expect(resultText(await call({ action: "create", schedule: "in 30s", prompt: "x" }))).toContain("最短 60s");
		expect(resultText(await call({ action: "create", schedule: "in 30m", prompt: "  " }))).toContain("不能为空");
		expect(store.list()).toHaveLength(0);
	});

	it("缺 action / 未知 action 给可读报错", async () => {
		expect(resultText(await call({ action: "" }))).toContain("action");
		expect(resultText(await call({ action: "nope" }))).toContain("未知 action");
	});

	it("list 展示全部任务，cancel 按 id 删除（删空报错）", async () => {
		await call({ action: "create", schedule: "in 30m", prompt: "甲" });
		await call({ action: "create", schedule: "in 1h", prompt: "乙", recurring: true });
		const list = resultText(await call({ action: "list" }));
		expect(list).toContain("定时任务（2）");
		const id = store.list()[0]!.id;
		expect(resultText(await call({ action: "cancel", id }))).toContain("已删除");
		expect(store.list()).toHaveLength(1);
		expect(resultText(await call({ action: "cancel", id: "no-such" }))).toContain("没有");
		expect(resultText(await call({ action: "cancel", id: "" }))).toContain("id");
	});

	it("store 未接入时直接报错（DSH 这类引擎）", async () => {
		const dead = makeScheduleTool({ ...host, store: () => undefined }, "c7", () => "zh");
		expect(dead.name).toBe("schedule");
		expect(
			resultText(
				await dead.execute(
					"c",
					{ action: "create", schedule: "in 30m", prompt: "x" } as never,
					undefined,
					undefined,
					CTX,
				),
			),
		).toContain("不支持");
	});

	it("issue #231：建任务时快照 owner 会话文件（compression-safe 绑定）", async () => {
		const withInfo: ScheduleToolHost = {
			...host,
			conversationInfo: (id?: string) => (id === "c7" ? { cwd: dir, sessionFile: "/tmp/sess-1.jsonl" } : undefined),
		};
		const tool2 = makeScheduleTool(withInfo, "c7", () => "zh");
		await tool2.execute(
			"call-1",
			{ action: "create", schedule: "in 30m", prompt: "巡检" } as never,
			undefined,
			undefined,
			CTX,
		);
		const tasks = store.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.conversationId).toBe("c7");
		expect(tasks[0]!.sessionFile).toBe("/tmp/sess-1.jsonl");
		expect(tasks[0]!.cwd).toBe(dir);
	});

	it("issue #231：宿主无 conversationInfo 时只绑 id（老行为兼容）", async () => {
		await call({ action: "create", schedule: "in 30m", prompt: "巡检" });
		const tasks = store.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.conversationId).toBe("c7");
		expect(tasks[0]!.sessionFile).toBe("");
	});
});

describe("issue #231 稳定键纯函数", () => {
	it("sameSessionFile：分隔符/尾部分隔符/大小写归一，空串永不等", () => {
		expect(sameSessionFile("/tmp/a.jsonl", "/tmp/a.jsonl")).toBe(true);
		expect(sameSessionFile("C:\\tmp\\a.jsonl", "C:/tmp/a.jsonl")).toBe(true);
		expect(sameSessionFile("/tmp/a.jsonl/", "/tmp/a.jsonl")).toBe(true);
		expect(sameSessionFile("/TMP/A.JSONL", "/tmp/a.jsonl")).toBe(true);
		expect(sameSessionFile("/tmp/a.jsonl", "/tmp/b.jsonl")).toBe(false);
		expect(sameSessionFile("", "/tmp/a.jsonl")).toBe(false);
		expect(sameSessionFile("", "")).toBe(false);
	});
	it("sameCwd：同项目归一，跨项目不等，空串永不等", () => {
		expect(sameCwd("/tmp/proj", "/tmp/proj")).toBe(true);
		expect(sameCwd("/tmp/proj/", "/tmp/proj")).toBe(true);
		expect(sameCwd("/tmp/a", "/tmp/b")).toBe(false);
		expect(sameCwd("", "/tmp/a")).toBe(false);
	});
});
