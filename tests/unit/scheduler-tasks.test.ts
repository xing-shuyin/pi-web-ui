/**
 * 内置定时任务单测（issue #184）：输入归一化/校验、下次触发计算、
 * Store 的 CRUD + 开关 + 持久化往返。执行器（Agent 无头调用）与 ticker
 * 时序不进单测，覆盖靠 tests/run-smoke 聚合里的协议冒烟。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SchedulerStore,
	computeNextFire,
	describeIntervalMs,
	normalizeSchedulerInput,
	sameSessionFile,
} from "../../server/scheduler-tasks.js";

const BASE = {
	name: "每日巡检",
	cwd: process.platform === "win32" ? "C:\\tmp" : "/tmp",
	kind: "cron" as const,
	spec: "0 9 * * *",
	prompt: "审计依赖并报告",
};

describe("normalizeSchedulerInput", () => {
	it("旧任务默认对话，画布允许空输入并剥离会话和模型覆盖", () => {
		expect(normalizeSchedulerInput(BASE).target).toBe("conversation");
		expect(() => normalizeSchedulerInput({ ...BASE, prompt: "" })).toThrow();
		const task = normalizeSchedulerInput({
			...BASE,
			graphId: "graph-1",
			prompt: "",
			conversationId: "c1",
			sessionFile: "/old",
			model: "invalid",
			thinkingLevel: "high",
		});
		expect(task).toMatchObject({
			target: "canvas",
			graphId: "graph-1",
			prompt: "",
			conversationId: "",
			sessionFile: "",
			model: "",
			thinkingLevel: "",
		});
		expect(normalizeSchedulerInput({ ...BASE, target: "conversation", graphId: "graph-1" }).graphId).toBeUndefined();
	});

	it("画布 graphId 必填并拒绝路径及非法目标", () => {
		for (const graphId of ["", "..", ".", "../escape", "a/b", "a\\b", "a".repeat(65)]) {
			expect(() => normalizeSchedulerInput({ ...BASE, target: "canvas", graphId })).toThrow();
		}
		expect(() => normalizeSchedulerInput({ ...BASE, target: "invalid" as any })).toThrow();
	});
	it("cron 归一化（多余空白压缩）", () => {
		const t = normalizeSchedulerInput({ ...BASE, spec: "  0  9  *  *  * " });
		expect(t.spec).toBe("0 9 * * *");
		expect(t.enabled).toBe(true);
		expect(t.catchUp).toBe("skip");
	});

	it("非法 cron 抛错", () => {
		expect(() => normalizeSchedulerInput({ ...BASE, spec: "not a cron" })).toThrow();
		expect(() => normalizeSchedulerInput({ ...BASE, spec: "0 9 * *" })).toThrow();
	});

	it("interval 按毫秒归一化，过短拒绝", () => {
		const t = normalizeSchedulerInput({ ...BASE, kind: "interval", spec: "3600000" });
		expect(t.spec).toBe("3600000");
		expect(() => normalizeSchedulerInput({ ...BASE, kind: "interval", spec: "1000" })).toThrow();
		expect(() => normalizeSchedulerInput({ ...BASE, kind: "interval", spec: "abc" })).toThrow();
	});

	it("必填缺失抛错（名称/cwd/prompt）", () => {
		expect(() => normalizeSchedulerInput({ ...BASE, name: "  " })).toThrow();
		expect(() => normalizeSchedulerInput({ ...BASE, cwd: "" })).toThrow();
		expect(() => normalizeSchedulerInput({ ...BASE, prompt: "" })).toThrow();
	});

	it("prompt 超长拒绝（与 host.chat 同口径 8000）", () => {
		expect(() => normalizeSchedulerInput({ ...BASE, prompt: "x".repeat(8001) })).toThrow();
	});

	it("模型格式校验（provider/id）", () => {
		expect(normalizeSchedulerInput({ ...BASE, model: "openai/gpt-5" }).model).toBe("openai/gpt-5");
		expect(() => normalizeSchedulerInput({ ...BASE, model: "gpt-5" })).toThrow();
	});

	it("缺 id 自动生成合法 id", () => {
		const t = normalizeSchedulerInput({ ...BASE });
		expect(t.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});

	it("issue #231：sessionFile 归一化（去空白/封顶，缺省空串）", () => {
		expect(normalizeSchedulerInput({ ...BASE }).sessionFile).toBe("");
		expect(normalizeSchedulerInput({ ...BASE, sessionFile: "  /s/a.jsonl  " }).sessionFile).toBe("/s/a.jsonl");
	});

	it("issue #231：sameSessionFile 分隔符/大小写归一", () => {
		expect(sameSessionFile("/a/b.jsonl", "/a/b.jsonl")).toBe(true);
		expect(sameSessionFile("C:\\a\\b.jsonl", "C:/a/b.jsonl")).toBe(true);
		expect(sameSessionFile("/a/b.jsonl", "/a/c.jsonl")).toBe(false);
		expect(sameSessionFile("", "")).toBe(false);
	});
});

describe("computeNextFire", () => {
	it("cron：每天 9 点从当天 8 点起算是今天 9 点", () => {
		// 2026-09-17 08:00 本地时区
		const from = new Date(2026, 8, 17, 8, 0, 0).getTime();
		const next = computeNextFire({ kind: "cron", spec: "0 9 * * *" }, from);
		const d = new Date(next!);
		expect(d.getHours()).toBe(9);
		expect(d.getMinutes()).toBe(0);
		expect(d.getDate()).toBe(17);
	});

	it("interval：fromMs + 毫秒", () => {
		expect(computeNextFire({ kind: "interval", spec: "3600000" }, 1000)).toBe(3601000);
	});

	it("非法回 null", () => {
		expect(computeNextFire({ kind: "cron", spec: "nope" }, Date.now())).toBeNull();
		expect(computeNextFire({ kind: "interval", spec: "0" }, Date.now())).toBeNull();
	});
});

describe("describeIntervalMs", () => {
	it("秒/分/时/天", () => {
		expect(describeIntervalMs(30_000)).toBe("每 30 秒");
		expect(describeIntervalMs(3_600_000)).toBe("每 1 小时");
		expect(describeIntervalMs(7_200_000)).toBe("每 2 小时");
		expect(describeIntervalMs(86_400_000)).toBe("每 1 天");
	});
});

describe("SchedulerStore", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "scheduler-test-"));
	});
	afterEach(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("upsert → list → 持久化往返（新 Store 读盘）", () => {
		const s = new SchedulerStore(dir, {});
		const task = s.upsert({ ...BASE, id: "daily" });
		expect(task.id).toBe("daily");
		const views = s.list();
		expect(views).toHaveLength(1);
		expect(views[0]!.nextFire).toBeGreaterThan(Date.now());
		expect(views[0]!.running).toBe(false);

		const s2 = new SchedulerStore(dir, {});
		s2.load();
		expect(s2.list()).toHaveLength(1);
		expect(s2.list()[0]!.prompt).toBe("审计依赖并报告");
	});

	it("坏文件当空表（不抛错）", () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a" });
		// 写坏文件
		writeFileSync(join(dir, "scheduler-tasks.json"), "{broken");
		const s2 = new SchedulerStore(dir, {});
		s2.load();
		expect(s2.list()).toHaveLength(0);
	});

	it("setEnabled 关 → nextFire 为 null；开 → 恢复", () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a" });
		s.setEnabled("a", false);
		expect(s.list()[0]!.enabled).toBe(false);
		expect(s.list()[0]!.nextFire).toBeNull();
		s.setEnabled("a", true);
		expect(s.list()[0]!.nextFire).toBeGreaterThan(Date.now());
	});

	it("remove 删任务；未知 id 回 false", () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a" });
		expect(s.remove("nope")).toBe(false);
		expect(s.remove("a")).toBe(true);
		expect(s.list()).toHaveLength(0);
	});

	it("issue #231：面板编辑（不带绑定字段）保留旧绑定，显式给空才清", () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a", conversationId: "c1", sessionFile: "/s/old.jsonl" });
		// 面板改名：没带绑定字段 → 绑定保留
		s.upsert({ ...BASE, id: "a", name: "新名字" });
		expect(s.list()[0]!.name).toBe("新名字");
		expect(s.list()[0]!.conversationId).toBe("c1");
		expect(s.list()[0]!.sessionFile).toBe("/s/old.jsonl");
		// 显式给空 → 按全量语义清掉
		s.upsert({ ...BASE, id: "a", conversationId: "", sessionFile: "" });
		expect(s.list()[0]!.conversationId).toBe("");
		expect(s.list()[0]!.sessionFile).toBe("");
	});

	it("issue #231：rebind 只改绑定（不碰下次触发/历史），无变化免写盘", () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a", conversationId: "c1", sessionFile: "/s/old.jsonl" });
		const before = s.list()[0]!;
		const nextBefore = before.nextFire;
		// 无变化 → false
		expect(s.rebind("a", { conversationId: "c1", sessionFile: "/s/old.jsonl" })).toBe(false);
		// 换新 id（压缩后同文件对话改名）→ true，下次触发不动
		expect(s.rebind("a", { conversationId: "c9" })).toBe(true);
		const after = s.list()[0]!;
		expect(after.conversationId).toBe("c9");
		expect(after.sessionFile).toBe("/s/old.jsonl");
		expect(after.nextFire).toBe(nextBefore);
		// 未知任务 → false
		expect(s.rebind("nope", { conversationId: "c1" })).toBe(false);
		// 持久化往返：重绑后的绑定落盘
		const s2 = new SchedulerStore(dir, {});
		s2.load();
		expect(s2.list()[0]!.conversationId).toBe("c9");
	});

	it("issue #231：老文件无 sessionFile 照读（默认空串，不炸）", () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a", conversationId: "c1" });
		const raw = JSON.parse(readFileSync(join(dir, "scheduler-tasks.json"), "utf8")) as {
			tasks: Record<string, Record<string, unknown>>;
		};
		delete raw.tasks["a"]!["sessionFile"];
		writeFileSync(join(dir, "scheduler-tasks.json"), JSON.stringify(raw));
		const s2 = new SchedulerStore(dir, {});
		s2.load();
		expect(s2.list()).toHaveLength(1);
		expect(s2.list()[0]!.sessionFile).toBe("");
		expect(s2.list()[0]!.conversationId).toBe("c1");
	});

	it("runNow 无 executor 记失败（不抛错）", async () => {
		const s = new SchedulerStore(dir, {});
		s.upsert({ ...BASE, id: "a" });
		const r = await s.runNow("a");
		expect(r.ok).toBe(false);
		expect(s.list()[0]!.history).toHaveLength(1);
		expect(s.list()[0]!.lastRun!.ok).toBe(false);
	});

	it("runNow 调 executor 并记录成功 + 会话 id", async () => {
		const s = new SchedulerStore(dir, {
			executor: async () => ({ ok: true, conversationId: "conv-1" }),
		});
		s.upsert({ ...BASE, id: "a" });
		const r = await s.runNow("a");
		expect(r.ok).toBe(true);
		const v = s.list()[0]!;
		expect(v.lastRun!.ok).toBe(true);
		expect(v.lastRun!.conversationId).toBe("conv-1");
		expect(v.lastRun!.manual).toBe(true);
	});

	it("画布持久化、编辑保留目标、拒绝会话重绑定并保留运行历史", async () => {
		const s = new SchedulerStore(dir, {
			executor: async () => ({ ok: false, runId: "run-1", graphId: "graph-1", error: "paused" }),
		});
		s.upsert({ ...BASE, id: "canvas", graphId: "graph-1", prompt: "" });
		await s.runNow("canvas");
		const restored = new SchedulerStore(dir);
		restored.load();
		expect(restored.list()[0]).toMatchObject({
			target: "canvas",
			graphId: "graph-1",
			lastRun: { target: "canvas", graphId: "graph-1", runId: "run-1", ok: false, error: "paused" },
		});
		expect(restored.upsert({ ...BASE, id: "canvas", prompt: "" })).toMatchObject({
			target: "canvas",
			graphId: "graph-1",
		});
		expect(restored.rebind("canvas", { conversationId: "c2", sessionFile: "/old" })).toBe(false);
		expect(restored.upsert({ ...BASE, id: "canvas", target: "conversation" })).toMatchObject({
			target: "conversation",
			conversationId: "",
			sessionFile: "",
		});
		expect(restored.list()[0].graphId).toBeUndefined();
	});

	it("upsert 引用验证失败不保存或发布，load 不依赖工程可用性", () => {
		const s = new SchedulerStore(dir, {
			validateTask: (task) => {
				if (task.graphId !== "exists") throw new Error("missing graph");
			},
		});
		s.upsert({ ...BASE, id: "a", graphId: "exists" });
		const before = readFileSync(join(dir, "scheduler-tasks.json"), "utf8");
		expect(() => s.upsert({ ...BASE, id: "a", graphId: "missing" })).toThrow("missing graph");
		expect(s.list()[0].graphId).toBe("exists");
		expect(readFileSync(join(dir, "scheduler-tasks.json"), "utf8")).toBe(before);
		const restored = new SchedulerStore(dir, {
			validateTask: () => {
				throw new Error("offline");
			},
		});
		restored.load();
		expect(restored.list()[0].graphId).toBe("exists");
	});

	it.each([true, false])("单次画布执行完成后删除（ok=%s），周期任务保留", async (ok) => {
		const removed: string[] = [];
		const s = new SchedulerStore(dir, {
			executor: async () => ({ ok }),
			onTaskRemoved: (id) => {
				removed.push(id);
			},
		});
		s.upsert({ ...BASE, id: "once", graphId: "graph-1", oneShot: true });
		s.upsert({ ...BASE, id: "repeat", graphId: "graph-1" });
		await s.runNow("once");
		await s.runNow("repeat");
		expect(s.list().map((t) => t.id)).toEqual(["repeat"]);
		expect(removed).toEqual(["once"]);
	});

	it("执行中 runNow 拒绝重入", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const s = new SchedulerStore(dir, {
			executor: async () => {
				await gate;
				return { ok: true };
			},
		});
		s.upsert({ ...BASE, id: "a" });
		const first = s.runNow("a");
		const second = await s.runNow("a");
		expect(second.ok).toBe(false);
		release();
		await first;
	});

	it("issue #836: 定时任务触发瞬间立即推进 nextFire 到下一周期（面板不显示过期时间）", async () => {
		vi.useFakeTimers();
		try {
			let finishRun!: () => void;
			const gate = new Promise<void>((r) => (finishRun = r));
			const s = new SchedulerStore(dir, {
				executor: async () => {
					await gate;
					return { ok: true };
				},
			});
			// 间隔 5 分钟
			s.upsert({ ...BASE, id: "t1", kind: "interval", spec: "300000" });
			const next0 = s.list().find((t) => t.id === "t1")!.nextFire!;
			expect(next0).toBeDefined();

			// 首次 tick 触发
			vi.setSystemTime(next0);
			await s.tick(next0);
			const viewWhileRunning = s.list().find((t) => t.id === "t1")!;
			expect(viewWhileRunning.running).toBe(true);
			// nextFire 必须已推进到下个周期，而不是停留在当前触发时间
			expect(viewWhileRunning.nextFire).toBe(next0 + 300000);

			finishRun();
			// 等待微任务消费完成
			await vi.advanceTimersByTimeAsync(0);
			const viewAfterRun = s.list().find((t) => t.id === "t1")!;
			expect(viewAfterRun.running).toBe(false);
			expect(viewAfterRun.nextFire).toBe(next0 + 300000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("issue #836: 单次执行耗时超过任务间隔时，顺延下次触发且任务完成后继续正常调度", async () => {
		vi.useFakeTimers();
		try {
			let finishRun!: () => void;
			const gate = new Promise<void>((r) => (finishRun = r));
			const s = new SchedulerStore(dir, {
				executor: async () => {
					await gate;
					return { ok: true };
				},
			});
			s.upsert({ ...BASE, id: "t1", kind: "interval", spec: "300000" });
			const next0 = s.list()[0]!.nextFire!;

			// 第一次触发
			vi.setSystemTime(next0);
			await s.tick(next0);
			expect(s.list()[0]!.running).toBe(true);
			expect(s.list()[0]!.nextFire).toBe(next0 + 300000);

			// 下一周期已到达，但第一次执行仍未结束（耗时 > 间隔）
			vi.setSystemTime(next0 + 300000);
			await s.tick(next0 + 300000);
			const viewDelayed = s.list()[0]!;
			expect(viewDelayed.running).toBe(true);
			// 顺延至第三个周期，而不是卡死在第二个周期
			expect(viewDelayed.nextFire).toBe(next0 + 600000);

			// 第一次运行在 400s 处结束
			vi.setSystemTime(next0 + 400000);
			finishRun();
			await vi.advanceTimersByTimeAsync(0);
			expect(s.list()[0]!.running).toBe(false);
			// 此时任务完成，nextFire 按完成时间顺延到 next0 + 700000
			expect(s.list()[0]!.nextFire).toBe(next0 + 700000);

			// 下次到达时第二次正常触发
			let secondRunStarted = false;
			(s as any).opts.executor = async () => {
				secondRunStarted = true;
				return { ok: true };
			};
			vi.setSystemTime(next0 + 700000);
			await s.tick(next0 + 700000);
			await vi.advanceTimersByTimeAsync(0);
			expect(secondRunStarted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("issue #836: 耗时任务在 tick 循环中不阻塞同批其他定时任务的触发", async () => {
		let finishA!: () => void;
		const gateA = new Promise<void>((r) => (finishA = r));
		let runBCount = 0;
		const s = new SchedulerStore(dir, {
			executor: async (task) => {
				if (task.id === "task-a") {
					await gateA;
					return { ok: true };
				}
				runBCount++;
				return { ok: true };
			},
		});
		s.upsert({ ...BASE, id: "task-a", kind: "interval", spec: "300000" });
		s.upsert({ ...BASE, id: "task-b", kind: "interval", spec: "300000" });
		const nextA = s.list().find((t) => t.id === "task-a")!.nextFire!;
		const nextB = s.list().find((t) => t.id === "task-b")!.nextFire!;

		// 触发两个任务
		await s.tick(Math.max(nextA, nextB));
		await new Promise((r) => setTimeout(r, 20));

		// task-a 正在运行，但 task-b 已成功执行完成，未被 task-a 阻塞
		expect(s.list().find((t) => t.id === "task-a")!.running).toBe(true);
		expect(runBCount).toBe(1);

		finishA();
		await new Promise((r) => setTimeout(r, 20));
		expect(s.list().find((t) => t.id === "task-a")!.running).toBe(false);
	});

	it("issue #836: cron 任务触发瞬间推进 nextFire 且超长执行顺延时不损坏后续 cron 排期", async () => {
		let finishRun!: () => void;
		const gate = new Promise<void>((r) => (finishRun = r));
		const s = new SchedulerStore(dir, {
			executor: async () => {
				await gate;
				return { ok: true };
			},
		});
		// 每 15 分钟触发一次
		s.upsert({ ...BASE, id: "cron-1", kind: "cron", spec: "*/15 * * * *" });
		const next0 = s.list()[0]!.nextFire!;
		expect(next0).toBeDefined();

		// 触发
		await s.tick(next0);
		expect(s.list()[0]!.running).toBe(true);
		// 下一次触发时间必须是下一个 15 分钟节点（next0 + 15 分钟）
		expect(s.list()[0]!.nextFire).toBe(next0 + 15 * 60 * 1000);

		// 15 分钟后下一轮已到达，但本轮仍在执行
		await s.tick(next0 + 15 * 60 * 1000);
		// 顺延至下下个 15 分钟节点（next0 + 30 分钟）
		expect(s.list()[0]!.nextFire).toBe(next0 + 30 * 60 * 1000);

		// 本轮完成
		finishRun();
		await new Promise((r) => setTimeout(r, 10));
		expect(s.list()[0]!.running).toBe(false);
		expect(s.list()[0]!.nextFire).toBe(next0 + 30 * 60 * 1000);
	});
});
