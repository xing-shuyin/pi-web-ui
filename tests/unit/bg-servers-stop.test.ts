/**
 * #974 §1：停止后台任务必须「确认进程真退出」再宣布成功。
 *
 * killPidTree 自身 `catch {}` 吞错，taskkill/SIGKILL 又都是异步送达，所以
 * 只看「调用过 kill」就删条目 + 公告成功是不可靠的：杀失败时端口行会消失，
 * 用户既看不到也没法重试。这里把三条停止路径（单个 / 清理遗留 / 全部关闭）
 * 都钉在「杀完复核」上。
 */
import { describe, expect, it, vi } from "vitest";
import { BgServerTracker } from "../../server/bg-servers.js";
import type { ServerMessage } from "../../server/protocol.js";

const h = vi.hoisted(() => ({
	/** 当前「系统里」的监听端口 → pid（refresh / verify 都读它）。 */
	ports: new Map<number, number>(),
	/** 还活着的 pid。 */
	alive: new Set<number>(),
	/** 杀不掉的 pid（模拟 taskkill 拒绝访问 / 进程逃过杀）。 */
	stubborn: new Set<number>(),
	killedPids: [] as number[],
}));

vi.mock("../../server/async-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../server/async-utils.js")>()),
	// trackAfterBash 的 1.5s 绑定窗口与测试无关。
	sleep: async () => {},
}));

vi.mock("../../server/process-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../server/process-utils.js")>()),
	snapshotListeningPorts: async () => new Map(h.ports),
	snapshotProcessTree: async () => new Map(),
	// 名字给个典型开发运行时：进程树查不到时 shouldTrackBackgroundServer 靠它保守收录。
	lookupProcessDetailsBatch: async () => new Map([...h.alive].map((pid) => [pid, { name: "node.exe" }])),
	killPidTree: async (pid: number) => {
		h.killedPids.push(pid);
		if (!h.stubborn.has(pid)) h.alive.delete(pid);
	},
	waitForPidGone: async (pid: number) => !h.alive.has(pid),
}));

function makeTracker(): { tracker: BgServerTracker; notices: ServerMessage[] } {
	h.ports.clear();
	h.alive.clear();
	h.stubborn.clear();
	h.killedPids.length = 0;
	const notices: ServerMessage[] = [];
	const tracker = new BgServerTracker({
		emit: (msg) => notices.push(msg),
		flushSnapshot: () => {},
		isDisposed: () => false,
	});
	return { tracker, notices };
}

/** 从真实入口喂条目：bash 之后新冒出来的监听端口。 */
async function track(tracker: BgServerTracker, port: number, pid: number): Promise<void> {
	h.alive.add(pid);
	tracker.snapshotBefore();
	h.ports.set(port, pid);
	await tracker.trackAfterBash();
	expect(portRows(tracker)).toContain(port);
}

function portRows(tracker: BgServerTracker): number[] {
	return tracker
		.list()
		.filter((s) => s.kind === "port")
		.map((s) => s.port)
		.sort((a, b) => a - b);
}

function texts(notices: ServerMessage[], level: "error" | "info" | "warning"): string[] {
	return notices.flatMap((m) => (m.type === "notice" && m.level === level ? [m.text] : []));
}

describe("BgServerTracker 停止路径", () => {
	it("killOne：进程确实退出后才删条目并公告成功", async () => {
		const { tracker, notices } = makeTracker();
		await track(tracker, 5173, 4242);

		expect(await tracker.killOne(5173)).toBe(true);
		expect(portRows(tracker)).toEqual([]);
		expect(h.killedPids).toEqual([4242]);
		expect(texts(notices, "info").some((t) => t.includes("已停止后台任务"))).toBe(true);
		expect(texts(notices, "error")).toEqual([]);
	});

	it("killOne：杀不掉时保留条目、报 error、返回 false（不留「已停止」的假象）", async () => {
		const { tracker, notices } = makeTracker();
		await track(tracker, 5173, 4242);
		h.stubborn.add(4242);

		expect(await tracker.killOne(5173)).toBe(false);
		expect(portRows(tracker)).toEqual([5173]);
		expect(texts(notices, "info").some((t) => t.includes("已停止后台任务"))).toBe(false);
		expect(texts(notices, "error").some((t) => t.includes("停止失败") && t.includes("5173"))).toBe(true);
	});

	it("cleanStale：只把确认退出的算进清理结果，杀不掉的那行留在列表里", async () => {
		const { tracker, notices } = makeTracker();
		await track(tracker, 5173, 4242);
		await track(tracker, 8787, 4343);
		h.stubborn.add(4343);
		await new Promise((r) => setTimeout(r, 5));

		expect(await tracker.cleanStale(1, { manual: true })).toEqual([5173]);
		expect(portRows(tracker)).toEqual([8787]);
		expect(texts(notices, "error").some((t) => t.includes("清理失败") && t.includes("8787"))).toBe(true);
	});

	it("cleanStale：自动清理失败不刷屏（不发 error 公告）", async () => {
		const { tracker, notices } = makeTracker();
		await track(tracker, 5173, 4242);
		h.stubborn.add(4242);
		await new Promise((r) => setTimeout(r, 5));
		const before = notices.length;

		expect(await tracker.cleanStale(1, { manual: false })).toEqual([]);
		expect(texts(notices.slice(before), "error")).toEqual([]);
		expect(portRows(tracker)).toEqual([5173]);
	});

	it("killAll：失败的行不清空，成功的行照常消失并报 error", async () => {
		const { tracker, notices } = makeTracker();
		await track(tracker, 5173, 4242);
		await track(tracker, 8787, 4343);
		h.stubborn.add(4343);

		expect(await tracker.killAll()).toEqual(["5173"]);
		expect(portRows(tracker)).toEqual([8787]);
		expect(texts(notices, "error").some((t) => t.includes("停止失败") && t.includes("8787"))).toBe(true);
	});
});
