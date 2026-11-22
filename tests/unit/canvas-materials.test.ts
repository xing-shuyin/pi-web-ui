import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDefaultCanvasGraph,
	loadCanvasGraph,
	mergeCanvasMaterials,
	sanitizeNodeMaterials,
	saveCanvasGraph,
} from "../../server/canvas/canvas-store.js";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";
import { MATERIAL_LIMITS } from "../../server/material.js";
import type { CanvasGraph, CanvasNode, CanvasNodeRole } from "../../server/protocol.js";

function mkNode(id: string, role: CanvasNodeRole, extra?: Partial<CanvasNode>): CanvasNode {
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

function mkGraph(id: string, nodes: CanvasNode[]): CanvasGraph {
	const graph = createDefaultCanvasGraph(id);
	graph.nodes = nodes;
	graph.edges = [];
	graph.executionMode = "simulate";
	return graph;
}

function promptLogOf(orchestrator: CanvasOrchestrator, graphId: string, nodeId: string): string {
	const entries = orchestrator.getNodeLog(graphId, nodeId).filter((entry) => entry.kind === "prompt");
	return entries.at(-1)?.text ?? "";
}

describe("canvas 节点材料的规格存取（存）", () => {
	it("只收路径字符串：去空白、去重、非字符串丢弃、按 maxItems 截断，且不 stat", () => {
		const raw = [" a.txt ", "a.txt", "", 5, null, "b.txt", "不存在的文件.txt"];
		expect(sanitizeNodeMaterials(raw)).toEqual(["a.txt", "b.txt", "不存在的文件.txt"]);

		const many = Array.from({ length: MATERIAL_LIMITS.maxItems + 5 }, (_, i) => `f${i}.md`);
		expect(sanitizeNodeMaterials(many)).toHaveLength(MATERIAL_LIMITS.maxItems);
		expect(sanitizeNodeMaterials(undefined)).toEqual([]);
		expect(sanitizeNodeMaterials("not-an-array")).toEqual([]);
	});

	it("落盘并回读材料；无材料的老规格不会被写入空字段", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-canvas-materials-"));
		try {
			const graph = mkGraph("mat_store", [
				mkNode("c", "coder", { materials: ["docs/spec.md", " ", 7, "docs/spec.md"] as string[] }),
			]);
			await saveCanvasGraph(tempDir, graph);
			expect(loadCanvasGraph(tempDir, "mat_store").nodes[0].materials).toEqual(["docs/spec.md"]);

			const legacy = mkGraph("mat_legacy", [mkNode("c", "coder")]);
			legacy.nodes[0].materials = [] as string[];
			await saveCanvasGraph(tempDir, legacy);
			const onDisk = JSON.parse(readFileSync(join(tempDir, "canvas", "mat_legacy.json"), "utf8")) as CanvasGraph;
			expect(onDisk.nodes[0]).not.toHaveProperty("materials");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("run 级与节点级合并去重，节点级优先", () => {
		expect(mergeCanvasMaterials(["a.md", "b.md"], ["b.md", "c.png"])).toEqual(["a.md", "b.md", "c.png"]);
		expect(mergeCanvasMaterials([], ["c.png"])).toEqual(["c.png"]);
		expect(mergeCanvasMaterials([" a.md "], ["a.md"])).toEqual(["a.md"]);
		expect(mergeCanvasMaterials(undefined, undefined)).toEqual([]);
	});
});

describe("canvas 节点材料的投递（归 + 投）", () => {
	let tempDir: string;
	let orchestrator: CanvasOrchestrator;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-canvas-materials-run-"));
		mkdirSync(join(tempDir, "docs"), { recursive: true });
		writeFileSync(join(tempDir, "docs", "spec.md"), "# spec\n");
		writeFileSync(join(tempDir, "shot.png"), "png-bytes");
		orchestrator = new CanvasOrchestrator(tempDir, tempDir);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("R10：不带 materials 时 prompt 与今天逐字节一致", async () => {
		const legacy = mkGraph("mat_legacy_prompt", [mkNode("c", "coder", { instruction: "do the thing" })]);
		await saveCanvasGraph(tempDir, legacy);
		await orchestrator.runNode(legacy, "c");
		const legacyPrompt = promptLogOf(orchestrator, legacy.id, "c");

		const empty = mkGraph("mat_empty_prompt", [mkNode("c", "coder", { instruction: "do the thing" })]);
		empty.nodes[0].materials = [];
		await saveCanvasGraph(tempDir, empty);
		await orchestrator.runNode(empty, "c");
		const emptyPrompt = promptLogOf(orchestrator, empty.id, "c");

		expect(legacyPrompt.length).toBeGreaterThan(0);
		expect(legacyPrompt).toBe(emptyPrompt);
		expect(legacyPrompt).not.toContain("材料");
	});

	it("节点级 + run 级合并去重后进 prompt，节点级在前", async () => {
		const graph = mkGraph("mat_merge_prompt", [
			mkNode("c", "coder", { instruction: "do the thing", materials: ["docs/spec.md", "shot.png"] }),
		]);
		await saveCanvasGraph(tempDir, graph);
		await orchestrator.runNode(graph, "c", undefined, undefined, false, ["shot.png", "docs/spec.md"]);

		const prompt = promptLogOf(orchestrator, graph.id, "c");
		expect(prompt).toContain("材料：docs/spec.md、shot.png");
		expect(prompt.match(/shot\.png/g)).toHaveLength(1);
	});

	it("不存在的路径走 dropped: missing，不抛错且日志与节点摘要可见", async () => {
		const graph = mkGraph("mat_missing_prompt", [
			mkNode("c", "coder", { instruction: "do the thing", materials: ["不存在.txt", "docs/spec.md"] }),
		]);
		await saveCanvasGraph(tempDir, graph);
		await orchestrator.runNode(graph, "c");

		const node = graph.nodes[0];
		expect(node.status).toBe("done");
		const prompt = promptLogOf(orchestrator, graph.id, "c");
		expect(prompt).toContain("材料：docs/spec.md");
		expect(prompt).toContain("不存在.txt(missing)");
		expect(node.lastOutputSummary).toContain("材料已忽略");
		const systemLog = orchestrator
			.getNodeLog(graph.id, "c")
			.filter((entry) => entry.kind === "system")
			.map((entry) => entry.text)
			.join("\n");
		expect(systemLog).toContain("不存在.txt(missing)");
	});
});
