import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";

/**
 * 中断记账（老实现 `AgentService.recordInterruptedRuns()`）：
 * 关停时把「此刻还在跑」的对话写进 `client-state.json` 的 `interrupted`，重启后的续跑链路
 * （`resumeInterrupted` → `listInterrupted`）就能把这份列表读回来。
 *
 * 这里用**真** `ClientStateStore`（同一个文件、同一套归一化与墓碑规则）跑写入 + 读回，
 * 只有 SDK 会话是假的：记账读的就是内核自己的对话相位，不该为了测它去开一个真模型会话。
 */
const openTurnSession = vi.fn();

vi.mock("../../packages/keel/src/adapters/sdk/index.js", () => ({
	openTurnSession: (...args: unknown[]) => openTurnSession(...args),
}));

const { CoreEngine } = await import("../../packages/keel/src/app/core-engine.js");
type Engine = InstanceType<typeof CoreEngine>;

const waitTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSession(sessionFile: string) {
	let resolveTurn: (() => void) | undefined;
	const session = {
		isStreaming: true,
		sessionFile,
		messages: [] as unknown[],
		model: { provider: "anthropic", id: "claude" },
		thinkingLevel: "high",
		// 喂轮挂住 = 这一轮一直在跑（记账要收的正是这种对话）。
		sendUserMessage: () => new Promise<void>((resolve) => (resolveTurn = resolve)),
		subscribe: () => () => {},
		dispose: () => {},
	};
	return {
		opened: { session, sessionId: "s1", sessionFile, dispose: () => {} },
		finish: () => resolveTurn?.(),
	};
}

let root: string;
let engines: Engine[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-core-interrupted-"));
	openTurnSession.mockReset();
});

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.disposeAll();
	rmSync(root, { recursive: true, force: true });
});

describe("core/app · 中断记账", () => {
	it("关停时把还在跑的对话写进中断列表，续跑链路能读回", async () => {
		const statePath = join(root, "client-state.json");
		const store = new ClientStateStore(statePath);
		const engine = new CoreEngine(root, {
			version: "test",
			attach: true,
			agentDir: join(root, "agent"),
			stateStore: store,
		});
		engines.push(engine);
		const file = join(root, "agent", "sessions", "s1.jsonl");
		const session = fakeSession(file);
		openTurnSession.mockImplementation(async () => session.opened);

		const cs = await engine.attach("c1", () => {});
		void cs.prompt("hello");
		await waitTick();
		await waitTick();

		engine.recordInterruptedRuns();

		// 读回：`listInterrupted` 就是重启后 `resumeInterrupted` 的源（成功续跑才 ack 而删）。
		const readBack = store.listInterrupted("c1");
		expect(readBack).toHaveLength(1);
		expect(readBack[0]).toMatchObject({ cwd: root, sessionFile: file });
		expect(readBack[0].title.length).toBeGreaterThan(0);
		expect(typeof readBack[0].at).toBe("number");
		// 真的落盘了（不是只留在内存里）：另开一个 store 读同一个文件。
		expect(new ClientStateStore(statePath).listInterrupted("c1")).toEqual(readBack);

		session.finish();
	});

	it("已收尾的对话不记账（列表里只该有在跑的）", async () => {
		const store = new ClientStateStore(join(root, "client-state.json"));
		const engine = new CoreEngine(root, {
			version: "test",
			attach: true,
			agentDir: join(root, "agent"),
			stateStore: store,
		});
		engines.push(engine);
		const session = fakeSession(join(root, "agent", "sessions", "s1.jsonl"));
		openTurnSession.mockImplementation(async () => session.opened);

		const cs = await engine.attach("c1", () => {});
		void cs.prompt("hello");
		await waitTick();
		await waitTick();

		// 这一轮收尾 → 相位回 idle → 不该被当成「中断」的。
		session.finish();
		await waitTick();
		engine.recordInterruptedRuns();

		expect(store.listInterrupted("c1")).toEqual([]);
	});

	it("disposeAll 先记账再拆（关停顺序错了就永远记不上）", async () => {
		const store = new ClientStateStore(join(root, "client-state.json"));
		const engine = new CoreEngine(root, {
			version: "test",
			attach: true,
			agentDir: join(root, "agent"),
			stateStore: store,
		});
		const session = fakeSession(join(root, "agent", "sessions", "s1.jsonl"));
		openTurnSession.mockImplementation(async () => session.opened);
		const cs = await engine.attach("c1", () => {});
		void cs.prompt("hello");
		await waitTick();
		await waitTick();

		await engine.disposeAll();

		expect(store.listInterrupted("c1")).toHaveLength(1);
		session.finish();
	});

	it("存储没有记账口：静默跳过，不把停机流程拖垮", async () => {
		const engine = new CoreEngine(root, {
			version: "test",
			attach: true,
			agentDir: join(root, "agent"),
			// 一份不实现 `saveInterrupted` 的存储（可选端口：没实现 = 不记账）。
			stateStore: {
				dataDir: root,
				getSettings: () => ({}) as never,
				getSettingsSnapshot: () => ({}) as never,
				getSettingsVersion: () => 0,
				saveSettings: () => ({}) as never,
				subscribeSettings: () => () => {},
				get: () => ({ projects: [] }),
				saveLocale: () => {},
				getGoalPrefs: () => undefined,
				saveGoalPrefs: () => {},
				mergeDiscoveredProjects: () => {},
				getRecentProjects: async () => [],
				getRemovedProjects: () => [],
				removeProject: () => {},
				getProjectModel: () => undefined,
				saveProjectModel: () => {},
				getProjectProviderKey: () => undefined,
				saveProjectProviderKey: () => {},
				deleteProjectProviderKey: () => {},
				getWorkspaceRoots: () => [],
				saveWorkspaceRoots: () => {},
				setSessionPinned: () => {},
				isSessionPinned: () => false,
				getDefaultModel: () => undefined,
				saveDefaultModel: () => {},
				getDefaultProviderKey: () => undefined,
				saveDefaultProviderKey: () => {},
			},
		});
		engines.push(engine);
		engine.pluginToolsProvider = () => [];
		expect(() => engine.recordInterruptedRuns()).not.toThrow();
	});
});
