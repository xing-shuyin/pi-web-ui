import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isRemoteWorkspaceUri } from "../remote-ssh-service.js";
import type {
	CanvasEngineId,
	CanvasMessage,
	CanvasGraph,
	CanvasNode,
	CanvasNodeLogEntry,
	CanvasNodeLogKind,
	ServerMessage,
	UiMessage,
} from "../protocol.js";
import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import {
	saveCanvasRuntimeState,
	loadCanvasGraph,
	saveCanvasGraph,
	isSafeGraphId,
	deleteCanvasGraph,
	markInterruptedCanvasRuns,
} from "./canvas-store.js";
import { prepareCanvasWorkspace, captureCanvasWorkspaceArtifact, type CanvasWorkspace } from "./canvas-workspace.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PSTACK_SKILLS_MAP } from "./pstack-skills-data.js";
import { discoverDiskSkills, readSkillInstruction } from "../skill-discovery.js";
import { randomUUID } from "node:crypto";
import {
	CanvasExecutionQueue,
	canvasCondition,
	canvasReadiness,
	isCanvasBackedge,
	validateCanvasTopology,
} from "./canvas-scheduler.js";

import { CanvasRuntimeError, canvasErrorMessage, canvasRuntimeMessage } from "./canvas-runtime-messages.js";

const exec = promisify(execFile);

export type CanvasEventBroadcaster = (msg: ServerMessage) => void;
export type EngineServiceGetter = (engine: CanvasEngineId) => any;

interface ActiveNodeExecution {
	graphId: string;
	nodeId: string;
	abortController?: AbortController;
	timeoutId?: ReturnType<typeof setTimeout>;
	session?: any;
}

export class CanvasOrchestrator {
	private readonly dataDir: string;
	private readonly nodeLogs = new Map<string, CanvasNodeLogEntry[]>();
	private readonly nodeMessages = new Map<string, UiMessage[]>();
	private logSeq = 0;
	private readonly baseCwd: string;
	private readonly runBaseByGraph = new Map<string, string>();
	private readonly engineGetter?: EngineServiceGetter;
	private broadcaster: CanvasEventBroadcaster | null = null;
	private readonly activeExecutions = new Map<string, ActiveNodeExecution>();
	private readonly runningGraphs = new Map<string, CanvasGraph>();
	private readonly graphGenerations = new Map<string, number>();
	private readonly nodeGenerations = new Map<string, number>();
	private readonly executionQueue = new CanvasExecutionQueue(4);
	private static readonly sharedWorkspaceQueue = new CanvasExecutionQueue(1);
	private readonly feedbackArtifacts = new Map<string, NonNullable<CanvasNode["artifact"]>["workspace"]>();
	private readonly runDeadlines = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(baseCwd: string, dataDir: string, engineGetter?: EngineServiceGetter) {
		this.baseCwd = baseCwd;
		this.dataDir = dataDir;
		this.engineGetter = engineGetter;
		markInterruptedCanvasRuns(dataDir);
	}

	setBroadcaster(broadcaster: CanvasEventBroadcaster): void {
		this.broadcaster = broadcaster;
	}

	private broadcast(msg: ServerMessage): void {
		try {
			this.broadcaster?.(msg);
		} catch {}
	}

	private broadcastCanvasRuntime(graph: CanvasGraph): void {
		try {
			this.broadcast({ type: "canvas_graph_state", graph: loadCanvasGraph(this.dataDir, graph.id) });
		} catch {}
	}

	private logKey(graphId: string, nodeId: string): string {
		return `${graphId}:${nodeId}`;
	}

	getNodeLog(graphId: string, nodeId: string): CanvasNodeLogEntry[] {
		const key = this.logKey(graphId, nodeId);
		const mem = this.nodeLogs.get(key);
		if (mem) return [...mem];
		try {
			const file = pathJoin(this.dataDir, "canvas", "logs", `${graphId}__${nodeId}.json`);
			if (fsExistsSync(file)) {
				const arr = JSON.parse(readFileSync(file, "utf8")) as CanvasNodeLogEntry[];
				if (Array.isArray(arr)) {
					const capped = arr.slice(-300);
					this.nodeLogs.set(key, capped);
					return [...capped];
				}
			}
		} catch {}
		return [];
	}

	getNodeMessages(graphId: string, nodeId: string): UiMessage[] {
		const mem = this.nodeMessages.get(this.logKey(graphId, nodeId));
		return mem ? [...mem] : [];
	}

	clearNodeLog(graphId: string, nodeId: string): void {
		const key = this.logKey(graphId, nodeId);
		this.nodeLogs.delete(key);
		this.nodeMessages.delete(key);
		try {
			const file = pathJoin(this.dataDir, "canvas", "logs", `${graphId}__${nodeId}.json`);
			if (fsExistsSync(file)) unlinkSync(file);
		} catch {}
	}

	/** 追加一条对话实录并广播 + 节流落盘 */
	private appendLog(
		graphId: string,
		nodeId: string,
		kind: CanvasNodeLogKind,
		text: string,
		toolName?: string,
		message?: CanvasMessage,
	): void {
		if (!isSafeGraphId(graphId) || !isSafeGraphId(nodeId)) return;
		const clean = (text ?? "").slice(0, 2000) || "(空)";
		const entry: CanvasNodeLogEntry = {
			id: `log_${Date.now()}_${(this.logSeq += 1)}`,
			ts: Date.now(),
			kind,
			text: clean,
			...(message ? { message } : {}),
			...(toolName ? { toolName: toolName.slice(0, 80) } : {}),
		};
		const key = this.logKey(graphId, nodeId);
		const list = this.nodeLogs.get(key) ?? [];
		list.push(entry);
		while (list.length > 300) list.shift();
		this.nodeLogs.set(key, list);
		const generation = this.graphGenerations.get(graphId) ?? 0;
		this.broadcast({ type: "canvas_node_log", graphId, nodeId, entry });
		if ((this.graphGenerations.get(graphId) ?? 0) !== generation) return;
		if (list.length % 10 === 0 || kind === "error" || kind === "done") {
			try {
				const dir = pathJoin(this.dataDir, "canvas", "logs");
				if (!fsExistsSync(dir)) fsMkdirSync(dir, { recursive: true });
				writeFileSync(pathJoin(dir, `${graphId}__${nodeId}.json`), JSON.stringify(list.slice(-300)));
			} catch {}
		}
	}

	private pushNodeMessages(graphId: string, nodeId: string, incoming: UiMessage[]): void {
		if (!Array.isArray(incoming) || incoming.length === 0) return;
		const key = this.logKey(graphId, nodeId);
		const list = this.nodeMessages.get(key) ?? [];
		const seen = new Set(list.map((m) => m.id));
		for (const m of incoming) {
			if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
			seen.add(m.id);
			list.push(m);
		}
		while (list.length > 200) list.shift();
		this.nodeMessages.set(key, list);
		this.broadcast({
			type: "canvas_node_messages",
			graphId,
			nodeId,
			appended: incoming.slice(-20),
			streaming: true,
		});
	}

	private pickRunBase(runBase?: string): string {
		const r = (runBase ?? "").trim();
		if (r && (isRemoteWorkspaceUri(r) || isAbsolute(r))) return isRemoteWorkspaceUri(r) ? r : resolve(r);
		return resolve(this.baseCwd);
	}

	async resolveNodeCwd(node: CanvasNode, runBase?: string): Promise<string> {
		if (!isSafeGraphId(node.id))
			throw new CanvasRuntimeError(`Invalid canvas node id: ${node.id}`, "error.invalidNodeId", { id: node.id });
		if (node.useWorktree)
			return (
				await prepareCanvasWorkspace({
					baseCwd: this.pickRunBase(runBase),
					dataDir: this.dataDir,
					graphId: "standalone",
					runId: randomUUID(),
					nodeId: node.id,
					cwd: node.cwd,
					useWorktree: true,
				})
			).cwd;
		const raw = (node.cwd ?? "").trim();
		if (isRemoteWorkspaceUri(raw)) return raw;
		const base = this.pickRunBase(runBase);
		if (isRemoteWorkspaceUri(base))
			return !raw || raw === "." ? base : `${base.replace(/\/+$/, "")}/${raw.replace(/^\/+/, "")}`;
		const cwd = !raw ? base : isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
		if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
		return cwd;
	}

	private armRunDeadline(graph: CanvasGraph): void {
		const previous = this.runDeadlines.get(graph.id);
		if (previous) clearTimeout(previous);
		const runId = graph.run!.id;
		const timer = setTimeout(
			() => {
				this.runDeadlines.delete(graph.id);
				if (
					graph.run?.id !== runId ||
					!graph.nodes.some((n) => n.status === "running" || n.status === "waiting_approval")
				)
					return;
				this.stopAll(graph.id);
				graph.status = "error";
				graph.run.error = "Canvas run exceeded 30 minute deadline";
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcastCanvasRuntime(graph);
			},
			30 * 60 * 1000,
		);
		timer.unref();
		this.runDeadlines.set(graph.id, timer);
	}

	deleteGraph(graphId: string): boolean {
		if (!isSafeGraphId(graphId)) return false;
		this.graphGenerations.set(graphId, (this.graphGenerations.get(graphId) ?? 0) + 1);
		for (const [key, execution] of this.activeExecutions) {
			if (execution.graphId !== graphId) continue;
			this.activeExecutions.delete(key);
			execution.abortController?.abort();
		}
		clearTimeout(this.runDeadlines.get(graphId));
		this.runDeadlines.delete(graphId);
		for (const key of this.feedbackArtifacts.keys())
			if (key.startsWith(`${graphId}:`)) this.feedbackArtifacts.delete(key);
		this.runningGraphs.delete(graphId);
		this.runBaseByGraph.delete(graphId);
		for (const key of this.nodeLogs.keys()) if (key.startsWith(`${graphId}:`)) this.nodeLogs.delete(key);
		for (const key of this.nodeMessages.keys()) if (key.startsWith(`${graphId}:`)) this.nodeMessages.delete(key);
		return deleteCanvasGraph(this.dataDir, graphId);
	}

	async runNode(
		graph: CanvasGraph,
		nodeId: string,
		initialPrompt?: string,
		runBase?: string,
		scheduled = false,
	): Promise<void> {
		if (!fsExistsSync(pathJoin(this.dataDir, "canvas", `${graph.id}.json`))) return;
		const execKey = `${graph.id}:${nodeId}`;
		if (this.activeExecutions.has(execKey))
			throw new CanvasRuntimeError(`Canvas node already running: ${nodeId}`, "error.nodeRunning", { id: nodeId });
		if (!scheduled && ["running", "waiting_approval"].includes(this.runningGraphs.get(graph.id)?.status ?? ""))
			throw new CanvasRuntimeError("Canvas graph already running", "error.graphRunning");
		// A separately loaded run_node must not replace an active graph object.
		if ([...this.activeExecutions.values()].some((execution) => execution.graphId === graph.id)) {
			graph = this.runningGraphs.get(graph.id) ?? graph;
		}
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return;
		this.runningGraphs.set(graph.id, graph);
		const generation = this.graphGenerations.get(graph.id) ?? 0;
		const nodeGeneration = (this.nodeGenerations.get(execKey) ?? 0) + 1;
		this.nodeGenerations.set(execKey, nodeGeneration);
		const lifecycleCurrent = () =>
			(this.graphGenerations.get(graph.id) ?? 0) === generation && this.nodeGenerations.get(execKey) === nodeGeneration;
		const controller = new AbortController();
		const execution: ActiveNodeExecution = {
			graphId: graph.id,
			nodeId,
			abortController: controller,
		};
		this.activeExecutions.set(execKey, execution);
		const isCurrent = () =>
			lifecycleCurrent() && !controller.signal.aborted && this.activeExecutions.get(execKey) === execution;

		if (!scheduled || !graph.run) {
			for (const key of this.feedbackArtifacts.keys())
				if (key.startsWith(`${graph.id}:`)) this.feedbackArtifacts.delete(key);
			graph.run = { id: randomUUID(), graphRev: graph.rev ?? 0, startedAt: Date.now(), scope: "node", nodeId };
		}
		graph.status = "running";
		if (!scheduled) this.armRunDeadline(graph);
		node.runId = graph.run!.id;
		node.attempt = (node.attempt ?? 0) + 1;
		node.artifact = undefined;
		node.lastOutputSummary = undefined;
		if (!scheduled) {
			const scope = new Set(this.runNodes(graph).map((n) => n.id));
			for (const target of this.runNodes(graph))
				if (target !== node) {
					target.status = "idle";
					target.error = undefined;
					target.errorMessage = undefined;
					target.currentAction = undefined;
					target.currentActionMessage = undefined;
					target.artifact = undefined;
					target.lastOutputSummary = undefined;
					target.aiVerdict = undefined;
					target.runId = graph.run!.id;
					target.attempt = 0;
				}
			for (const edge of graph.edges) {
				edge.active = scope.has(edge.sourceNodeId) ? undefined : false;
				edge.runId = graph.run!.id;
				edge.lastHandoffSummary = undefined;
				edge.currentLoopCount = 0;
			}
		}
		node.aiVerdict = undefined;
		node.actualEngine = undefined;
		node.actualModel = undefined;
		node.status = "running";
		node.error = undefined;
		node.errorMessage = undefined;
		node.currentAction = `[${node.engine.toUpperCase()}] 正在分配独立环境与工作目录...`;
		node.currentActionMessage = canvasRuntimeMessage("action.allocating", { engine: node.engine.toUpperCase() });
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		this.appendLog(
			graph.id,
			nodeId,
			"system",
			`启动节点「${node.title}」(${node.engine}/${node.model})，工作目录: ${node.cwd || "."}（基准: ${this.pickRunBase(runBase ?? this.runBaseByGraph.get(graph.id))}）`,
			undefined,
			canvasRuntimeMessage("log.nodeStarted", {
				title: node.title,
				engine: node.engine,
				model: node.model,
				cwd: node.cwd || ".",
				base: this.pickRunBase(runBase ?? this.runBaseByGraph.get(graph.id)),
			}),
		);

		this.broadcast({
			type: "canvas_node_event",
			graphId: graph.id,
			nodeId,
			event: "started",
			currentAction: node.currentAction,
			currentActionMessage: node.currentActionMessage,
		});

		let releaseSlot = () => {};
		let releaseCwd = () => {};
		const releaseCapacity = () => {
			releaseSlot();
			releaseCwd();
		};
		try {
			releaseSlot = await this.executionQueue.acquire(controller.signal);
			if (["cron", "webhook", "memory", "loop"].includes(node.role))
				throw new CanvasRuntimeError(`Unsupported canvas executor: ${node.role}`, "error.unsupportedExecutor", {
					role: node.role,
				});
			if ((runBase ?? "").trim()) this.runBaseByGraph.set(graph.id, runBase as string);
			const upstreamArtifacts = graph.edges
				.filter((e) => e.targetNodeId === node.id && e.active === true)
				.flatMap((e) => {
					const artifact = graph.nodes.find((n) => n.id === e.sourceNodeId)?.artifact;
					const feedback = this.feedbackArtifacts.get(`${graph.id}:${graph.run?.id}:${e.id}`);
					return feedback
						? [feedback]
						: artifact && artifact.runId === graph.run?.id && artifact.workspace
							? [artifact.workspace]
							: [];
				});
			if (!node.useWorktree && upstreamArtifacts.length === 0) {
				releaseCwd = await CanvasOrchestrator.sharedWorkspaceQueue.acquire(controller.signal);
			}
			const workspace: CanvasWorkspace = await prepareCanvasWorkspace({
				baseCwd: this.pickRunBase(runBase ?? this.runBaseByGraph.get(graph.id)),
				dataDir: this.dataDir,
				graphId: graph.id,
				runId: graph.run!.id,
				nodeId: node.id + "-" + node.attempt,
				cwd: node.cwd,
				useWorktree: node.useWorktree,
				upstreamArtifacts,
				signal: controller.signal,
			});
			const resolvedCwd = workspace.cwd;
			if (!isCurrent()) return;
			const captureControlArtifact = async () => {
				const workspaceArtifact = workspace.isolated
					? await captureCanvasWorkspaceArtifact(workspace, { signal: controller.signal })
					: undefined;
				if (!isCurrent()) return;
				node.artifact = {
					runId: graph.run!.id,
					attempt: node.attempt!,
					summary: node.lastOutputSummary ?? "",
					text: node.lastOutputSummary,
					cwd: resolvedCwd,
					createdAt: Date.now(),
					workspace: workspaceArtifact,
				};
			};

			const roleDetail =
				node.role === "pstack"
					? `pstack: ${String(node.config?.skill || "poteto-mode")}`
					: node.role === "skill"
						? `skill: ${String(node.config?.skillName || node.config?.skill || "soul")}`
						: node.role;
			node.currentAction = `[${node.engine.toUpperCase()}] 启动 ${node.model} 执行中 (${roleDetail})...`;
			node.currentActionMessage = canvasRuntimeMessage("action.starting", {
				engine: node.engine.toUpperCase(),
				model: node.model,
				role: roleDetail,
			});
			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "action",
				currentAction: node.currentAction,
				currentActionMessage: node.currentActionMessage,
			});

			const incomingEdges = graph.edges.filter((e) => e.targetNodeId === nodeId && e.active !== false);
			let contractContext = "";
			for (const edge of incomingEdges) {
				if (edge.lastHandoffSummary) {
					const PORT_LABELS: Record<string, string> = {
						contract: "Task contract",
						instruction: "AI instructions",
						system: "Role instructions",
						config: "Control parameters",
					};
					const srcTitle = graph.nodes.find((n) => n.id === edge.sourceNodeId)?.title || edge.sourceNodeId;
					const portSuffix =
						edge.targetPort && edge.targetPort !== "contract"
							? ` → ${PORT_LABELS[edge.targetPort] || edge.targetPort}`
							: "";
					contractContext += `\n[Directed input from “${srcTitle}”${portSuffix}]:\n${edge.lastHandoffSummary}\n`;
				}
			}

			const rawInstruction =
				initialPrompt?.trim() || node.instruction?.trim() || node.systemPromptOverride?.trim() || "";
			let expandedInstruction = rawInstruction;
			if (contractContext) {
				expandedInstruction = expandedInstruction.replace(
					/\{\{\s*(上游摘要|upstream|contract|input)\s*\}\}/gi,
					contractContext,
				);
			}
			const isInputOnly =
				contractContext.trim().length > 0 &&
				(!expandedInstruction.trim() || expandedInstruction.trim() === contractContext.trim());
			const cfgEntries = Object.entries(node.config ?? {}).filter((entry) => entry[1] !== undefined && entry[1] !== "");
			let configContext = "";
			if (!isCanvasPassthroughRole(node.role) && node.role !== "transform" && cfgEntries.length > 0) {
				configContext = `\n[Node-specific parameters]:\n${cfgEntries.map((entry) => `${entry[0]}=${String(entry[1])}`).join("; ")}\n`;
			}
			let prompt = isInputOnly
				? `${contractContext}${configContext ? `\n${configContext}` : ""}`
				: `${expandedInstruction || "Carry out the development task according to your role."}\n${configContext}${contractContext}`;

			if (
				!contractContext.trim() &&
				!initialPrompt?.trim() &&
				!node.instruction?.trim() &&
				!isCanvasPassthroughRole(node.role)
			) {
				prompt += `\n\n[First-node guidance]: This is the first node in the workflow. Inspect the current workspace, establish the project architecture and conventions, identify the core tasks, and provide explicit task contracts for downstream nodes.`;
			}

			if (node.role === "pstack") {
				const skillKey = String(node.config?.skill ?? "poteto-mode").trim();
				const item = PSTACK_SKILLS_MAP[skillKey] || PSTACK_SKILLS_MAP["poteto-mode"];
				const skillTitle = item ? `${item.icon} ${item.id}` : skillKey;
				const skillDoc = item?.content ? item.content.slice(0, 4500) : "";
				prompt = `[Pstack engineering reference · ${skillTitle}]\n${skillDoc}\n\n[Pstack execution rules]\n1. Work thoroughly and avoid AI filler (Unslop): do not produce empty descriptions or superficial code fixes.\n2. Provide reproducible evidence after making changes: test output, runtime diagnostics, or precise behavioral evidence.\n3. Follow every non-negotiable principle of the selected skill (${skillKey}) for this node's task.\n\n[Node task and context]\n${prompt}`;
			} else if (node.role === "skill") {
				const targetSkillName = String(node.config?.skillName ?? node.config?.skill ?? "").trim();
				let skillInstruction = "";
				let foundSkillTitle = targetSkillName || "Unspecified skill";
				if (targetSkillName) {
					const diskSkills = discoverDiskSkills({
						cwd: resolvedCwd || this.baseCwd,
						dataDir: this.dataDir,
						scanAncestors: true,
					});
					const matched = diskSkills.find((s) => s.name.toLowerCase() === targetSkillName.toLowerCase());
					if (matched) {
						skillInstruction = readSkillInstruction(matched.filePath);
						foundSkillTitle = matched.name;
					} else {
						const pstackItem = PSTACK_SKILLS_MAP[targetSkillName.toLowerCase()];
						if (pstackItem) {
							skillInstruction = pstackItem.content;
							foundSkillTitle = `${pstackItem.icon} ${pstackItem.id}`;
						}
					}
				}
				prompt = `[Soul of Skill · ${foundSkillTitle}]\n${skillInstruction ? `Use this skill's rules and methods as your core operating guidance:\n${skillInstruction.slice(0, 4500)}` : `Use the requirements of the "${foundSkillTitle}" skill as your operating principles.`}\n\n[Execution contract]\nPerform the work according to this skill's professional role and standards, carefully incorporating upstream deliverables.\n\n[Node task and context]\n${prompt}`;
			}

			let outputSummary = "";

			const wantAiJudge =
				(node.role === "ai_judge" || (node.role === "condition" && node.config?.aiJudge === true)) &&
				graph.executionMode !== "simulate";
			let judgeModel: string = node.model;
			if (wantAiJudge) {
				const condRef = String(node.config?.condition ?? "").trim() || "The upstream output meets expectations";
				const instructionAsk = (node.instruction ?? "").trim().slice(0, 500);
				const judgeAsk =
					typeof node.config?.judge === "string" && node.config.judge.trim()
						? String(node.config.judge).trim().slice(0, 500)
						: instructionAsk || `Determine whether the upstream output satisfies [${condRef}]`;
				const upstreamBlock = contractContext.trim()
					? `Upstream output summary:\n${contractContext.slice(0, 4000)}\nQuestion: ${judgeAsk} (use the upstream output as evidence)`
					: `No upstream output is available. Answer this question directly: ${judgeAsk}`;
				// These two verdict tokens are a compatibility contract with the existing decision parser.
				prompt = `You are the workflow branch judge. Make only a binary semantic decision; do not perform other work or call tools.\n${upstreamBlock}\nThe last line must be exactly "结论：通过" or "结论：不通过". You may precede it with one line of reasoning.`;
				judgeModel =
					typeof node.config?.judgeModel === "string" && node.config.judgeModel.trim()
						? node.config.judgeModel.trim().slice(0, 120)
						: node.model;
				this.appendLog(
					graph.id,
					nodeId,
					"system",
					`AI 裁决启动（${node.engine}/${judgeModel}）：${judgeAsk.slice(0, 200)}`,
					undefined,
					canvasRuntimeMessage("log.judgeStarted", {
						engine: node.engine,
						model: judgeModel,
						question: judgeAsk.slice(0, 200),
					}),
				);
			} else if (!isCanvasPassthroughRole(node.role) && node.role !== "transform") {
				prompt += `\n\n[Automated workflow execution rules]:
1. Proceed autonomously: this is an unattended collaborative workflow. Do not stop to ask the user questions or wait for a human decision. Resolve branches using sound engineering judgment and continue.
2. Avoid blocking the terminal: do not leave long-running services or verification commands in the foreground. Check and resolve occupied ports (such as 3000/3001), and stop and clean up all background child processes when verification finishes.
3. Deliver clearly: provide a concise change summary, interface contracts, and the current status so downstream nodes or review gates can continue.`;
			}
			this.appendLog(graph.id, nodeId, "prompt", prompt.slice(0, 2000));
			if (node.role === "transform") {
				const transformed = executeTransformNode(graph, node);
				node.status = "done";
				node.currentAction = "格式转换完成（本地执行）";
				node.currentActionMessage = canvasRuntimeMessage("action.transformCompleted");
				node.lastOutputSummary = transformed;
				await captureControlArtifact();
				if (!isCurrent()) return;
				this.appendLog(graph.id, nodeId, "done", transformed.slice(0, 2000));
				if (!isCurrent()) return;
				releaseCapacity();
				this.activeExecutions.delete(execKey);
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcastCanvasRuntime(graph);
				this.broadcast({
					type: "canvas_node_event",
					graphId: graph.id,
					nodeId,
					event: "done",
					currentAction: node.currentAction,
					currentActionMessage: node.currentActionMessage,
					summary: node.lastOutputSummary,
				});
				await this.handleDownstreamEdges(
					graph,
					node,
					undefined,
					() => lifecycleCurrent() && !controller.signal.aborted,
				);
				return;
			}
			if (!wantAiJudge && isCanvasPassthroughRole(node.role)) {
				const passthroughSummary = buildPassthroughSummary(node, contractContext, initialPrompt);
				if (node.role === "human") {
					node.status = "waiting_approval";
					node.currentAction =
						(node.config?.approvalHint ? String(node.config.approvalHint) + " —— " : "") + "等待人工在抽屉中批准/驳回";
					node.currentActionMessage = node.config?.approvalHint
						? canvasRuntimeMessage("action.waitingApprovalWithHint", { hint: String(node.config.approvalHint) })
						: canvasRuntimeMessage("action.waitingApproval");
					node.lastOutputSummary = passthroughSummary;
					await captureControlArtifact();
					if (!isCurrent()) return;
					this.appendLog(
						graph.id,
						nodeId,
						"system",
						"人工审批节点已就绪，等待批准",
						undefined,
						canvasRuntimeMessage("log.approvalReady"),
					);
					if (!isCurrent()) return;
					releaseCapacity();
					this.activeExecutions.delete(execKey);
					this.settleGraph(graph);
					saveCanvasRuntimeState(this.dataDir, graph);
					this.broadcastCanvasRuntime(graph);
					this.broadcast({
						type: "canvas_node_event",
						graphId: graph.id,
						nodeId,
						event: "paused",
						currentAction: node.currentAction,
						currentActionMessage: node.currentActionMessage,
						summary: node.lastOutputSummary,
					});
					return;
				}
				node.status = "done";
				node.currentAction = `控制节点直通 (${node.role})`;
				node.currentActionMessage = canvasRuntimeMessage("action.passthrough", { role: node.role });
				node.lastOutputSummary = passthroughSummary;
				await captureControlArtifact();
				if (!isCurrent()) return;
				this.appendLog(graph.id, nodeId, "done", passthroughSummary.slice(0, 2000));
				if (!isCurrent()) return;
				releaseCapacity();
				this.activeExecutions.delete(execKey);
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcastCanvasRuntime(graph);
				this.broadcast({
					type: "canvas_node_event",
					graphId: graph.id,
					nodeId,
					event: "done",
					currentAction: node.currentAction,
					currentActionMessage: node.currentActionMessage,
					summary: node.lastOutputSummary,
				});
				await this.handleDownstreamEdges(
					graph,
					node,
					undefined,
					() => lifecycleCurrent() && !controller.signal.aborted,
				);
				return;
			}

			if (graph.executionMode === "simulate") {
				await this.simulateNodeExecution(node, resolvedCwd, prompt, controller.signal, (action, message) => {
					if (!isCurrent()) return;
					node.currentAction = action;
					node.currentActionMessage = message;
					this.broadcast({
						type: "canvas_node_event",
						graphId: graph.id,
						nodeId,
						event: "action",
						currentAction: action,
						currentActionMessage: message,
					});
				});
				outputSummary = `[${node.title}] Simulation completed, working directory: ${node.cwd || "."}`;
			} else {
				const savedModel = node.model;
				if (wantAiJudge && judgeModel !== node.model) node.model = judgeModel;
				try {
					outputSummary = await this.executeRealEngineNode(
						graph,
						node,
						resolvedCwd,
						prompt,
						controller.signal,
						(action, message) => {
							if (!isCurrent()) return;
							node.currentAction = action;
							node.currentActionMessage = message;
							this.broadcast({
								type: "canvas_node_event",
								graphId: graph.id,
								nodeId,
								event: "action",
								currentAction: action,
								currentActionMessage: message,
							});
						},
					);
				} finally {
					node.model = savedModel;
				}
			}

			if (!isCurrent()) return;

			const workspaceArtifact = workspace.isolated
				? await captureCanvasWorkspaceArtifact(workspace, { signal: controller.signal })
				: undefined;
			if (!isCurrent()) return;
			node.artifact = {
				runId: graph.run!.id,
				attempt: node.attempt!,
				summary: outputSummary,
				text: outputSummary,
				cwd: workspace.cwd,
				createdAt: Date.now(),
				workspace: workspaceArtifact,
			};
			node.status = "done";
			node.currentAction = `已完成 (${node.engine.toUpperCase()})`;
			node.currentActionMessage = canvasRuntimeMessage("action.completed", { engine: node.engine.toUpperCase() });
			node.lastOutputSummary = outputSummary;
			if (wantAiJudge) {
				const hits = [
					...outputSummary.matchAll(/结论\s*[：:]\s*(通过|不通过|成立|不成立|是|否|真|假|true|false|yes|no)/gi),
				];
				const last = hits.length > 0 ? String(hits[hits.length - 1][1]).toLowerCase() : "";
				node.aiVerdict = last ? ["通过", "成立", "是", "真", "true", "yes"].includes(last) : undefined;
				if (node.aiVerdict === undefined)
					throw new CanvasRuntimeError("AI judge returned no explicit decision", "error.judgeNoDecision");
				this.appendLog(
					graph.id,
					nodeId,
					"system",
					node.aiVerdict === undefined
						? "AI 裁决未给出有效结论（默认走不成立边）。"
						: `AI 裁决结论：${node.aiVerdict ? "通过" : "不通过"}（独立判定，未混入关键词）。`,
					undefined,
					canvasRuntimeMessage(
						node.aiVerdict === undefined
							? "log.judgeInvalid"
							: node.aiVerdict
								? "log.judgePassed"
								: "log.judgeRejected",
					),
				);
			}
			this.appendLog(graph.id, nodeId, "done", outputSummary.slice(0, 2000));
			if (!isCurrent()) return;
			releaseCapacity();
			this.activeExecutions.delete(execKey);
			saveCanvasRuntimeState(this.dataDir, graph);
			this.broadcastCanvasRuntime(graph);

			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "done",
				currentAction: node.currentAction,
				currentActionMessage: node.currentActionMessage,
				summary: node.lastOutputSummary,
			});

			await this.handleDownstreamEdges(graph, node, undefined, () => lifecycleCurrent() && !controller.signal.aborted);
		} catch (err: unknown) {
			if (!lifecycleCurrent() || controller.signal.aborted) return;
			const msg = (err as Error).message || String(err);
			node.status = "error";
			node.error = msg;
			node.errorMessage = canvasErrorMessage(err);
			node.currentAction = `执行出错: ${msg}`;
			node.currentActionMessage = node.errorMessage ?? canvasRuntimeMessage("action.failed", { error: msg });
			this.appendLog(graph.id, node.id, "error", msg.slice(0, 2000), undefined, node.errorMessage);
			if (!lifecycleCurrent() || controller.signal.aborted) return;
			releaseCapacity();
			this.activeExecutions.delete(execKey);
			this.settleGraph(graph);
			saveCanvasRuntimeState(this.dataDir, graph);
			this.broadcastCanvasRuntime(graph);

			this.broadcast({
				type: "canvas_node_event",
				graphId: graph.id,
				nodeId,
				event: "error",
				currentAction: node.currentAction,
				currentActionMessage: node.currentActionMessage,
				error: msg,
				errorMessage: node.errorMessage,
			});
		} finally {
			releaseCapacity();
		}
	}

	async runAll(graph: CanvasGraph, initialPrompt?: string, runBase?: string): Promise<void> {
		if (!fsExistsSync(pathJoin(this.dataDir, "canvas", `${graph.id}.json`))) return;
		const current = this.runningGraphs.get(graph.id);
		if (current && ["running", "waiting_approval"].includes(current.status))
			throw new CanvasRuntimeError("Canvas graph already running", "error.graphRunning");
		if ([...this.activeExecutions.values()].some((e) => e.graphId === graph.id))
			throw new CanvasRuntimeError("Canvas graph already running", "error.graphRunning");
		validateCanvasTopology(graph);
		for (const key of this.feedbackArtifacts.keys())
			if (key.startsWith(`${graph.id}:`)) this.feedbackArtifacts.delete(key);
		this.graphGenerations.set(graph.id, (this.graphGenerations.get(graph.id) ?? 0) + 1);
		graph.run = { id: randomUUID(), graphRev: graph.rev ?? 0, startedAt: Date.now(), scope: "all" };
		graph.status = "running";
		for (const node of graph.nodes) {
			node.status = "idle";
			node.error = undefined;
			node.errorMessage = undefined;
			node.currentAction = undefined;
			node.currentActionMessage = undefined;
			node.lastOutputSummary = undefined;
			node.artifact = undefined;
			node.aiVerdict = undefined;
			node.runId = graph.run!.id;
			node.attempt = 0;
			node.actualEngine = undefined;
			node.actualModel = undefined;
		}
		for (const edge of graph.edges) {
			edge.active = undefined;
			edge.runId = graph.run!.id;
			edge.lastHandoffSummary = undefined;
			edge.currentLoopCount = 0;
		}
		this.runningGraphs.set(graph.id, graph);
		this.armRunDeadline(graph);
		if ((runBase ?? "").trim()) this.runBaseByGraph.set(graph.id, runBase!);
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		const roots = graph.nodes.filter((n) => !graph.edges.some((e) => e.targetNodeId === n.id && !isCanvasBackedge(e)));
		const generation = this.graphGenerations.get(graph.id);
		await Promise.all(roots.map((n) => this.runNode(graph, n.id, initialPrompt, runBase, true)));
		if (this.graphGenerations.get(graph.id) !== generation || this.runningGraphs.get(graph.id) !== graph) return;
		this.settleGraph(graph);
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
	}

	private runNodes(graph: CanvasGraph): CanvasNode[] {
		if (graph.run?.scope !== "node" || !graph.run.nodeId) return graph.nodes;
		const ids = new Set<string>();
		const visit = (id: string) => {
			if (ids.has(id)) return;
			ids.add(id);
			for (const edge of graph.edges) if (edge.sourceNodeId === id) visit(edge.targetNodeId);
		};
		visit(graph.run.nodeId);
		return graph.nodes.filter((n) => ids.has(n.id));
	}

	private settleGraph(graph: CanvasGraph): void {
		const scoped = this.runNodes(graph);
		if (scoped.some((n) => n.status === "error")) graph.status = "error";
		else if (scoped.some((n) => n.status === "waiting_approval")) graph.status = "waiting_approval";
		else if (scoped.some((n) => n.status === "running")) graph.status = "running";
		else if (scoped.every((n) => n.status === "done" || n.status === "skipped")) graph.status = "completed";
		else graph.status = "blocked";
		if (
			graph.run &&
			["completed", "error", "blocked"].includes(graph.status) &&
			!scoped.some((n) => n.status === "running" || n.status === "waiting_approval")
		) {
			clearTimeout(this.runDeadlines.get(graph.id));
			this.runDeadlines.delete(graph.id);
			graph.run.finishedAt = Date.now();
			graph.run.error = scoped.find((n) => n.error)?.error;
		}
	}

	private async handleDownstreamEdges(
		graph: CanvasGraph,
		completedNode: CanvasNode,
		via?: "approve" | "reject",
		lifecycleCurrent: () => boolean = () => true,
	): Promise<void> {
		const generation = this.graphGenerations.get(graph.id) ?? 0;
		const isCurrent = () =>
			lifecycleCurrent() &&
			(this.graphGenerations.get(graph.id) ?? 0) === generation &&
			this.runningGraphs.get(graph.id) === graph &&
			fsExistsSync(pathJoin(this.dataDir, "canvas", `${graph.id}.json`));
		if (!isCurrent()) return;
		completedNode.artifact = {
			...completedNode.artifact,
			runId: graph.run?.id ?? "",
			attempt: completedNode.attempt ?? 1,
			summary: completedNode.lastOutputSummary ?? "",
			text: completedNode.lastOutputSummary,
			cwd: completedNode.artifact?.cwd ?? completedNode.cwd,
			createdAt: completedNode.artifact?.createdAt ?? Date.now(),
		};
		const conditional = completedNode.role === "condition" || completedNode.role === "ai_judge";
		const hit = conditional ? canvasCondition(completedNode, graph) : undefined;
		const decision = via ?? (conditional ? (hit ? "approve" : "reject") : undefined);
		const rework: CanvasNode[] = [];
		for (const edge of graph.edges.filter((e) => e.sourceNodeId === completedNode.id)) {
			const back = isCanvasBackedge(edge);
			const selected = back
				? decision === "reject"
				: via !== "reject" &&
					(edge.type === "approve"
						? via === "approve" || (conditional && hit === true)
						: edge.type === "condition_true"
							? hit === true
							: edge.type === "condition_false"
								? hit === false
								: true);
			edge.runId = graph.run?.id;
			edge.active = selected;
			edge.lastHandoffSummary = selected ? completedNode.artifact.text : undefined;
			if (selected)
				this.appendLog(
					graph.id,
					edge.targetNodeId,
					"handoff",
					`收到来自「${completedNode.title}」的交接：${edge.lastHandoffSummary ?? ""}`,
					undefined,
					canvasRuntimeMessage("log.handoff", {
						title: completedNode.title,
						summary: (edge.lastHandoffSummary ?? "").slice(0, 2000),
					}),
				);
			if (!selected || !back) continue;
			if ((edge.currentLoopCount ?? 0) >= (edge.maxLoopRetries ?? 3)) {
				completedNode.status = "waiting_approval";
				completedNode.currentAction = "已达审查重试上限，等待人工仲裁";
				completedNode.currentActionMessage = canvasRuntimeMessage("action.retryLimit");
				continue;
			}
			const feedbackKey = `${graph.id}:${graph.run?.id}:${edge.id}`;
			if (completedNode.artifact.workspace) this.feedbackArtifacts.set(feedbackKey, completedNode.artifact.workspace);
			else this.feedbackArtifacts.delete(feedbackKey);
			edge.currentLoopCount = (edge.currentLoopCount ?? 0) + 1;
			const target = graph.nodes.find((n) => n.id === edge.targetNodeId);
			if (target && !rework.includes(target)) rework.push(target);
		}
		if (via === "reject" && rework.length === 0 && completedNode.status !== "waiting_approval") {
			completedNode.status = "waiting_approval";
			completedNode.currentAction = "Rejection requires a configured rework edge";
			completedNode.currentActionMessage = canvasRuntimeMessage("action.reworkEdgeRequired");
		}
		const reset = (id: string, seen = new Set<string>()) => {
			if (seen.has(id)) return;
			seen.add(id);
			const node = graph.nodes.find((n) => n.id === id)!;
			if (this.activeExecutions.has(graph.id + ":" + id)) this.stopNode(graph.id, id);
			node.status = "idle";
			node.error = undefined;
			node.errorMessage = undefined;
			node.currentAction = undefined;
			node.currentActionMessage = undefined;
			node.artifact = undefined;
			node.lastOutputSummary = undefined;
			node.aiVerdict = undefined;
			for (const edge of graph.edges.filter((e) => e.sourceNodeId === id && !isCanvasBackedge(e))) {
				edge.active = undefined;
				edge.lastHandoffSummary = undefined;
				reset(edge.targetNodeId, seen);
			}
		};
		for (const target of rework) reset(target.id);
		const scheduled: Promise<void>[] = [];
		for (const target of rework) {
			if (!isCurrent()) return;
			scheduled.push(this.runNode(graph, target.id, undefined, this.runBaseByGraph.get(graph.id), true));
		}
		let changed = true;
		while (changed) {
			changed = false;
			for (const node of this.runNodes(graph))
				if (node.status === "idle" && canvasReadiness(graph, node) === "skip") {
					node.status = "skipped";
					changed = true;
					for (const edge of graph.edges.filter((e) => e.sourceNodeId === node.id && !isCanvasBackedge(e))) {
						edge.active = false;
						edge.lastHandoffSummary = undefined;
					}
				}
		}
		for (const node of this.runNodes(graph)) {
			if (!isCurrent()) return;
			if (
				node.status === "idle" &&
				graph.edges.some((e) => e.targetNodeId === node.id && !isCanvasBackedge(e) && e.active === true) &&
				canvasReadiness(graph, node) === "ready"
			)
				scheduled.push(this.runNode(graph, node.id, undefined, this.runBaseByGraph.get(graph.id), true));
		}
		this.settleGraph(graph);
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		await Promise.all(scheduled);
		if (!isCurrent()) return;
		this.settleGraph(graph);
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
	}

	stopNode(graphId: string, nodeId: string): void {
		const execKey = `${graphId}:${nodeId}`;
		this.nodeGenerations.set(execKey, (this.nodeGenerations.get(execKey) ?? 0) + 1);
		const execution = this.activeExecutions.get(execKey);
		if (execution) {
			execution.abortController?.abort();
			this.activeExecutions.delete(execKey);
		}

		const graph = this.runningGraphs.get(graphId);
		if (graph) {
			const node = graph.nodes.find((n) => n.id === nodeId);
			if (node) {
				node.status = "cancelled";
				node.currentAction = "已手动中止";
				node.currentActionMessage = canvasRuntimeMessage("action.stopped");
				this.settleGraph(graph);
				this.appendLog(graphId, nodeId, "system", "已手动中止当前任务", undefined, canvasRuntimeMessage("log.stopped"));
				saveCanvasRuntimeState(this.dataDir, graph);
				this.broadcastCanvasRuntime(graph);
				this.broadcast({
					type: "canvas_node_event",
					graphId,
					nodeId,
					event: "paused",
					currentAction: node.currentAction,
					currentActionMessage: node.currentActionMessage,
				});
			}
		}
	}

	stopAll(graphId: string): void {
		clearTimeout(this.runDeadlines.get(graphId));
		this.runDeadlines.delete(graphId);
		this.graphGenerations.set(graphId, (this.graphGenerations.get(graphId) ?? 0) + 1);
		this.runBaseByGraph.delete(graphId);
		for (const [key, execution] of this.activeExecutions.entries()) {
			if (execution.graphId === graphId) {
				execution.abortController?.abort();
				this.activeExecutions.delete(key);
			}
		}
		const graph = this.runningGraphs.get(graphId);
		if (graph) {
			graph.status = "paused";
			if (graph.run) graph.run.finishedAt = Date.now();
			for (const node of graph.nodes) {
				if (["running", "idle", "waiting_approval"].includes(node.status)) {
					node.status = "cancelled";
					node.currentAction = "已手动中止";
					node.currentActionMessage = canvasRuntimeMessage("action.stopped");
				}
			}
			saveCanvasRuntimeState(this.dataDir, graph);
			this.broadcastCanvasRuntime(graph);
		}
	}

	reviewNode(graphId: string, nodeId: string, decision: "approve" | "reject", comment?: string): CanvasGraph | null {
		if (!isSafeGraphId(graphId)) return null;
		let graph = this.runningGraphs.get(graphId);
		if (!graph) {
			try {
				graph = loadCanvasGraph(this.dataDir, graphId);
			} catch {
				return null;
			}
		}
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return null;
		if (node.status !== "waiting_approval") return null;
		const cleanComment = (comment ?? "").trim();
		node.lastOutputSummary = `${node.lastOutputSummary ?? ""}\n${decision === "reject" ? "Rework requested" : "Approved"}: ${cleanComment}`;
		graph.status = "running";
		if (decision === "approve") {
			node.status = "done";
			node.currentAction = cleanComment ? `人工审查批准合流：${cleanComment}` : "人工审查批准合流";
			node.currentActionMessage = cleanComment
				? canvasRuntimeMessage("action.reviewApprovedComment", { comment: cleanComment })
				: canvasRuntimeMessage("action.reviewApproved");
		} else {
			node.status = "done";
			node.currentAction = cleanComment ? `人工驳回：${cleanComment}` : "人工驳回：需补充完善测试与注释";
			node.currentActionMessage = cleanComment
				? canvasRuntimeMessage("action.reviewRejectedComment", { comment: cleanComment })
				: canvasRuntimeMessage("action.reviewRejected");
		}
		graph.updatedAt = Date.now();
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		this.runningGraphs.set(graphId, graph);
		this.appendLog(
			graphId,
			nodeId,
			"review",
			`${decision === "approve" ? "人工审查批准合流" : "人工驳回"}${cleanComment ? `：${cleanComment}` : ""}`,
			undefined,
			cleanComment
				? canvasRuntimeMessage(
						decision === "approve" ? "action.reviewApprovedComment" : "action.reviewRejectedComment",
						{ comment: cleanComment },
					)
				: canvasRuntimeMessage(decision === "approve" ? "action.reviewApproved" : "log.reviewRejected"),
		);
		if (this.activeExecutions.has(`${graphId}:${nodeId}`)) {
			this.broadcast({
				type: "canvas_node_event",
				graphId,
				nodeId,
				event: decision === "approve" ? "done" : "paused",
				currentAction: node.currentAction,
				currentActionMessage: node.currentActionMessage,
				summary: node.lastOutputSummary,
			});
		}
		void this.handleDownstreamEdges(graph, node, decision).catch((error: unknown) => {
			node.status = "error";
			node.error = String(error);
			node.errorMessage = canvasErrorMessage(error);
			this.settleGraph(graph);
			saveCanvasRuntimeState(this.dataDir, graph);
			this.broadcastCanvasRuntime(graph);
		});
		return graph;
	}

	async steerNode(graphId: string, nodeId: string, message: string): Promise<void> {
		let graph = this.runningGraphs.get(graphId);
		if (!graph) {
			try {
				graph = loadCanvasGraph(this.dataDir, graphId);
				this.runningGraphs.set(graphId, graph);
			} catch {
				return;
			}
		}
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return;

		node.currentAction = `[收到人工插话指导]: ${message.slice(0, 40)}`;
		node.currentActionMessage = canvasRuntimeMessage("action.steered", { preview: message.slice(0, 40) });
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
		this.appendLog(graphId, nodeId, "steer", message.slice(0, 2000));

		this.broadcast({
			type: "canvas_node_event",
			graphId,
			nodeId,
			event: "action",
			currentAction: node.currentAction,
			currentActionMessage: node.currentActionMessage,
		});

		const execKey = `${graphId}:${nodeId}`;
		const execution = this.activeExecutions.get(execKey);
		if (execution?.session && typeof execution.session.prompt === "function") {
			try {
				await execution.session.prompt(message);
				if (execution.abortController?.signal.aborted || this.activeExecutions.get(execKey) !== execution) return;
				this.appendLog(
					graphId,
					nodeId,
					"system",
					"已将插话实时投递进正在运行的智能体会话。",
					undefined,
					canvasRuntimeMessage("log.steerDelivered"),
				);
			} catch (err: unknown) {
				if (execution.abortController?.signal.aborted || this.activeExecutions.get(execKey) !== execution) return;
				const errMsg = err instanceof Error ? err.message : String(err);
				this.appendLog(
					graphId,
					nodeId,
					"error",
					`插话投递底层会话失败: ${errMsg}`,
					undefined,
					canvasRuntimeMessage("log.steerFailed", { error: errMsg.slice(0, 2000) }),
				);
			}
		} else if (node.status !== "running") {
			const cleanMsg = message.trim();
			if (cleanMsg) {
				node.instruction = node.instruction ? `${node.instruction}\n\n[人工指导补充]: ${cleanMsg}` : cleanMsg;
				saveCanvasGraph(this.dataDir, graph);
				this.appendLog(graphId, nodeId, "system", "节点未在运行，指导意见已暂存为该节点下一次执行指令。");
			}
		}
	}

	resetStatus(graph: CanvasGraph): void {
		this.stopAll(graph.id);
		graph.status = "idle";
		for (const node of graph.nodes) {
			node.status = "idle";
			node.aiVerdict = undefined;
			node.error = undefined;
			node.errorMessage = undefined;
			node.currentAction = undefined;
			node.currentActionMessage = undefined;
			node.lastOutputSummary = undefined;
		}
		for (const edge of graph.edges) {
			edge.currentLoopCount = 0;
			edge.lastHandoffSummary = undefined;
		}
		saveCanvasRuntimeState(this.dataDir, graph);
		this.broadcastCanvasRuntime(graph);
	}

	private async simulateNodeExecution(
		node: CanvasNode,
		_cwd: string,
		_prompt: string,
		signal: AbortSignal,
		onAction: (act: string, message?: CanvasMessage) => void,
	): Promise<void> {
		const steps = [
			[`[${node.engine.toUpperCase()}] 分析任务上下文与关联代码库...`, "action.simulateAnalyze"],
			[`[${node.engine.toUpperCase()}] 规划模块变更方案与接口契约...`, "action.simulatePlan"],
			[`[${node.engine.toUpperCase()}] 写入并应用变更...`, "action.simulateApply"],
			[`[${node.engine.toUpperCase()}] 验证输出结果与测试检查...`, "action.simulateVerify"],
		];

		for (const [step, key] of steps) {
			if (signal.aborted) return;
			onAction(step, canvasRuntimeMessage(key, { engine: node.engine.toUpperCase() }));
			const stepDelay = process.env.NODE_ENV === "test" || process.env.VITEST ? 20 : 600;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, stepDelay);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("Aborted"));
					},
					{ once: true },
				);
			});
		}
	}

	private async executeRealEngineNode(
		graph: CanvasGraph,
		node: CanvasNode,
		resolvedCwd: string,
		prompt: string,
		signal: AbortSignal,
		onAction: (act: string, message?: CanvasMessage) => void,
	): Promise<string> {
		if (!this.engineGetter) {
			throw new CanvasRuntimeError("引擎服务提供者未注入", "error.engineProviderMissing");
		}
		const engineSvc = this.engineGetter(node.engine);
		if (!engineSvc) {
			throw new CanvasRuntimeError(`找不到智能体引擎：${node.engine}`, "error.engineMissing", { engine: node.engine });
		}

		const clientId = `canvas:${graph.id}:${node.id}`;
		let collectedText = "";

		onAction(
			`[${node.engine.toUpperCase()}] 正在接入真实引擎运行时...`,
			canvasRuntimeMessage("action.connecting", { engine: node.engine.toUpperCase() }),
		);

		const seenToolIds = new Set<string>();
		let sinkError: string | undefined;
		const baselineMsgIds = new Set<string>();
		let captureErrors = false;
		const sink = (msg: ServerMessage) => {
			if (signal.aborted) return;
			if (msg.type === "message_delta") {
				const delta = (msg as any).delta || "";
				collectedText += delta;
				if (collectedText.length % 50 === 0) {
					onAction(
						`[${node.engine.toUpperCase()}] 正在生成: ${collectedText.slice(-30).replace(/\n/g, " ")}...`,
						canvasRuntimeMessage("action.generating", {
							engine: node.engine.toUpperCase(),
							preview: collectedText.slice(-30).replace(/\n/g, " "),
						}),
					);
				}
			} else if (msg.type === "snapshot" || msg.type === "snapshot_delta") {
				const messages = ((msg as any).state?.messages || (msg as any).appended || []) as UiMessage[];
				if (messages.length > 0) this.pushNodeMessages(graph.id, node.id, messages);
				for (const m of messages) {
					if (signal.aborted) return;
					if (m.toolName) {
						const tid = m.toolCallId || `${m.toolName}:${m.id}`;
						if (!seenToolIds.has(tid)) {
							seenToolIds.add(tid);
							this.appendLog(
								graph.id,
								node.id,
								"tool",
								m.isError
									? `工具 ${m.toolName} 报错${m.errorMessage ? `：${m.errorMessage.slice(0, 500)}` : ""}`
									: `正在调用工具： ${m.toolName}`,
								m.toolName,
								canvasRuntimeMessage(
									m.isError ? (m.errorMessage ? "log.toolFailedDetail" : "log.toolFailed") : "log.tool",
									{ tool: m.toolName, ...(m.isError && m.errorMessage ? { error: m.errorMessage.slice(0, 500) } : {}) },
								),
							);
						}
						onAction(
							`[${node.engine.toUpperCase()}] 正在调用工具: ${m.toolName}`,
							canvasRuntimeMessage("action.tool", { engine: node.engine.toUpperCase(), tool: m.toolName }),
						);
					} else if (m.errorMessage) {
						if (captureErrors && !baselineMsgIds.has(m.id)) sinkError = m.errorMessage;
						if (!baselineMsgIds.has(m.id)) {
							this.appendLog(graph.id, node.id, "error", m.errorMessage.slice(0, 2000));
						}
					}
				}
			}
		};

		const execKey = `${graph.id}:${node.id}`;
		const execution = this.activeExecutions.get(execKey);
		const cs = await engineSvc.attach(clientId, sink);
		const checkCurrent = () => {
			if (signal.aborted || this.activeExecutions.get(execKey) !== execution)
				throw new CanvasRuntimeError("任务已被手动中止", "error.aborted");
		};
		if (!signal.aborted && this.activeExecutions.get(execKey) === execution && execution) {
			execution.session = cs;
		}

		try {
			checkCurrent();
			if (cs.cwd !== resolvedCwd) {
				await cs.setCwd(resolvedCwd);
			}

			checkCurrent();

			if (node.model) {
				if (typeof cs.switchModelOrThrow !== "function")
					throw new CanvasRuntimeError(`Engine cannot select model: ${node.model}`, "error.modelSelection", {
						model: node.model,
					});
				await cs.switchModelOrThrow(normalizeCanvasModelId(node.model));
			}
			node.actualEngine = node.engine;
			node.actualModel = node.model;
			checkCurrent();

			if (node.thinkingLevel && typeof (cs as any).setThinking === "function") {
				try {
					(cs as any).setThinking(node.thinkingLevel);
				} catch {}
			}

			onAction(
				`[${node.engine.toUpperCase()}] 开始执行任务...`,
				canvasRuntimeMessage("action.running", { engine: node.engine.toUpperCase() }),
			);

			const preRunMsgs = canvasSnapshotMessages(cs);
			for (const m of preRunMsgs) baselineMsgIds.add(m.id);
			const baselineMsgCount = preRunMsgs.length;
			captureErrors = true;

			const abortSession = () => {
				void Promise.resolve()
					.then(() => cs.abort())
					.catch(() => {});
			};
			signal.addEventListener("abort", abortSession, { once: true });
			try {
				checkCurrent();
				await cs.prompt(prompt);
			} finally {
				signal.removeEventListener("abort", abortSession);
			}
			checkCurrent();

			const startTime = Date.now();
			const maxWaitMs = 15 * 60 * 1000;

			while (!signal.aborted) {
				await new Promise((r) => setTimeout(r, 1200));
				if (signal.aborted) {
					await cs.abort().catch(() => {});
					throw new CanvasRuntimeError("任务已被手动中止", "error.aborted");
				}

				let isStreaming = false;
				let turnError: string | undefined;

				if (typeof (cs as any).readConversationForPlugins === "function") {
					const snap = (cs as any).readConversationForPlugins();
					isStreaming = snap?.isStreaming === true;
					turnError =
						tailAssistantError(canvasSnapshotMessages(cs).slice(baselineMsgCount)) ??
						(sinkError && !CANVAS_ABORT_MESSAGES.test(sinkError.trim()) ? sinkError : undefined);
				}

				if (turnError) {
					throw new CanvasRuntimeError(`引擎执行失败：${turnError}`, "error.engineFailed", { error: turnError });
				}

				if (!isStreaming && Date.now() - startTime > 3000) {
					break;
				}

				if (Date.now() - startTime > maxWaitMs) {
					await cs.abort().catch(() => {});
					throw new CanvasRuntimeError("任务执行超时 (15分钟)", "error.timeout");
				}
			}

			checkCurrent();

			let diffSummary = "";
			try {
				if (!isRemoteWorkspaceUri(resolvedCwd)) {
					const { stdout: diffStat } = await exec("git", ["diff", "--stat"], {
						cwd: resolvedCwd,
						timeout: 5000,
						windowsHide: true,
					});
					if (diffStat.trim()) {
						diffSummary = `\n[Code change statistics]:\n${diffStat.trim()}`;
					}
				}
			} catch {}

			const replyText = (
				collectedText.trim() || extractRunReplyText(canvasSnapshotMessages(cs).slice(baselineMsgCount))
			).trim();
			if (replyText) return `${replyText}${diffSummary}`;
			return `[${node.title}] Delivery completed${diffSummary || " (no file changes)"}`;
		} finally {
			if (execution) {
				execution.session = undefined;
			}
			engineSvc.detach(clientId, sink);
		}
	}
}

function canvasSnapshotMessages(cs: unknown): UiMessage[] {
	const reader = (cs as { readConversationForPlugins?: () => { messages?: UiMessage[] } | null } | null)
		?.readConversationForPlugins;
	if (typeof reader !== "function") return [];
	try {
		const snap = reader.call(cs);
		return (snap?.messages ?? []) as UiMessage[];
	} catch {
		return [];
	}
}

const CANVAS_ABORT_MESSAGES = /^(This operation was aborted|Request aborted|任务已被手动中止)$/;

function tailAssistantError(msgs: UiMessage[]): string | undefined {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role !== "assistant") continue;
		if (m.stopReason === "aborted") return undefined;
		const err = (m.errorMessage ?? "").trim();
		if (!err) return undefined;
		return CANVAS_ABORT_MESSAGES.test(err) ? undefined : err;
	}
	return undefined;
}

function extractRunReplyText(msgs: UiMessage[]): string {
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role !== "assistant" || m.stopReason === "aborted") continue;
		const text = (m.content ?? [])
			.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

const CANVAS_PASSTHROUGH_ROLES: ReadonlySet<string> = new Set([
	"condition",
	"loop",
	"human",
	"merge",
	"memory",
	"end",
	"trigger",
	"cron",
	"webhook",
]);

function isCanvasPassthroughRole(role: string): boolean {
	return CANVAS_PASSTHROUGH_ROLES.has(role);
}

function executeTransformNode(graph: CanvasGraph, node: CanvasNode): string {
	const cfg = (node as { config?: Record<string, string | number | boolean | undefined> }).config ?? {};
	const mode = String(cfg["mode"] ?? "text2json");
	const rawInput = graph.edges
		.filter((e) => e.targetNodeId === node.id)
		.map((e) => e.lastHandoffSummary ?? "")
		.filter(Boolean)
		.join("\n")
		.trim();
	const fallbackInput = rawInput || String(cfg["input"] ?? "");
	try {
		if (mode === "json2text") {
			if (!fallbackInput) return "[Format conversion " + node.title + "] Empty input; no output";
			try {
				const v = JSON.parse(fallbackInput) as unknown;
				if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
				if (v !== null && typeof v === "object") {
					const vals = Object.values(v as Record<string, unknown>);
					if (vals.every((x) => typeof x === "string" || typeof x === "number")) return vals.join("\n");
					return JSON.stringify(v, null, 2);
				}
				return String(v);
			} catch {
				return fallbackInput;
			}
		}
		if (mode === "template") {
			const tpl = String(cfg["template"] ?? "{{input}}");
			return tpl.split("{{input}}").join(fallbackInput).split("{{上游摘要}}").join(fallbackInput);
		}
		if (!fallbackInput) return "[Format conversion " + node.title + "] Empty input; no output";
		try {
			return JSON.stringify(JSON.parse(fallbackInput), null, 2);
		} catch {
			return JSON.stringify({ text: fallbackInput }, null, 2);
		}
	} catch (err) {
		return "[Format conversion " + node.title + "] Conversion failed: " + (err as Error).message;
	}
}

function normalizeCanvasModelId(raw: string): string {
	const t = (raw ?? "").trim();
	const slash = t.indexOf("/");
	if (slash <= 0) return t;
	const provider = t.slice(0, slash);
	let rest = t.slice(slash + 1);
	const prefix = `${provider}/`;
	while (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
	return `${provider}/${rest}`;
}

function buildPassthroughSummary(node: CanvasNode, contractContext: string, initialPrompt?: string): string {
	const cfg = (node as { config?: Record<string, string | number | boolean> }).config ?? {};
	const cfgText = Object.entries(cfg)
		.map(([k, v]) => `${k}=${String(v)}`)
		.slice(0, 8)
		.join("; ");
	const contract = contractContext || "(No upstream input; passing through directly)";
	switch (node.role) {
		case "condition":
			return `[Condition branch ${node.title}] Decision configuration: ${cfgText || "No expression configured; using the true branch by default"}\nUpstream deliverables:\n${contract}`;
		case "loop":
			return `[Loop control ${node.title}] Loop configuration: ${cfgText || "Up to 3 attempts by default (circuit breaker)"}\nUpstream deliverables:\n${contract}`;
		case "human":
			return `[Human approval ${node.title}] ${cfgText ? `Approval hint: ${cfgText}` : ""}\nWaiting for approval or rejection in the node drawer. Upstream deliverables:\n${contract}`;
		case "trigger": {
			const popup = (initialPrompt ?? "").trim();
			const payload = popup || String(cfg["payload"] ?? "").trim() || String(node.instruction ?? "").trim();
			const extra = contractContext || "";
			if (payload)
				return `[Manual trigger · Task input ${node.title}] Task:\n${payload}${extra ? "\nUpstream input:\n" + extra : ""}`;
			return `[Manual trigger · Task input ${node.title}]${extra ? "Upstream input:\n" + extra : "(No payload; starting directly)"}`;
		}
		case "cron":
			return `[Scheduled trigger ${node.title}] Schedule: ${cfgText || "No Cron configured (manual start by default)"}\nUpstream deliverables:\n${contract}`;
		case "webhook":
			return `[Webhook trigger ${node.title}] Connection configuration: ${cfgText || "No path configured"}\nUpstream deliverables:\n${contract}`;
		case "merge":
			return `[Merge ${node.title}] Combined upstream deliverables:\n${contract}`;
		case "memory":
			return `[Memory ${node.title}] Memory key: ${cfgText || "default"}\nSnapshot:\n${contract}`;
		case "end":
			return `[Workflow end ${node.title}] Final delivery summary:\n${contract}`;
		default:
			return `[Control node ${node.title}] Pass-through:\n${contract}`;
	}
}
