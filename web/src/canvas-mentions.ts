import type { CanvasGraphSummary, ServerMessage } from "./types";
import type { AtHit } from "./at-mention";

export const CANVAS_LIST_EVENT = "pi:canvas-list-result";
const triggers = new Set(["canvas", "canvases", "画布", "工作流", "workflow", "workflows"]);

export function mapCanvasHits(graphs: CanvasGraphSummary[], query: string, label: string, limit = 10): AtHit[] {
	const q = query.toLowerCase();
	return graphs
		.filter((g) => !q || triggers.has(q) || g.name.toLowerCase().includes(q) || g.id.toLowerCase().includes(q))
		.slice(0, Math.max(0, limit))
		.map((g) => ({
			providerId: "host:canvases",
			providerLabel: label,
			title: `${label} · ${g.name}`,
			text: g.name,
			hint: g.id,
			attachments: [{ path: g.id, name: g.name, mode: "canvas" }],
		}));
}

export function searchCanvasMentions(send: () => boolean, timeoutMs = 1800): Promise<CanvasGraphSummary[]> {
	return new Promise((resolve) => {
		const finish = (graphs: CanvasGraphSummary[]) => {
			clearTimeout(timer);
			window.removeEventListener(CANVAS_LIST_EVENT, receive);
			resolve(graphs);
		};
		const receive = (event: Event) => {
			const msg = (event as CustomEvent<Extract<ServerMessage, { type: "canvas_list_result" }>>).detail;
			finish(msg.graphs);
		};
		const timer = setTimeout(() => finish([]), timeoutMs);
		window.addEventListener(CANVAS_LIST_EVENT, receive);
		try {
			if (!send()) finish([]);
		} catch {
			finish([]);
		}
	});
}
