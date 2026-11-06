import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasTimeline } from "../../web/src/components/canvas/CanvasTimeline";
import type { CanvasNode, CanvasEdge } from "../../server/protocol";
import { parseDagJson, dagToGraph, buildSmartPrompt } from "../../web/src/components/canvas/canvas-dag";
import {
	autoLayout,
	computeMinimap,
	fitCanvasViewport,
	computeCanvasBounds,
} from "../../web/src/components/canvas/canvas-p0";
import { getSquadTemplates } from "../../web/src/components/canvas/CanvasTemplates";
import { getRoleMetas, getRoleFields, getStatusMetas } from "../../web/src/components/canvas/CanvasTypes";
import { getPstackSkills } from "../../web/src/components/canvas/pstack-skills-data";
import { graphFingerprint, mergeGraphRuntime, parseGraphImport } from "../../web/src/components/canvas/canvas-state";
import type { Translate } from "../../web/src/i18n";
import canvasZh from "../../web/src/i18n/messages/canvas/zh.json";
import canvasEn from "../../web/src/i18n/messages/canvas/en.json";
import {
	isRoleImplemented,
	visibleRoleFields,
	STATUS_COLORS,
	outPortsForRole,
} from "../../web/src/components/canvas/CanvasTypes";
import { formatCanvasMessage } from "../../web/src/components/canvas/canvas-i18n";
const translator =
	(messages: Record<string, string>): Translate =>
	(key, vars) =>
		Object.entries(vars ?? {}).reduce(
			(text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
			messages[key] ?? key,
		);
const tZh = translator(canvasZh);
const tEn = translator(canvasEn);
const node = (id: string, x = 0, y = 0): CanvasNode => ({
	id,
	title: id,
	role: "coder",
	x,
	y,
	engine: "pi",
	model: "",
	cwd: ".",
	useWorktree: false,
	status: "idle",
});
const link = (from: string, to: string): CanvasEdge => ({
	id: from + to,
	sourceNodeId: from,
	targetNodeId: to,
	type: "handoff",
});
const base = () => ({
	nodes: [
		{ title: "Decision", role: "condition", config: { keyword: "ready", enabled: true, count: 2 } },
		{ title: "Build", role: "coder", instruction: "Implement", cwd: "project" },
	],
	edges: [{ from: 0, to: 1, type: "condition_true", sourcePort: "true", targetPort: "instruction", label: "Ready" }],
});
describe("canvas DAG contract", () => {
	it("keeps AI limits while allowing explicit whole-graph import limits", () => {
		const data = { nodes: Array.from({ length: 21 }, (_, i) => ({ title: `Step ${i}`, role: "coder" })), edges: [] };
		const raw = JSON.stringify(data);
		expect(() => parseDagJson(raw)).toThrow();
		expect(parseDagJson(raw, 200, 1000).nodes).toHaveLength(21);
		expect(() => parseDagJson(raw, 201, 1000)).toThrow();
	});
	it("retains typed edges, ports, instructions and scalar config", () => {
		const parsed = parseDagJson(JSON.stringify(base()));
		const graph = dagToGraph(parsed, "flow", "model", autoLayout, "fallback");
		expect(graph.edges[0]).toMatchObject({
			type: "condition_true",
			sourcePort: "true",
			targetPort: "instruction",
			label: "Ready",
		});
		expect(graph.nodes[0].config).toEqual(base().nodes[0].config);
		expect(graph.nodes[1]).toMatchObject({ cwd: "project", instruction: "Implement", useWorktree: false });
	});
	it("keeps explicit disconnected graphs disconnected", () => {
		const graph = dagToGraph(parseDagJson(JSON.stringify({ ...base(), edges: [] })), "flow", "", autoLayout);
		expect(graph.edges).toEqual([]);
	});
	it.each([
		{ nodes: [{ title: "bad", role: "toString" }], edges: [] },
		{ nodes: [{ title: "bad", role: "cron" }], edges: [] },
		{ nodes: [{ title: " ", role: "coder" }], edges: [] },
		{ nodes: [{ title: "bad", role: "coder", instruction: 3 }], edges: [] },
		{ nodes: [{ title: "bad", role: "coder", config: { nested: { x: 1 } } }], edges: [] },
		{ ...base(), edges: null },
		{ ...base(), edges: [{ from: 0, to: 9 }] },
		{ ...base(), edges: [{ from: 0, to: 0 }] },
		{ ...base(), edges: [{ from: 0, to: 1, type: "fake" }] },
		{ ...base(), edges: [{ from: 0, to: 1, sourcePort: "missing" }] },
		{ ...base(), edges: [{ from: 0, to: 1, targetPort: "missing" }] },
		{ ...base(), edges: [{ from: 0, to: 1, sourcePort: "true", type: "handoff" }] },
		{
			...base(),
			edges: [
				{ from: 0, to: 1 },
				{ from: 0, to: 1 },
			],
		},
		{
			...base(),
			edges: [
				{ from: 0, to: 1 },
				{ from: 1, to: 0 },
			],
		},
		{ ...base(), unknown: true },
	])("rejects malformed or unsupported DAG %#", (data) => expect(() => parseDagJson(JSON.stringify(data))).toThrow());
	it("rejects prototype config keys", () =>
		expect(() =>
			parseDagJson('{"nodes":[{"title":"x","role":"coder","config":{"__proto__":"bad"}}],"edges":[]}'),
		).toThrow());
	it("excludes unavailable roles from generation", () =>
		expect(buildSmartPrompt("task").split("Allowed roles: ")[1].split(".\n")[0]).not.toMatch(
			/cron|webhook|memory|subflow/,
		));
});
describe("canvas geometry", () => {
	it("uses longest dependency paths so joins follow every predecessor", () => {
		const nodes = [node("a"), node("b"), node("c"), node("d")];
		const laid = autoLayout(nodes, [link("a", "d"), link("a", "b"), link("b", "c"), link("c", "d")]);
		expect(laid[3].x).toBeGreaterThan(laid[2].x);
		expect(nodes[0].x).toBe(0);
	});
	it("spaces variable height cards and variable width columns", () => {
		const nodes = [{ ...node("a"), width: 420 }, node("b"), node("c")];
		const laid = autoLayout(nodes, [link("a", "c")], new Map([["a", 800]]));
		expect(laid[1].y).toBe(920);
		expect(laid[2].x).toBe(560);
	});
	it("preserves relative positions without modulo wrapping and fits measured cards", () => {
		const nodes = [node("a", -900, -500), node("b", 1800, 900)];
		const heights = { a: 700, b: 900 };
		const mini = computeMinimap(nodes, 160, 100, heights);
		expect(mini.nodes[1].x).toBeGreaterThan(mini.nodes[0].x);
		for (const n of mini.nodes) {
			expect(n.x).toBeGreaterThanOrEqual(0);
			expect(n.x + n.width).toBeLessThanOrEqual(160);
			expect(n.y + n.height).toBeLessThanOrEqual(100);
		}
		const b = computeCanvasBounds(nodes, heights);
		expect(b).toEqual({ x: -900, y: -500, width: 3000, height: 2300 });
		const fit = fitCanvasViewport(nodes, 1000, 800, heights);
		expect(b.x * fit.zoom + fit.x).toBeGreaterThanOrEqual(39);
		expect((b.y + b.height) * fit.zoom + fit.y).toBeLessThanOrEqual(761);
	});
	it("handles empty and cyclic legacy graphs deterministically", () => {
		expect(computeMinimap([]).nodes).toEqual([]);
		expect(Number.isFinite(fitCanvasViewport([], 0, 0).zoom)).toBe(true);
		expect(autoLayout([node("a"), node("b")], [link("a", "b"), link("b", "a")])).toHaveLength(2);
	});
});
describe("capability honesty and defaults", () => {
	it("offers both human decisions for wiring", () =>
		expect(outPortsForRole("human").map((p) => p.key)).toEqual(["result", "approve", "reject"]));
	it.each(["cron", "webhook", "memory", "subflow"] as const)("marks %s description only", (role) => {
		expect(isRoleImplemented(role)).toBe(false);
		expect(visibleRoleFields(role, {})).toMatchObject([{ kind: "hint" }]);
	});
	it("ships serial templates with QA, explicit human acceptance and no worktrees", () => {
		for (const tmpl of getSquadTemplates(tZh)) {
			const graph = tmpl.createGraph();
			expect(graph.nodes.some((n) => n.role === "human")).toBe(true);
			expect(graph.nodes.some((n) => n.role === "reviewer" || n.title === "审查")).toBe(true);
			expect(graph.nodes.every((n) => !n.useWorktree && isRoleImplemented(n.role))).toBe(true);
			expect(graph.edges).toHaveLength(graph.nodes.length - 1);
			for (let i = 0; i < graph.edges.length; i++)
				expect(graph.edges[i]).toMatchObject({ sourceNodeId: graph.nodes[i].id, targetNodeId: graph.nodes[i + 1].id });
		}
	});
	it("supports translated terminal statuses and structured messages with literal fallbacks", () => {
		expect(STATUS_COLORS.skipped).toBeTruthy();
		expect(STATUS_COLORS.cancelled).toBeTruthy();
		expect(getStatusMetas(tZh).cancelled.label).not.toBe(getStatusMetas(tEn).cancelled.label);
		expect(formatCanvasMessage({ key: "canvas.defaults.teammate", vars: { count: 3 } }, "old", tEn)).toBe("Teammate 3");
		expect(formatCanvasMessage({ key: "unknown.future.key" }, "AI / 用户原文", tZh)).toBe("AI / 用户原文");
		expect(formatCanvasMessage(undefined, "User-authored name", tZh)).toBe("User-authored name");
	});
});

describe("Canvas localized metadata and saved data", () => {
	it("refreshes template and role labels while leaving existing graph data and English execution content intact", () => {
		const saved = getSquadTemplates(tZh)[1].createGraph();
		const snapshot = structuredClone(saved);
		const english = getSquadTemplates(tEn)[1].createGraph();
		expect(english.name).not.toBe(saved.name);
		expect(english.nodes[1].title).not.toBe(saved.nodes[1].title);
		expect(english.nodes.map((n) => n.instruction)).toEqual(saved.nodes.map((n) => n.instruction));
		expect(english.nodes.flatMap((n) => n.instruction ?? "").join(" ")).not.toMatch(/[\u4e00-\u9fff]/);
		expect(getRoleMetas(tZh).coder.label).not.toBe(getRoleMetas(tEn).coder.label);
		expect(getRoleFields(tZh).researcher.map((f) => f.default)).toEqual(
			getRoleFields(tEn).researcher.map((f) => f.default),
		);
		expect(saved).toEqual(snapshot);
	});
	it("keeps official Pstack descriptions and content independent of UI language", () => {
		const chinese = getPstackSkills(tZh),
			english = getPstackSkills(tEn);
		expect(english.map((s) => [s.id, s.category, s.description, s.content])).toEqual(
			chinese.map((s) => [s.id, s.category, s.description, s.content]),
		);
		expect(english[0].name).not.toBe(chinese[0].name);
	});
	it("localizes validation errors without changing imported user data", () => {
		expect(() => parseGraphImport("{", true, tEn)).toThrow("Invalid JSON");
		expect(() => parseDagJson("{", 20, 200, tEn)).toThrow("Invalid DAG JSON");
		const graph = getSquadTemplates(tZh)[1].createGraph();
		graph.name = "用户命名 / User name";
		graph.nodes[1].title = "用户节点 / User node";
		const imported = parseGraphImport(JSON.stringify(graph), true, tEn);
		expect(imported.name).toBe(graph.name);
		expect(imported.nodes[1].title).toBe(graph.nodes[1].title);
	});
	it("excludes structured runtime messages from authored changes and clears stale metadata on runtime replacement", () => {
		const graph = getSquadTemplates(tEn)[1].createGraph();
		const running = structuredClone(graph);
		running.nodes[0].currentAction = "old";
		running.nodes[0].currentActionMessage = { key: "canvas.defaults.teammate", vars: { count: 1 } };
		running.nodes[0].errorMessage = { key: "canvas.import.invalidJson" };
		expect(graphFingerprint(running)).toBe(graphFingerprint(graph));
		const merged = mergeGraphRuntime(running, graph);
		expect(merged.nodes[0].currentActionMessage).toBeUndefined();
		expect(merged.nodes[0].errorMessage).toBeUndefined();
		expect(parseGraphImport(JSON.stringify(running), true, tEn).nodes[0].currentActionMessage).toBeUndefined();
	});
});

describe("Canvas timeline display", () => {
	it("translates status labels while keeping wire values in CSS classes", () => {
		const html = renderToStaticMarkup(
			createElement(CanvasTimeline, {
				nodes: [{ ...node("timeline"), status: "error" }],
				edges: [],
				logs: {},
				onRunNode: () => {},
				onLocate: () => {},
			}),
		);
		expect(html).toContain("st-error");
		expect(html).toContain(canvasEn["canvas.metadata.status.error"]);
		expect(html).not.toContain("canvas.metadata.");
	});
});
