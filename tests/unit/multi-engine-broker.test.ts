import { describe, expect, it, vi } from "vitest";
import { MultiEngineBroker } from "../../server/multi-engine.js";
import type { DispatchSession, EngineService } from "../../server/engine-service.js";
import type { EngineId, ServerMessage } from "../../packages/keel/src/protocol.js";

function makeMockService(engine: EngineId) {
	const sinks = new Map<string, (msg: ServerMessage) => void>();
	const cs = {
		cwd: "/work",
		refreshSessions: vi.fn().mockResolvedValue(undefined),
		pushSessionsForCwd: vi.fn().mockResolvedValue(undefined),
		pushProjects: vi.fn().mockResolvedValue(undefined),
		flushSnapshot: vi.fn(),
		setCwd: vi.fn().mockResolvedValue(undefined),
		removeProject: vi.fn().mockResolvedValue(undefined),
	} as unknown as DispatchSession;

	const service = {
		attach: vi.fn(async (clientId: string, send: (msg: ServerMessage) => void) => {
			sinks.set(clientId, send);
			return cs;
		}),
		detach: vi.fn((clientId: string) => {
			sinks.delete(clientId);
		}),
	} as unknown as EngineService;

	return {
		service,
		cs,
		emit: (clientId: string, msg: ServerMessage) => sinks.get(clientId)?.(msg),
	};
}

describe("MultiEngineBroker", () => {
	it("merges conversations and sessions from all installed engines and routes cross-engine actions", async () => {
		const pi = makeMockService("pi");
		const agy = makeMockService("agy");
		const sent: ServerMessage[] = [];
		const onEngineChanged = vi.fn();

		const broker = new MultiEngineBroker({
			clientId: "c1",
			initialEngine: "pi",
			allEngines: ["pi", "agy"],
			ensureEngine: (engine) => (engine === "agy" ? agy.service : pi.service),
			probeEngine: async (engine) => ({ installed: engine === "pi" || engine === "agy" }),
			send: (msg) => void sent.push(msg),
			sendShared: () => {},
			buildReady: (engine) => ({ type: "ready", clientId: "c1", serverVersion: "1.0.0", engine }) as ServerMessage,
			onEngineChanged,
		});

		await broker.attachInitial();
		await vi.waitFor(() => expect(agy.service.attach).toHaveBeenCalled());

		// 两个引擎各自推送 conversations 与 sessions
		pi.emit("c1", {
			type: "conversations",
			activeId: "pi-1",
			conversations: [
				{ id: "pi-1", title: "Pi Chat", cwd: "/work", messageCount: 2, isStreaming: false, isSubagent: false },
			],
		});
		agy.emit("c1", {
			type: "conversations",
			activeId: "agy-1",
			conversations: [
				{ id: "agy-1", title: "Agy Chat", cwd: "/work", messageCount: 3, isStreaming: false, isSubagent: false },
			],
		});

		const lastConvFrame = sent.filter((m) => m.type === "conversations").at(-1) as Extract<
			ServerMessage,
			{ type: "conversations" }
		>;
		expect(lastConvFrame.activeId).toBe("pi-1");
		expect(lastConvFrame.conversations.map((c) => [c.id, c.engine])).toEqual([
			["pi-1", "pi"],
			["agy-1", "agy"],
		]);

		// 非活动引擎的 notice(info) 不会污染主视图
		const beforeNoticeCount = sent.length;
		agy.emit("c1", { type: "notice", level: "info", text: "background" });
		expect(sent.length).toBe(beforeNoticeCount);

		// 历史会话合并
		pi.emit("c1", {
			type: "sessions",
			cwd: "/work",
			sessions: [{ path: "/work/pi.jsonl", firstMessage: "pi", messageCount: 1, modified: 100 }],
		});
		agy.emit("c1", {
			type: "sessions",
			cwd: "/work",
			sessions: [{ path: "agy-s1", firstMessage: "agy", messageCount: 2, modified: 200 }],
		});
		const lastSessFrame = sent.filter((m) => m.type === "sessions").at(-1) as Extract<
			ServerMessage,
			{ type: "sessions" }
		>;
		expect(lastSessFrame.sessions.map((s) => [s.path, s.engine])).toEqual([
			["agy-s1", "agy"],
			["/work/pi.jsonl", "pi"],
		]);

		// 删除非活动引擎的历史会话：直接路由给 agy，不切换活动引擎
		const delRoute = await broker.routeMessage({ type: "delete_session", path: "agy-s1" });
		expect(delRoute.handled).toBe(false);
		expect(delRoute.targetCs).toBe(agy.cs);
		expect(broker.getActiveEngine()).toBe("pi");

		// 切换到 agy 对话：自动切换活动引擎并推 ready
		const switchRoute = await broker.routeMessage({ type: "switch_conversation", id: "agy-1" });
		expect(switchRoute.handled).toBe(false);
		expect(switchRoute.targetCs).toBe(agy.cs);
		expect(broker.getActiveEngine()).toBe("agy");
		expect(onEngineChanged).toHaveBeenCalledWith("agy");
		expect(sent.some((m) => m.type === "ready" && m.engine === "agy")).toBe(true);

		// 跨引擎项目列表合并（保留各自独有项目并按 lastUsed 排序）
		pi.emit("c1", {
			type: "projects",
			projects: [
				{ path: "/work", lastUsed: 100 },
				{ path: "/pi-only", lastUsed: 300 },
			],
		});
		agy.emit("c1", {
			type: "projects",
			projects: [
				{ path: "/work", lastUsed: 500 },
				{ path: "/agy-only", lastUsed: 400 },
			],
		});
		const lastProjectsFrame = sent.filter((m) => m.type === "projects").at(-1) as Extract<
			ServerMessage,
			{ type: "projects" }
		>;
		expect(lastProjectsFrame.projects).toEqual([
			{ path: "/work", lastUsed: 500 },
			{ path: "/agy-only", lastUsed: 400 },
			{ path: "/pi-only", lastUsed: 300 },
		]);

		// 指定 pi 新建对话：自动切回 pi
		const newRoute = await broker.routeMessage({ type: "new_chat", engine: "pi" });
		expect(newRoute.handled).toBe(false);
		expect(newRoute.targetCs).toBe(pi.cs);
		expect(broker.getActiveEngine()).toBe("pi");

		broker.dispose();
	});

	it("yields a macrotask, bounds background engine mount concurrency to 2, and awaits bgMountPromise on list_sessions", async () => {
		const services: Record<EngineId, ReturnType<typeof makeMockService>> = {
			pi: makeMockService("pi"),
			dsh: makeMockService("dsh"),
			claude: makeMockService("claude"),
			codex: makeMockService("codex"),
			agy: makeMockService("agy"),
			durable: makeMockService("durable"),
		};

		let inFlightProbes = 0;
		let maxConcurrentProbes = 0;
		const probeResolvers = new Map<EngineId, () => void>();
		const probeOrder: EngineId[] = [];

		const broker = new MultiEngineBroker({
			clientId: "c1",
			initialEngine: "pi",
			allEngines: ["pi", "dsh", "claude", "codex", "agy"],
			ensureEngine: (engine) => services[engine].service,
			probeEngine: (engine) => {
				probeOrder.push(engine);
				inFlightProbes++;
				maxConcurrentProbes = Math.max(maxConcurrentProbes, inFlightProbes);
				return new Promise<{ installed: boolean }>((resolve) => {
					probeResolvers.set(engine, () => {
						inFlightProbes--;
						resolve({ installed: true });
					});
				});
			},
			send: () => {},
			sendShared: () => {},
			buildReady: (engine) => ({ type: "ready", clientId: "c1", serverVersion: "1.0.0", engine }) as ServerMessage,
			onEngineChanged: () => {},
		});

		await broker.attachInitial();
		// 宏任务让步：attachInitial 返回时后台 probe 尚未立即启动
		expect(probeOrder).toEqual([]);

		// 让出宏任务后，第一批最多 2 个后台引擎开始 probe
		await vi.waitFor(() => expect(probeOrder).toEqual(["dsh", "claude"]));
		expect(maxConcurrentProbes).toBe(2);
		expect(services.codex.service.attach).not.toHaveBeenCalled();

		// 发起 list_sessions，它会等待 bgMountPromise 完成
		const listPromise = broker.routeMessage({ type: "list_sessions", path: "/work" });
		let listSettled = false;
		void listPromise.then(() => {
			listSettled = true;
		});

		// 放行第一批
		probeResolvers.get("dsh")?.();
		probeResolvers.get("claude")?.();
		await vi.waitFor(() => expect(probeOrder).toEqual(["dsh", "claude", "codex", "agy"]));
		expect(maxConcurrentProbes).toBe(2);
		expect(listSettled).toBe(false);

		// 放行第二批，list_sessions 随后完成
		probeResolvers.get("codex")?.();
		probeResolvers.get("agy")?.();
		const res = await listPromise;
		expect(res).toEqual({ handled: true });
		expect(services.dsh.service.attach).toHaveBeenCalledTimes(1);
		expect(services.claude.service.attach).toHaveBeenCalledTimes(1);
		expect(services.codex.service.attach).toHaveBeenCalledTimes(1);
		expect(services.agy.service.attach).toHaveBeenCalledTimes(1);

		broker.dispose();
	});

	it("deduplicates pushSessionsForCwd across activeCwd, cs.cwd, and requestedProjectPaths", async () => {
		const pi = makeMockService("pi");
		const agy = makeMockService("agy");
		(pi.cs as { cwd: string }).cwd = "/Active/Dir/";
		(agy.cs as { cwd: string }).cwd = "/agy-default";

		let releaseProbe!: () => void;
		const broker = new MultiEngineBroker({
			clientId: "c1",
			initialEngine: "pi",
			allEngines: ["pi", "agy"],
			ensureEngine: (engine) => (engine === "agy" ? agy.service : pi.service),
			probeEngine: () =>
				new Promise<{ installed: boolean }>((resolve) => {
					releaseProbe = () => resolve({ installed: true });
				}),
			send: () => {},
			sendShared: () => {},
			buildReady: (engine) => ({ type: "ready", clientId: "c1", serverVersion: "1.0.0", engine }) as ServerMessage,
			onEngineChanged: () => {},
		});

		await broker.attachInitial();
		await vi.waitFor(() => expect(releaseProbe).toBeDefined());

		// 在后台引擎挂载完成前，写入多条等价/重复路径到 requestedProjectPaths
		const list1 = broker.routeMessage({ type: "list_sessions", path: "/active/dir" });
		const list2 = broker.routeMessage({ type: "list_sessions", path: "/AGY-DEFAULT/" });
		const list3 = broker.routeMessage({ type: "list_sessions", path: "/Project-X/" });
		const list4 = broker.routeMessage({ type: "list_sessions", path: "/project-x" });

		releaseProbe();
		await Promise.all([list1, list2, list3, list4]);

		// mountBackgroundEngines 阶段：
		// - activeCwd ("/Active/Dir/") 触发 1 次
		// - "/active/dir" 与 activeCwd 归一化重复，跳过
		// - "/AGY-DEFAULT/" 与 agy.cs.cwd ("/agy-default") 归一化重复，跳过
		// - "/Project-X/" 触发 1 次，"/project-x" 与之归一化重复，跳过
		// 之后 4 个 list_sessions 各自按其 msg.path !== agy.cs.cwd 逻辑再调（除了 list2 匹配 agy.cs.cwd）
		const calls = (agy.cs.pushSessionsForCwd as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		// 前两次来自 mountBackgroundEngines，且严格为去重后的 "/Active/Dir/" 和 "/Project-X/"
		expect(calls.slice(0, 2)).toEqual(["/Active/Dir/", "/Project-X/"]);

		broker.dispose();
	});

	it("switches instantly to already-attached dsh engine without re-probing and routes dsh conversations", async () => {
		const pi = makeMockService("pi");
		const dsh = makeMockService("dsh");
		const probeEngine = vi.fn(async () => ({ installed: true }));

		const broker = new MultiEngineBroker({
			clientId: "c1",
			initialEngine: "pi",
			allEngines: ["pi", "dsh"],
			ensureEngine: (engine) => (engine === "dsh" ? dsh.service : pi.service),
			probeEngine,
			send: () => {},
			sendShared: () => {},
			buildReady: (engine) => ({ type: "ready", clientId: "c1", serverVersion: "1.0.0", engine }) as ServerMessage,
			onEngineChanged: () => {},
		});

		await broker.attachInitial();
		await vi.waitFor(() => expect(dsh.service.attach).toHaveBeenCalled());
		const probeCallsAfterMount = probeEngine.mock.calls.length;

		// 已挂载的引擎切过去不再调用 probeEngine
		const cs = await broker.switchActiveEngine("dsh");
		expect(cs).toBe(dsh.cs);
		expect(broker.getActiveEngine()).toBe("dsh");
		expect(probeEngine.mock.calls.length).toBe(probeCallsAfterMount);

		// 切回 pi，再通过带 engine:"dsh" 的 switch_conversation 切回 dsh
		await broker.switchActiveEngine("pi");
		expect(broker.getActiveEngine()).toBe("pi");
		const routed = await broker.routeMessage({ type: "switch_conversation", id: "dsh-conv-1", engine: "dsh" });
		expect(routed.handled).toBe(false);
		expect(routed.targetCs).toBe(dsh.cs);
		expect(broker.getActiveEngine()).toBe("dsh");

		// 在非 pi 引擎（如 dsh）下发起 new_cli_chat，直接打开 CLI 而不切换当前引擎
		const cliRouted = await broker.routeMessage({
			type: "new_cli_chat",
			config: { preset: "dsh" },
			cwd: "/work",
		});
		expect(cliRouted.handled).toBe(false);
		expect(cliRouted.targetCs).toBe(pi.cs);
		expect(broker.getActiveEngine()).toBe("dsh");
		expect(broker.getActiveSession()).toBe(pi.cs);

		// 切回 dsh 普通对话后，activeSession 恢复为 dsh.cs
		const backToDsh = await broker.routeMessage({ type: "switch_conversation", id: "dsh-conv-1", engine: "dsh" });
		expect(backToDsh.targetCs).toBe(dsh.cs);
		expect(broker.getActiveEngine()).toBe("dsh");
		expect(broker.getActiveSession()).toBe(dsh.cs);

		broker.dispose();
	});

	it("routes set_cwd only to the active engine without broadcasting to background engines", async () => {
		const pi = makeMockService("pi");
		const claude = makeMockService("claude");
		const broker = new MultiEngineBroker({
			clientId: "c1",
			initialEngine: "pi",
			allEngines: ["pi", "claude"],
			ensureEngine: (engine) => (engine === "claude" ? claude.service : pi.service),
			probeEngine: async () => ({ installed: true }),
			send: () => {},
			sendShared: () => {},
			buildReady: (engine) => ({ type: "ready", clientId: "c1", serverVersion: "1.0.0", engine }) as ServerMessage,
			onEngineChanged: () => {},
		});

		await broker.attachInitial();
		await vi.waitFor(() => expect(claude.service.attach).toHaveBeenCalled());

		const routed = await broker.routeMessage({ type: "set_cwd", path: "/new-project" });
		expect(routed.handled).toBe(false);
		expect(routed.targetCs).toBe(pi.cs);
		expect(claude.cs.setCwd).not.toHaveBeenCalled();

		broker.dispose();
	});
});
