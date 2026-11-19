// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { McpServersPanel, type McpServersPanelProps } from "../../web/src/components/McpServersPanel";
import { LanguageProvider } from "../../web/src/i18n";
import { appSend } from "../../web/src/app-globals";
import type { UiSettingsState } from "../../server/protocol";
vi.mock("../../web/src/app-globals", () => ({ appSend: vi.fn() }));

let root: Root | undefined;
let host: HTMLDivElement;

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	host?.remove();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

async function mount() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ packs: [] }) })),
	);
	localStorage.setItem("pi-web-ui:lang", "en");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const settings = {
		mcpServers: [
			{
				name: "srv",
				scope: "global",
				command: "node",
				enabled: true,
				status: "stopped",
				exposure: "direct",
				toolExposure: { click: "hidden" },
			},
		],
	} as unknown as UiSettingsState;
	await act(async () =>
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(McpServersPanel, { settings } satisfies McpServersPanelProps),
			),
		),
	);
	await act(async () => host.querySelector<HTMLButtonElement>('button[title="Edit"]')!.click());
}

function button(text: string) {
	return Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent === text)!;
}

function selectExposure(value: string) {
	const select = host.querySelector<HTMLSelectElement>("#mcp-exposure-select")!;
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

describe("MCP 暴露方式下拉（issue #941）", () => {
	it("打开编辑弹窗显示服务器当前的 exposure，保存时把它带回服务端", async () => {
		await mount();
		const select = host.querySelector<HTMLSelectElement>("#mcp-exposure-select")!;
		expect(select.value).toBe("direct");
		expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "direct", "deferred", "hidden"]);

		selectExposure("hidden");
		await act(async () => button("Save").click());
		const saved = vi
			.mocked(appSend)
			.mock.calls.map(([message]) => message)
			.find((message) => message.type === "save_mcp_server");
		expect(saved).toMatchObject({ server: { name: "srv", exposure: "hidden" } });
	});

	it("选「默认」时发 null，让服务端删字段回到 pi 的 codemode", async () => {
		await mount();
		selectExposure("");
		await act(async () => button("Save").click());
		const saved = vi
			.mocked(appSend)
			.mock.calls.map(([message]) => message)
			.find((message) => message.type === "save_mcp_server");
		expect(saved).toMatchObject({ server: { name: "srv", exposure: null, toolExposure: { click: "hidden" } } });
	});
});
