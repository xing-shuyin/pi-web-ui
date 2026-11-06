import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDefaultCanvasGraph,
	listCanvasGraphs,
	loadCanvasGraph,
	saveCanvasGraph,
	deleteCanvasGraph,
} from "../../server/canvas/canvas-store.js";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";
import { makeCanvasTool } from "../../server/canvas/canvas-agent-tool.js";
import type { ServerMessage, CanvasNode, CanvasNodeRole, CanvasEdge, UiMessage } from "../../server/protocol.js";

function mkTestNode(id: string, role: CanvasNodeRole, extra?: Partial<CanvasNode>): CanvasNode {
	return {
		id,
		title: id,
		role,
		x: 0,
		y: 0,
		width: 300,
		engine: "pi",
		model: "test/model",
		cwd: ".",
		useWorktree: false,
		status: "idle",
		...extra,
	};
}

describe("Canvas Store & Default Squad", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-canvas-test-"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("默认战队是无需隔离的四节点 Pi 串行流水线", () => {
		const def = createDefaultCanvasGraph();
		expect(def.nodes).toHaveLength(4);
		expect(def.edges).toHaveLength(3);
		expect(def.nodes.map((n) => n.engine)).toEqual(["pi", "pi", "pi", "pi"]);
		expect(def.nodes.map((n) => n.role)).toEqual(["trigger", "coder", "tester", "human"]);
		expect(def.nodes.every((n) => n.useWorktree === false)).toBe(true);
		expect(def.nodes.every((n) => n.cwd === ".")).toBe(true);
		expect(def.edges.map((e) => [e.sourceNodeId, e.targetNodeId])).toEqual(
			def.nodes.slice(1).map((n, i) => [def.nodes[i].id, n.id]),
		);
		expect(def.edges.every((e) => e.type === "handoff")).toBe(true);
	});
	it("支持画布保存、读取、列表与删除", () => {
		const def = createDefaultCanvasGraph("test_graph");
		saveCanvasGraph(tempDir, def);

		const loaded = loadCanvasGraph(tempDir, "test_graph");
		expect(loaded.id).toBe("test_graph");
		expect(loaded.nodes.length).toBe(4);

		const list = listCanvasGraphs(tempDir);
		expect(list.some((g) => g.id === "test_graph")).toBe(true);

		const deleted = deleteCanvasGraph(tempDir, "test_graph");
		expect(deleted).toBe(true);

		const listAfter = listCanvasGraphs(tempDir);
		expect(listAfter.some((g) => g.id === "test_graph")).toBe(false);
	});
});

function makeOrchestratorGraph(id: string) {
	const graph = createDefaultCanvasGraph(id);
	graph.nodes = [
		mkTestNode("node_architect", "architect"),
		mkTestNode("node_fe", "coder"),
		mkTestNode("node_be", "coder"),
		mkTestNode("node_qa", "tester"),
	];
	graph.edges = [];
	return graph;
}

describe("Canvas Orchestrator", () => {
	let tempDir: string;
	let orchestrator: CanvasOrchestrator;
	const events: ServerMessage[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-canvas-orch-"));
		orchestrator = new CanvasOrchestrator(tempDir, tempDir);
		events.length = 0;
		orchestrator.setBroadcaster((msg) => events.push(msg));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("支持单节点启动与完成事件通知", async () => {
		const graph = makeOrchestratorGraph("orch_test");
		graph.executionMode = "simulate";
		saveCanvasGraph(tempDir, graph);

		const feNode = graph.nodes.find((n) => n.id === "node_fe")!;
		feNode.useWorktree = false;

		await orchestrator.runNode(graph, "node_fe");

		expect(feNode.status).toBe("done");
		expect(events.some((e) => e.type === "canvas_node_event" && e.event === "started")).toBe(true);
		expect(events.some((e) => e.type === "canvas_node_event" && e.event === "done")).toBe(true);
	});

	it("支持运行中实时插话干预 (Steer)", () => {
		const graph = makeOrchestratorGraph("steer_test");
		saveCanvasGraph(tempDir, graph);

		orchestrator.steerNode(graph.id, "node_architect", "注意必须支持移动端触控");

		const updated = loadCanvasGraph(tempDir, graph.id);
		const arch = updated.nodes.find((n) => n.id === "node_architect");
		expect(arch?.currentAction).toContain("收到人工插话指导");
		expect(arch?.currentAction).toContain("必须支持移动端触控");
	});

	it("普通完成不触发审查回路", async () => {
		const graph = makeOrchestratorGraph("review_test");
		graph.executionMode = "simulate";
		graph.nodes = [mkTestNode("review", "reviewer"), mkTestNode("work", "end")];
		graph.edges = [
			{
				id: "back",
				sourceNodeId: "review",
				targetNodeId: "work",
				type: "review",
				currentLoopCount: 3,
				maxLoopRetries: 3,
			},
		];
		saveCanvasGraph(tempDir, graph);
		await orchestrator.runNode(graph, "review");
		expect(graph.nodes[0].status).toBe("done");
		expect(graph.edges[0].active).toBe(false);
		expect(graph.edges[0].currentLoopCount).toBe(0);
	});

	it("拒绝非等待中的节点审查", () => {
		const graph = makeOrchestratorGraph("review_gate_test");
		saveCanvasGraph(tempDir, graph);
		expect(orchestrator.reviewNode(graph.id, "node_fe", "approve")).toBeNull();
		expect(orchestrator.reviewNode(graph.id, "node_missing", "reject")).toBeNull();
		expect(orchestrator.reviewNode("../evil", "node_fe", "approve")).toBeNull();
	});

	it("引擎真实报错不得标记为已完成（403 RegionError 曾被当成功）", async () => {
		const graph = makeOrchestratorGraph("engine_error_test");
		graph.executionMode = "real";
		const node = graph.nodes.find((n) => n.id === "node_fe")!;
		node.useWorktree = false;
		node.cwd = ".";
		saveCanvasGraph(tempDir, graph);

		const messages: UiMessage[] = [];
		const fakeEngine = {
			attach: async () => ({
				cwd: tempDir,
				setCwd: async () => {},
				abort: async () => {},
				switchModelOrThrow: async () => {},
				prompt: async () => {
					messages.push({
						id: "a1",
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: 'opencode-go API error (403): {"type":"RegionError"}',
					});
				},
				readConversationForPlugins: () => ({ isStreaming: false, messages }),
			}),
			detach: () => {},
		};
		const orch = new CanvasOrchestrator(tempDir, tempDir, () => fakeEngine);
		const engineEvents: ServerMessage[] = [];
		orch.setBroadcaster((msg) => engineEvents.push(msg));

		await orch.runNode(graph, "node_fe");

		expect(node.status).toBe("error");
		expect(node.error).toContain("403");
		expect(engineEvents.some((e) => e.type === "canvas_node_event" && e.event === "done")).toBe(false);
		expect(engineEvents.some((e) => e.type === "canvas_node_event" && e.event === "error")).toBe(true);
	});

	it("历史遗留报错不得污染本轮判定（换模型重跑应能成功）", async () => {
		const graph = makeOrchestratorGraph("engine_stale_error_test");
		graph.nodes = graph.nodes.filter((n) => n.id === "node_fe");
		graph.edges = [];
		graph.executionMode = "real";
		const node = graph.nodes.find((n) => n.id === "node_fe")!;
		node.useWorktree = false;
		node.cwd = ".";
		saveCanvasGraph(tempDir, graph);

		const messages: UiMessage[] = [
			{
				id: "a-old",
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "opencode-go API error (403): RegionError",
			},
		];
		const fakeEngine = {
			attach: async (clientId: string, sink: (msg: unknown) => void) => {
				sink({ type: "snapshot", clientId, state: { messages: [...messages] } });
				return {
					cwd: tempDir,
					setCwd: async () => {},
					abort: async () => {},
					switchModelOrThrow: async () => {},
					prompt: async () => {
						messages.push({ id: "a-new", role: "assistant", content: [], stopReason: "end_turn" });
						sink({ type: "snapshot", clientId, state: { messages: [...messages] } });
					},
					readConversationForPlugins: () => ({ isStreaming: false, messages }),
				};
			},
			detach: () => {},
		};
		const orch = new CanvasOrchestrator(tempDir, tempDir, () => fakeEngine);
		orch.setBroadcaster(() => {});

		await orch.runNode(graph, "node_fe");

		expect(node.status).toBe("done");
		expect(node.error).toBeUndefined();
	});

	it("交付摘要取本轮 assistant 正文（无 message_delta 也不退化成占位文案）", async () => {
		const graph = makeOrchestratorGraph("engine_reply_test");
		graph.executionMode = "real";
		const node = graph.nodes.find((n) => n.id === "node_fe")!;
		graph.nodes = [node];
		graph.edges = [];
		node.useWorktree = false;
		node.cwd = ".";
		saveCanvasGraph(tempDir, graph);

		const messages: UiMessage[] = [];
		const fakeEngine = {
			attach: async () => ({
				cwd: tempDir,
				setCwd: async () => {},
				abort: async () => {},
				switchModelOrThrow: async () => {},
				prompt: async () => {
					messages.push({
						id: "a1",
						role: "assistant",
						content: [{ type: "text", text: "你好！有什么我可以帮你的吗？" }],
						stopReason: "end_turn",
					});
				},
				readConversationForPlugins: () => ({ isStreaming: false, messages }),
			}),
			detach: () => {},
		};
		const orch = new CanvasOrchestrator(tempDir, tempDir, () => fakeEngine);
		orch.setBroadcaster(() => {});

		await orch.runNode(graph, "node_fe");

		expect(node.lastOutputSummary).toContain("有什么我可以帮你的吗");
		expect(node.lastOutputSummary).not.toContain("未产生文件修改");
	});

	it("人工审批批准后只走批准边，不触发驳回回路", () => {
		const graph = makeOrchestratorGraph("approve_filter_test");
		const h = mkTestNode("h", "human", { status: "waiting_approval" });
		graph.nodes = [h, mkTestNode("a", "end"), mkTestNode("b", "end")];
		graph.edges = [
			{ id: "e1", sourceNodeId: "h", targetNodeId: "a", type: "approve" },
			{ id: "e2", sourceNodeId: "h", targetNodeId: "b", type: "reject" },
		] as CanvasEdge[];
		saveCanvasGraph(tempDir, graph);

		orchestrator.reviewNode(graph.id, "h", "approve");
		expect(orchestrator.getNodeLog(graph.id, "a").some((e) => e.kind === "handoff")).toBe(true);
		expect(orchestrator.getNodeLog(graph.id, "b").some((e) => e.kind === "handoff")).toBe(false);
		orchestrator.stopAll(graph.id);
	});

	it("条件分支按关键词路由到 true/false 边", async () => {
		const mkGraph = (gid: string, summary: string) => {
			const graph = makeOrchestratorGraph(gid);
			const cNode: CanvasNode = { ...mkTestNode("c", "condition"), config: { condition: "成功" } };
			graph.nodes = [mkTestNode("s", "trigger"), cNode, mkTestNode("t", "end"), mkTestNode("f", "end")];
			graph.edges = [
				{ id: "e0", sourceNodeId: "s", targetNodeId: "c", type: "handoff", lastHandoffSummary: summary },
				{ id: "e1", sourceNodeId: "c", targetNodeId: "t", type: "condition_true" },
				{ id: "e2", sourceNodeId: "c", targetNodeId: "f", type: "condition_false" },
			] as CanvasEdge[];
			saveCanvasGraph(tempDir, graph);
			return graph;
		};
		const gTrue = mkGraph("cond_true_test", "任务执行成功，无报错");
		await orchestrator.runNode(gTrue, "c", undefined, undefined, true);
		expect(orchestrator.getNodeLog(gTrue.id, "t").some((e) => e.kind === "handoff")).toBe(true);
		expect(orchestrator.getNodeLog(gTrue.id, "f").some((e) => e.kind === "handoff")).toBe(false);
		orchestrator.stopAll(gTrue.id);

		const gFalse = mkGraph("cond_false_test", "任务执行失败，需要回炉");
		await orchestrator.runNode(gFalse, "c", undefined, undefined, true);
		expect(orchestrator.getNodeLog(gFalse.id, "t").some((e) => e.kind === "handoff")).toBe(false);
		expect(orchestrator.getNodeLog(gFalse.id, "f").some((e) => e.kind === "handoff")).toBe(true);
		orchestrator.stopAll(gFalse.id);
	});

	it("定向输入端口标注进入提示词（targetPort=instruction）", async () => {
		const graph = makeOrchestratorGraph("port_label_test");
		graph.nodes = [mkTestNode("s", "trigger"), mkTestNode("n", "coder")];
		graph.edges = [
			{
				id: "e0",
				sourceNodeId: "s",
				targetNodeId: "n",
				type: "handoff",
				targetPort: "instruction",
				lastHandoffSummary: "XYZ-789 定向487输入摘要",
			},
		] as CanvasEdge[];
		saveCanvasGraph(tempDir, graph);

		await orchestrator.runNode(graph, "n", undefined, undefined, true);
		const promptLog = orchestrator.getNodeLog(graph.id, "n").find((e) => e.kind === "prompt");
		expect(promptLog?.text).toContain("AI instructions");
		expect(promptLog?.text).toContain("XYZ-789");
		orchestrator.stopAll(graph.id);
	});

	it("节点专属参数拼入提示词（所见即所得）", async () => {
		const graph = makeOrchestratorGraph("cfg_prompt_test");
		const n: CanvasNode = { ...mkTestNode("n", "reviewer"), config: { strictness: "严格" } };
		graph.nodes = [mkTestNode("s", "trigger"), n];
		graph.edges = [
			{ id: "e0", sourceNodeId: "s", targetNodeId: "n", type: "handoff", lastHandoffSummary: "待审代码" },
		] as CanvasEdge[];
		saveCanvasGraph(tempDir, graph);

		await orchestrator.runNode(graph, "n");
		const promptLog = orchestrator.getNodeLog(graph.id, "n").find((e) => e.kind === "prompt");
		expect(promptLog?.text).toContain("Node-specific parameters");
		expect(promptLog?.text).toContain("严格");
		orchestrator.stopAll(graph.id);
	});

	it("格式转换节点本地执行（文本↔JSON / 模板）", async () => {
		const mkGraph = (gid: string, mode: string, summary: string, extra?: Record<string, string>) => {
			const graph = makeOrchestratorGraph(gid);
			const t: CanvasNode = { ...mkTestNode("t", "transform"), config: { mode, ...(extra ?? {}) } };
			graph.nodes = [mkTestNode("s", "trigger"), t];
			graph.edges = [
				{ id: "e0", sourceNodeId: "s", targetNodeId: "t", type: "handoff", lastHandoffSummary: summary },
			] as CanvasEdge[];
			saveCanvasGraph(tempDir, graph);
			return graph;
		};
		const g1 = mkGraph("tf_text2json", "text2json", '{"a":1}');
		await orchestrator.runNode(g1, "t", undefined, undefined, true);
		expect(orchestrator.getNodeLog(g1.id, "t").some((e) => e.kind === "done" && e.text.includes('"a": 1'))).toBe(true);
		orchestrator.stopAll(g1.id);

		const g2 = mkGraph("tf_wrap", "text2json", "纯文本不是 JSON");
		await orchestrator.runNode(g2, "t", undefined, undefined, true);
		expect(
			orchestrator.getNodeLog(g2.id, "t").some((e) => e.kind === "done" && e.text.includes("纯文本不是 JSON")),
		).toBe(true);
		orchestrator.stopAll(g2.id);

		const g3 = mkGraph("tf_json2text", "json2text", '["x","y"]');
		await orchestrator.runNode(g3, "t", undefined, undefined, true);
		const done3 = orchestrator.getNodeLog(g3.id, "t").find((e) => e.kind === "done");
		expect(done3 && done3.text.includes("x") && done3.text.includes("y")).toBe(true);
		orchestrator.stopAll(g3.id);

		const g4 = mkGraph("tf_tpl", "template", "上游结论", { template: "报告：{{input}}（完）" });
		await orchestrator.runNode(g4, "t", undefined, undefined, true);
		expect(
			orchestrator.getNodeLog(g4.id, "t").some((e) => e.kind === "done" && e.text.includes("报告：上游结论")),
		).toBe(true);
		orchestrator.stopAll(g4.id);
	});

	it("触发器族纯直通（手动 / 定时 / Webhook 不启动 LLM）", async () => {
		const graph = makeOrchestratorGraph("trigger_passthrough_test");
		graph.nodes = [
			{ ...mkTestNode("tri", "trigger"), config: { payload: '{"task":"demo"}' } },
			{ ...mkTestNode("cro", "cron"), config: { cron: "*/5 * * * *" } },
			{ ...mkTestNode("wh", "webhook"), config: { path: "/hook/demo" } },
			mkTestNode("out", "end"),
		];
		graph.edges = [{ id: "e1", sourceNodeId: "tri", targetNodeId: "out", type: "handoff" }] as CanvasEdge[];
		saveCanvasGraph(tempDir, graph);

		await orchestrator.runNode(graph, "tri");
		const tri = graph.nodes.find((n) => n.id === "tri")!;
		expect(tri.status).toBe("done");
		expect(tri.lastOutputSummary).toContain("Manual trigger");
		expect(orchestrator.getNodeLog(graph.id, "out").some((e) => e.kind === "handoff")).toBe(true);

		await orchestrator.runNode(graph, "cro");
		expect(graph.nodes.find((n) => n.id === "cro")?.error).toContain("Unsupported canvas executor");

		await orchestrator.runNode(graph, "wh");
		expect(graph.nodes.find((n) => n.id === "wh")?.error).toContain("Unsupported canvas executor");
		orchestrator.stopAll(graph.id);
	});

	it("支持复位状态 (resetStatus)", () => {
		const graph = makeOrchestratorGraph("reset_test");
		graph.nodes[0].status = "done";
		graph.nodes[1].status = "error";
		saveCanvasGraph(tempDir, graph);

		orchestrator.resetStatus(graph);

		expect(graph.nodes[0].status).toBe("idle");
		expect(graph.nodes[1].status).toBe("idle");
	});

	it("审查回路递增重试计数并在达到上限时熔断暂停", async () => {
		const graph = makeOrchestratorGraph("loop_fuse_test");
		graph.nodes = [{ ...mkTestNode("rev", "reviewer"), lastOutputSummary: "需修改" }, mkTestNode("work", "coder")];
		const loopEdge: CanvasEdge = {
			id: "e_loop",
			sourceNodeId: "rev",
			targetNodeId: "work",
			type: "loop_back",
			maxLoopRetries: 2,
			currentLoopCount: 1,
		};
		graph.edges = [loopEdge];
		saveCanvasGraph(tempDir, graph);

		(orchestrator as any).runningGraphs.set(graph.id, graph);
		await (orchestrator as any).handleDownstreamEdges(graph, graph.nodes[0], "reject");
		expect(loopEdge.currentLoopCount).toBe(2);

		await (orchestrator as any).handleDownstreamEdges(graph, graph.nodes[0], "reject");
		const revNode = graph.nodes.find((n) => n.id === "rev")!;
		expect(revNode.status).toBe("waiting_approval");
		expect(revNode.currentAction).toContain("审查重试上限");
	});

	it("canvas tool 连边防线：拒绝自环边与重复连边", async () => {
		const graph = makeOrchestratorGraph("tool_edge_test");
		graph.nodes = [mkTestNode("n1", "coder"), mkTestNode("n2", "reviewer")];
		graph.edges = [];
		saveCanvasGraph(tempDir, graph);

		const tool = makeCanvasTool({ dataDir: tempDir, lang: () => "zh" });

		const selfRes = await tool.execute(
			"call1",
			{
				action: "add_edge",
				graphId: "tool_edge_test",
				sourceNodeId: "n1",
				targetNodeId: "n1",
			},
			undefined as any,
			undefined as any,
			{} as any,
		);
		expect(String((selfRes as any)?.content?.[0]?.text)).toContain("自环");

		const addRes = await tool.execute(
			"call2",
			{
				action: "add_edge",
				graphId: "tool_edge_test",
				sourceNodeId: "n1",
				targetNodeId: "n2",
			},
			undefined as any,
			undefined as any,
			{} as any,
		);
		expect(String((addRes as any)?.content?.[0]?.text)).toContain("已连边");

		const dupRes = await tool.execute(
			"call3",
			{
				action: "add_edge",
				graphId: "tool_edge_test",
				sourceNodeId: "n1",
				targetNodeId: "n2",
			},
			undefined as any,
			undefined as any,
			{} as any,
		);
		expect(String((dupRes as any)?.content?.[0]?.text)).toContain("已存在");
	});

	it("steerNode 真正将插话投递进正在运行的底层会话，未运行时暂存为待命指令", async () => {
		const graph = makeOrchestratorGraph("steer_test");
		graph.nodes = [mkTestNode("lead", "architect")];
		graph.edges = [];
		saveCanvasGraph(tempDir, graph);

		const promptedMessages: string[] = [];
		const mockSession = {
			cwd: tempDir,
			abort: async () => {},
			switchModelOrThrow: async () => {},
			prompt: async (text: string) => {
				promptedMessages.push(text);
			},
			readConversationForPlugins: () => ({ isStreaming: true, messages: [] }),
		};

		const orch = new CanvasOrchestrator(tempDir, tempDir, () => ({
			attach: async () => mockSession,
			detach: () => {},
		}));

		await orch.steerNode(graph.id, "lead", "优先使用 Fastify 代替 Express");
		const loaded = loadCanvasGraph(tempDir, graph.id);
		expect(loaded.nodes[0].instruction).toContain("优先使用 Fastify");
		const logIdle = orch.getNodeLog(graph.id, "lead");
		expect(logIdle.some((e) => e.text.includes("已暂存为该节点下一次执行指令"))).toBe(true);

		const runPromise = orch.runNode(graph, "lead");
		await new Promise((r) => setTimeout(r, 50));
		await orch.steerNode(graph.id, "lead", "检测 3001 端口并释放");
		expect(promptedMessages).toContain("检测 3001 端口并释放");
		const logRunning = orch.getNodeLog(graph.id, "lead");
		expect(logRunning.some((e) => e.text.includes("已将插话实时投递进正在运行的智能体会话"))).toBe(true);

		orch.stopAll(graph.id);
		await runPromise.catch(() => {});
	});

	it("resolveNodeCwd 完整支持远程 SSH 工作区项目与路径解析", async () => {
		const orch = new CanvasOrchestrator(tempDir, tempDir);

		const sshNode = mkTestNode("ssh_node", "coder", {
			cwd: "ssh://user@example.com:2222/var/www/my-project",
			useWorktree: false,
		});
		const res1 = await orch.resolveNodeCwd(sshNode);
		expect(res1).toBe("ssh://user@example.com:2222/var/www/my-project");

		const subNode = mkTestNode("sub_node", "coder", { cwd: "packages/api" });
		const res2 = await orch.resolveNodeCwd(subNode, "ssh://user@example.com:2222/var/www/my-project");
		expect(res2).toBe("ssh://user@example.com:2222/var/www/my-project/packages/api");

		const emptyNode = mkTestNode("empty_node", "coder", { cwd: "" });
		const res3 = await orch.resolveNodeCwd(emptyNode, "ssh://user@example.com:2222/var/www/my-project");
		expect(res3).toBe("ssh://user@example.com:2222/var/www/my-project");
	});
});
