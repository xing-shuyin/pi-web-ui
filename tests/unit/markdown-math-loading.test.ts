// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownBody } from "../../web/src/components/Markdown";
import { getMathRenderer, loadMathRenderer, mathRendererImport } from "../../web/src/markdown-math-loader";

vi.mock("../../web/src/components/copy-button", () => ({ CopyButton: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
const root = createRoot(container);
afterEach(() => {
	act(() => root.unmount());
	vi.restoreAllMocks();
});

it("loads math on demand, shares requests, retries later and updates mounted DOM", async () => {
	const load = vi.spyOn(mathRendererImport, "load");
	const render = async (text: string, props = {}) => {
		await act(async () => {
			root.render(createElement(MarkdownBody, { text, ...props }));
		});
	};
	await render("Ordinary **body** and `code`");
	expect(container.querySelector("strong")?.textContent).toBe("body");
	expect(load).not.toHaveBeenCalled();
	await render("$x$ \\(x\\) ```math", { disableMath: true, rawHtml: true });
	expect(load).not.toHaveBeenCalled();
	expect(container.querySelector(".katex")).toBeNull();

	expect(renderToStaticMarkup(createElement(MarkdownBody, { text: "$x$" }))).not.toContain('class="katex"');
	expect(load).not.toHaveBeenCalled();

	load.mockRejectedValueOnce(new Error("chunk unavailable"));
	await render("First $x$ candidate");
	expect(load).toHaveBeenCalledTimes(1);
	expect(getMathRenderer()).toBeUndefined();
	expect(container.textContent).toContain("First");
	await render("Another $x$ in the same mounted candidate");
	expect(load).toHaveBeenCalledTimes(1);

	let resolve!: (module: Awaited<ReturnType<typeof mathRendererImport.load>>) => void;
	load.mockImplementationOnce(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	await render("Plain text");
	await act(async () => {
		root.render(
			createElement(
				Fragment,
				null,
				createElement(MarkdownBody, { text: "Visible **body**\n\n```math\nx^2\n```" }),
				createElement(MarkdownBody, { text: String.raw`Inline \(y^2\)` }),
				createElement(MarkdownBody, {
					text: '<code class="language-math">z^2</code><script>bad()</script>',
					rawHtml: true,
				}),
				createElement(MarkdownBody, { text: "$disabled$", disableMath: true }),
			),
		);
	});
	expect(load).toHaveBeenCalledTimes(2);
	expect(container.querySelector("strong")?.textContent).toBe("body");
	expect(container.querySelector(".katex")).toBeNull();
	expect(container.querySelector("script")).toBeNull();
	const pending = loadMathRenderer();
	expect(loadMathRenderer()).toBe(pending);

	await act(async () => {
		resolve(await import("../../web/src/markdown-math-renderer"));
		await pending;
	});
	expect(container.querySelectorAll(".katex")).toHaveLength(3);
	expect(container.querySelector(".katex-display")).not.toBeNull();
	expect(container.textContent).toContain("$disabled$");
	expect(container.querySelector("script")).toBeNull();
	await loadMathRenderer();
	expect(load).toHaveBeenCalledTimes(2);
	expect(renderToStaticMarkup(createElement(MarkdownBody, { text: "$x$" }))).toContain('class="katex"');
});
