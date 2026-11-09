import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseCronField,
	parseCronSpec,
	armDelay,
	nextCronFire,
	MAX_TIMEOUT_MS,
	loadScheduleRecords,
	saveScheduleRecords,
} from "../../server/plugin-schedule.js";
import { PluginManager, type PluginHost } from "../../server/plugins.js";
import { pluginStateDir } from "../../server/plugin-paths.js";

describe("parseCronField", () => {
	it("星/步长/范围/列表/单值", () => {
		expect(parseCronField("*", 0, 59)).toHaveLength(60);
		expect(parseCronField("*/15", 0, 59)).toEqual([0, 15, 30, 45]);
		expect(parseCronField("1-5", 0, 59)).toEqual([1, 2, 3, 4, 5]);
		expect(parseCronField("1-10/3", 0, 59)).toEqual([1, 4, 7, 10]);
		expect(parseCronField("5,10,5", 0, 59)).toEqual([5, 10]);
		expect(parseCronField("7", 0, 59)).toEqual([7]);
		expect(parseCronField("60", 0, 59)).toBeNull();
	});
	it("非法形状回 null", () => {
		expect(parseCronField("", 0, 59)).toBeNull();
		expect(parseCronField("*/0", 0, 59)).toBeNull();
		expect(parseCronField("5-2", 0, 59)).toBeNull();
		expect(parseCronField("abc", 0, 59)).toBeNull();
		expect(parseCronField("1,2,", 0, 59)).toBeNull();
	});
	it("英文名 + 周日 7 视作 0", () => {
		expect(parseCronField("mon", 0, 6, { mon: 1 })).toEqual([1]);
		expect(parseCronField("7", 0, 6)).toEqual([0]);
		expect(parseCronField("jan", 1, 12, { jan: 1 })).toEqual([1]);
	});
});

describe("parseCronSpec", () => {
	it("5 字段合法，老 */N 子集照常工作", () => {
		expect(parseCronSpec("*/5 * * * *")?.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
		expect(parseCronSpec("0 9 * * *")?.hour).toEqual([9]);
		expect(parseCronSpec("30 8 * * mon-fri")?.dow).toEqual([1, 2, 3, 4, 5]);
	});
	it("非法回 null（4 字段/越界/坏 token）", () => {
		expect(parseCronSpec("* * * *")).toBeNull();
		expect(parseCronSpec("61 * * * *")).toBeNull();
		expect(parseCronSpec("* * * * * *")).toBeNull();
		expect(parseCronSpec("0 9 * * nonsense")).toBeNull();
	});
});

describe("nextCronFire（本地时区构造，跨 TZ 稳定）", () => {
	const sunday1030 = new Date(2026, 8, 20, 10, 30, 0).getTime();
	it("每天 9 点：周日 10:30 → 周一 09:00", () => {
		const parts = parseCronSpec("0 9 * * *")!;
		expect(nextCronFire(parts, sunday1030)).toBe(new Date(2026, 8, 21, 9, 0, 0).getTime());
	});
	it("整点边界不取当前分钟（严格下一分钟起扫）", () => {
		const monday9 = new Date(2026, 8, 21, 9, 0, 0).getTime();
		const parts = parseCronSpec("0 9 * * *")!;
		expect(nextCronFire(parts, monday9)).toBe(new Date(2026, 8, 22, 9, 0, 0).getTime());
	});
	it("日-周 OR 语义：每月 1 号或周一都触发", () => {
		const parts = parseCronSpec("0 9 1 * mon")!;
		expect(nextCronFire(parts, sunday1030)).toBe(new Date(2026, 8, 21, 9, 0, 0).getTime());
		const sept30 = new Date(2026, 8, 30, 10, 0, 0).getTime();
		expect(nextCronFire(parts, sept30)).toBe(new Date(2026, 9, 1, 9, 0, 0).getTime());
	});
	it("分钟步长：10:30 → 10:35", () => {
		const parts = parseCronSpec("*/5 * * * *")!;
		expect(nextCronFire(parts, sunday1030)).toBe(new Date(2026, 8, 20, 10, 35, 0).getTime());
	});
});

describe("远期 cron 的安全引爆（回归：setTimeout 24.8 天溢出 → 死循环）", () => {
	it("一年内没有下一次 → null（不再回「366 天后的哨兵值」）", () => {
		const from = new Date(2026, 8, 20, 10, 30, 0).getTime();
		expect(nextCronFire(parseCronSpec("0 0 31 2 *")!, from)).toBeNull();
		expect(nextCronFire(parseCronSpec("0 0 30 2 *")!, from)).toBeNull();
		expect(nextCronFire(parseCronSpec("0 9 1 1 *")!, from)).toBe(new Date(2027, 0, 1, 9, 0, 0).getTime());
	});

	it("armDelay：远期只等一个分片，近处按实际差值，过去的立刻", () => {
		const now = 1_700_000_000_000;
		const hour = 3_600_000;
		expect(armDelay(now + 42 * 24 * hour, now)).toBe(6 * hour);
		expect(armDelay(now + 365 * 24 * hour, now)).toBe(6 * hour);
		expect(armDelay(now + 1000 * 24 * hour, now, 999 * 24 * hour)).toBe(MAX_TIMEOUT_MS);
		expect(armDelay(now + 1000 * 24 * hour, now, 999 * 24 * hour)).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
		expect(armDelay(now + 90_000, now)).toBe(90_000);
		expect(armDelay(now - hour, now)).toBe(0);
		expect(armDelay(Number.NaN, now)).toBe(0);
	});
});

describe("持久记录读写", () => {
	it("往返 + 坏文件当空表", () => {
		const dir = mkdtempSync(join(tmpdir(), "sched-rec-"));
		try {
			expect(loadScheduleRecords(dir)).toEqual({});
			saveScheduleRecords(dir, {
				a: { spec: "0 9 * * *", catchUp: "once", label: "日报", lastRun: 123, createdAt: 100 },
			});
			expect(loadScheduleRecords(dir)).toEqual({
				a: { spec: "0 9 * * *", catchUp: "once", label: "日报", lastRun: 123, createdAt: 100 },
			});
			writeFileSync(join(dir, "schedules.json"), "{坏");
			expect(loadScheduleRecords(dir)).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("host.schedule 持久版", () => {
	let dir: string;
	let mgr: PluginManager;

	function makePlugin(id: string): void {
		const pdir = join(dir, "plugins", id);
		mkdirSync(pdir, { recursive: true });
		writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id }));
		writeFileSync(join(pdir, "index.mjs"), `export default { activate(h) { globalThis.__hosts["${id}"] = h; } };`);
	}
	async function hostOf(id: string): Promise<PluginHost> {
		(globalThis as unknown as { __hosts?: Record<string, PluginHost> }).__hosts ??= {};
		await mgr.ensureLoaded();
		return (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts[id];
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-sched-test-"));
		mgr = new PluginManager(dir, dir);
	});
	afterEach(() => {
		mgr.dispose();
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it.each(["* * * * *", "0 0 1 3 *"])("cron %s 到期执行，分片不提前、不跳过", async (spec) => {
		makePlugin("s");
		const h = await hostOf("s");
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0));
		const dueAt = nextCronFire(parseCronSpec(spec)!, Date.now())!;
		const fire = vi.fn();
		const off = h.schedule(spec, fire);
		vi.advanceTimersByTime(dueAt - Date.now() - 1);
		expect(fire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(fire).toHaveBeenCalledTimes(1);
		off();
		vi.advanceTimersByTime(60_000);
		expect(fire).toHaveBeenCalledTimes(1);
	});

	it("persistent 必须给合法 id", async () => {
		makePlugin("s");
		const h = await hostOf("s");
		expect(() => h.schedule(60_000, () => {}, { persistent: true })).toThrow(/必须给合法 id/);
		expect(() => h.schedule(60_000, () => {}, { persistent: true, id: "has space" })).toThrow(/必须给合法 id/);
	});
	it("声明落盘 + 进后台面板；off() 删声明并下线面板", async () => {
		makePlugin("s");
		const h = await hostOf("s");
		const off = h.schedule("0 9 * * *", () => {}, { persistent: true, id: "daily", label: "日报" });
		const raw = JSON.parse(readFileSync(join(pluginStateDir(dir, "s"), "schedules.json"), "utf8"));
		expect(raw.schedules.daily.spec).toBe("0 9 * * *");
		expect(raw.schedules.daily.catchUp).toBe("skip");
		const tasks = mgr.bgTasks().filter((t) => t.taskId === "schedule:daily");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.plugin).toBe("s");
		expect(tasks[0]!.name).toContain("日报");
		off();
		expect(JSON.parse(readFileSync(join(pluginStateDir(dir, "s"), "schedules.json"), "utf8")).schedules).toEqual({});
		expect(mgr.bgTasks().filter((t) => t.taskId === "schedule:daily")).toHaveLength(0);
	});
	it("activate 重调同 id 幂等：保留 lastRun/createdAt，只更新声明", async () => {
		makePlugin("s");
		const h = await hostOf("s");
		mkdirSync(pluginStateDir(dir, "s"), { recursive: true });
		writeFileSync(
			join(pluginStateDir(dir, "s"), "schedules.json"),
			JSON.stringify({
				v: 1,
				schedules: { daily: { spec: "0 8 * * *", catchUp: "skip", createdAt: 100, lastRun: 123 } },
			}),
		);
		h.schedule("0 9 * * *", () => {}, { persistent: true, id: "daily", catchUp: "once" });
		const rec = JSON.parse(readFileSync(join(pluginStateDir(dir, "s"), "schedules.json"), "utf8")).schedules.daily;
		expect(rec.spec).toBe("0 9 * * *");
		expect(rec.catchUp).toBe("once");
		expect(rec.lastRun).toBe(123);
		expect(rec.createdAt).toBe(100);
	});
	it("全 cron 现在合法（旧实现只认 */N）；非法形状仍抛错", async () => {
		makePlugin("s");
		const h = await hostOf("s");
		const off = h.schedule("30 8 * * mon-fri", () => {});
		expect(typeof off).toBe("function");
		off();
		expect(() => h.schedule("not a cron", () => {})).toThrow(/5 字段/);
		expect(() => h.schedule("61 * * * *", () => {})).toThrow(/5 字段/);
	});
	it("毫秒间隔底线：内存 10s、持久 60s（静默钳制不断言 timer，只不断言落盘声明）", async () => {
		makePlugin("s");
		const h = await hostOf("s");
		const off = h.schedule(1000, () => {}, { persistent: true, id: "fast" });
		expect(JSON.parse(readFileSync(join(pluginStateDir(dir, "s"), "schedules.json"), "utf8")).schedules.fast.spec).toBe(
			"60000",
		);
		off();
	});
});
