import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundExecutorRegistry, type BackgroundExecutor } from "../../server/background-executors.js";
import { PluginManager } from "../../server/plugins.js";

describe("BackgroundExecutorRegistry", () => {
	it("只启动 kind=boot 的执行者，on-demand 保持 pending", async () => {
		const calls: string[] = [];
		const reg = new BackgroundExecutorRegistry();
		reg.register({ id: "a", kind: "boot", start: () => void calls.push("a") });
		reg.register({ id: "b", kind: "on-demand", start: () => void calls.push("b") });
		const r = await reg.startAll();
		expect(calls).toEqual(["a"]);
		expect(r.failed).toEqual([]);
		const snap = reg.snapshot();
		expect(snap.find((s) => s.id === "a")?.state).toBe("running");
		expect(snap.find((s) => s.id === "b")?.state).toBe("pending");
	});

	it("单个执行者抛错不阻断其它执行者，也不让 startAll 抛出", async () => {
		const ran: string[] = [];
		const reg = new BackgroundExecutorRegistry();
		reg.register({
			id: "broken",
			kind: "boot",
			start: () => {
				throw new Error("boom");
			},
		});
		reg.register({ id: "fine", kind: "boot", start: () => void ran.push("fine") });
		const r = await reg.startAll();
		expect(ran).toEqual(["fine"]);
		expect(r.failed).toEqual(["broken"]);
		const broken = reg.snapshot().find((s) => s.id === "broken");
		expect(broken?.state).toBe("failed");
		expect(broken?.lastError).toBe("boom");
		expect(reg.unhealthy().map((u) => u.id)).toEqual(["broken"]);
	});

	it("startAll 幂等：重复调用不会二次启动", async () => {
		let count = 0;
		const reg = new BackgroundExecutorRegistry();
		reg.register({ id: "once", kind: "boot", start: () => void count++ });
		await reg.startAll();
		await reg.startAll();
		expect(count).toBe(1);
		expect(reg.isBooted()).toBe(true);
	});

	it("重复 id 直接拒绝（避免两个同源执行者静默互相覆盖状态）", () => {
		const reg = new BackgroundExecutorRegistry();
		const ex: BackgroundExecutor = { id: "dup", kind: "boot", start: () => {} };
		reg.register(ex);
		expect(() => reg.register({ ...ex })).toThrow(/duplicate background executor/);
	});

	it("probe 刷新 health，并按 on-failure + 冷却重启，超过上限后不再重启", async () => {
		let now = 0;
		let healthy = false;
		let starts = 0;
		const reg = new BackgroundExecutorRegistry({
			now: () => now,
			restartCooldownMs: 1_000,
			maxRestarts: 2,
		});
		reg.register({
			id: "flaky",
			kind: "boot",
			restart: "on-failure",
			start: () => {
				starts++;
				healthy = true;
			},
			health: () => ({ ok: healthy }),
		});
		await reg.startAll();
		expect(starts).toBe(1);

		// 变坏 → 立刻探到，但冷却窗口内不重启（刚启动过）。
		healthy = false;
		await reg.probe();
		expect(starts).toBe(1);
		expect(reg.unhealthy().map((u) => u.id)).toEqual(["flaky"]);

		// 过了冷却 → 重启一次。
		now += 2_000;
		healthy = false;
		await reg.probe();
		expect(starts).toBe(2);

		// 再次变坏 + 冷却 → 第二次重启（maxRestarts=2）。
		now += 2_000;
		healthy = false;
		await reg.probe();
		expect(starts).toBe(3);

		// 第三次被上限拦住。
		now += 2_000;
		healthy = false;
		await reg.probe();
		expect(starts).toBe(3);
		expect(reg.snapshot()[0]?.restarts).toBe(2);
	});

	it("restart=never（默认）即使 unhealthy 也不重启，只报告", async () => {
		let starts = 0;
		const reg = new BackgroundExecutorRegistry({ now: () => 0 });
		reg.register({
			id: "quiet",
			kind: "boot",
			start: () => void starts++,
			health: () => ({ ok: false, detail: "unhealthy" }),
		});
		await reg.startAll();
		await reg.probe();
		expect(starts).toBe(1);
		expect(reg.unhealthy()).toEqual([{ id: "quiet", state: "running", detail: "unhealthy" }]);
	});

	it("health() 抛错等价于 unhealthy，不影响 snapshot", async () => {
		const reg = new BackgroundExecutorRegistry();
		reg.register({
			id: "throws",
			kind: "boot",
			start: () => {},
			health: () => {
				throw new Error("bad health");
			},
		});
		await reg.startAll();
		await reg.probe();
		const h = reg.snapshot()[0]?.health;
		expect(h?.ok).toBe(false);
		expect(h?.detail).toMatch(/bad health/);
	});

	it("snapshot 是上次探针的缓存，snapshotLive 才是实时（/api/health 必须用后者）", async () => {
		let healthy = true;
		const reg = new BackgroundExecutorRegistry();
		reg.register({
			id: "live",
			kind: "boot",
			start: () => {},
			health: () => ({ ok: healthy, detail: healthy ? "up" : "down" }),
		});
		await reg.startAll();
		await reg.probe();
		expect(reg.snapshot()[0]?.health?.ok).toBe(true);
		healthy = false;
		// 缓存快照仍是旧值：这正是「health 显示积压不更新」的坑（2026-11 修复）
		expect(reg.snapshot()[0]?.health?.ok).toBe(true);
		expect(reg.snapshotLive()[0]?.health?.ok).toBe(false);
	});

	it("stopAll 调 stop 并置 stopped，之后 probe 跳过", async () => {
		let stopped = 0;
		let probed = 0;
		const reg = new BackgroundExecutorRegistry();
		reg.register({
			id: "s",
			kind: "boot",
			start: () => {},
			stop: () => void stopped++,
			health: () => {
				probed++;
				return { ok: true };
			},
		});
		await reg.startAll();
		await reg.stopAll();
		expect(stopped).toBe(1);
		expect(reg.snapshot()[0]?.state).toBe("stopped");
		await reg.probe();
		expect(probed).toBe(0);
	});
});

describe("PluginManager alwaysOn 作用域（无 WebSocket 连接时也应激活）", () => {
	let dir: string;
	let mgr: PluginManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-alwayson-test-"));
		mgr = new PluginManager(dir, dir);
	});
	afterEach(() => {
		mgr.dispose();
		rmSync(dir, { recursive: true, force: true });
		(globalThis as Record<string, unknown>).__alwaysOnProbe = undefined;
		delete (globalThis as Record<string, unknown>).__alwaysOnFail;
	});

	function makePlugin(id: string, opts: { alwaysOn?: boolean; body?: string } = {}): void {
		const pdir = join(dir, "plugins", id);
		mkdirSync(pdir, { recursive: true });
		writeFileSync(
			join(pdir, "manifest.json"),
			JSON.stringify({
				id,
				name: id,
				version: "1.0.0",
				apiVersion: 2,
				permissions: ["storage"],
				...(opts.alwaysOn ? { alwaysOn: true } : {}),
			}),
		);
		writeFileSync(
			join(pdir, "index.mjs"),
			opts.body ??
				`export default { activate() { globalThis.__alwaysOnProbe = (globalThis.__alwaysOnProbe || []).concat("${id}"); } };`,
		);
	}

	it("ensureAlwaysOnLoaded 只激活声明 alwaysOn 的插件，其余保持懒激活", async () => {
		makePlugin("channel", { alwaysOn: true });
		makePlugin("ui-only");
		const list = await mgr.ensureAlwaysOnLoaded();
		expect(list.find((p) => p.id === "channel")?.active).toBe(true);
		expect(list.find((p) => p.id === "ui-only")?.active).toBeFalsy();
		expect((globalThis as Record<string, unknown>).__alwaysOnProbe).toEqual(["channel"]);
	});

	it("alwaysOn 之后再用 scope=all 会补齐其余插件（不重复激活已加载的）", async () => {
		makePlugin("channel", { alwaysOn: true });
		makePlugin("ui-only");
		await mgr.ensureAlwaysOnLoaded();
		await mgr.ensureLoaded();
		const probes = (globalThis as Record<string, unknown>).__alwaysOnProbe as string[];
		expect(probes.sort()).toEqual(["channel", "ui-only"]);
		expect(mgr.alwaysOnSnapshot().map((p) => p.id)).toEqual(["channel"]);
	});

	it("alwaysOn 插件激活失败时 snapshot 报 active=false，rescanAlwaysOn 可自愈", async () => {
		makePlugin("channel", {
			alwaysOn: true,
			body: `export default { activate() { if (globalThis.__alwaysOnFail) throw new Error("boot boom"); globalThis.__alwaysOnProbe = (globalThis.__alwaysOnProbe || []).concat("channel"); } };`,
		});
		(globalThis as Record<string, unknown>).__alwaysOnFail = true;
		await mgr.ensureAlwaysOnLoaded();
		const bad = mgr.alwaysOnSnapshot();
		expect(bad).toHaveLength(1);
		expect(bad[0]?.active).toBe(false);
		expect(bad[0]?.error).toMatch(/boot boom/);

		(globalThis as Record<string, unknown>).__alwaysOnFail = false;
		await mgr.rescanAlwaysOn();
		const fixed = mgr.alwaysOnSnapshot();
		expect(fixed[0]?.active).toBe(true);
		expect((globalThis as Record<string, unknown>).__alwaysOnProbe).toEqual(["channel"]);
	});

	it("缺 index.mjs 的 alwaysOn 插件不会被扫描激活（保持现有规则）", async () => {
		const pdir = join(dir, "plugins", "no-entry");
		mkdirSync(pdir, { recursive: true });
		writeFileSync(
			join(pdir, "manifest.json"),
			JSON.stringify({ id: "no-entry", name: "no-entry", version: "1.0.0", alwaysOn: true }),
		);
		const list = await mgr.ensureAlwaysOnLoaded();
		expect(list.find((p) => p.id === "no-entry")?.active).toBeFalsy();
		expect(mgr.alwaysOnSnapshot()).toEqual([]);
	});
});
