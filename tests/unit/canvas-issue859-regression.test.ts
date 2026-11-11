import { describe, expect, it, vi, afterEach } from "vitest";
import { parseGraphImport } from "../../web/src/components/canvas/canvas-state";
import type { CanvasGraph } from "../../server/protocol";
import { en } from "../../web/src/i18n";
const t = ((k: string) => (en as any)[k] ?? k) as any;
const baseGraph = (): CanvasGraph => ({
	id: "g",
	name: "G",
	viewport: { x: 0, y: 0, zoom: 1 },
	nodes: [
		{
			id: "a",
			title: "A",
			role: "coder",
			x: 0,
			y: 0,
			engine: "pi",
			model: "",
			cwd: ".",
			useWorktree: false,
			status: "idle",
		},
	],
	edges: [],
	status: "idle",
	createdAt: 1,
	updatedAt: 1,
});
describe("issue 859 regression", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});
	it("import generates safe id without secure-context randomUUID", () => {
		const orig = (globalThis as any).crypto;
		vi.stubGlobal("crypto", { getRandomValues: orig?.getRandomValues?.bind(orig) });
		const raw = JSON.stringify(baseGraph());
		const imported = parseGraphImport(raw, true, t as any);
		expect(imported.id).toMatch(/^graph_[A-Za-z0-9._-]{1,64}$/);
		expect(imported.rev).toBe(0);
	});
});
