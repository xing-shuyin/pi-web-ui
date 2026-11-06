import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCanvasTool, setCanvasRuntime } from "../../server/canvas/canvas-agent-tool.js";
import { listCustomCards } from "../../server/canvas/canvas-cards.js";
import { listCanvasGraphs, loadCanvasGraph } from "../../server/canvas/canvas-store.js";
import { registerServerStrings, unregisterServerStrings } from "../../server/i18n.js";
import type { CanvasCustomCard, CanvasEdge, CanvasGraph, CanvasNode } from "../../server/protocol.js";

const ruPack = JSON.parse(readFileSync(new URL("../../locales/ru.json", import.meta.url), "utf8"));

describe("canvas tool Russian interpolation", () => {
	let dataDir: string;
	let tool: ReturnType<typeof makeCanvasTool>;
	const runtime = {
		runAll: vi.fn(async () => {}),
		runNode: vi.fn(async () => {}),
		stopNode: vi.fn(),
		stopAll: vi.fn(),
		deleteGraph: vi.fn(() => true),
		steerNode: vi.fn(),
		reviewNode: vi.fn(),
		getNodeLog: vi.fn(() => []),
		getNodeMessages: vi.fn(() => []),
		resetStatus: vi.fn(),
	};

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "canvas-i18n-"));
		registerServerStrings(ruPack.code, ruPack.serverStrings);
		tool = makeCanvasTool({ dataDir, lang: () => "ru" });
		setCanvasRuntime(null);
		vi.clearAllMocks();
	});

	afterEach(() => {
		setCanvasRuntime(null);
		unregisterServerStrings(ruPack.code);
		rmSync(dataDir, { recursive: true, force: true });
	});

	async function invoke(action: string, params: Record<string, unknown> = {}) {
		const result = await tool.execute("canvas-i18n", { action, ...params }, undefined, undefined, {} as any);
		return {
			message: result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
			details: result.details as {
				graph: CanvasGraph;
				card: CanvasCustomCard;
				node: CanvasNode;
				edge: CanvasEdge;
				ok: boolean;
			},
		};
	}

	function expectMessage(message: string, expected: string) {
		expect.soft(message).toBe(expected);
		expect.soft(message).not.toMatch(/\{[^{}]+\}/);
	}

	async function createGraph() {
		return (await invoke("create_graph", { title: "Проверка" })).details.graph;
	}

	it("creates a graph with its actual name and generated id", async () => {
		const {
			message,
			details: { graph },
		} = await invoke("create_graph", { title: "Мой граф" });
		expectMessage(message, `Создан граф Мой граф (${graph.id}) с начальной цепочкой trigger->end.`);
		expect(loadCanvasGraph(dataDir, graph.id).name).toBe("Мой граф");
	});

	it("saves, updates and places reusable cards with their actual titles and ids", async () => {
		const graph = await createGraph();
		const added = await invoke("card_add", { title: "Автор", role: "writer" });
		const cardId = added.details.card.id;
		expectMessage(added.message, `Карточка «Автор» сохранена (${cardId}); панель обновлена.`);
		const updated = await invoke("card_update", { cardId, title: "Редактор", role: "writer" });
		expectMessage(updated.message, "Карточка «Редактор» обновлена.");
		const placed = await invoke("card_place", { graphId: graph.id, cardId });
		expectMessage(placed.message, `Карточка «Редактор» размещена как узел ${placed.details.node.id}.`);
		expect(loadCanvasGraph(dataDir, graph.id).nodes.some((node) => node.id === placed.details.node.id)).toBe(true);
		const deleted = await invoke("card_delete", { cardId });
		expect(deleted.details.ok).toBe(true);
		expect(listCustomCards(dataDir)).toEqual([]);
	});

	it("adds, updates and deletes nodes and reports a missing node id", async () => {
		const graph = await createGraph();
		const added = await invoke("add_node", { graphId: graph.id, title: "Исследователь", role: "researcher" });
		const nodeId = added.details.node.id;
		expectMessage(added.message, `Добавлен узел «Исследователь» (${nodeId}).`);
		const updated = await invoke("update_node", { graphId: graph.id, nodeId, patch: { title: "Аналитик" } });
		expectMessage(updated.message, "Узел «Аналитик» обновлён.");
		const missing = await invoke("update_node", { graphId: graph.id, nodeId: "missing-node" });
		expectMessage(missing.message, "Узел не найден: missing-node");
		expect(missing.details.ok).toBe(false);
		const deleted = await invoke("delete_node", { graphId: graph.id, nodeId });
		expectMessage(deleted.message, `Удалён узел ${nodeId} вместе со связями.`);
		expect(loadCanvasGraph(dataDir, graph.id).nodes.some((node) => node.id === nodeId)).toBe(false);
	});

	it("reports duplicate connections and adds and deletes edges with concrete endpoints", async () => {
		const graph = await createGraph();
		const sourceNodeId = graph.nodes[0].id;
		const targetNodeId = graph.nodes[1].id;
		const duplicate = await invoke("add_edge", { graphId: graph.id, sourceNodeId, targetNodeId });
		expectMessage(duplicate.message, `Связь между ${sourceNodeId} и ${targetNodeId} уже существует.`);
		expect(duplicate.details.ok).toBe(false);
		const deleted = await invoke("delete_edge", { graphId: graph.id, edgeId: graph.edges[0].id });
		expectMessage(deleted.message, `Удалена связь ${graph.edges[0].id}.`);
		const added = await invoke("add_edge", { graphId: graph.id, sourceNodeId, targetNodeId });
		expectMessage(added.message, `Соединено ${sourceNodeId} -> ${targetNodeId}.`);
		expect(loadCanvasGraph(dataDir, graph.id).edges.map((edge) => edge.id)).toEqual([added.details.edge.id]);
	});

	it("replaces the DAG with actual node and edge counts", async () => {
		const graph = await createGraph();
		const result = await invoke("apply_dag", {
			graphId: graph.id,
			nodes: [
				{ title: "Начало", role: "trigger" },
				{ title: "Автор", role: "writer" },
				{ title: "Конец", role: "end" },
			],
			edges: [
				{ from: 0, to: 1 },
				{ from: 1, to: 2 },
			],
		});
		expectMessage(result.message, "Граф заменён: узлов 3 / связей 2.");
		expect(loadCanvasGraph(dataDir, graph.id).nodes).toHaveLength(3);
	});

	it.each(["run_all", "run_node", "stop_node", "steer_node", "layout_graph"])(
		"interpolates %s results through the injected runtime",
		async (action) => {
			const graph = await createGraph();
			setCanvasRuntime(runtime);
			const nodeId = graph.nodes[0].id;
			const result = await invoke(action, { graphId: graph.id, nodeId, message: "Уточнение" });
			const expected: Record<string, string> = {
				run_all: `Запущен прогон всех узлов для ${graph.name}; прогресс смотрите в Canvas Studio.`,
				run_node: `Запущен узел ${nodeId}; для просмотра используйте get_log.`,
				stop_node: `Остановлен узел ${nodeId}.`,
				steer_node: `Узел ${nodeId} получил корректировку.`,
				layout_graph: "Узлы (2) разложены по слоям — пересечений больше нет.",
			};
			expectMessage(result.message, expected[action]);
			expect(result.details.ok).toBe(true);
		},
	);

	it("reports unknown actions and preserves exception text in Russian failures", async () => {
		const graph = await createGraph();
		const unknown = await invoke("unknown_action", { graphId: graph.id });
		expectMessage(unknown.message, "Неизвестное действие: unknown_action");
		expect(unknown.details.ok).toBe(false);
		const invalid = await invoke("card_add", { title: "", role: "writer" });
		expectMessage(invalid.message, "Операция канваса не удалась: Card title is required (1-24 chars).");
		expect(invalid.details.ok).toBe(false);
	});

	it("distinguishes an omitted card id from an unknown card id", async () => {
		const graph = await createGraph();
		const omitted = await invoke("card_place", { graphId: graph.id });
		expectMessage(omitted.message, "Не указан cardId; сначала вызовите card_list.");
		expect(omitted.details.ok).toBe(false);
		const unknown = await invoke("card_place", { graphId: graph.id, cardId: "unknown-card" });
		expectMessage(unknown.message, "Карточка не найдена: unknown-card.");
		expect(unknown.details.ok).toBe(false);
	});

	it("distinguishes an omitted runtime node id from an unknown node id", async () => {
		const graph = await createGraph();
		setCanvasRuntime(runtime);
		const omitted = await invoke("run_node", { graphId: graph.id });
		expectMessage(omitted.message, "Не указан nodeId.");
		expect(omitted.details.ok).toBe(false);
		expect(runtime.runNode).not.toHaveBeenCalled();
		const unknown = await invoke("update_node", { graphId: graph.id, nodeId: "unknown-node" });
		expectMessage(unknown.message, "Узел не найден: unknown-node");
		expect(unknown.details.ok).toBe(false);
	});

	it("deletes a graph through the real store", async () => {
		const graph = await createGraph();
		const deleted = await invoke("delete_graph", { graphId: graph.id });
		expect(deleted.details.ok).toBe(true);
		expect(listCanvasGraphs(dataDir).some((entry) => entry.id === graph.id)).toBe(false);
	});
});
