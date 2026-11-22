import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MATERIAL_LIMITS, MATERIAL_STAGE_DIR } from "../../server/material.js";
import { deliverScheduledRun, type SchedulerDeliveryHost } from "../../server/scheduler-delivery.js";
import { makeScheduleTool, type ScheduleToolHost } from "../../server/schedule-agent-tool.js";
import { normalizeSchedulerInput, SchedulerStore, type SchedulerTask } from "../../server/scheduler-tasks.js";

/**
 * 定时任务线的材料规格（docs/proposals/material-spec-contract.md §3）。
 *
 * 盯住四件事，而不是实现细节：
 * - R10：没材料时 prompt 与今天**逐字节**一致，也不多发任何提示；
 * - 投：有材料时清单（`describeMaterials` 唯一产出）拼在 prompt 末尾，后台执行同一份；
 * - 反例：不存在的路径 → `dropped: missing`，不抛错、不静默（日志 + notice）；
 * - 存：规格只收路径字符串，且面板编辑（不重发 materials）不会把它们抹掉。
 */

let dir = "";

const touch = (rel: string, content = "x"): string => {
	const abs = join(dir, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
	return abs;
};

const task = (over: Record<string, unknown> = {}): SchedulerTask =>
	normalizeSchedulerInput({
		id: "task-1",
		name: "巡检",
		cwd: dir,
		kind: "interval",
		spec: String(60 * 60_000),
		prompt: "检查构建",
		conversationId: "c2",
		sessionFile: "/sessions/proj/abc.jsonl",
		...over,
	});

interface Recorder {
	host: SchedulerDeliveryHost;
	wakes: { text: string; cwd: string }[];
	headless: SchedulerTask[];
	notices: { level: string; text: string; textEn: string }[];
}

function recorder(over: Partial<SchedulerDeliveryHost> = {}): Recorder {
	const rec: Recorder = { wakes: [], headless: [], notices: [], host: {} as SchedulerDeliveryHost };
	rec.host = {
		wake: async (opts) => {
			rec.wakes.push({ text: opts.text, cwd: opts.cwd });
			return { ok: true, conversationId: "c9", sessionFile: opts.sessionFile };
		},
		headless: async (t) => {
			rec.headless.push(t);
			return { ok: true, conversationId: "sched-1", sessionFile: "/sessions/sched/run.jsonl" };
		},
		notice: (level, text, textEn) => {
			rec.notices.push({ level, text, textEn });
		},
		...over,
	};
	return rec;
}

/** 把 console.warn 收成一段文本：R6 要求 dropped 至少进日志。 */
function captureWarn(): { text: () => string; restore: () => void } {
	const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
	return {
		text: () => spy.mock.calls.map((call) => String(call[0])).join("\n"),
		restore: () => spy.mockRestore(),
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "piweb-sched-material-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("投递：清单进 prompt", () => {
	it("不传 materials：prompt 与今天逐字节一致，且一条提示都不多发（R10）", async () => {
		const rec = recorder();
		await deliverScheduledRun(task(), rec.host);
		expect(rec.wakes[0]!.text).toBe("[定时任务 巡检] 检查构建");
		expect(rec.notices).toEqual([]);
	});

	it("有 materials：清单（describeMaterials 产出）拼在 prompt 末尾", async () => {
		touch("req.md");
		touch("shot.png");
		const rec = recorder();
		await deliverScheduledRun(task({ materials: ["req.md", "shot.png"] }), rec.host);
		expect(rec.wakes[0]!.text).toBe("[定时任务 巡检] 检查构建\n\n材料：req.md、shot.png");
		expect(rec.notices).toEqual([]);
	});

	it("后台执行拿到同一份清单（无对话地址的老任务）", async () => {
		touch("req.md");
		const rec = recorder();
		await deliverScheduledRun(task({ conversationId: "", sessionFile: "", materials: ["req.md"] }), rec.host);
		expect(rec.wakes).toEqual([]);
		expect(rec.headless[0]!.prompt).toBe("检查构建\n\n材料：req.md");
	});
});

describe("反例与去重（R6：不静默）", () => {
	it("不存在的路径走 dropped:missing：不抛错，日志 + 用户可见 notice 都有", async () => {
		const warn = captureWarn();
		const rec = recorder();
		const r = await deliverScheduledRun(task({ materials: ["不存在.txt"] }), rec.host);
		const logs = warn.text();
		warn.restore();
		expect(r.ok).toBe(true);
		// 清单为空 → prompt 不长出空块
		expect(rec.wakes[0]!.text).toBe("[定时任务 巡检] 检查构建");
		expect(rec.notices).toHaveLength(1);
		expect(rec.notices[0]!.level).toBe("warning");
		expect(rec.notices[0]!.text).toContain("不存在.txt");
		expect(rec.notices[0]!.textEn).toContain("不存在.txt");
		expect(logs).toContain("missing");
		expect(logs).toContain("不存在.txt");
	});

	it("重复项只出现一次：duplicate 进日志但不打扰用户", async () => {
		touch("a.md");
		const warn = captureWarn();
		const rec = recorder();
		await deliverScheduledRun(task({ materials: ["a.md", " a.md ", "a.md"] }), rec.host);
		const logs = warn.text();
		warn.restore();
		expect(rec.wakes[0]!.text).toBe("[定时任务 巡检] 检查构建\n\n材料：a.md");
		expect(rec.notices).toEqual([]);
		expect(logs).toContain("duplicate");
	});
});

describe("跨环境（R7：执行 cwd 与材料基准不一致）", () => {
	it("先 stageMaterials 搬到执行目录，清单给暂存路径", async () => {
		touch("a.md", "hello");
		const runDir = mkdtempSync(join(tmpdir(), "piweb-sched-material-run-"));
		try {
			const rec = recorder({ runCwd: () => runDir });
			await deliverScheduledRun(task({ materials: ["a.md"] }), rec.host);
			expect(rec.wakes[0]!.text).toBe(`[定时任务 巡检] 检查构建\n\n材料：${MATERIAL_STAGE_DIR}/a.md`);
			expect(existsSync(join(runDir, MATERIAL_STAGE_DIR, "a.md"))).toBe(true);
			expect(rec.notices).toEqual([]);
		} finally {
			rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});
});

describe("规格侧：只存路径字符串", () => {
	const BASE = { name: "t", cwd: "/tmp", kind: "interval" as const, spec: String(60_000), prompt: "hi" };

	it("非字符串 / 空串丢掉，超过上限就截到 maxItems", async () => {
		const t = normalizeSchedulerInput({ ...BASE, materials: [" a.md ", "  ", 42 as never, "b.md"] });
		expect(t.materials).toEqual(["a.md", "b.md"]);
		const many = Array.from({ length: MATERIAL_LIMITS.maxItems + 3 }, (_, i) => `f${i}.md`);
		expect(normalizeSchedulerInput({ ...BASE, materials: many }).materials).toHaveLength(MATERIAL_LIMITS.maxItems);
		expect(normalizeSchedulerInput(BASE).materials).toBeUndefined();
	});

	it("视图带出 materials；面板编辑省略 materials 时保持原值，显式 [] 才清空", async () => {
		const storeDir = mkdtempSync(join(tmpdir(), "piweb-sched-material-store-"));
		const store = new SchedulerStore(storeDir);
		try {
			await store.upsert({ ...BASE, id: "t1", materials: ["a.md"] });
			expect(store.list()[0]!.materials).toEqual(["a.md"]);
			await store.upsert({ ...BASE, id: "t1", name: "改名" });
			expect(store.list()[0]!.materials).toEqual(["a.md"]);
			await store.upsert({ ...BASE, id: "t1", materials: [] });
			expect(store.list()[0]!.materials).toBeUndefined();
		} finally {
			store.stop();
			rmSync(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});
});

describe("AI 入口（R3：只给路径字符串）", () => {
	it("create 接受 materials 并原样落到规格", async () => {
		const storeDir = mkdtempSync(join(tmpdir(), "piweb-sched-material-tool-"));
		const store = new SchedulerStore(storeDir);
		const host: ScheduleToolHost = { store: () => store, cwd: () => storeDir, activeConversationId: () => "c7" };
		try {
			const tool = makeScheduleTool(host, "c7", () => "zh");
			await tool.execute(
				"call-1",
				{ action: "create", schedule: "in 30m", prompt: "看看截图", materials: ["shot.png", "req.md"] } as never,
				undefined,
				undefined,
				{ cwd: storeDir } as never,
			);
			expect(store.list()[0]!.materials).toEqual(["shot.png", "req.md"]);
		} finally {
			store.stop();
			rmSync(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});
});
