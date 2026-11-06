// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const service = "https://hub.example/device/desktop/__relay/capability";
let root: Root | undefined;

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}")),
	);
	localStorage.clear();
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.replaceChildren();
	document.getElementById("theme-stylesheet")?.remove();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function native() {
	const { configureMobileRuntime } = await import("../../web/src/mobile-runtime");
	configureMobileRuntime({ serverUrl: service, token: "native-secret" });
}

async function renderMarkdown(text: string) {
	const { MarkdownBody } = await import("../../web/src/components/Markdown");
	const { LanguageProvider } = await import("../../web/src/i18n");
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root!.render(createElement(LanguageProvider, null, createElement(MarkdownBody, { text }))));
	return host;
}

describe("native service resource CORS", () => {
	it("uses anonymous CORS only for the exact configured service and path", async () => {
		await native();
		const { appResourceCrossOrigin, appResourceUrl } = await import("../../web/src/base-url");
		expect(appResourceCrossOrigin(appResourceUrl("/api/file?path=image.png"))).toBe("anonymous");
		for (const url of [
			"https://third.example/image.png",
			"//third.example/image.png",
			"https://hub.example/device/desktop/__relay/other/api/file",
			"https://hub.example/device/desktop/__relay/capability-other/api/file",
			"data:image/png;base64,AAAA",
			"blob:https://localhost/image",
			"/icons/icon-192.png",
			undefined,
		])
			expect(appResourceCrossOrigin(url)).toBeUndefined();
	});

	it("sets theme CORS mode before assigning href on initial load and retries", async () => {
		await native();
		vi.useFakeTimers();
		const href = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href")!;
		const modesAtRequest: (string | null)[] = [];
		vi.spyOn(HTMLLinkElement.prototype, "href", "set").mockImplementation(function (this: HTMLLinkElement, value) {
			modesAtRequest.push(this.getAttribute("crossorigin"));
			href.set!.call(this, value);
		});
		const { applyTheme } = await import("../../web/src/theme");
		applyTheme("nord");
		const link = document.getElementById("theme-stylesheet") as HTMLLinkElement;
		expect(modesAtRequest).toEqual(["anonymous"]);
		expect(new URL(link.href).pathname).toBe("/device/desktop/__relay/capability/themes/nord.css");
		expect(new URL(link.href).searchParams.get("token")).toBe("native-secret");
		link.onerror?.(new Event("error"));
		await vi.advanceTimersByTimeAsync(500);
		expect(modesAtRequest).toEqual(["anonymous", "anonymous"]);
	});

	it("renders authenticated API and workspace Markdown images with CORS while preserving third-party images", async () => {
		await native();
		const host = await renderMarkdown(
			[
				"![api](/api/file?path=api.png)",
				`![absolute](${service}/api/file?path=absolute.png)`,
				"![workspace](output/chart.png)",
				"![third](https://third.example/image.png)",
				"![cdn](//third.example/image.png)",
			].join("\n\n"),
		);
		const images = [...host.querySelectorAll("img")];
		expect(images).toHaveLength(5);
		for (const image of images.slice(0, 3)) {
			expect(image.getAttribute("crossorigin")).toBe("anonymous");
			const url = new URL(image.src);
			expect(url.origin + url.pathname).toBe(`${service}/api/file`);
			expect(url.searchParams.get("token")).toBe("native-secret");
		}
		expect(new URL(images[0]!.src).searchParams.get("path")).toBe("api.png");
		expect(new URL(images[2]!.src).searchParams.get("path")).toBe("output/chart.png");
		expect(images[3]!.getAttribute("src")).toBe("https://third.example/image.png");
		expect(images[4]!.getAttribute("src")).toBe("//third.example/image.png");
		for (const image of images.slice(3)) expect(image.hasAttribute("crossorigin")).toBe(false);
	});

	it("preserves browser theme and image requests without a CORS attribute", async () => {
		const { appResourceCrossOrigin } = await import("../../web/src/base-url");
		expect(appResourceCrossOrigin(`${service}/api/file`)).toBeUndefined();
		const { applyTheme } = await import("../../web/src/theme");
		applyTheme("nord");
		expect(document.getElementById("theme-stylesheet")!.hasAttribute("crossorigin")).toBe(false);
		const host = await renderMarkdown("![workspace](output/chart.png) ![third](https://third.example/image.png)");
		const images = [...host.querySelectorAll("img")];
		expect(images).toHaveLength(2);
		for (const image of images) expect(image.hasAttribute("crossorigin")).toBe(false);
		expect(images[0]!.getAttribute("src")).toContain("/api/file?");
		expect(images[1]!.getAttribute("src")).toBe("https://third.example/image.png");
	});
});
