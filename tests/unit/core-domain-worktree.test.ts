import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { WorkspacePort } from "../../packages/keel/src/contracts/files.js";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import type { WorktreePort } from "../../packages/keel/src/contracts/worktree.js";
import { createWorktreeHandlers, type WorktreeHandlers } from "../../packages/keel/src/domains/worktree/handlers.js";
import type { ServerMessage, WorktreeInfo } from "../../packages/keel/src/protocol.js";

type Call = [name: string, ...args: unknown[]];

/** 绝对路径一律用 `resolve` 拼：断言两边同口径，Windows 与 CI 都不会跑偏。 */
const CWD = resolve("/work/repo");
const MAIN = CWD;
const LINKED = resolve(CWD, "wt-feature");

function info(currentPath: string): WorktreeInfo {
	return {
		isLinkedWorktree: currentPath !== MAIN,
		currentPath,
		mainPath: MAIN,
		linkedWorktrees: [{ path: LINKED, branch: "feature" }],
	};
}

/**
 * 三个假端口共用一个 `calls` 账本：handler 里「先回退 cwd → 再删 → 再刷新」的顺序才能逐条断言。
 * `lang` 记的是**调用结果**（不是函数引用），既证明 thunk 递进去了，也不让断言里出现函数。
 */
function fakes(
	context: WorktreeInfo | null = null,
	overrides: Partial<WorktreePort> = {},
): {
	worktree: WorktreePort;
	workspace: WorkspacePort;
	transport: TransportPort;
	calls: Call[];
	sent: ServerMessage[];
} {
	const calls: Call[] = [];
	const sent: ServerMessage[] = [];
	return {
		calls,
		sent,
		worktree: {
			getWorktreeContext: async (cwd: string) => {
				calls.push(["getWorktreeContext", cwd]);
				return context;
			},
			removeWorktree: async (
				cwd: string,
				targetPathInput: string,
				force?: boolean,
				lang?: () => string,
			): Promise<void> => {
				calls.push(["removeWorktree", cwd, targetPathInput, force, lang ? lang() : undefined]);
			},
			// 真实现会把反斜杠换成正斜杠；这里原样返回：测试只关心「归一走的是端口」，不关心平台细节。
			normalizeWirePath: (p: string) => {
				calls.push(["normalizeWirePath", p]);
				return p;
			},
			...overrides,
		},
		workspace: {
			setCwd: async (path: string) => void calls.push(["setCwd", path]),
			setWorkspaceRoots: async (roots?: string[]) => void calls.push(["setWorkspaceRoots", roots]),
		},
		transport: {
			send: (msg: ServerMessage) => void sent.push(msg),
			isClosed: () => false,
		},
	};
}

describe("工作树 handler（B3·T2）· 3 个成员按位转发", () => {
	it("refreshWorktreeInfo → getWorktreeContext(cwd)，结果交给 publish", async () => {
		const f = fakes(info(LINKED));
		const published: (WorktreeInfo | null)[] = [];
		await createWorktreeHandlers({
			worktree: () => f.worktree,
			workspace: () => f.workspace,
			cwd: CWD,
			transport: f.transport,
			currentInfo: () => null,
			publish: (next) => void published.push(next),
		}).refreshWorktreeInfo();
		expect(f.calls).toEqual([["getWorktreeContext", CWD]]);
		expect(published).toEqual([info(LINKED)]);
		expect(f.sent).toEqual([]);
	});

	it("refreshWorktreeInfo 读到 null 也照样发布（不在 git 里 = 要清掉旧信息）", async () => {
		const f = fakes(null);
		const published: (WorktreeInfo | null)[] = [];
		await createWorktreeHandlers({
			worktree: () => f.worktree,
			cwd: CWD,
			transport: f.transport,
			publish: (next) => void published.push(next),
		}).refreshWorktreeInfo();
		expect(published).toEqual([null]);
	});

	it("switchWorktree → 只调工作区 setCwd（老实现逐字就是 setCwd，不自己刷工作树信息）", async () => {
		const f = fakes(info(LINKED));
		const published: (WorktreeInfo | null)[] = [];
		await createWorktreeHandlers({
			worktree: () => f.worktree,
			workspace: () => f.workspace,
			cwd: CWD,
			transport: f.transport,
			publish: (next) => void published.push(next),
		}).switchWorktree(LINKED);
		expect(f.calls).toEqual([["setCwd", LINKED]]);
		expect(published).toEqual([]);
		expect(f.sent).toEqual([]);
	});

	it("removeWorktree → 先按 cwd 归一目标，再原样带 force 删，删完刷新并报一帧 info", async () => {
		const f = fakes(null);
		await createWorktreeHandlers({
			worktree: () => f.worktree,
			workspace: () => f.workspace,
			cwd: CWD,
			transport: f.transport,
			currentInfo: () => null,
			getLang: () => "zh",
		}).removeWorktree("wt-feature", true);
		expect(f.calls).toEqual([
			["normalizeWirePath", LINKED],
			["removeWorktree", CWD, LINKED, true, "zh"],
			["getWorktreeContext", CWD],
		]);
		expect(f.sent).toEqual([
			{
				type: "notice",
				level: "info",
				text: `🗑️ 已移除 Git 工作树：${LINKED}`,
				textEn: `🗑️ Removed Git worktree: ${LINKED}`,
			},
		]);
	});

	it("removeWorktree 的 force 不打折：缺省 undefined 原样进端口（由端口兜 false）", async () => {
		const f = fakes(null);
		await createWorktreeHandlers({
			worktree: () => f.worktree,
			cwd: CWD,
			transport: f.transport,
			getLang: () => "en",
		}).removeWorktree("wt-feature");
		expect(f.calls).toEqual([
			["normalizeWirePath", LINKED],
			["removeWorktree", CWD, LINKED, undefined, "en"],
			["getWorktreeContext", CWD],
		]);
	});

	it("删的是当前工作树 → 先回退到主仓库，再删（顺序不能反）", async () => {
		const f = fakes(null);
		await createWorktreeHandlers({
			worktree: () => f.worktree,
			workspace: () => f.workspace,
			cwd: LINKED,
			transport: f.transport,
			currentInfo: () => info(LINKED),
			// cwd 就在这条工作树里时，前端给的是它的绝对路径（相对路径此时会解析成它的子目录）。
		}).removeWorktree(LINKED, true);
		expect(f.calls).toEqual([
			["normalizeWirePath", LINKED],
			["setCwd", MAIN],
			["removeWorktree", LINKED, LINKED, true, "zh"],
			["getWorktreeContext", LINKED],
		]);
	});

	it("删的不是当前工作树 → 不碰工作区端口（缺了也不该挡掉删除）", async () => {
		const f = fakes(null);
		await createWorktreeHandlers({
			worktree: () => f.worktree,
			cwd: MAIN,
			transport: f.transport,
			currentInfo: () => info(MAIN),
		}).removeWorktree("wt-feature", true);
		expect(f.calls.filter(([name]) => name === "setCwd")).toEqual([]);
		expect(f.calls.map(([name]) => name)).toEqual(["normalizeWirePath", "removeWorktree", "getWorktreeContext"]);
	});

	it("端口缺省 → 3 个成员都同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const invokes: [keyof WorktreeHandlers, (h: WorktreeHandlers) => Promise<void>][] = [
			["refreshWorktreeInfo", (h) => h.refreshWorktreeInfo()],
			["switchWorktree", (h) => h.switchWorktree("wt-feature")],
			["removeWorktree", (h) => h.removeWorktree("wt-feature", true)],
		];
		const f = fakes(null);
		const handlers = createWorktreeHandlers({ cwd: CWD, transport: f.transport });
		const silent: string[] = [];
		for (const [member, invoke] of invokes) {
			try {
				void invoke(handlers);
				silent.push(`${member}（没抛）`);
			} catch (err) {
				if (!(err instanceof CoreEngineNotReadyError)) silent.push(`${member}（抛错类型不对）`);
			}
		}
		expect(silent).toEqual([]);
		// 抛在端口解析上：既没读 cwd，也没提前发半截帧。
		expect(f.calls).toEqual([]);
		expect(f.sent).toEqual([]);
	});

	it("端口报错不吞：先发 error notice，再原样冒泡（删工作树不可逆）", async () => {
		const boom = new Error("fatal: not a working tree");
		const f = fakes(null, { removeWorktree: () => Promise.reject(boom) });
		const handlers = createWorktreeHandlers({
			worktree: () => f.worktree,
			workspace: () => f.workspace,
			cwd: CWD,
			transport: f.transport,
			currentInfo: () => null,
		});
		await expect(handlers.removeWorktree("wt-feature", true)).rejects.toBe(boom);
		expect(f.sent).toEqual([
			{
				type: "notice",
				level: "error",
				text: "移除工作树失败：fatal: not a working tree",
				textEn: "Failed to remove worktree: fatal: not a working tree",
			},
		]);
		// 删失败就不该报「已移除」，也不该刷新出半截状态（假体的 override 不记账，只剩归一那一步）。
		expect(f.calls.map(([name]) => name)).toEqual(["normalizeWirePath"]);
	});

	it("取信息期间 cwd 变了 → 丢弃这次结果（不把旧目录的工作树盖到新目录上）", async () => {
		const f = fakes(info(LINKED));
		const published: (WorktreeInfo | null)[] = [];
		let live = CWD;
		const pending = createWorktreeHandlers({
			worktree: () => f.worktree,
			cwd: () => live,
			transport: f.transport,
			publish: (next) => void published.push(next),
		}).refreshWorktreeInfo();
		live = resolve("/work/other");
		await pending;
		expect(f.calls).toEqual([["getWorktreeContext", CWD]]);
		expect(published).toEqual([]);
	});
});
