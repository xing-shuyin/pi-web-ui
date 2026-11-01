// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi, describe } from "vitest";
import { GroupWorkspaceActions } from "../../web/src/components/GroupWorkspaceActions";
import { LanguageProvider } from "../../web/src/i18n";

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("GroupWorkspaceActions Component Integration", () => {
	async function mountComponent(props: Parameters<typeof GroupWorkspaceActions>[0]) {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(createElement(LanguageProvider, null, createElement(GroupWorkspaceActions, props)));
		});
		return {
			host,
			cleanup: () => {
				act(() => root.unmount());
				host.remove();
			},
		};
	}

	it("renders ready plan and enforces explicit start button execution", async () => {
		const startMock = vi.fn().mockResolvedValue(undefined);
		const { host, cleanup } = await mountComponent({
			roomId: "room-1",
			activeTaskId: "task-101",
			planState: {
				state: "ready",
				steps: [{ id: "s1", title: "Survey API" }],
			},
			onStartPlanExecution: startMock,
		});

		const startBtn = host.querySelector<HTMLButtonElement>(".start-plan-btn");
		expect(startBtn).not.toBeNull();
		expect(startBtn?.textContent).toMatch(/Start Execution|开始实施/);

		await act(async () => {
			startBtn?.click();
		});

		expect(startMock).toHaveBeenCalledWith("task-101");
		cleanup();
	});

	it("hides start button when plan is still in draft state", async () => {
		const startMock = vi.fn();
		const { host, cleanup } = await mountComponent({
			roomId: "room-1",
			activeTaskId: "task-102",
			planState: {
				state: "draft",
				steps: [{ id: "s1", title: "Still drafting" }],
			},
			onStartPlanExecution: startMock,
		});

		const startBtn = host.querySelector<HTMLButtonElement>(".start-plan-btn");
		expect(startBtn).toBeNull();
		cleanup();
	});

	it("displays canvas note indicating no auto-run, launches explicitly on click", async () => {
		const launchMock = vi.fn().mockResolvedValue(undefined);
		const { host, cleanup } = await mountComponent({
			roomId: "room-1",
			canvasRef: {
				graphId: "canvas-graph-42",
				title: "Data Pipeline",
				boundAt: Date.now(),
			},
			onLaunchCanvas: launchMock,
		});

		expect(host.textContent).toMatch(/will not run automatically|引用不会自动运行/);
		expect(launchMock).not.toHaveBeenCalled();

		const launchBtn = host.querySelector<HTMLButtonElement>(".launch-canvas-btn");
		expect(launchBtn).not.toBeNull();

		await act(async () => {
			launchBtn?.click();
		});

		expect(launchMock).toHaveBeenCalledWith("canvas-graph-42");
		cleanup();
	});

	it("locks preset snapshot on active in-flight task, prevents hot-reload", async () => {
		const applyMock = vi.fn().mockResolvedValue(undefined);
		const { host, cleanup } = await mountComponent({
			roomId: "room-1",
			taskSnapshotRevision: 1, // in-flight task locked to rev 1
			botSnapshot: {
				botId: "bot-agent",
				revision: 2, // new preset candidate is rev 2
				name: "Agent Bot",
				toolWhitelist: ["read", "write"],
				capturedAt: Date.now(),
			},
			onApplyPresetSnapshot: applyMock,
		});

		const applyBtn = host.querySelector<HTMLButtonElement>(".apply-preset-btn");
		expect(applyBtn).not.toBeNull();
		expect(applyBtn?.disabled).toBe(true);
		expect(applyBtn?.title).toMatch(/Active tasks cannot hot-reload presets|在途任务禁止热改预设/);

		await act(async () => {
			applyBtn?.click();
		});

		expect(applyMock).not.toHaveBeenCalled();
		cleanup();
	});
});
