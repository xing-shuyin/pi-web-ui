import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";
import { handleCanvasMessage } from "../../server/canvas/canvas-dispatch.js";
import {
	CanvasRuntimeError,
	canvasRuntimeMessage,
	isCanvasMessage,
} from "../../server/canvas/canvas-runtime-messages.js";
import { assertCanvasGraph } from "../../server/canvas/canvas-validation.js";
import { parseGraphImport } from "../../web/src/components/canvas/canvas-state.js";
import { formatCanvasMessage } from "../../web/src/components/canvas/canvas-i18n.js";
import { en as uiEn } from "../../web/src/i18n.js";
import {
	createDefaultCanvasGraph,
	loadCanvasGraph,
	saveCanvasGraph,
	saveCanvasRuntimeState,
} from "../../server/canvas/canvas-store.js";
import type { CanvasGraph, CanvasMessage, CanvasNodeRole, ServerMessage } from "../../server/protocol.js";
import zh from "../../web/src/i18n/messages/canvas-runtime/zh.json";
import en from "../../web/src/i18n/messages/canvas-runtime/en.json";

describe("Canvas runtime message metadata", () => {
	let dir: string;
	let runtime: CanvasOrchestrator;
	let events: ServerMessage[];
	const graph = (role: CanvasNodeRole = "coder"): CanvasGraph => ({
		...createDefaultCanvasGraph("runtime"),
		nodes: [
			{
				id: "n",
				title: "用户节点",
				role,
				engine: "pi",
				model: "test/model",
				cwd: ".",
				useWorktree: false,
				x: 0,
				y: 0,
				status: "idle",
			},
		],
		edges: [],
		executionMode: "real",
	});
	const admit = (g: CanvasGraph) => {
		saveCanvasGraph(dir, g);
		return g;
	};
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "canvas-runtime-i18n-"));
		runtime = new CanvasOrchestrator(dir, dir);
		events = [];
		runtime.setBroadcaster((event) => events.push(structuredClone(event)));
	});
	afterEach(() => {
		runtime.stopAll("runtime");
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		{ key: { toString: null } },
		{ key: [] },
		{ key: "canvas.runtime.action.stopped", vars: [] },
		{ key: "canvas.runtime.action.stopped", vars: { title: {} } },
	])("rejects malformed message metadata at both entry points and safely displays old data: %j", (message) => {
		const g = graph();
		Object.assign(g.nodes[0], { currentAction: "legacy status", currentActionMessage: message });
		expect(isCanvasMessage(message)).toBe(false);
		expect(() => assertCanvasGraph(g)).toThrow("Invalid node message metadata");
		expect(() => parseGraphImport(JSON.stringify(g))).toThrow("canvas.import.invalidRuntimeText");
		expect(formatCanvasMessage(message, "legacy status", (key) => uiEn[key])).toBe("legacy status");
	});

	it("accepts unknown well-formed message keys for forward compatibility and displays their original text", () => {
		const message = { key: "canvas.runtime.futureAction", vars: { count: 2 } };
		const g = graph();
		g.nodes[0].currentActionMessage = message;
		expect(isCanvasMessage(message)).toBe(true);
		expect(() => assertCanvasGraph(g)).not.toThrow();
		expect(() => parseGraphImport(JSON.stringify(g))).not.toThrow();
		expect(formatCanvasMessage(message, "future status", (key) => uiEn[key])).toBe("future status");
	});

	it.each(["coder", "pstack", "skill"] as const)(
		"sends English execution instructions and system wrappers for %s nodes",
		async (role) => {
			const g = graph(role);
			g.nodes[0].title = "English worker";
			g.nodes[0].config = { focus: "Architecture" };
			admit(g);
			const execute = vi.spyOn(runtime as any, "executeRealEngineNode").mockResolvedValue("Completed");
			await runtime.runNode(g, "n");
			expect(execute).toHaveBeenCalledOnce();
			const prompt = execute.mock.calls[0][3] as string;
			expect(prompt).toContain("[Automated workflow execution rules]");
			expect(prompt).toContain("[Node-specific parameters]");
			expect(prompt).toContain("[First-node guidance]");
			expect(prompt).not.toMatch(/[\u4e00-\u9fff]/);
		},
	);

	it("broadcasts and persists translated system actions and logs alongside their legacy text", async () => {
		const g = admit(graph("human"));
		g.nodes[0].config = { approvalHint: "请保留这条用户提示" };
		await runtime.runNode(g, "n");
		const started = events.find((event) => event.type === "canvas_node_event" && event.event === "started");
		expect(started).toMatchObject({
			currentAction: "[PI] 正在分配独立环境与工作目录...",
			currentActionMessage: { key: "canvas.runtime.action.allocating", vars: { engine: "PI" } },
		});
		const paused = events.find((event) => event.type === "canvas_node_event" && event.event === "paused");
		expect(paused).toMatchObject({
			currentActionMessage: {
				key: "canvas.runtime.action.waitingApprovalWithHint",
				vars: { hint: "请保留这条用户提示" },
			},
		});
		expect(loadCanvasGraph(dir, g.id).nodes[0].currentActionMessage).toEqual(g.nodes[0].currentActionMessage);
		expect(runtime.getNodeLog(g.id, "n")).toContainEqual(
			expect.objectContaining({
				kind: "system",
				text: "人工审批节点已就绪，等待批准",
				message: { key: "canvas.runtime.log.approvalReady" },
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "canvas_node_log",
				entry: expect.objectContaining({ message: expect.objectContaining({ key: "canvas.runtime.log.nodeStarted" }) }),
			}),
		);
	});

	it("attaches known runtime failures to the error, action, and persisted error log", async () => {
		const g = admit(graph());
		await runtime.runNode(g, "n");
		const message = { key: "canvas.runtime.error.engineProviderMissing" };
		expect(g.nodes[0]).toMatchObject({
			status: "error",
			error: "引擎服务提供者未注入",
			errorMessage: message,
			currentActionMessage: message,
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "canvas_node_event",
				event: "error",
				error: "引擎服务提供者未注入",
				errorMessage: message,
				currentActionMessage: message,
			}),
		);
		expect(new CanvasOrchestrator(dir, dir).getNodeLog(g.id, "n")).toContainEqual(
			expect.objectContaining({ kind: "error", text: "引擎服务提供者未注入", message }),
		);
	});

	it("clears stale metadata when an engine publishes raw text and preserves model output", async () => {
		const g = graph();
		g.nodes[0].error = "上次错误";
		g.nodes[0].errorMessage = canvasRuntimeMessage("error.timeout");
		g.nodes[0].currentAction = "上次动作";
		g.nodes[0].currentActionMessage = canvasRuntimeMessage("action.stopped");
		admit(g);
		const raw = "模型自有文本，不得翻译 {example}";
		vi.spyOn(runtime as any, "executeRealEngineNode").mockImplementation(async (...args: unknown[]) => {
			(args[5] as (text: string, message?: CanvasMessage) => void)(raw);
			return raw;
		});
		await runtime.runNode(g, "n");
		const rawEvent = events.find((event) => event.type === "canvas_node_event" && event.currentAction === raw);
		expect(rawEvent).toMatchObject({ type: "canvas_node_event", currentAction: raw });
		expect(rawEvent).toHaveProperty("currentActionMessage", undefined);
		const startedState = events.find((event) => event.type === "canvas_graph_state");
		expect(startedState?.type === "canvas_graph_state" && startedState.graph.nodes[0].errorMessage).toBeUndefined();
		expect(g.nodes[0].lastOutputSummary).toBe(raw);
		expect(g.nodes[0].errorMessage).toBeUndefined();
		expect(runtime.getNodeLog(g.id, "n").find((entry) => entry.kind === "done")).toMatchObject({ text: raw });
		expect(runtime.getNodeLog(g.id, "n").find((entry) => entry.kind === "done")?.message).toBeUndefined();
		expect(
			runtime
				.getNodeLog(g.id, "n")
				.filter((entry) => entry.kind === "prompt")
				.every((entry) => entry.message === undefined),
		).toBe(true);
	});

	it("does not treat arbitrary external errors as translation keys", async () => {
		const g = admit(graph());
		const raw = "供应商原始错误: canvas.runtime.error.timeout";
		vi.spyOn(runtime as any, "executeRealEngineNode").mockRejectedValue(new Error(raw));
		await runtime.runNode(g, "n");
		expect(g.nodes[0]).toMatchObject({
			error: raw,
			currentActionMessage: { key: "canvas.runtime.action.failed", vars: { error: raw } },
		});
		expect(g.nodes[0].errorMessage).toBeUndefined();
		expect(runtime.getNodeLog(g.id, "n").find((entry) => entry.kind === "error")).toMatchObject({ text: raw });
		expect(runtime.getNodeLog(g.id, "n").find((entry) => entry.kind === "error")?.message).toBeUndefined();
	});

	it("publishes simulation steps with message metadata", async () => {
		const g = graph();
		g.executionMode = "simulate";
		admit(g);
		await runtime.runAll(g);
		const steps = events.filter(
			(event) =>
				event.type === "canvas_node_event" &&
				event.currentActionMessage?.key.startsWith("canvas.runtime.action.simulate"),
		);
		expect(steps).toHaveLength(4);
		expect(g.nodes[0].currentActionMessage).toEqual({ key: "canvas.runtime.action.completed", vars: { engine: "PI" } });
	});

	it("replaces action metadata on cancellation and clears it on reset and rerun", async () => {
		const g = admit(graph());
		vi.spyOn(runtime as any, "executeRealEngineNode").mockImplementation(async () => {
			runtime.stopNode(g.id, "n");
			return "late completion";
		});
		await runtime.runNode(g, "n");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "canvas_node_event",
				event: "paused",
				currentActionMessage: { key: "canvas.runtime.action.stopped" },
			}),
		);
		g.nodes[0].error = "旧错误";
		g.nodes[0].errorMessage = canvasRuntimeMessage("error.timeout");
		runtime.resetStatus(g);
		const reset = loadCanvasGraph(dir, g.id).nodes[0];
		expect(reset.currentAction).toBeUndefined();
		expect(reset.currentActionMessage).toBeUndefined();
		expect(reset.error).toBeUndefined();
		expect(reset.errorMessage).toBeUndefined();
		g.nodes[0].role = "end";
		await runtime.runAll(g);
		expect(g.nodes[0].currentActionMessage).toEqual({
			key: "canvas.runtime.action.passthrough",
			vars: { role: "end" },
		});
	});

	it("keeps metadata authoritative across topology saves, and clears absent runtime metadata", () => {
		const g = admit(graph());
		const stale = structuredClone(g);
		g.nodes[0].currentAction = "已手动中止";
		g.nodes[0].currentActionMessage = canvasRuntimeMessage("action.stopped");
		g.nodes[0].error = "引擎服务提供者未注入";
		g.nodes[0].errorMessage = canvasRuntimeMessage("error.engineProviderMissing");
		saveCanvasRuntimeState(dir, g);
		stale.nodes[0].title = "新用户标题";
		saveCanvasGraph(dir, stale);
		expect(loadCanvasGraph(dir, g.id).nodes[0]).toMatchObject({
			title: "新用户标题",
			currentActionMessage: g.nodes[0].currentActionMessage,
			errorMessage: g.nodes[0].errorMessage,
		});
		g.nodes[0].currentAction = "legacy engine action";
		g.nodes[0].currentActionMessage = undefined;
		g.nodes[0].error = undefined;
		g.nodes[0].errorMessage = undefined;
		saveCanvasRuntimeState(dir, g);
		expect(loadCanvasGraph(dir, g.id).nodes[0]).toMatchObject({
			title: "新用户标题",
			currentAction: "legacy engine action",
		});
		expect(loadCanvasGraph(dir, g.id).nodes[0].currentActionMessage).toBeUndefined();
		expect(loadCanvasGraph(dir, g.id).nodes[0].errorMessage).toBeUndefined();
	});

	it("keeps old graph and log text compatible without inventing metadata", () => {
		const g = graph();
		g.nodes[0].currentAction = "旧版状态";
		g.nodes[0].error = "旧版错误";
		admit(g);
		const old = { id: "old", ts: 1, kind: "system", text: "旧版日志" };
		mkdirSync(join(dir, "canvas", "logs"));
		writeFileSync(join(dir, "canvas", "logs", `${g.id}__n.json`), JSON.stringify([old]));
		expect(runtime.getNodeLog(g.id, "n")).toEqual([old]);
		expect(loadCanvasGraph(dir, g.id).nodes[0]).toMatchObject({ currentAction: "旧版状态", error: "旧版错误" });
		expect(loadCanvasGraph(dir, g.id).nodes[0].currentActionMessage).toBeUndefined();
	});

	it("replaces stale in-progress action metadata after server restart", () => {
		const g = graph();
		g.status = "running";
		g.nodes[0].status = "running";
		g.nodes[0].currentActionMessage = canvasRuntimeMessage("action.running", { engine: "PI" });
		admit(g);
		new CanvasOrchestrator(dir, dir);
		expect(loadCanvasGraph(dir, g.id).nodes[0]).toMatchObject({
			status: "paused",
			currentAction: "Server restarted; run interrupted",
			currentActionMessage: { key: "canvas.runtime.action.interrupted" },
		});
	});

	it("preserves human guidance and review comments as interpolation values", async () => {
		const g = admit(graph("human"));
		await runtime.runNode(g, "n");
		await runtime.steerNode(g.id, "n", "用户原文 {keep}");
		expect(g.nodes[0].currentActionMessage).toEqual({
			key: "canvas.runtime.action.steered",
			vars: { preview: "用户原文 {keep}" },
		});
		runtime.reviewNode(g.id, "n", "approve", "保留我的审查意见");
		expect(g.nodes[0].currentActionMessage).toEqual({
			key: "canvas.runtime.action.reviewApprovedComment",
			vars: { comment: "保留我的审查意见" },
		});
		expect(runtime.getNodeLog(g.id, "n").find((entry) => entry.kind === "steer")?.message).toBeUndefined();
	});

	it("includes metadata for request errors while preserving message, code, and request identity", () => {
		const sent: ServerMessage[] = [];
		handleCanvasMessage({ type: "canvas_load", id: "missing", requestId: "load-1" }, dir, runtime, (event) =>
			sent.push(event),
		);
		expect(sent[0]).toMatchObject({
			type: "canvas_error",
			code: "not_found",
			requestId: "load-1",
			message: "Canvas graph not found: missing",
			messageI18n: { key: "canvas.runtime.error.graphNotFound", vars: { id: "missing" } },
		});
		const g = admit(graph());
		handleCanvasMessage(
			{ type: "canvas_save", graph: { ...g, name: "x".repeat(301) }, requestId: "save-1" },
			dir,
			runtime,
			(event) => sent.push(event),
		);
		expect(sent.at(-1)).toMatchObject({
			type: "canvas_error",
			code: "invalid_graph",
			requestId: "save-1",
			messageI18n: { key: "canvas.runtime.error.invalidGraphIdentity" },
		});
		handleCanvasMessage({ type: "canvas_save", graph: g, baseRev: 0, requestId: "save-2" }, dir, runtime, (event) =>
			sent.push(event),
		);
		expect(sent).toContainEqual(
			expect.objectContaining({
				type: "canvas_error",
				code: "rev_conflict",
				message: "stale",
				messageI18n: { key: "canvas.runtime.error.stale" },
			}),
		);
	});

	it("uses English source content for new default graphs without rewriting saved author content", () => {
		const defaults = createDefaultCanvasGraph();
		expect(JSON.stringify(defaults)).not.toMatch(/[\u4e00-\u9fff]/);
		const authored = createDefaultCanvasGraph("authored");
		authored.name = "用户画布";
		authored.nodes[0].title = "用户节点";
		authored.nodes[0].instruction = "保留用户指令 {{上游摘要}}";
		saveCanvasGraph(dir, authored);
		createDefaultCanvasGraph("authored");
		expect(loadCanvasGraph(dir, "authored").nodes[0]).toMatchObject({
			title: "用户节点",
			instruction: "保留用户指令 {{上游摘要}}",
		});
		expect(loadCanvasGraph(dir, "authored").name).toBe("用户画布");
	});

	it("uses English delivery wrappers while preserving upstream task content", async () => {
		const g = graph("trigger");
		const original = "用户任务内容 {保留}";
		g.nodes[0].title = "Input";
		g.nodes[0].config = { payload: original };
		g.nodes.push({ ...g.nodes[0], id: "accept", title: "Approval", role: "human", config: {} });
		g.edges = [
			{ id: "handoff", sourceNodeId: "n", targetNodeId: "accept", type: "handoff", targetPort: "instruction" },
		];
		admit(g);
		await runtime.runAll(g);
		expect(g.nodes[0].lastOutputSummary).toBe(`[Manual trigger · Task input Input] Task:\n${original}`);
		expect(g.nodes[1].lastOutputSummary).toContain("[Human approval Approval]");
		expect(g.nodes[1].lastOutputSummary).toContain("Directed input from “Input” → AI instructions");
		expect(g.nodes[1].lastOutputSummary).toContain(original);
		expect(g.nodes[1].lastOutputSummary?.replaceAll(original, "")).not.toMatch(/[\u4e00-\u9fff]/);
	});

	it.each(["text2json", "json2text"])("uses an English empty-input wrapper for %s conversion", async (mode) => {
		const g = graph("transform");
		g.nodes[0].title = "Converter";
		g.nodes[0].config = { mode };
		admit(g);
		await runtime.runNode(g, "n");
		expect(g.nodes[0].lastOutputSummary).toBe("[Format conversion Converter] Empty input; no output");
	});

	it("retains original error and cause for non-UI callers", () => {
		const cause = new Error("git output");
		const error = new CanvasRuntimeError("Original failure", "error.localGitRequired", undefined, { cause });
		expect(error.message).toBe("Original failure");
		expect(String(error)).toBe("Error: Original failure");
		expect(error.cause).toBe(cause);
	});

	it("keeps zh/en keys and interpolation placeholders aligned", () => {
		expect(Object.keys(en)).toEqual(Object.keys(zh));
		for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
			expect(key).toMatch(/^canvas\.runtime\./);
			const vars = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
			expect(vars(en[key]), key).toEqual(vars(zh[key]));
		}
	});
});
