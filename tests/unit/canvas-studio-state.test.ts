// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasStudio } from "../../web/src/components/canvas/CanvasStudio";
import { en, LanguageProvider } from "../../web/src/i18n";
import type { CanvasGraph, ServerMessage, ModelInfo } from "../../server/protocol";
const connection = vi.hoisted(() => ({
	notify: (_connected: boolean) => {},
	load: (_request: { id: string; requestId: string }) => {},
}));
vi.mock("../../web/src/components/canvas/canvas-client", () => ({
	CanvasClient: class {
		static readLastGraphId() {
			return localStorage.getItem("pi-web-ui.canvas.lastGraphId") ?? "default";
		}
		onLoadRequest?: (request: { id: string; requestId: string }) => void;
		connect() {
			connection.load = (request) => this.onLoadRequest?.(request);
		}
		subscribeConnection(fn: (connected: boolean) => void) {
			connection.notify = fn;
			return () => {};
		}
		subscribe() {
			return () => {};
		}
		dispose() {}
		send() {
			return false;
		}
		setCurrentGraphId() {}
	},
}));
const graph = (): CanvasGraph => ({
	id: "g",
	name: "Loaded graph",
	createdAt: 1,
	updatedAt: 1,
	rev: 2,
	viewport: { x: 0, y: 0, zoom: 1 },
	nodes: [],
	edges: [],
	status: "idle",
	executionMode: "real",
});
let cleanup = () => {};
afterEach(() => {
	cleanup();
	localStorage.clear();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});
function mount() {
	vi.spyOn(navigator, "languages", "get").mockReturnValue(["en"]);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const send = vi.fn();
	const render = (active = true, lastMessage?: ServerMessage, models: ModelInfo[] = [], defaultModel?: string) =>
		act(() =>
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(CanvasStudio, { active, send, lastMessage, models, defaultModel }),
				),
			),
		);
	cleanup = () => act(() => root.unmount());
	return { host, send, render };
}
function save() {
	act(() =>
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })),
	);
}
describe("Studio request and visibility boundaries", () => {
	it("shows uncorrelated runtime errors only for the current graph without clearing pending saves or changing draft status", () => {
		const { render, send, host } = mount();
		render();
		save();
		const request = send.mock.calls.find(([m]) => m.type === "canvas_save")![0];
		render(true, {
			type: "canvas_error",
			code: "execution_error",
			graphId: request.graph.id,
			message: "engine unavailable",
		});
		expect(host.textContent).toContain(en["canvas.studio.runFailed"].replace("{name}", "engine unavailable"));
		render(true, {
			type: "canvas_error",
			code: "execution_error",
			graphId: "another-graph",
			message: "unrelated failure",
		});
		expect(host.textContent).not.toContain("unrelated failure");
		save();
		expect(send.mock.calls.filter(([m]) => m.type === "canvas_save")).toHaveLength(1);
		expect(JSON.parse(localStorage.getItem(`pi-web-ui.canvas.draft.${request.graph.id}`)!).status).toBe(
			request.graph.status,
		);
		render(true, { type: "canvas_graph_state", graph: { ...request.graph, rev: 1 }, requestId: request.requestId });
		expect(host.textContent).toContain(en["canvas.studio.saved"]);
	});
	it("model catalog arrival never rewrites existing engine models or creates an autosave", () => {
		vi.useFakeTimers();
		try {
			const { render, send } = mount();
			render();
			act(() => connection.load({ id: "g", requestId: "initial" }));
			const remote = graph();
			remote.nodes = [
				{
					id: "claude",
					title: "Claude",
					role: "coder",
					engine: "claude",
					model: "",
					cwd: ".",
					useWorktree: false,
					x: 0,
					y: 0,
					status: "idle",
				},
				{
					id: "dsh",
					title: "DSH",
					role: "coder",
					engine: "dsh",
					model: "custom/unlisted",
					cwd: ".",
					useWorktree: false,
					x: 350,
					y: 0,
					status: "idle",
				},
			];
			render(true, { type: "canvas_graph_state", graph: remote, requestId: "initial" });
			render(true, undefined, [{ id: "cat", provider: "pi-catalog", name: "Cat" } as ModelInfo], "pi-catalog/cat");
			act(() => vi.advanceTimersByTime(31000));
			expect(send.mock.calls.filter(([m]) => m.type === "canvas_save")).toHaveLength(0);
			save();
			const saved = send.mock.calls.find(([m]) => m.type === "canvas_save")![0];
			expect(saved.graph.nodes.map((n: CanvasGraph["nodes"][number]) => [n.engine, n.model])).toEqual([
				["claude", ""],
				["dsh", "custom/unlisted"],
			]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("starts empty and does not replace the initial load when activated", () => {
		const { render, send, host } = mount();
		render(false);
		expect(host.querySelectorAll(".canvas-node-card")).toHaveLength(0);
		render(true); // Activate before socket open: placeholder must never issue a load.
		expect(send.mock.calls.filter(([m]) => m.type === "canvas_load")).toHaveLength(0);
		act(() => connection.load({ id: "default", requestId: "initial" }));
		render(false);
		render(true); // Activate again while initial load remains pending.
		expect(send.mock.calls.filter(([m]) => m.type === "canvas_load")).toHaveLength(0);
		render(true, {
			type: "canvas_graph_state",
			graph: { ...graph(), id: "default", name: "Server default" },
			requestId: "initial",
		});
		save();
		const saved = send.mock.calls.find(([m]) => m.type === "canvas_save")![0];
		expect(saved.graph.id).toBe("default");
		expect(saved.graph.name).toBe("Server default");
	});
	it("falls back from a missing last graph with a correlated default request", () => {
		localStorage.setItem("pi-web-ui.canvas.lastGraphId", "deleted");
		const { render, send, host } = mount();
		render(false);
		act(() => connection.load({ id: "deleted", requestId: "missing" }));
		render(true);
		render(true, {
			type: "canvas_error",
			code: "not_found",
			message: "missing graph",
			graphId: "deleted",
			requestId: "missing",
		});
		const load = send.mock.calls.find(([m]) => m.type === "canvas_load")![0];
		expect(load.id).toBe("default");
		expect(load.requestId).toBeTruthy();
		expect(load.requestId).not.toBe("missing");
		render(true, {
			type: "canvas_graph_state",
			graph: { ...graph(), id: "default", name: "Fallback default" },
			requestId: load.requestId,
		});
		expect(host.textContent).not.toContain(en["canvas.studio.loading"]);
		expect(host.querySelectorAll(".canvas-node-card")).toHaveLength(0);
	});
	it.each([true, false])("unblocks save after disconnect and read-back (committed=%s)", (committed) => {
		const { render, send, host } = mount();
		render();
		save();
		const request = send.mock.calls.find(([m]) => m.type === "canvas_save")![0];
		act(() => connection.notify(false));
		expect(host.textContent).toContain(en["canvas.studio.disconnectedHint"]);
		act(() => connection.load({ id: request.graph.id, requestId: "reconnect" }));
		const remote = { ...request.graph, rev: committed ? 1 : 0, ...(!committed ? { name: "remote differs" } : {}) };
		render(true, { type: "canvas_graph_state", graph: remote, requestId: "reconnect" });
		if (committed) expect(host.textContent).toContain(en["canvas.studio.reconnectedSaved"]);
		else {
			expect(host.textContent).toContain(en["canvas.studio.reconnectedConflict"]);
			const button = Array.from(host.querySelectorAll("button")).find(
				(b) => b.textContent === en["canvas.studio.keepLocalDraft"],
			)!;
			act(() => button.click());
		}
		save();
		expect(send.mock.calls.filter(([m]) => m.type === "canvas_save")).toHaveLength(2);
		const latest = send.mock.calls.filter(([m]) => m.type === "canvas_save").at(-1)![0];
		render(true, { type: "canvas_graph_state", graph: { ...request.graph, rev: 99 }, requestId: request.requestId });
		render(true, { type: "canvas_error", code: "save_failed", message: "late failure", requestId: request.requestId });
		save(); // Old reply must leave the new request pending, so no third save is sent.
		expect(send.mock.calls.filter(([m]) => m.type === "canvas_save")).toHaveLength(2);
		expect(host.textContent).not.toContain("late failure");
		render(true, { type: "canvas_graph_state", graph: { ...latest.graph, rev: 2 }, requestId: latest.requestId });
		expect(host.textContent).toContain(en["canvas.studio.saved"]);
	});
	it("does not intercept shortcuts while inactive", () => {
		const { render, send } = mount();
		render(false);
		save();
		expect(send).not.toHaveBeenCalled();
		render(true);
		save();
		expect(send.mock.calls.some(([m]) => m.type === "canvas_save")).toBe(true);
	});
	it("retains visible failure and ignores conflict's following state", () => {
		const { render, send, host } = mount();
		render();
		save();
		const request = send.mock.calls.find(([m]) => m.type === "canvas_save")![0];
		const remote = { ...request.graph, name: "Remote must not replace draft", rev: 20 };
		render(true, {
			type: "canvas_error",
			code: "rev_conflict",
			message: "conflict",
			graph: remote,
			graphId: remote.id,
			requestId: request.requestId,
		});
		expect(host.textContent).toContain(en["canvas.studio.operationFailed"].replace("{name}", "conflict"));
		render(true, { type: "canvas_graph_state", graph: remote, requestId: request.requestId });
		expect(host.textContent).toContain(en["canvas.studio.operationFailed"].replace("{name}", "conflict"));
		expect(host.textContent).toContain(en["canvas.studio.keepLocalDraft"]);
	});
	it("unrelated broadcasts never change the current graph or save target", () => {
		const { render, send } = mount();
		render();
		save();
		const first = send.mock.calls.find(([m]) => m.type === "canvas_save")![0];
		render(true, { type: "canvas_graph_state", graph: first.graph, requestId: first.requestId });
		render(true, { type: "canvas_graph_state", graph: graph() });
		save();
		const saves = send.mock.calls.filter(([m]) => m.type === "canvas_save");
		expect(saves.at(-1)![0].graph.id).toBe(first.graph.id);
	});
});
