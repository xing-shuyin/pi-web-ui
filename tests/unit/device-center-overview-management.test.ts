// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DeviceCenter } from "../../web/src/components/DeviceCenter.js";
import { DeviceDirectory } from "../../web/src/components/DeviceDirectory.js";
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

function response(body: unknown, status = 200) {
	return { ok: status < 400, status, json: async () => body } as Response;
}

describe("device center overview and remark management", () => {
	it("prefers remark over original device name in DeviceDirectory and allows setting remark", async () => {
		localStorage.setItem("pi-web-ui:lang", "zh");
		let currentRemark: string | undefined = "我的办公电脑";
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			const path = new URL(url, window.location.href).pathname;
			if (path === "/api/device-center/devices" && (!init?.method || init.method === "GET")) {
				return response({
					devices: [
						{ id: "dev-1", name: "DESKTOP-S1QKEI6", remark: currentRemark, online: true },
						{ id: "dev-2", name: "cdeMac-mini.local", remark: null, online: false },
					],
				});
			}
			if (path === "/api/device-center/devices/dev-2/remark" && init?.method === "POST") {
				const body = JSON.parse(init.body as string);
				return response({ device: { id: "dev-2", name: "cdeMac-mini.local", remark: body.remark, online: false } });
			}
			return response({}, 404);
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
				createElement(
					LanguageProvider,
					null,
					createElement(DeviceDirectory, { hubUrl: "http://198.51.100.10:50001", currentDeviceId: "dev-1" }),
				),
			);
		});

		const items = container.querySelectorAll(".dd-device");
		expect(items).toHaveLength(2);

		const dev1Identity = items[0].querySelector(".dd-identity")!;
		expect(dev1Identity.querySelector("strong")?.textContent).toBe("我的办公电脑");
		expect(dev1Identity.querySelector("span")?.textContent).toContain("DESKTOP-S1QKEI6");

		const dev2Identity = items[1].querySelector(".dd-identity")!;
		expect(dev2Identity.querySelector("strong")?.textContent).toBe("cdeMac-mini.local");

		const editButton = items[1].querySelector<HTMLButtonElement>('.dc-actions button[title="设置备注"]')!;
		expect(editButton).not.toBeNull();
		await act(async () => editButton.click());

		const form = items[1].querySelector(".dd-remark-form");
		expect(form).not.toBeNull();
		const input = form!.querySelector<HTMLInputElement>("input")!;
		await act(async () => {
			const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			nativeSetter?.call(input, "家庭迷你主机");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});

		await act(async () => {
			form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});

		const updatedItems = container.querySelectorAll(".dd-device");
		expect(updatedItems[1].querySelector(".dd-identity strong")?.textContent).toBe("家庭迷你主机");
		expect(updatedItems[1].querySelector(".dd-identity span")?.textContent).toContain("cdeMac-mini.local");
	});

	it("shows bot list, device list, and group list on overview without displaying chat messages", async () => {
		localStorage.setItem("pi-web-ui:lang", "zh");
		const fetchMock = vi.fn(async (url: string) => {
			const path = new URL(url, window.location.href).pathname;
			switch (path) {
				case "/api/device-center/status":
					return response({
						name: "DESKTOP-S1QKEI6",
						remark: "工作站主控机",
						hubUrl: "http://198.51.100.10:50001",
						deviceId: "dev-1",
						allowExecution: true,
						connected: true,
					});
				case "/api/device-center/devices":
					return response({
						devices: [{ id: "dev-1", name: "DESKTOP-S1QKEI6", remark: "工作站主控机", online: true }],
					});
				case "/api/device-center/local-bots":
				case "/api/device-center/bots":
					return response({
						bots: [
							{
								id: "bot-1",
								name: "代码评审助手",
								enabled: true,
								revision: 1,
								description: "自动审查代码",
								systemPrompt: "review code",
								cwd: "/workspace",
								tools: [],
								skills: [],
								mcpServers: [],
							},
						],
					});
				case "/api/device-center/rooms":
					return response({
						rooms: [{ id: "room-1", name: "开发协作群", botIds: ["bot-1"], primaryBotId: "bot-1" }],
					});
				case "/api/device-center/execution-queue":
					return response({
						settings: { ...DEFAULT_EXECUTION_SETTINGS },
						activeCount: 0,
						waitingCount: 0,
						blockedCount: 0,
						running: [],
						waiting: [],
						blocked: [],
					} satisfies DeviceTaskSchedulerSnapshot);
				case "/api/device-desktop/local/status":
					return response({ os: "win32", enabled: false, environmentEnabled: false, supported: true });
				default:
					return response({}, 200);
			}
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
			root.render(createElement(LanguageProvider, null, createElement(DeviceCenter)));
		});

		const summary = container.querySelector(".dc-device-summary")!;
		expect(summary).not.toBeNull();
		expect(summary.querySelector("h2")?.textContent).toBe("工作站主控机");
		expect(summary.querySelector("p")?.textContent).toContain("DESKTOP-S1QKEI6");

		const deviceSection = container.querySelector('section[aria-label="所有设备"]');
		expect(deviceSection).not.toBeNull();
		expect(deviceSection?.textContent).toContain("工作站主控机");

		const botSection = container.querySelector(".dc-bots");
		expect(botSection).not.toBeNull();
		expect(botSection?.textContent).toContain("代码评审助手");

		const groups = [...container.querySelectorAll("nav.dc-sidebar button")].find(
			(button) => button.textContent === "群组与工单",
		) as HTMLButtonElement;
		await act(async () => groups.click());
		const groupSection = container.querySelector('section[aria-label="群聊列表"]');
		expect(groupSection).not.toBeNull();
		expect(groupSection?.textContent).toContain("开发协作群");
		expect(groupSection?.textContent).toContain("主 Bot: 代码评审助手");

		expect(container.querySelector(".dg-chat-messages")).toBeNull();
		expect(container.querySelector(".dg-message-form")).toBeNull();
		expect(container.querySelector("textarea")).toBeNull();
	});
});
