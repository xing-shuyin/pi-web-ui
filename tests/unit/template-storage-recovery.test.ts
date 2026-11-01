// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TemplateProvider, useTemplates } from "../../web/src/components/PromptTemplates";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals";
import { LanguageProvider } from "../../web/src/i18n";

let root: Root | undefined;
const response = () => ({ ok: true, json: async () => ({ templates: [] }) });

function mockTemplateFetch(fetch: (url: string) => unknown) {
	vi.stubGlobal("fetch", (url: string) =>
		url.endsWith("/api/prompt-templates") ? fetch(url) : Promise.resolve({ ok: true, json: async () => ({}) }),
	);
}

async function mount() {
	localStorage.setItem("pi-web-ui:lang", "zh");
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TemplateProvider, {
					currentModelId: null,
					children: createElement(Consumer),
				}),
			),
		);
	});
}

function Consumer() {
	return createElement("span", null, useTemplates().templates.length);
}

async function status(value: "open" | "closed") {
	await act(async () => {
		setAppGlobals({ status: value });
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	localStorage.clear();
	resetAppGlobals();
	vi.unstubAllGlobals();
});

describe("template storage recovery", () => {
	it("waits for connection and clears the failed read after reconnect", async () => {
		const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(response());
		mockTemplateFetch(fetch);
		await mount();
		expect(fetch).not.toHaveBeenCalled();
		await status("open");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("Failed to fetch");
		await status("closed");
		await status("open");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});

	it("retries on network recovery and clears the error", async () => {
		mockTemplateFetch(vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(response()));
		await mount();
		await status("open");
		expect(document.querySelector('[role="alert"]')).not.toBeNull();
		await act(async () => {
			window.dispatchEvent(new Event("online"));
		});
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});

	it("ignores a stale failed read after a newer refresh succeeds", async () => {
		let rejectOld!: (error: Error) => void;
		const old = new Promise((_, reject) => {
			rejectOld = reject;
		});
		mockTemplateFetch(vi.fn().mockReturnValueOnce(old).mockResolvedValue(response()));
		await mount();
		await status("open");
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		await act(async () => {
			rejectOld(new TypeError("Failed to fetch"));
		});
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});
});
