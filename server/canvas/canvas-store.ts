/**
 * canvas-store.ts — 画布协作工程持久化与模板管理器。
 *
 * 画布工程存放在 <dataDir>/canvas/<graphId>.json 中。
 * 提供画布的增删改查、列表摘要、以及内置开箱即用模板。
 */
import { CanvasRuntimeError, canvasRuntimeMessage } from "./canvas-runtime-messages.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-file.js";
import { MATERIAL_LIMITS } from "../material.js";
import type { CanvasGraph, CanvasGraphSummary } from "../protocol.js";

export function createDefaultCanvasGraph(id = "default"): CanvasGraph {
	const now = Date.now();
	return {
		id,
		name: "Develop · Test · Human acceptance",
		viewport: { x: 50, y: 50, zoom: 1 },
		status: "idle",
		createdAt: now,
		updatedAt: now,
		nodes: [
			{
				id: "node_architect",
				title: "Requirements and acceptance criteria",
				role: "trigger",
				x: 80,
				y: 180,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				config: { payload: "Enter the task objective, scope, and acceptance criteria before running the workflow." },
				instruction: "Pass the task objective and acceptance criteria to the next node.",
				status: "idle",
			},
			{
				id: "node_fe",
				title: "Implementation engineer",
				role: "coder",
				x: 480,
				y: 60,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				systemPromptOverride:
					"Make the smallest necessary changes to satisfy the task and acceptance criteria. Check existing conventions and report files, verification commands, and results.",
				instruction:
					"Complete the upstream task {{upstream}} and deliver a verifiable implementation with complete evidence.",
				status: "idle",
			},
			{
				id: "node_be",
				title: "Testing and code review",
				role: "tester",
				x: 880,
				y: 180,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				systemPromptOverride:
					"Review the implementation and run relevant checks. Record passing, failing, and unverified items explicitly. Never fabricate test results.",
				instruction:
					"Verify upstream deliverables {{upstream}} and provide commands, results, and remaining risks for human acceptance.",
				status: "idle",
			},
			{
				id: "node_qa",
				title: "Human acceptance",
				role: "human",
				x: 1280,
				y: 180,
				width: 300,
				engine: "pi",
				model: "",
				cwd: ".",
				useWorktree: false,
				instruction:
					"Check the implementation and test evidence. Approve completion or adjust the workflow and run it again.",
				status: "idle",
			},
		],
		edges: [
			{
				id: "edge_arch_to_fe",
				sourceNodeId: "node_architect",
				targetNodeId: "node_fe",
				type: "handoff",
				label: "Task and acceptance criteria",
			},
			{
				id: "edge_fe_to_be",
				sourceNodeId: "node_fe",
				targetNodeId: "node_be",
				type: "handoff",
				label: "Implementation and verification evidence",
			},
			{
				id: "edge_be_to_qa",
				sourceNodeId: "node_be",
				targetNodeId: "node_qa",
				type: "handoff",
				label: "Check results and deliverables for acceptance",
			},
		],
	};
}

/**
 * 节点材料的规格校验：只收路径字符串、按 `MATERIAL_LIMITS.maxItems` 截断、去重。
 * 不做可达性判定（不 stat）——那是 `server/material.ts#normalizeMaterials` 的事。
 */
export function sanitizeNodeMaterials(raw: unknown): string[] {
	const items: unknown[] = Array.isArray(raw) ? raw : [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (typeof item !== "string") continue;
		const value = item.trim();
		if (!value || seen.has(value)) continue;
		if (out.length >= MATERIAL_LIMITS.maxItems) break;
		seen.add(value);
		out.push(value);
	}
	return out;
}

/**
 * 合并 run 级与节点级材料：**节点级优先**（先出现者胜），按路径去重。
 * 上限不在这里截断：超限交给 `normalizeMaterials` 记 `over-cap`，避免静默丢项。
 */
export function mergeCanvasMaterials(
	nodeMaterials: readonly string[] = [],
	runMaterials: readonly string[] = [],
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of [...nodeMaterials, ...runMaterials]) {
		if (typeof item !== "string") continue;
		const value = item.trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

/** 规格落盘/读取时的材料归一：合法值就地写回，空值删字段（老规格无 materials 保持逐字节不变）。 */
function reconcileGraphMaterials(graph: CanvasGraph): CanvasGraph {
	for (const node of graph.nodes ?? []) {
		const materials = sanitizeNodeMaterials(node.materials);
		if (materials.length > 0) node.materials = materials;
		else delete node.materials;
	}
	return graph;
}

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isSafeGraphId(id: unknown): id is string {
	return typeof id === "string" && SAFE_ID_RE.test(id);
}

function assertSafeGraphId(id: string): void {
	if (!isSafeGraphId(id))
		throw new CanvasRuntimeError(`Invalid canvas graph id: ${JSON.stringify(id)}`, "error.invalidGraphId", {
			id: JSON.stringify(id),
		});
}

function ensureCanvasDir(dataDir: string): string {
	const dir = join(dataDir, "canvas");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

export function listCanvasGraphs(dataDir: string): CanvasGraphSummary[] {
	const dir = ensureCanvasDir(dataDir);
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	if (files.length === 0) {
		// 内置模板只在内存里给出去：读路径不能 await 落盘，而漂浮的种子写入可能后落地、把用户后来保存的版本盖回去。
		// 真正的落盘发生在第一次 `saveCanvasGraph`（已 await）。
		const def = createDefaultCanvasGraph();
		return [
			{
				id: def.id,
				name: def.name,
				nodeCount: def.nodes.length,
				edgeCount: def.edges.length,
				updatedAt: def.updatedAt,
			},
		];
	}

	const list: CanvasGraphSummary[] = [];
	for (const f of files) {
		try {
			const full = join(dir, f);
			const content = JSON.parse(readFileSync(full, "utf8")) as CanvasGraph;
			if (content && content.id) {
				list.push({
					id: content.id,
					name: content.name || content.id,
					nodeCount: content.nodes?.length ?? 0,
					edgeCount: content.edges?.length ?? 0,
					updatedAt: content.updatedAt ?? Date.now(),
				});
			}
		} catch {}
	}
	return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadCanvasGraph(dataDir: string, id: string): CanvasGraph {
	assertSafeGraphId(id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${id}.json`);
	if (!existsSync(path)) {
		if (id === "default") {
			// 同上：读路径只给内存模板，持久化留给 `saveCanvasGraph`。
			return createDefaultCanvasGraph(id);
		}
		throw new CanvasRuntimeError(`Canvas graph not found: ${id}`, "error.graphNotFound", { id });
	}
	return reconcileGraphMaterials(JSON.parse(readFileSync(path, "utf8")) as CanvasGraph);
}

/**
 * 保存画布工程（真值存储）：`await` 返回时文件已落盘，下一次 `loadCanvasGraph` / `new` 实例必能读到本笔内容。
 * 读-合并-写回只在调用方按序 `await` 时成立：并发写入会互相覆盖，所以每个调用点都必须 `await`。
 */
export async function saveCanvasGraph(
	dataDir: string,
	graph: CanvasGraph,
	opts?: { expectedRev?: number },
): Promise<{ conflict: boolean; graph: CanvasGraph }> {
	return withGraphLock(join(ensureCanvasDir(dataDir), `${graph.id}.json`), () =>
		saveCanvasGraphLocked(dataDir, graph, opts),
	);
}

async function saveCanvasGraphLocked(
	dataDir: string,
	graph: CanvasGraph,
	opts?: { expectedRev?: number },
): Promise<{ conflict: boolean; graph: CanvasGraph }> {
	assertSafeGraphId(graph.id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${graph.id}.json`);
	let diskRev = 0;
	let disk: CanvasGraph | undefined;
	if (existsSync(path)) {
		try {
			disk = JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
			diskRev = disk.rev ?? 0;
		} catch {
			diskRev = 0;
		}
	}
	if (opts?.expectedRev !== undefined && opts.expectedRev !== diskRev) {
		return { conflict: true, graph: disk ?? graph };
	}
	if (disk) {
		graph.status = disk.status;
		graph.run = disk.run;
		const existingNodes = new Map(disk.nodes.map((node) => [node.id, node]));
		for (const node of graph.nodes) {
			const prior = existingNodes.get(node.id);
			if (!prior) continue;
			for (const field of RUNTIME_FIELDS) (node as unknown as Record<string, unknown>)[field] = prior[field];
		}
		const existingEdges = new Map(disk.edges.map((edge) => [edge.id, edge]));
		for (const edge of graph.edges) {
			const prior = existingEdges.get(edge.id);
			if (!prior) continue;
			for (const field of ["lastHandoffSummary", "currentLoopCount", "runId", "active"] as const)
				(edge as unknown as Record<string, unknown>)[field] = prior[field];
		}
	}
	reconcileGraphMaterials(graph);
	graph.rev = diskRev + 1;
	graph.updatedAt = Date.now();
	await writeJsonAtomic(path, graph);
	return { conflict: false, graph };
}

/**
 * 同一份画布文件的「读-合并-写回」必须互斥：结构写（saveCanvasGraph）与运行态写
 * （saveCanvasRuntimeState/标记中断）都在读盘后改一部分字段再写回，交错就会互相覆盖
 * （异步化之后窗口变宽，issue #966）。锁只按文件、只在本进程内。
 */
const graphLocks = new Map<string, Promise<unknown>>();

function withGraphLock<T>(file: string, run: () => Promise<T>): Promise<T> {
	const previous = graphLocks.get(file) ?? Promise.resolve();
	const result = previous.then(run, run);
	const settled = result.then(
		() => undefined,
		() => undefined,
	);
	graphLocks.set(file, settled);
	void settled.then(() => {
		if (graphLocks.get(file) === settled) graphLocks.delete(file);
	});
	return result;
}

const RUNTIME_FIELDS = [
	"status",
	"currentAction",
	"currentActionMessage",
	"errorMessage",
	"lastOutputSummary",
	"error",
	"aiVerdict",
	"runId",
	"attempt",
	"artifact",
	"actualEngine",
	"actualModel",
] as const;

/**
 * 把「运行态」字段从 `source` 覆盖到 `target`（拓扑/名称等结构字段保持 `target` 的）。
 * 单源：落盘合并与广播投影都用它，避免两处各写一份字段清单。
 */
export function applyCanvasRuntimeFields(target: CanvasGraph, source: CanvasGraph): void {
	const rt = new Map(source.nodes.map((n) => [n.id, n]));
	for (const node of target.nodes) {
		const live = rt.get(node.id);
		if (!live) continue;
		for (const field of RUNTIME_FIELDS)
			(node as unknown as Record<string, unknown>)[field] = (live as unknown as Record<string, unknown>)[field];
	}
	const rtEdges = new Map(source.edges.map((e) => [e.id, e]));
	for (const edge of target.edges) {
		const live = rtEdges.get(edge.id);
		if (!live) continue;
		for (const key of ["lastHandoffSummary", "currentLoopCount", "runId", "active"] as const)
			(edge as unknown as Record<string, unknown>)[key] = (live as unknown as Record<string, unknown>)[key];
	}
	target.status = source.status;
	target.run = source.run;
}

export async function saveCanvasRuntimeState(dataDir: string, runtime: CanvasGraph): Promise<void> {
	await withGraphLock(join(ensureCanvasDir(dataDir), `${runtime.id}.json`), () =>
		saveCanvasRuntimeStateLocked(dataDir, runtime),
	);
}

async function saveCanvasRuntimeStateLocked(dataDir: string, runtime: CanvasGraph): Promise<void> {
	assertSafeGraphId(runtime.id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${runtime.id}.json`);
	if (!existsSync(path)) return;
	let disk: CanvasGraph;
	try {
		disk = JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
	} catch {
		return;
	}
	applyCanvasRuntimeFields(disk, runtime);
	disk.updatedAt = Date.now();
	await writeJsonAtomic(path, disk);
	runtime.rev = disk.rev;
}

export async function markInterruptedCanvasRuns(dataDir: string): Promise<void> {
	const dir = ensureCanvasDir(dataDir);
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
		const path = join(dir, file);
		try {
			const graph = JSON.parse(readFileSync(path, "utf8")) as CanvasGraph;
			const interrupted =
				graph.status === "running" ||
				graph.nodes?.some((node) => node.status === "running" || node.status === "queued");
			if (!interrupted) continue;
			graph.status = "paused";
			if (graph.run) {
				graph.run.error = "Server restarted; the previous run was interrupted. Restart the run to continue.";
				graph.run.finishedAt = Date.now();
			}
			for (const node of graph.nodes)
				if (node.status === "running" || node.status === "queued") {
					node.status = "paused";
					node.currentAction = "Server restarted; run interrupted";
					node.currentActionMessage = canvasRuntimeMessage("action.interrupted");
				}
			await writeJsonAtomic(path, graph);
		} catch (error) {
			console.error(`[canvas] Could not recover ${file}:`, error);
		}
	}
}

export function deleteCanvasGraph(dataDir: string, id: string): boolean {
	assertSafeGraphId(id);
	const dir = ensureCanvasDir(dataDir);
	const path = join(dir, `${id}.json`);
	if (existsSync(path)) {
		unlinkSync(path);
		return true;
	}
	return false;
}
