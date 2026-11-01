/**
 * canvas-dispatch.ts — 画布协作 WebSocket 客户端消息分发器。
 */
import type { ClientMessage, ServerMessage } from "../protocol.js";
import { isSafeGraphId, listCanvasGraphs, loadCanvasGraph, saveCanvasGraph } from "./canvas-store.js";
import { deleteCustomCard, listCustomCards } from "./canvas-cards.js";
import type { CanvasOrchestrator } from "./canvas-orchestrator.js";
import { assertCanvasGraph } from "./canvas-validation.js";
import { validateDeviceProject } from "../device-center/workspaces.js";

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
			graphId,
			requestId,
		});
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
			try {
				deleteCustomCard(dataDir, msg.id);
			} catch {
				// 非法 id 直接忽略
			}
			send({ type: "canvas_cards_state", cards: listCustomCards(dataDir) });
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
					graphId: msg.id,
					requestId: msg.requestId,
				});
			}
			return true;
		}

		case "canvas_save": {
			if (!isSafeGraphId(msg.graph?.id)) return true;
			try {
				assertCanvasGraph(msg.graph);
			} catch (error) {
				send({
					type: "canvas_error",
					code: "invalid_graph",
					message: (error as Error).message,
					graphId: msg.graph.id,
					requestId: msg.requestId,
				});
				return true;
			}
			let res: ReturnType<typeof saveCanvasGraph>;
			try {
				res = saveCanvasGraph(dataDir, msg.graph, { expectedRev: msg.baseRev ?? msg.graph.rev ?? 0 });
			} catch (error) {
				send({
					type: "canvas_error",
					code: "save_failed",
					message: (error as Error).message,
					graphId: msg.graph.id,
					requestId: msg.requestId,
				});
				return true;
			}
			if (res.conflict) {
				send({
					type: "canvas_error",
					code: "rev_conflict",
					message: "stale",
					graphId: msg.graph.id,
					graph: res.graph,
					requestId: msg.requestId,
				});
				send({ type: "canvas_graph_state", graph: res.graph, requestId: msg.requestId });
				return true;
			}
			send({ type: "canvas_graph_state", graph: res.graph, requestId: msg.requestId });
			const graphs = listCanvasGraphs(dataDir);
			send({ type: "canvas_list_result", graphs });
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
							return orchestrator.runAll(current, msg.initialPrompt, cwd);
						})
						.catch((error) => fail(error, msg.graphId));
				} else {
					void orchestrator.runAll(graph, msg.initialPrompt, opts?.runBase).catch((error) => fail(error, msg.graphId));
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
					.runNode(graph, msg.nodeId, msg.prompt, opts?.runBase)
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
			// 审查门禁真动作：落盘持久化 + 广播，非本地假状态（#707）
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
