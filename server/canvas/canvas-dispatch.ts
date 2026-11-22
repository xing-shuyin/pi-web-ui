import type { ClientMessage, ServerMessage } from "../protocol.js";
import { isSafeGraphId, listCanvasGraphs, loadCanvasGraph, saveCanvasGraph } from "./canvas-store.js";
import { deleteCustomCard, listCustomCards } from "./canvas-cards.js";
import type { CanvasOrchestrator } from "./canvas-orchestrator.js";
import { assertCanvasGraph } from "./canvas-validation.js";
import { validateDeviceProject } from "../device-center/workspaces.js";
import { canvasErrorMessage, canvasRuntimeMessage } from "./canvas-runtime-messages.js";

export function handleCanvasMessage(
	msg: ClientMessage,
	dataDir: string,
	orchestrator: CanvasOrchestrator,
	send: (msg: ServerMessage) => void,
	opts?: { runBase?: string },
): boolean {
	const fail = (error: unknown, graphId?: string, requestId?: string) =>
		send({
			type: "canvas_error",
			code: "execution_error",
			message: error instanceof Error ? error.message : String(error),
			messageI18n: canvasErrorMessage(error),
			graphId,
			requestId,
		});
	/**
	 * canvas 保存的落盘已改异步（issue #966）：分支本身必须让出事件循环，
	 * 结果仍按原协议异步回推（先 `canvas_graph_state`、再 `canvas_list_result`）。
	 */
	const runCanvasSaveAsync = (saveMsg: Extract<ClientMessage, { type: "canvas_save" }>): void => {
		void (async () => {
			if (!isSafeGraphId(saveMsg.graph?.id)) {
				send({
					type: "canvas_error",
					code: "invalid_graph",
					message: `Invalid canvas graph id: ${String(saveMsg.graph?.id)}`,
					messageI18n: canvasRuntimeMessage("error.invalidGraphId", { id: String(saveMsg.graph?.id) }),
					graphId: typeof saveMsg.graph?.id === "string" ? saveMsg.graph.id : undefined,
					requestId: saveMsg.requestId,
				});
				return;
			}
			try {
				assertCanvasGraph(saveMsg.graph);
			} catch (error) {
				send({
					type: "canvas_error",
					code: "invalid_graph",
					message: (error as Error).message,
					messageI18n: canvasErrorMessage(error),
					graphId: saveMsg.graph.id,
					requestId: saveMsg.requestId,
				});
				return;
			}
			let res: Awaited<ReturnType<typeof saveCanvasGraph>>;
			try {
				res = await saveCanvasGraph(dataDir, saveMsg.graph, {
					expectedRev: saveMsg.baseRev ?? saveMsg.graph.rev ?? 0,
				});
			} catch (error) {
				send({
					type: "canvas_error",
					code: "save_failed",
					message: (error as Error).message,
					messageI18n: canvasErrorMessage(error),
					graphId: saveMsg.graph.id,
					requestId: saveMsg.requestId,
				});
				return;
			}
			if (res.conflict) {
				send({
					type: "canvas_error",
					code: "rev_conflict",
					message: "stale",
					messageI18n: canvasRuntimeMessage("error.stale"),
					graphId: saveMsg.graph.id,
					graph: res.graph,
					requestId: saveMsg.requestId,
				});
			}
			send({ type: "canvas_graph_state", graph: res.graph, requestId: saveMsg.requestId });
			if (!res.conflict) send({ type: "canvas_list_result", graphs: listCanvasGraphs(dataDir) });
		})().catch((error) => fail(error, saveMsg.graph?.id, saveMsg.requestId));
	};

	/** 卡片增删删改也要落盘，同样让出事件循环后再回推列表。 */
	const runCardAsync = (run: () => Promise<unknown>): void => {
		void run()
			.then(() => send({ type: "canvas_cards_state", cards: listCustomCards(dataDir) }))
			.catch((error) => fail(error));
	};

	// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
	switch (msg.type) {
		case "canvas_list": {
			const graphs = listCanvasGraphs(dataDir);
			send({ type: "canvas_list_result", graphs });
			return true;
		}

		case "canvas_cards": {
			send({ type: "canvas_cards_state", cards: listCustomCards(dataDir) });
			return true;
		}

		case "canvas_card_delete": {
			runCardAsync(() => deleteCustomCard(dataDir, msg.id));
			return true;
		}

		case "canvas_load": {
			if (!isSafeGraphId(msg.id)) return true;
			try {
				const graph = loadCanvasGraph(dataDir, msg.id);
				send({ type: "canvas_graph_state", graph, requestId: msg.requestId });
			} catch (error) {
				send({
					type: "canvas_error",
					code: "not_found",
					message: error instanceof Error ? error.message : String(error),
					messageI18n: canvasErrorMessage(error),
					graphId: msg.id,
					requestId: msg.requestId,
				});
			}
			return true;
		}

		case "canvas_save": {
			runCanvasSaveAsync(msg);
			return true;
		}

		case "canvas_delete": {
			if (!isSafeGraphId(msg.id)) return true;
			orchestrator.deleteGraph(msg.id);
			const graphs = listCanvasGraphs(dataDir);
			send({ type: "canvas_list_result", graphs });
			return true;
		}

		case "canvas_run_all": {
			try {
				const graph = loadCanvasGraph(dataDir, msg.graphId);
				assertCanvasGraph(graph);
				if (msg.cwd !== undefined) {
					void validateDeviceProject(msg.cwd, dataDir)
						.then((cwd) => {
							const current = loadCanvasGraph(dataDir, msg.graphId);
							assertCanvasGraph(current);
							return orchestrator.runAll(current, msg.initialPrompt, cwd, msg.materials);
						})
						.catch((error) => fail(error, msg.graphId));
				} else {
					void orchestrator
						.runAll(graph, msg.initialPrompt, opts?.runBase, msg.materials)
						.catch((error) => fail(error, msg.graphId));
				}
			} catch (error) {
				fail(error, msg.graphId);
			}
			return true;
		}

		case "canvas_run_node": {
			try {
				const graph = loadCanvasGraph(dataDir, msg.graphId);
				assertCanvasGraph(graph);
				void orchestrator
					.runNode(graph, msg.nodeId, msg.prompt, opts?.runBase, false, msg.materials)
					.catch((error) => fail(error, msg.graphId));
			} catch (error) {
				fail(error, msg.graphId);
			}
			return true;
		}

		case "canvas_stop_node": {
			orchestrator.stopNode(msg.graphId, msg.nodeId);
			return true;
		}

		case "canvas_stop_all": {
			orchestrator.stopAll(msg.graphId);
			return true;
		}

		case "canvas_steer_node": {
			if (!isSafeGraphId(msg.graphId)) return true;
			void orchestrator.steerNode(msg.graphId, msg.nodeId, msg.message).catch((error) => fail(error, msg.graphId));
			return true;
		}

		case "canvas_get_log": {
			if (!isSafeGraphId(msg.graphId)) return true;
			send({
				type: "canvas_node_log_state",
				graphId: msg.graphId,
				nodeId: msg.nodeId,
				entries: orchestrator.getNodeLog(msg.graphId, msg.nodeId),
				messages: orchestrator.getNodeMessages(msg.graphId, msg.nodeId),
			});
			return true;
		}

		case "canvas_clear_log": {
			if (!isSafeGraphId(msg.graphId)) return true;
			orchestrator.clearNodeLog(msg.graphId, msg.nodeId);
			send({
				type: "canvas_node_log_state",
				graphId: msg.graphId,
				nodeId: msg.nodeId,
				entries: [],
				messages: [],
			});
			return true;
		}

		case "canvas_review_node": {
			if (!isSafeGraphId(msg.graphId)) return true;
			try {
				const graph = orchestrator.reviewNode(msg.graphId, msg.nodeId, msg.decision, msg.comment);
				if (graph) send({ type: "canvas_graph_state", graph });
			} catch (error) {
				fail(error, msg.graphId);
			}
			return true;
		}

		case "canvas_reset_status": {
			try {
				const graph = loadCanvasGraph(dataDir, msg.graphId);
				orchestrator.resetStatus(graph);
				send({ type: "canvas_graph_state", graph });
			} catch (error) {
				fail(error, msg.graphId);
			}
			return true;
		}

		default:
			return false;
	}
}
