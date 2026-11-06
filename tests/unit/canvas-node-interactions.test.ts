// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../../web/src/i18n";
import { CanvasNodeCard, type CanvasNodeCardProps } from "../../web/src/components/canvas/CanvasNodeCard";
import { CanvasToolbar, type CanvasToolbarProps } from "../../web/src/components/canvas/CanvasToolbar";
import { getSquadTemplates } from "../../web/src/components/canvas/CanvasTemplates";
import { en, type Translate } from "../../web/src/i18n";

const translate: Translate = (key) => en[key];
const SQUAD_TEMPLATES = getSquadTemplates(translate);
let root: Root | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});
function mount(child: ReturnType<typeof createElement>) {
	const el = document.createElement("div");
	document.body.append(el);
	root = createRoot(el);
	act(() => root!.render(createElement(LanguageProvider, null, child)));
	return el;
}
function props(role: CanvasNodeCardProps["node"]["role"] = "trigger"): CanvasNodeCardProps {
	return {
		node: {
			id: "n1",
			role,
			title: "Example",
			x: 100,
			y: 200,
			engine: "pi",
			model: "",
			cwd: ".",
			useWorktree: false,
			status: "idle",
		},
		zoom: 0.5,
		isSelected: false,
		models: [],
		projects: [],
		onSelect: vi.fn(),
		onUpdate: vi.fn(),
		onDelete: vi.fn(),
		onRun: vi.fn(),
		onStop: vi.fn(),
		onOpenDrawer: vi.fn(),
		onStartConnect: vi.fn(),
		onEndConnect: vi.fn(),
		onDragStart: vi.fn(),
	};
}
describe("canvas pointer and capability controls", () => {
	it("converts pointer displacement by zoom and only snapshots a drag once", () => {
		const p = props();
		const el = mount(createElement(CanvasNodeCard, p));
		const header = el.querySelector(".canvas-node-header") as HTMLElement;
		header.setPointerCapture = vi.fn();
		header.releasePointerCapture = vi.fn();
		act(() =>
			header.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 30, pointerId: 1 }),
			),
		);
		act(() =>
			header.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 40, clientY: 60, pointerId: 1 })),
		);
		expect(p.onUpdate).toHaveBeenLastCalledWith("n1", { x: 140, y: 260 });
		expect(p.onDragStart).toHaveBeenCalledTimes(1);
		act(() => header.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 })));
		act(() =>
			header.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 80, clientY: 90, pointerId: 1 })),
		);
		expect(p.onUpdate).toHaveBeenCalledTimes(1);
	});
	it("does not drag while editing a title", () => {
		const p = props();
		const el = mount(createElement(CanvasNodeCard, p));
		act(() => el.querySelector("input")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
		expect(p.onDragStart).not.toHaveBeenCalled();
	});
	it("exposes human reject port for elementFromPoint", () => {
		const el = mount(createElement(CanvasNodeCard, props("human")));
		expect(
			el.querySelector('[data-canvas-node-id="n1"][data-canvas-port="reject"][data-canvas-port-direction="out"]'),
		).toBeTruthy();
		expect(el.querySelector('.canvas-node-card[data-canvas-node-id="n1"]')).toBeTruthy();
	});
	it.each(["cron", "webhook", "memory", "subflow"] as const)(
		"blocks %s execution and hides editable config",
		(role) => {
			const p = props(role);
			const el = mount(createElement(CanvasNodeCard, p));
			const button = el.querySelector(".canvas-btn.run") as HTMLButtonElement;
			expect(button.disabled).toBe(true);
			expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/未实现|Not implemented/);
			expect(el.querySelector(".canvas-instruction-input")).toBeNull();
			act(() => button.click());
			expect(p.onRun).not.toHaveBeenCalled();
		},
	);
	it("portals the palette to body and closes on outside click", () => {
		const graph = SQUAD_TEMPLATES[0].createGraph();
		const p: CanvasToolbarProps = {
			graph,
			graphList: [],
			onSelectGraph: vi.fn(),
			onSave: vi.fn(),
			onAddNode: vi.fn(),
			onApplyTemplate: vi.fn(),
			onRunAll: vi.fn(),
			onStopAll: vi.fn(),
			onResetStatus: vi.fn(),
			onCreateGraph: vi.fn(),
			onDeleteGraph: vi.fn(),
			onRenameGraph: vi.fn(),
			onFitView: vi.fn(),
			onUndo: vi.fn(),
			onRedo: vi.fn(),
			onDuplicate: vi.fn(),
			onAutoLayout: vi.fn(),
			zoom: 1,
			onZoomChange: vi.fn(),
			onResetViewport: vi.fn(),
		};
		const el = mount(createElement(CanvasToolbar, p));
		const btn = [...el.querySelectorAll("button")].find(
			(b) => b.textContent?.includes("节点库") || b.textContent?.includes("Node library"),
		)!;
		act(() => btn.click());
		const menu = document.body.querySelector(".canvas-node-palette") as HTMLElement;
		expect(menu.parentElement).toBe(document.body);
		expect(menu.style.position).toBe("fixed");
		expect([...menu.querySelectorAll("b")].map((b) => b.textContent).join(" ")).not.toMatch(
			/Webhook|Cron|Memory|Subflow|定时触发|记忆读写/,
		);
		act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
		expect(document.body.querySelector(".canvas-node-palette")).toBeNull();
	});
});
