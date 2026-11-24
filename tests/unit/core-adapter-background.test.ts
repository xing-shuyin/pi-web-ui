import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "../../server/protocol.js";

/**
 * 宿主后台任务适配器：`BgServerTracker`（真叶子）+ `JobRegistry`（替身：真实现会 spawn 进程）。
 * 端口行相关的行为由真叶子跑，job 行只钉「适配器怎么装配、参数怎么传」，两边合起来覆盖 7 个成员（第 8 个 `abortBash` 不在这张端口上：句柄表与中止都在内核）。
 */
const h = vi.hoisted(() => ({
	/** 当前「系统里」的监听端口 → pid。 */
	ports: new Map<number, number>(),
	alive: new Set<number>(),
	stubborn: new Set<number>(),
	killedPids: [] as number[],
	trackers: [] as any[],
	registryOptions: undefined as any,
	starts: [] as any[],
	listed: [] as any[],
	killAndWait: [] as string[],
	killAndWaitResult: { ok: true, exited: true, timedOut: false },
	getIds: [] as string[],
	snapshot: undefined as any,
	killIds: [] as string[],
	killAllResult: [] as string[],
	killAllCalls: 0,
	disposed: 0,
	startError: "",
}));

vi.mock("../../server/bg-servers.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../server/bg-servers.js")>();
	return {
		...real,
		BgServerTracker: class extends real.BgServerTracker {
			constructor(opts: any) {
				super(opts);
				h.trackers.push(this);
			}
		},
	};
});

vi.mock("../../server/job-runner.js", () => ({
	JOB_TASK_PREFIX: "job:",
	JobRegistry: class {
		constructor(opts: any) {
			h.registryOptions = opts;
		}
		start(spec: any) {
			if (h.startError) throw new Error(h.startError);
			h.starts.push(spec);
			return { id: `j${h.starts.length}` };
		}
		list() {
			return h.listed;
		}
		get(id: string) {
			h.getIds.push(id);
			return h.snapshot;
		}
		kill(id: string) {
			h.killIds.push(id);
			return true;
		}
		killAndWait(id: string) {
			h.killAndWait.push(id);
			return Promise.resolve(h.killAndWaitResult);
		}
		killAll() {
			h.killAllCalls++;
			return h.killAllResult;
		}
		dispose() {
			h.disposed++;
		}
	},
}));

vi.mock("../../server/async-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../server/async-utils.js")>()),
	sleep: async () => {},
}));

vi.mock("../../server/process-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../server/process-utils.js")>()),
	snapshotListeningPorts: async () => new Map(h.ports),
	snapshotProcessTree: async () => new Map(),
	lookupProcessDetailsBatch: async () => new Map([...h.alive].map((pid) => [pid, { name: "node.exe" }])),
	killPidTree: async (pid: number) => {
		h.killedPids.push(pid);
		if (!h.stubborn.has(pid)) h.alive.delete(pid);
	},
	waitForPidGone: async (pid: number) => !h.alive.has(pid),
}));

const { createCoreBackground } = await import("../../server/core-background-adapter.js");

type Sinks = Partial<Parameters<typeof createCoreBackground>[0]>;

function makePort(overrides: Sinks = {}) {
	const frames: ServerMessage[] = [];
	let flushes = 0;
	const port = createCoreBackground({
		dataDir: "/data/pi-web",
		emit: (msg) => frames.push(msg),
		flushSnapshot: () => {
			flushes++;
		},
		isDisposed: () => false,
		getCwd: () => "/work/project",
		activeConversationId: () => "conv-1",
		cleanupMinutes: () => 0,
		...overrides,
	});
	return {
		port,
		frames,
		notices: () => frames.flatMap((msg) => (msg.type === "notice" ? [msg] : [])),
		bgFrames: () => frames.flatMap((msg) => (msg.type === "bg_servers" ? [msg.servers] : [])),
		flushes: () => flushes,
	};
}

/** 从真实入口喂一条端口行：bash 之后新冒出来的监听端口。 */
async function track(port: number, pid: number): Promise<void> {
	h.alive.add(pid);
	const tracker = h.trackers.at(-1);
	tracker.snapshotBefore();
	h.ports.set(port, pid);
	await tracker.trackAfterBash();
}

beforeEach(() => {
	h.ports.clear();
	h.alive.clear();
	h.stubborn.clear();
	h.killedPids.length = 0;
	h.trackers.length = 0;
	h.registryOptions = undefined;
	h.starts.length = 0;
	h.listed.length = 0;
	h.killAndWait.length = 0;
	h.killAndWaitResult = { ok: true, exited: true, timedOut: false };
	h.getIds.length = 0;
	h.snapshot = undefined;
	h.killIds.length = 0;
	h.killAllResult = [];
	h.killAllCalls = 0;
	h.disposed = 0;
	h.startError = "";
});

afterEach(() => {
	vi.useRealTimers();
});

describe("后台任务适配器：装配", () => {
	it("job 日志落 <dataDir>/jobs，变更即推 bg_servers（onChange 直接接到真叶子的 push）", () => {
		const { bgFrames } = makePort();
		expect(h.registryOptions.logDir()).toBe(join("/data/pi-web", "jobs"));
		h.registryOptions.onChange();
		expect(bgFrames()).toHaveLength(1);
	});

	it("job 结束通知只在宿主给了 onJobExit 时转发，且参数原样带出", () => {
		makePort();
		expect(h.registryOptions.onExit).toBeUndefined();
		h.trackers.length = 0;
		const seen: any[] = [];
		makePort({ onJobExit: (job) => seen.push(job) });
		const job = { id: "j1", reason: "exit" };
		h.registryOptions.onExit(job);
		expect(seen).toEqual([job]);
	});

	it("tracker 的四个取值 sink 直通宿主：cleanupMinutes / getCwd / killAllJobs / jobs 行", () => {
		const opts = { cleanupMinutes: () => 12, getCwd: () => "/work/other" };
		const { port } = makePort(opts);
		const trackerOpts = (h.trackers.at(-1) as any).opts;
		expect(trackerOpts.cleanupMinutes()).toBe(12);
		expect(trackerOpts.workspaceCwd()).toBe("/work/other");
		h.killAllResult = ["a"];
		expect(trackerOpts.killAllJobs()).toEqual(["a"]);
		expect(h.killAllCalls).toBe(1);
		h.listed = [
			{ id: "abc", pid: 11, since: 5, label: "dev", command: "npm run dev", origin: "conv-9", logPath: "/l/abc.log" },
		];
		expect(trackerOpts.jobs()).toEqual([
			{
				taskId: "job:abc",
				pid: 11,
				since: 5,
				name: "dev",
				command: "npm run dev",
				status: "running",
				origin: "conv-9",
				logPath: "/l/abc.log",
			},
		]);
		port.dispose();
	});

	it("通道已关时自动清理作罢（不再扫端口）：cleanupMinutes 对已关闭的通道返回 0", () => {
		const { port } = makePort({ isDisposed: () => true, cleanupMinutes: () => 12 });
		expect((h.trackers.at(-1) as any).opts.cleanupMinutes()).toBe(0);
		port.dispose();
	});

	it("插件常驻任务行只在给了 pluginTasks 时接上（没给 = 面板上没有这一类行，不凭空造空数组）", () => {
		makePort();
		expect((h.trackers.at(-1) as any).opts.pluginTasks).toBeUndefined();
		const { port } = makePort({ pluginTasks: () => [{ taskId: "notes", since: 1 }] });
		expect((h.trackers.at(-1) as any).opts.pluginTasks()).toEqual([{ taskId: "notes", since: 1 }]);
		port.dispose();
	});
});

describe("后台任务适配器：7 个成员", () => {
	it("listBgServers：重算并下发一帧（真叶子里的 job 行也在帧里）", async () => {
		const { port, bgFrames } = makePort();
		h.listed = [{ id: "abc", pid: 11, since: 5, label: "dev", command: "npm run dev", logPath: "/l/abc.log" }];
		await port.listBgServers();
		expect(bgFrames()).toEqual([
			[
				{
					kind: "job",
					taskId: "job:abc",
					pid: 11,
					since: 5,
					name: "dev",
					command: "npm run dev",
					status: "running",
					logPath: "/l/abc.log",
				},
			],
		]);
		port.dispose();
	});

	it("killBackgroundServer(job:)：前缀去掉再交给 killAndWait，成功不解释、2s 后补一帧", async () => {
		vi.useFakeTimers();
		const { port, bgFrames, notices, flushes } = makePort();
		await expect(port.killBackgroundServer(undefined, "job:j1")).resolves.toBe(true);
		expect(h.killAndWait).toEqual(["j1"]);
		expect(notices()).toEqual([]);
		expect(bgFrames()).toHaveLength(1);
		expect(flushes()).toBe(1);
		vi.advanceTimersByTime(2000);
		expect(bgFrames()).toHaveLength(2);
		port.dispose();
	});

	it("killBackgroundServer(job:)：停不掉 / 超时各发一条 notice，返回值仍按宿主结论", async () => {
		h.killAndWaitResult = { ok: false, exited: false, timedOut: true };
		const { port, notices } = makePort();
		await expect(port.killBackgroundServer(undefined, "job:j1")).resolves.toBe(false);
		expect(notices().map((n) => [n.level, n.text])).toEqual([
			["info", "后台任务「job:j1」不存在或已结束"],
			["warning", "后台任务「job:j1」停止超时，已强制从列表移除；若进程仍在请手动 kill"],
		]);
		port.dispose();
	});

	it("killBackgroundServer(plugin)：taskId 原样交给 stopBgTask；没接该能力时按「不存在」解释", async () => {
		const seen: string[] = [];
		const withStop = makePort({
			stopBgTask: (taskId) => {
				seen.push(taskId);
				return true;
			},
		});
		await expect(withStop.port.killBackgroundServer(undefined, "plugin-task")).resolves.toBe(true);
		expect(seen).toEqual(["plugin-task"]);
		expect(withStop.notices()).toEqual([]);
		expect(withStop.bgFrames()).toHaveLength(1);
		withStop.port.dispose();

		const bare = makePort();
		await expect(bare.port.killBackgroundServer(undefined, "plugin-task")).resolves.toBe(false);
		expect(bare.notices().map((n) => n.text)).toEqual(["后台任务「plugin-task」不存在或已结束"]);
		bare.port.dispose();
	});

	it("killBackgroundServer(port)：交给真叶子的 killOne（杀前复核 pid）", async () => {
		const { port, notices } = makePort();
		await track(3000, 4321);
		await expect(port.killBackgroundServer(3000)).resolves.toBe(true);
		expect(h.killedPids).toEqual([4321]);
		expect(notices().at(-1)?.text).toBe("已停止后台任务：端口 3000（pid 4321）");
		port.dispose();
	});

	it("killBackgroundServer(undefined)：什么都不给就不动（老实现的兜底 false）", async () => {
		const { port, frames } = makePort();
		await expect(port.killBackgroundServer(undefined)).resolves.toBe(false);
		expect(frames).toEqual([]);
		port.dispose();
	});

	it("killAllBackgroundServers：端口行 + job 行一起收，返回值原样透传", async () => {
		const { port } = makePort();
		await track(3000, 4321);
		h.killAllResult = ["abc"];
		await expect(port.killAllBackgroundServers()).resolves.toEqual(["job:abc", "3000"]);
		expect(h.killAllCalls).toBe(1);
		expect(h.killedPids).toEqual([4321]);
		port.dispose();
	});

	it("startBgScript：脚本名/cwd 原样解析，起 job 时补上当前对话做 origin", async () => {
		const dir = mkdtempSync(join(tmpdir(), "core-bg-adapter-"));
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
			const { port, bgFrames, flushes } = makePort({ activeConversationId: () => "conv-7" });
			port.startBgScript("dev", dir);
			expect(h.starts).toEqual([{ command: "npm run dev", cwd: resolve(dir), label: "dev", origin: "conv-7" }]);
			expect(bgFrames()).toHaveLength(1);
			expect(flushes()).toBe(1);
			port.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("startBgScript：缺 cwd 时退到宿主的 getCwd", async () => {
		const dir = mkdtempSync(join(tmpdir(), "core-bg-adapter-"));
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
			const { port } = makePort({ getCwd: () => dir });
			port.startBgScript("build");
			expect(h.starts).toEqual([{ command: "npm run build", cwd: resolve(dir), label: "build", origin: "conv-1" }]);
			port.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("startBgScript：脚本名不合法 / 没这个脚本 / 起不来都是 warning，且不碰 job 注册表", () => {
		const dir = mkdtempSync(join(tmpdir(), "core-bg-adapter-"));
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
			const bad = makePort();
			bad.port.startBgScript("rm -rf /", dir);
			expect(bad.notices().map((n) => [n.level, n.text])).toEqual([["warning", "启动脚本名不合法：「rm -rf /」"]]);
			bad.port.startBgScript("missing", dir);
			expect(bad.notices().at(-1)?.text).toBe("package.json 里没有脚本「missing」");
			expect(h.starts).toEqual([]);
			expect(bad.flushes()).toBe(0);
			bad.port.dispose();

			h.startError = "boom";
			const failing = makePort();
			failing.port.startBgScript("dev", dir);
			expect(failing.notices().map((n) => n.text)).toEqual(["启动失败：boom"]);
			expect(failing.flushes()).toBe(1);
			failing.port.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restartBgJob：先 kill 再按原 command/cwd/label 重起，非 job: 前缀直接忽略", () => {
		const { port, notices, flushes } = makePort({ activeConversationId: () => "conv-3" });
		h.snapshot = { id: "abc", command: "npm run dev", cwd: "/work/p", label: "dev" };
		port.restartBgJob("job:abc");
		expect(h.getIds).toEqual(["abc"]);
		expect(h.killIds).toEqual(["abc"]);
		expect(h.starts).toEqual([{ command: "npm run dev", cwd: "/work/p", label: "dev", origin: "conv-3" }]);
		expect(flushes()).toBe(1);
		expect(notices()).toEqual([]);
		port.dispose();

		h.getIds.length = 0;
		h.snapshot = undefined;
		const missing = makePort();
		missing.port.restartBgJob("job:gone");
		expect(missing.notices().map((n) => n.text)).toEqual(["后台任务「job:gone」不存在或已结束"]);
		expect(h.killIds).toEqual(["abc"]);
		missing.port.dispose();

		const ignored = makePort();
		ignored.port.restartBgJob("not-a-job");
		expect(ignored.frames).toEqual([]);
		ignored.port.dispose();
	});

	it("setBackgroundKeep：钉住落到真叶子（端口不在列表时 false + notice）", async () => {
		const { port, bgFrames, notices } = makePort();
		await track(3000, 4321);
		expect(port.setBackgroundKeep(3000, true)).toBe(true);
		expect(bgFrames().at(-1)).toEqual([
			{ port: 3000, pid: 4321, since: expect.any(Number), kind: "port", name: "node.exe", keep: true },
		]);
		expect(port.setBackgroundKeep(8080, true)).toBe(false);
		expect(notices().at(-1)?.text).toBe("端口 8080 不在后台任务列表中（可能已自行退出）");
		port.dispose();
	});

	it("cleanBackgroundLeftovers：阈值解析 入参 > 设置项 > 兜底 30 分钟，全部走宿主", async () => {
		const cases: Array<[number | undefined, number, string]> = [
			[5, 0, "阈值 5 分钟"],
			[undefined, 10, "阈值 10 分钟"],
			[0, 0, "阈值 30 分钟"],
		];
		for (const [override, policy, expected] of cases) {
			const { port, notices } = makePort({ cleanupMinutes: () => policy });
			await expect(port.cleanBackgroundLeftovers(override)).resolves.toEqual([]);
			expect(notices().at(-1)?.text).toContain(expected);
			port.dispose();
		}
	});

	it("dispose：停刷新定时器并把 job 进程树一起收", () => {
		const { port } = makePort();
		port.dispose();
		expect(h.disposed).toBe(1);
	});
});
