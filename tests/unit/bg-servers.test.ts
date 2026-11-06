import { describe, expect, it } from "vitest";
import { staleLeftovers, shouldTrackBackgroundServer } from "../../server/bg-servers.js";

function parentsOf(entries: Array<[number, number]>): Map<number, number> {
	return new Map(entries);
}

describe("shouldTrackBackgroundServer", () => {
	const SERVER = 1000;

	it("命中黑名单进程名直接跳过（微信、WPS、ima.copilot 等，大小写不敏感）", () => {
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "WeChat.exe")).toBe(false);
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "wechatappex.exe")).toBe(false);
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "QQ.EXE")).toBe(false);
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "wps.exe")).toBe(false);
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "ima.copilot.exe")).toBe(false);
	});

	it("黑名单优先于保守路径：进程树查不到也不记录微信", () => {
		expect(shouldTrackBackgroundServer(42, undefined, new Set(), SERVER, "WeChat.exe")).toBe(false);
	});

	it("进程树查不到且不在黑名单 → 保守记录", () => {
		expect(shouldTrackBackgroundServer(42, undefined, new Set([42]), SERVER, "node.exe")).toBe(true);
	});

	it("父链撞上服务器进程 → 记录（AI 直接 bash 拉起的服务）", () => {
		const parents = parentsOf([
			[7001, 7002],
			[7002, SERVER],
		]);
		expect(shouldTrackBackgroundServer(7001, parents, new Set([7001]), SERVER)).toBe(true);
	});

	it("父链撞上本次 diff 的其他新 pid → 记录（中间层如 concurrently/npm 已脱离 bash）", () => {
		const parents = parentsOf([
			[7001, 7005],
			[7005, 9000],
		]);
		expect(shouldTrackBackgroundServer(7001, parents, new Set([7001, 7005]), SERVER)).toBe(true);
	});

	it("断链（父已退出/reparent）→ 保守记录", () => {
		const parents = parentsOf([[8001, 88888]]);
		expect(shouldTrackBackgroundServer(8001, parents, new Set([8001]), SERVER)).toBe(true);
	});

	it("完整父链回溯到系统根未命中 → 跳过（自己开的 Chrome）", () => {
		const parents = parentsOf([
			[5001, 5002],
			[5002, 5003],
			[5003, 0],
			[0, 0],
		]);
		expect(shouldTrackBackgroundServer(5001, parents, new Set([5001]), SERVER)).toBe(false);
	});

	it("完整父链到根且根自引用 → 跳过（POSIX 风格 0 根/演进到 1）", () => {
		const parents = parentsOf([
			[5001, 1],
			[1, 0],
			[0, 0],
		]);
		expect(shouldTrackBackgroundServer(5001, parents, new Set([5001]), SERVER)).toBe(false);
		expect(shouldTrackBackgroundServer(5001, parentsOf([[5001, 1]]), new Set([5001]), SERVER)).toBe(false);
	});

	it("Playwright 拉的 Chrome：父链经 node 到服务器 → 记录", () => {
		const parents = parentsOf([
			[3001, 3002],
			[3002, 3003],
			[3003, SERVER],
		]);
		expect(shouldTrackBackgroundServer(3001, parents, new Set([3001]), SERVER, "chrome.exe")).toBe(true);
	});

	it("微信进程树（WeChatAppEx 等子进程，父链完整且不涉服务器）→ 跳过", () => {
		const parents = parentsOf([
			[6001, 6002],
			[6002, 6003],
			[6003, 0],
			[0, 0],
		]);
		expect(shouldTrackBackgroundServer(6001, parents, new Set([6001]), SERVER, "WeChatAppEx.exe")).toBe(false);
	});

	it("循环链防御：不会死循环，最终完整链 → 跳过", () => {
		const parents = parentsOf([
			[7777, 7778],
			[7778, 7777],
		]);
		expect(shouldTrackBackgroundServer(7777, parents, new Set([7777]), SERVER)).toBe(false);
	});

	it("Issue #651：进程启动时间早于当前 bash 启动时刻 → 直接跳过（排除已有桌面软件/游戏）", () => {
		const now = Date.now();
		const bashStart = now;
		const alreadyRunningCreated = bashStart - 60_000;
		const parents = parentsOf([[29356, 88888]]);
		expect(
			shouldTrackBackgroundServer(29356, parents, new Set([29356]), SERVER, "custom_client.exe", {
				createdMs: alreadyRunningCreated,
				startedBeforeMs: bashStart,
			}),
		).toBe(false);
	});

	it("Issue #651：祖先节点中命中 explorer.exe / services.exe 等系统外壳 → 直接跳过", () => {
		const tree = new Map([
			[12012, { ppid: 12000, name: "game.exe" }],
			[12000, { ppid: 35596, name: "launcher.exe" }],
			[35596, { ppid: 1812, name: "explorer.exe" }],
		]);
		expect(shouldTrackBackgroundServer(12012, tree, new Set([12012]), SERVER, "game.exe")).toBe(false);
	});

	it("Issue #651：断链但在 Program Files 目录下的桌面软件 → 跳过", () => {
		const parents = parentsOf([[12640, 99999]]);
		expect(
			shouldTrackBackgroundServer(12640, parents, new Set([12640]), SERVER, "app.exe", {
				commandLine: '"C:\\Program Files\\SomeApp\\app.exe" --listen 51789',
			}),
		).toBe(false);
	});

	it("断链但为典型开发运行时（node, python 等）→ 保留收录（哪怕安装在 Program Files 或 AppData 下）", () => {
		const parents = parentsOf([[8001, 88888]]);
		expect(
			shouldTrackBackgroundServer(8001, parents, new Set([8001]), SERVER, "node.exe", {
				commandLine: '"C:\\Program Files\\nodejs\\node.exe" server.js',
			}),
		).toBe(true);
		expect(
			shouldTrackBackgroundServer(8001, parents, new Set([8001]), SERVER, "python.exe", {
				commandLine: '"C:\\Users\\c\\AppData\\Local\\Programs\\Python\\Python312\\python.exe" -m http.server 8000',
			}),
		).toBe(true);
		expect(
			shouldTrackBackgroundServer(8001, parents, new Set([8001]), SERVER, "wps.exe", {
				commandLine: '"C:\\Program Files\\Kingsoft\\WPS Office\\wps.exe"',
			}),
		).toBe(false);
	});

	it("断链但命令行包含当前工作区路径 → 保留收录", () => {
		const parents = parentsOf([[9001, 88888]]);
		expect(
			shouldTrackBackgroundServer(9001, parents, new Set([9001]), SERVER, "my_custom_server.exe", {
				commandLine: "E:\\pi-web-ui\\bin\\my_custom_server.exe --port 9000",
				workspaceCwd: "E:\\pi-web-ui",
			}),
		).toBe(true);
	});
});

describe("staleLeftovers（自动清理挑选）", () => {
	const NOW = 1_800_000_000_000;
	const MIN = 60_000;
	const entry = (port: number, idleMin: number, keep?: boolean) => ({
		port,
		pid: 1000 + port,
		since: NOW - idleMin * MIN,
		...(keep ? { keep: true } : {}),
	});

	it("闲置超阈值的才算遗留", () => {
		const picked = staleLeftovers([entry(8788, 45), entry(8789, 5)], { now: NOW, thresholdMs: 30 * MIN });
		expect(picked.map((p) => p.port)).toEqual([8788]);
	});

	it("钉住（keep）的永不参与，哪怕闲置很久", () => {
		const picked = staleLeftovers([entry(8788, 600, true), entry(8789, 600)], { now: NOW, thresholdMs: 30 * MIN });
		expect(picked.map((p) => p.port)).toEqual([8789]);
	});

	it("阈值 ≤ 0（策略关）一律不清", () => {
		expect(staleLeftovers([entry(8788, 600)], { now: NOW, thresholdMs: 0 })).toEqual([]);
		expect(staleLeftovers([entry(8788, 600)], { now: NOW, thresholdMs: -1 })).toEqual([]);
		expect(staleLeftovers([entry(8788, 600)], { now: NOW, thresholdMs: Number.NaN })).toEqual([]);
	});

	it("刚好到阈值算遗留（>=），坏 since 的不动", () => {
		const bad = { port: 8790, pid: 1, since: Number.NaN };
		const picked = staleLeftovers([entry(8788, 30), bad], { now: NOW, thresholdMs: 30 * MIN });
		expect(picked.map((p) => p.port)).toEqual([8788]);
	});

	it("空列表安全", () => {
		expect(staleLeftovers([], { now: NOW, thresholdMs: 30 * MIN })).toEqual([]);
	});
});
