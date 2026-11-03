// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DeviceExecutionSettings } from "../../web/src/components/DeviceExecutionSettings.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { DeviceTaskSchedulerSnapshot } from "../../server/protocol.js";
import { DEFAULT_EXECUTION_SETTINGS } from "../../server/device-center/execution-settings.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups
		.splice(0)
		.reverse()
		.forEach((fn) => fn());
	vi.unstubAllGlobals();
});

const mockSnapshot: DeviceTaskSchedulerSnapshot = {
	settings: { ...DEFAULT_EXECUTION_SETTINGS, maxActiveTasks: 4, maxWaitingTasks: 32 },
	activeCount: 1,
	waitingCount: 1,
	blockedCount: 1,
	running: [
		{
			taskId: "run-task-1111",
			attemptId: "att-1",
			roomId: "room-alpha",
			botId: "bot-worker",
			startedAt: Date.now() - 10000,
		},
	],
	waiting: [
		{
			taskId: "wait-task-2222",
			attemptId: "att-2",
			roomId: "room-beta",
			botId: "bot-worker",
			queuedAt: Date.now() - 5000,
			queuePosition: 1,
			blockReason: "bot_busy",
			blockReasonDetail: "Target bot is currently running another task",
			cancelable: true,
		},
	],
	blocked: [
		{
			taskId: "blocked-task-3333",
			attemptId: "att-3",
			roomId: "room-gamma",
			botId: "bot-crashed",
			reason: "unconfirmed_stop",
		},
	],
};

function response(body: unknown, status = 200) {
	return {
		ok: status < 400,
		status,
		json: async () => body,
	} as Response;
}

function setInputValue(input: HTMLInputElement, value: string) {
	const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
	nativeSetter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function mount(props: { hubUrl?: string; deviceId?: string; onNotice?: (text: string) => void }) {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	await act(async () => {
		root.render(createElement(LanguageProvider, null, createElement(DeviceExecutionSettings, props)));
	});
	return { container, root };
}

describe("DeviceExecutionSettings Component", () => {
	it("fetches execution queue with appUrl/withToken and same-origin credentials on mount", async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const str = String(url);
			if (str.includes("execution-queue")) {
				return response(mockSnapshot);
			}
			return response({});
		});
		vi.stubGlobal("fetch", fetchMock);

		const { container } = await mount({ hubUrl: "http://hub.example.com", deviceId: "device-1" });

		const queueCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/device-center/execution-queue"));
		expect(queueCall).toBeDefined();
		const [calledUrl, calledInit] = queueCall!;
		expect(String(calledUrl)).toContain("/api/device-center/execution-queue");
		expect(calledInit?.credentials).toBe("same-origin");

		// Verify state display
		expect(container.textContent).toContain("执行调度与队列可观测");
		expect(container.textContent).toContain("run-task");
		expect(container.textContent).toContain("wait-tas");
		expect(container.textContent).toContain("Bot 忙碌中");
		expect(container.textContent).toContain("隔离占槽任务 (停止未确认)");
	});

	it("saves updated settings with credentials and triggers notice callback", async () => {
		const onNotice = vi.fn();
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const str = String(url);
			if (str.includes("execution-settings") && init?.method === "POST") {
				const body = JSON.parse(String(init.body));
				return response({ settings: body });
			}
			if (str.includes("execution-queue")) {
				return response(mockSnapshot);
			}
			return response({});
		});
		vi.stubGlobal("fetch", fetchMock);

		const { container } = await mount({ deviceId: "device-1", onNotice });

		// Change active input using React-compatible setter
		const activeInput = container.querySelector<HTMLInputElement>("#des-max-active");
		expect(activeInput).not.toBeNull();
		await act(async () => {
			setInputValue(activeInput!, "8");
		});

		// Submit form
		const form = container.querySelector<HTMLFormElement>("form");
		expect(form).not.toBeNull();
		await act(async () => {
			form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/device-center/execution-settings"),
			expect.objectContaining({
				method: "POST",
				credentials: "same-origin",
				body: JSON.stringify({
					...mockSnapshot.settings,
					maxActiveTasks: 8,
				}),
			}),
		);

		expect(onNotice).toHaveBeenCalledWith("调度设置已持久化并应用");
	});

	it("cancels waiting task with taskId and attemptId", async () => {
		const onNotice = vi.fn();
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const str = String(url);
			if (str.includes("execution-queue/cancel") && init?.method === "POST") {
				return response({ cancelled: true });
			}
			if (str.includes("execution-queue")) {
				return response(mockSnapshot);
			}
			return response({});
		});
		vi.stubGlobal("fetch", fetchMock);

		const { container } = await mount({ deviceId: "device-1", onNotice });

		// Find cancel button in waiting table
		const cancelBtn = container.querySelector<HTMLButtonElement>(".des-btn-danger-sm");
		expect(cancelBtn).not.toBeNull();
		expect(cancelBtn!.textContent).toBe("取消任务");

		await act(async () => {
			cancelBtn!.click();
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/api/device-center/execution-queue/cancel"),
			expect.objectContaining({
				method: "POST",
				credentials: "same-origin",
				body: JSON.stringify({ taskId: "wait-task-2222", attemptId: "att-2" }),
			}),
		);

		expect(onNotice).toHaveBeenCalledWith("任务已取消");
	});

	it("aborts in-flight request when binding deviceId changes", async () => {
		const signals: AbortSignal[] = [];
		const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const str = String(url);
			if (str.includes("execution-queue")) {
				signals.push(init?.signal as AbortSignal);
				return new Promise<Response>(() => {}); // Never resolves to simulate pending network
			}
			return response({});
		});
		vi.stubGlobal("fetch", fetchMock);

		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		cleanups.push(() => {
			act(() => root.unmount());
			container.remove();
		});

		await act(async () => {
			root.render(
				createElement(LanguageProvider, null, createElement(DeviceExecutionSettings, { deviceId: "device-old" })),
			);
		});

		expect(signals.length).toBe(1);
		expect(signals[0]!.aborted).toBe(false);

		// Switch to a new deviceId
		await act(async () => {
			root.render(
				createElement(LanguageProvider, null, createElement(DeviceExecutionSettings, { deviceId: "device-new" })),
			);
		});

		// The previous in-flight request (signals[0]) MUST be aborted!
		expect(signals[0]!.aborted).toBe(true);
		expect(signals.length).toBe(2);
		expect(signals[1]!.aborted).toBe(false);
	});

	it("renders all 5 feature groups and 14 execution parameters", async () => {
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const str = String(url);
			if (str.includes("execution-queue")) {
				return response(mockSnapshot);
			}
			return response({});
		});
		vi.stubGlobal("fetch", fetchMock);

		const { container } = await mount({ deviceId: "device-1" });

		// 5 feature groups
		expect(container.textContent).toContain("调度并发");
		expect(container.textContent).toContain("任务派发与协作");
		expect(container.textContent).toContain("群上下文与历史");
		expect(container.textContent).toContain("文件同步配额");
		expect(container.textContent).toContain("资源锁与黑板");

		// All 14 inputs
		const ids = [
			"#des-max-active",
			"#des-max-waiting",
			"#des-starvation-ms",
			"#des-max-skips",
			"#des-max-depth",
			"#des-max-budget",
			"#des-allow-bot-mentions",
			"#des-group-context-bytes",
			"#des-group-retention",
			"#des-file-sync-bytes",
			"#des-file-sync-files",
			"#des-file-sync-staged-bytes",
			"#des-resource-lock-ttl",
			"#des-blackboard-bytes",
		];
		for (const id of ids) {
			const el = container.querySelector(id);
			expect(el, `Input ${id} should exist`).not.toBeNull();
		}
	});

	it("resets drafts to default settings via reset defaults button", async () => {
		const customSnapshot: DeviceTaskSchedulerSnapshot = {
			...mockSnapshot,
			settings: {
				...DEFAULT_EXECUTION_SETTINGS,
				maxActiveTasks: 12,
				maxWaitingTasks: 64,
				starvationThresholdMs: 15000,
				allowBotMentions: true,
			},
		};
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const str = String(url);
			if (str.includes("execution-queue")) {
				return response(customSnapshot);
			}
			return response({});
		});
		vi.stubGlobal("fetch", fetchMock);

		const { container } = await mount({ deviceId: "device-1" });

		const activeInput = container.querySelector<HTMLInputElement>("#des-max-active")!;
		const waitingInput = container.querySelector<HTMLInputElement>("#des-max-waiting")!;
		const mentionsInput = container.querySelector<HTMLInputElement>("#des-allow-bot-mentions")!;

		expect(activeInput.value).toBe("12");
		expect(waitingInput.value).toBe("64");
		expect(mentionsInput.checked).toBe(true);

		// Find and click the Reset Defaults button
		const resetButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
		const resetDefaultsBtn = resetButtons.find((b) => b.textContent?.includes("恢复默认值"));
		expect(resetDefaultsBtn).toBeDefined();

		await act(async () => {
			resetDefaultsBtn!.click();
		});

		expect(activeInput.value).toBe(String(DEFAULT_EXECUTION_SETTINGS.maxActiveTasks));
		expect(waitingInput.value).toBe(String(DEFAULT_EXECUTION_SETTINGS.maxWaitingTasks));
		expect(mentionsInput.checked).toBe(DEFAULT_EXECUTION_SETTINGS.allowBotMentions);
	});
});
