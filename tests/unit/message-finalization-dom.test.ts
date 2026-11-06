// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Message } from "../../web/src/components/Message";
import { LanguageProvider } from "../../web/src/i18n";

vi.spyOn(document, "hidden", "get").mockReturnValue(true);

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
let root = createRoot(container);
afterEach(() => {
	act(() => root.unmount());
	container.replaceChildren();
	root = createRoot(container);
});

it("preserves streamed body DOM when the message receives its persisted ID", async () => {
	const maps = { toolResults: new Map(), liveOutputs: new Map(), toolStatuses: new Map() };
	const render = async (id: string, streaming: boolean, text: string) => {
		await act(async () => {
			root.render(
				createElement(
					LanguageProvider,
					null,
					createElement(Message, {
						...maps,
						message: { id, role: "assistant", content: [{ type: "text", text }], timestamp: 123 },
						streaming,
						isLast: true,
						uiMessageActions: [],
					}),
				),
			);
		});
	};
	await render("stream-123", true, "Final answer");
	const body = container.querySelector(".md p");
	expect(body).not.toBeNull();
	await render("a-123-4", false, "Final answer");
	expect(container.querySelector(".md p")).toBe(body);
	await render("a-123-4", false, "Final answer updated");
	expect(container.querySelector(".md p")).toBe(body);
	expect(body?.textContent).toBe("Final answer updated");
});
