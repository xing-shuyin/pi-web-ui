// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { McpServersPanel, type McpServersPanelProps } from "../../web/src/components/McpServersPanel";
import { LanguageProvider } from "../../web/src/i18n";
import { appSend } from "../../web/src/app-globals";
import type { ServerMessage, UiSettingsState } from "../../server/protocol";
vi.mock("../../web/src/app-globals", () => ({ appSend: vi.fn() }));
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	host?.remove();
	vi.useRealTimers();
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
		mcpServers: [{ name: "remote", scope: "project", url: "https://mcp.example", enabled: true, status: "stopped" }],
	} as UiSettingsState;
	const render = async (result?: Extract<ServerMessage, { type: "mcp_oauth_result" }>) => {
		await act(async () =>
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(McpServersPanel, { settings, chat: { mcpOAuthResult: result } } satisfies McpServersPanelProps),
				),
			),
		);
	};
	await render();
	await act(async () => button("OAuth login").click());
	const request = vi
		.mocked(appSend)
		.mock.calls.map(([msg]) => msg)
		.find((msg) => msg.type === "mcp_oauth_start")!;
	expect(request).toMatchObject({ name: "remote", scope: "project" });
	const pending = {
		type: "mcp_oauth_result" as const,
		reqId: (request as { reqId: string }).reqId,
		id: "login-id",
		status: "pending" as const,
		authorizationUrl: "https://auth.example/authorize",
		redirectUrl: "http://localhost:123/callback",
	};
	return { render, pending };
}
function button(text: string) {
	return Array.from(host.querySelectorAll("button")).find((button) => button.textContent === text)!;
}

describe("MCP OAuth modal", () => {
	it("renders safe authorization link, polls automatically and stops after completion", async () => {
		const { render, pending } = await mount();
		expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Preparing authorization");
		await render(pending);
		const link = host.querySelector('a[href="https://auth.example/authorize"]')!;
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
		expect(link.getAttribute("target")).toBe("_blank");
		vi.useFakeTimers();
		await render({ ...pending, status: "error" });
		await render(pending);
		await act(async () => vi.advanceTimersByTime(1500));
		expect(appSend).toHaveBeenCalledWith({ type: "mcp_oauth_status", reqId: pending.reqId, id: pending.id });
		await render({ ...pending, status: "complete" });
		expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Signed in");
		vi.mocked(appSend).mockClear();
		await act(async () => vi.advanceTimersByTime(3000));
		expect(appSend).not.toHaveBeenCalled();
		await act(async () => button("Close").click());
		expect(appSend).toHaveBeenCalledWith({ type: "mcp_oauth_cancel", reqId: pending.reqId });
	});

	it("submits pasted callback, clears it immediately, and renders sanitized errors", async () => {
		const { render, pending } = await mount();
		await render(pending);
		const input = host.querySelector<HTMLInputElement>("#mcp-oauth-redirect")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
				input,
				"http://localhost:123/callback?code=private",
			);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => button("Complete login").click());
		expect(appSend).toHaveBeenCalledWith({
			type: "mcp_oauth_finish",
			reqId: pending.reqId,
			id: pending.id,
			redirectUrl: "http://localhost:123/callback?code=private",
		});
		expect(input.value).toBe("");
		expect(input.disabled).toBe(true);
		await render({ ...pending, error: "Invalid redirect URL" });
		expect(input.disabled).toBe(false);
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid redirect URL");
		await render({ ...pending, status: "error", error: "provider-sensitive-data" });
		expect(host.querySelector('[role="alert"]')?.textContent).toContain("Authorization failed");
		expect(host.textContent).not.toContain("provider-sensitive-data");
	});

	it("ignores another request's response and cancels on unmount", async () => {
		const { render, pending } = await mount();
		await render({ ...pending, reqId: "another-request" });
		expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Preparing authorization");
		await act(async () => root!.unmount());
		root = undefined;
		expect(appSend).toHaveBeenCalledWith({ type: "mcp_oauth_cancel", reqId: pending.reqId });
	});
});
