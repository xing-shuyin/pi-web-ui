import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	deliverScheduledRun,
	hasConversationAddress,
	type SchedulerDeliveryHost,
} from "../../server/scheduler-delivery.js";
import { normalizeSchedulerInput, SchedulerStore, type SchedulerTask } from "../../server/scheduler-tasks.js";

/**
 * issue #959：定时任务报告投递策略。
 *
 * 盯住的是**边界**（谁算可达、失败怎么办、绑定会不会被悄悄改掉），不是实现细节：
 * - 寻址只认转录文件，投不进去时绝不把报告挪到别的对话；
 * - 门关着（压缩 / 会话退役窗口）在宿主侧已经变成排队，策略层不该再看到它；
 * - 任何失败都保持绑定不变，只退到后台执行 + 如实告知。
 */

const task = (over: Record<string, unknown> = {}): SchedulerTask =>
	normalizeSchedulerInput({
		id: "task-1",
		name: "巡检",
		cwd: "/proj",
		kind: "interval",
		spec: String(60 * 60_000),
		prompt: "检查构建",
		conversationId: "c2",
		sessionFile: "/sessions/proj/abc.jsonl",
		...over,
	});

interface Recorder {
	host: SchedulerDeliveryHost;
	wakes: { conversationId: string; sessionFile: string; text: string; taskId: string }[];
	headless: number;
	notices: { level: string; text: string; textEn: string }[];
}

function recorder(over: Partial<SchedulerDeliveryHost> = {}): Recorder {
	const rec: Recorder = {
		wakes: [],
		headless: 0,
		notices: [],
		host: {} as SchedulerDeliveryHost,
	};
	const recordWake = over.wake;
	rec.host = {
		wake: async (opts) => {
			rec.wakes.push(opts);
			return recordWake ? recordWake(opts) : { ok: true, conversationId: "c9", sessionFile: opts.sessionFile };
		},
		headless: async (t) => {
			rec.headless += 1;
			return over.headless
				? over.headless(t)
				: { ok: true, conversationId: "sched-1", sessionFile: "/sessions/sched/run.jsonl" };
		},
		notice: (level, text, textEn) => {
			rec.notices.push({ level, text, textEn });
		},
	};
	return rec;
}

describe("hasConversationAddress", () => {
	it("转录文件或老运行时 id 任一存在即视为有地址", () => {
		expect(hasConversationAddress({ conversationId: "", sessionFile: "" })).toBe(false);
		expect(hasConversationAddress({ conversationId: "c2", sessionFile: "" })).toBe(true);
		expect(hasConversationAddress({ conversationId: "", sessionFile: " /s.jsonl " })).toBe(true);
	});
});

describe("deliverScheduledRun", () => {
	it("投回原对话：只按转录寻址，回执带落地对话，不惊动后台执行", async () => {
		const rec = recorder();
		const r = await deliverScheduledRun(task(), rec.host);
		expect(r).toMatchObject({ ok: true, conversationId: "c9", sessionFile: "/sessions/proj/abc.jsonl" });
		expect(rec.headless).toBe(0);
		expect(rec.notices).toEqual([]);
		expect(rec.wakes).toHaveLength(1);
		expect(rec.wakes[0]).toMatchObject({ sessionFile: "/sessions/proj/abc.jsonl", cwd: "/proj", taskId: "task-1" });
		expect(rec.wakes[0]!.text).toBe("[定时任务 巡检] 检查构建");
	});

	it("按转录恢复也算投递成功，并明确告知报告落在原对话（不是别的对话）", async () => {
		const rec = recorder({
			wake: async (opts) => ({ ok: true, conversationId: "c3", sessionFile: opts.sessionFile, resumed: true }),
		});
		const r = await deliverScheduledRun(task(), rec.host);
		expect(r.ok).toBe(true);
		expect(rec.headless).toBe(0);
		expect(rec.notices).toHaveLength(1);
		expect(rec.notices[0]!.level).toBe("info");
		expect(rec.notices[0]!.text).toContain("按转录恢复");
	});

	it("原对话不可达：如实告知原因 + 后台执行，报告不动别的对话", async () => {
		const rec = recorder({
			wake: async () => ({ ok: false, error: "转录无法恢复（会话目录里没有这份记录，或已被移走）" }),
		});
		const r = await deliverScheduledRun(task(), rec.host);
		expect(r.ok).toBe(true);
		expect(rec.headless).toBe(1);
		expect(rec.notices[0]!.level).toBe("warning");
		// 原因必须透出：这正是原实现丢掉的东西（调用方只看到「原对话不在」）。
		expect(rec.notices[0]!.text).toContain("转录无法恢复");
		expect(rec.notices[0]!.text).toContain("绑定不变");
		expect(rec.wakes).toHaveLength(1);
	});

	it("唤醒抛异常不炸调度循环：转后台执行并带上原因", async () => {
		const rec = recorder({
			wake: async () => {
				throw new Error("boom");
			},
		});
		const r = await deliverScheduledRun(task(), rec.host);
		expect(rec.headless).toBe(1);
		expect(rec.notices[0]!.text).toContain("boom");
		expect(r.error === undefined || typeof r.error === "string").toBe(true);
	});

	it("无地址的老任务直接后台执行，不算降级、不发提示", async () => {
		const rec = recorder();
		const r = await deliverScheduledRun(task({ conversationId: "", sessionFile: "" }), rec.host);
		expect(r.ok).toBe(true);
		expect(rec.wakes).toEqual([]);
		expect(rec.headless).toBe(1);
		expect(rec.notices).toEqual([]);
	});

	it("后台执行本身失败时把它的错误原样带回（别用「原对话不在」盖掉真因）", async () => {
		const rec = recorder({
			wake: async () => ({ ok: false, error: "转录无法恢复" }),
			headless: async () => ({ ok: false, error: "目标项目不存在或不是目录：/proj" }),
		});
		const r = await deliverScheduledRun(task(), rec.host);
		expect(r.ok).toBe(false);
		expect(r.error).toBe("目标项目不存在或不是目录：/proj");
	});
});

describe("backfill：只由成功回执填充（issues #976 / #959）", () => {
	it("投回原对话成功：backfill 带落地地址", async () => {
		const rec = recorder({
			wake: async () => ({ ok: true, conversationId: "c7", sessionFile: "/sessions/proj/abc.jsonl" }),
		});
		const r = await deliverScheduledRun(task({ sessionFile: "" }), rec.host);
		expect(r.backfill).toEqual({ conversationId: "c7", sessionFile: "/sessions/proj/abc.jsonl" });
	});

	it("失败转后台：即使后台回执带了新对话地址，backfill 也必须为空（绑定不许被改）", async () => {
		const rec = recorder({
			wake: async () => ({ ok: false, error: "原对话不可用" }),
			headless: async () => ({ ok: true, conversationId: "other", sessionFile: "/sessions/other/run.jsonl" }),
		});
		const r = await deliverScheduledRun(task(), rec.host);
		expect(r.ok).toBe(true);
		expect(r.backfill).toBeUndefined();
		// 历史仍可显示这次实际落在哪（只用于展示，不用于改绑）。
		expect(r.sessionFile).toBe("/sessions/other/run.jsonl");
	});
});

describe("occurrence 对账（issues #976：终态单调、不静默重投）", () => {
	const mkStore = () => {
		const dir = mkdtempSync(join(tmpdir(), "sched-occurrence-"));
		const notices: { level: string; text: string }[] = [];
		const store = new SchedulerStore(dir, {
			executor: async () => ({ ok: true }),
			notify: (level, text) => notices.push({ level, text }),
		});
		return { dir, store, notices };
	};

	it("每次触发分配 runId，与终态记录一次落盘后就清掉 occurrence", async () => {
		const { dir, store } = mkStore();
		const task = await store.upsert({
			id: "task-occ",
			name: "对账",
			cwd: "/proj",
			kind: "interval",
			spec: String(3600000),
			prompt: "检查",
			conversationId: "c1",
		});
		await store.runNow(task.id);
		const persisted = JSON.parse(readFileSync(join(dir, "scheduler-tasks.json"), "utf8"));
		const record = persisted.tasks[task.id];
		expect(record.occurrence).toBeUndefined();
		expect(typeof record.history[0].runId).toBe("string");
		expect(record.history[0].runId.startsWith("run-")).toBe(true);
		expect(typeof record.history[0].scheduledFor).toBe("number");
		rmSync(dir, { recursive: true, force: true });
	});

	it("重启时发现「触发过但没有终态」：报结果未知、清掉记录、绝不自动重投", async () => {
		const { dir, store } = mkStore();
		const task = await store.upsert({
			id: "task-occ2",
			name: "对账2",
			cwd: "/proj",
			kind: "interval",
			spec: String(3600000),
			prompt: "检查",
			conversationId: "c1",
			enabled: false,
		});
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const persisted = { v: 1, tasks: { [task.id]: { ...task, occurrence: { runId: "run-x", scheduledFor: 1 } } } };
		writeFileSync(join(dir, "scheduler-tasks.json"), JSON.stringify(persisted), "utf8");

		const notices: { level: string; text: string }[] = [];
		let fired = 0;
		const reopened = new SchedulerStore(dir, {
			executor: async () => {
				fired += 1;
				return { ok: true };
			},
			notify: (level, text) => notices.push({ level, text }),
		});
		reopened.start();
		reopened.stop();
		// 对账清理是排队落盘（不阻塞启动）：等到它真写完再看文件。
		for (let i = 0; i < 200; i++) {
			const raw = JSON.parse(readFileSync(join(dir, "scheduler-tasks.json"), "utf8"));
			if (!raw.tasks[task.id]?.occurrence) break;
			await new Promise((resolve) => setTimeout(resolve, 1));
		}

		expect(fired).toBe(0);
		expect(notices[0]?.level).toBe("warning");
		expect(notices[0]?.text).toContain("结果未知");
		expect(notices[0]?.text).toContain("run-x");
		const after = JSON.parse(readFileSync(join(dir, "scheduler-tasks.json"), "utf8"));
		expect(after.tasks[task.id].occurrence).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});
