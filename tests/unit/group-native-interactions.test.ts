// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { LanguageProvider } from "../../web/src/i18n";
import { GroupNativeInteractions } from "../../web/src/components/GroupNativeInteractions";
let root: Root;
let host: HTMLDivElement;
const item = {
	taskId: "task",
	attemptId: "attempt",
	roomId: "room",
	botId: "bot",
	deviceId: "device",
	id: "public-id",
	kind: "question",
	createdAt: 1,
	questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
};
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
async function render(roomId = "room") {
	await act(async () =>
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(GroupNativeInteractions, { roomId, disabled: false, connected: true }),
			),
		),
	);
}
beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
describe("group native interaction cards", () => {
	it("blocks empty answers, submits only finite fields and aborts an in-flight answer when switching rooms", async () => {
		let post: RequestInit | undefined;
		let body: any;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				if (init.method === "POST") {
					post = init;
					body = JSON.parse(init.body as string);
					return new Promise(() => {});
				}
				return response({ interactions: [item] });
			}),
		);
		await render();
		const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		expect(submit.disabled).toBe(true);
		await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
		expect(submit.disabled).toBe(false);
		await act(async () => submit.click());
		expect(body).toEqual({
			taskId: "task",
			attemptId: "attempt",
			interactionId: "public-id",
			answers: [{ id: "q", selected: ["Yes"] }],
		});
		expect(post!.signal!.aborted).toBe(false);
		await render("another");
		expect(post!.signal!.aborted).toBe(true);
	});
	it("handles missing interaction payload without crashing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({})),
		);
		await render();
		expect(host.querySelector("section")).toBeNull();
	});
	it("renders approval once and deny controls with no persistent allow action", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({
					interactions: [
						{ ...item, kind: "approval", questions: undefined, toolName: "bash", paramsPreview: "Inspect on device" },
					],
				}),
			),
		);
		await render();
		expect(host.querySelectorAll("button")).toHaveLength(2);
		expect(host.textContent).toContain("bash");
	});
});
