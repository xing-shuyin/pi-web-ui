// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StreamMarkdown } from "../../web/src/components/StreamMarkdown";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function render(text: string) {
	act(() => root.render(createElement(StreamMarkdown, { text })));
}

describe("stream segment identity", () => {
	it.each(["", "Next tail"])("preserves paragraph and inline code when freezing before %j", (tail) => {
		const first = "First paragraph with `inline code`.";
		render(first);
		const paragraph = container.querySelector("p")!;
		const code = paragraph.querySelector("code")!;
		expect(code.textContent).toBe("inline code");

		render(`${first}\n\n${tail}`);
		expect(container.querySelector("p")).toBe(paragraph);
		expect(container.querySelector("code")).toBe(code);

		const mutations: MutationRecord[] = [];
		const observer = new MutationObserver((records) => mutations.push(...records));
		observer.observe(paragraph, { subtree: true, childList: true, characterData: true, attributes: true });
		try {
			render(`${first}\n\nNext tail grows with **markdown**`);
			const second = container.querySelectorAll("p")[1];
			render(`${first}\n\nNext tail grows with **markdown**\n\nThird tail`);
			expect(container.querySelectorAll("p")[1]).toBe(second);
			expect(container.querySelector("p")).toBe(paragraph);
			expect(container.querySelector("code")).toBe(code);
			expect([...mutations, ...observer.takeRecords()]).toEqual([]);
		} finally {
			observer.disconnect();
		}
	});

	it("flushes the latest long-tail text immediately on freeze without replacing DOM", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const first = `Long paragraph with \`inline code\` ${"word ".repeat(130)}`;
		render(first);
		const paragraph = container.querySelector("p")!;
		const code = paragraph.querySelector("code")!;

		render(`${first}latest text`);
		expect(paragraph.textContent).not.toContain("latest text");
		render(`${first}latest text\n\nNext tail`);
		expect(container.querySelector("p")).toBe(paragraph);
		expect(container.querySelector("code")).toBe(code);
		expect(paragraph.textContent).toContain("latest text");

		act(() => vi.advanceTimersByTime(64));
		expect(container.querySelector("p")).toBe(paragraph);
		expect(paragraph.textContent).toContain("latest text");
		expect(container.querySelectorAll("p")[1].textContent).toBe("Next tail");
	});

	it("allows an open code fence to become highlighted while preserving preceding blocks", () => {
		const prefix = "Keep this `inline code`.\n\n";
		const open = "```js\nconst answer = 42;";
		render(prefix + open);
		const paragraph = container.querySelector("p")!;
		const inlineCode = paragraph.querySelector("code")!;
		expect(container.querySelector("pre code")!.textContent).toBe(open);

		render(`${prefix}${open}\n\`\`\`\n\nNew tail`);
		expect(container.querySelector("p")).toBe(paragraph);
		expect(paragraph.querySelector("code")).toBe(inlineCode);
		const highlighted = container.querySelector("pre code")!;
		expect(highlighted.textContent).toContain("const answer = 42;");
		expect(highlighted.querySelector(".hljs-keyword")).not.toBeNull();

		render(`${prefix}${open}\n\`\`\`\n\nNew tail grows`);
		expect(container.querySelector("pre code")).toBe(highlighted);
		expect(container.querySelector("p")).toBe(paragraph);
	});
});
