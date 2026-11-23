import { describe, expect, it } from "vitest";
import type { BackgroundPort } from "../../packages/keel/src/contracts/background.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import {
	createBackgroundHandlers,
	type BackgroundHandlers,
} from "../../packages/keel/src/domains/background/handlers.js";

type Call = [name: string, ...args: unknown[]];

function fakeBackground(overrides: Partial<BackgroundPort> = {}): { port: BackgroundPort; calls: Call[] } {
	const calls: Call[] = [];
	const port: BackgroundPort = {
		listBgServers: async () => {
			calls.push(["listBgServers"]);
		},
		killBackgroundServer: async (p: number | undefined, taskId?: string) => {
			calls.push(["killBackgroundServer", p, taskId]);
			return true;
		},
		killAllBackgroundServers: async () => {
			calls.push(["killAllBackgroundServers"]);
			return ["3000", "job:j1"];
		},
		startBgScript: (script: string, cwd?: string) => {
			calls.push(["startBgScript", script, cwd]);
		},
		restartBgJob: (taskId: string) => {
			calls.push(["restartBgJob", taskId]);
		},
		setBackgroundKeep: (p: number, keep: boolean) => {
			calls.push(["setBackgroundKeep", p, keep]);
			return keep;
		},
		cleanBackgroundLeftovers: async (minutesOverride?: number) => {
			calls.push(["cleanBackgroundLeftovers", minutesOverride]);
			return [3000];
		},
		abortBash: async (conversationId?: string) => {
			calls.push(["abortBash", conversationId]);
		},
		...overrides,
	};
	return { port, calls };
}

const cases: [string, (h: BackgroundHandlers) => unknown, Call][] = [
	["listBgServers", (h) => h.listBgServers(), ["listBgServers"]],
	// 三支都盖：只有端口 / job: 行的 taskId / 插件任务的 taskId —— 判别在宿主，内核按位转交不许改动。
	["killBackgroundServer(port)", (h) => h.killBackgroundServer(3000), ["killBackgroundServer", 3000, undefined]],
	[
		"killBackgroundServer(taskId=job:)",
		(h) => h.killBackgroundServer(undefined, "job:j1"),
		["killBackgroundServer", undefined, "job:j1"],
	],
	[
		"killBackgroundServer(taskId=plugin)",
		(h) => h.killBackgroundServer(undefined, "plugin-task"),
		["killBackgroundServer", undefined, "plugin-task"],
	],
	["killAllBackgroundServers", (h) => h.killAllBackgroundServers(), ["killAllBackgroundServers"]],
	["startBgScript(script,cwd)", (h) => h.startBgScript("dev", "/work"), ["startBgScript", "dev", "/work"]],
	["startBgScript(script)", (h) => h.startBgScript("dev"), ["startBgScript", "dev", undefined]],
	["restartBgJob", (h) => h.restartBgJob("job:j1"), ["restartBgJob", "job:j1"]],
	["setBackgroundKeep(keep=true)", (h) => h.setBackgroundKeep(3000, true), ["setBackgroundKeep", 3000, true]],
	["setBackgroundKeep(keep=false)", (h) => h.setBackgroundKeep(3000, false), ["setBackgroundKeep", 3000, false]],
	["cleanBackgroundLeftovers(minutes)", (h) => h.cleanBackgroundLeftovers(15), ["cleanBackgroundLeftovers", 15]],
	["cleanBackgroundLeftovers()", (h) => h.cleanBackgroundLeftovers(), ["cleanBackgroundLeftovers", undefined]],
	["abortBash(conversationId)", (h) => h.abortBash("c-7"), ["abortBash", "c-7"]],
	["abortBash()", (h) => h.abortBash(), ["abortBash", undefined]],
];

describe("后台任务 handler（B5）· 8 个按位转发", () => {
	for (const [member, invoke, expected] of cases) {
		it(`${member} → ${expected[0]}(${expected.slice(1).length} 参逐字)`, async () => {
			const { port, calls } = fakeBackground();
			await invoke(createBackgroundHandlers({ background: () => port }));
			expect(calls).toEqual([expected]);
		});
	}

	it("返回值原样透出：是否真停了 / 停掉的行 / 是否改到 keep / 清掉的端口", async () => {
		const { port } = fakeBackground();
		const handlers = createBackgroundHandlers({ background: () => port });
		await expect(handlers.killBackgroundServer(3000)).resolves.toBe(true);
		await expect(handlers.killAllBackgroundServers()).resolves.toEqual(["3000", "job:j1"]);
		expect(handlers.setBackgroundKeep(3000, false)).toBe(false);
		await expect(handlers.cleanBackgroundLeftovers()).resolves.toEqual([3000]);
	});

	it("端口缺省时 8 个成员都同步抛 CoreEngineNotReadyError（register 表口径：不能变 rejected promise）", () => {
		const handlers = createBackgroundHandlers({});
		const silent: string[] = [];
		for (const [member, invoke] of cases) {
			try {
				invoke(handlers);
				silent.push(`${member}（没抛）`);
			} catch (err) {
				if (!(err instanceof CoreEngineNotReadyError)) silent.push(`${member}（抛错类型不对）`);
			}
		}
		expect(silent).toEqual([]);
	});

	it("abortBash 没有活跃命令的分支归宿主：内核照样转交、自己不补 notice、不抛", async () => {
		// 老实现这一支是「info notice（当前没有正在运行的 bash 命令）+ flush 快照」——
		// per-对话 kill 句柄集合在宿主，内核看不见，所以宿主的 abortBash 直接 resolve 就代表「没有活跃命令」。
		const { port, calls } = fakeBackground({
			abortBash: async (conversationId?: string) => void calls.push(["abortBash", conversationId]),
		});
		const handlers = createBackgroundHandlers({ background: () => port });
		await expect(handlers.abortBash("c-empty")).resolves.toBeUndefined();
		expect(calls).toEqual([["abortBash", "c-empty"]]);
	});

	it("宿主 reject 不吞：错原样冒泡（停不掉的端口行由宿主发 notice，内核不假装成功）", async () => {
		const { port } = fakeBackground({
			startBgScript: () => {
				throw new Error("spawn failed");
			},
			cleanBackgroundLeftovers: () => Promise.reject(new Error("cleanup failed")),
		});
		const handlers = createBackgroundHandlers({ background: () => port });
		expect(() => handlers.startBgScript("dev")).toThrow("spawn failed");
		await expect(handlers.cleanBackgroundLeftovers(5)).rejects.toThrow("cleanup failed");
	});
});
