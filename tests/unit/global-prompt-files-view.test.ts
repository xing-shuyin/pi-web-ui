// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GlobalPromptFiles } from "../../web/src/components/GlobalPromptFiles.js";
import { requestJson } from "../../web/src/api-client.js";

vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));
vi.mock("../../web/src/api-client", () => ({ requestJson: vi.fn() }));

const catalog = {
	files: [
		{
			id: "pi:system",
			agent: "pi",
			kind: "system",
			path: "/tmp/agent/SYSTEM.md",
			custom: false,
			exists: true,
			content: "global soul",
			revision: "1:11",
			truncated: false,
		},
		{
			id: "claude:context",
			agent: "claude",
			kind: "context",
			path: "/tmp/home/.claude/CLAUDE.md",
			custom: false,
			exists: false,
			content: "",
			revision: "missing",
			truncated: false,
		},
	],
	directories: [],
	customStorageBlocked: false,
};

let root: Root | undefined;

beforeEach(() => {
	vi.mocked(requestJson).mockReset();
	vi.mocked(requestJson).mockResolvedValue(catalog);
});

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

async function mount(onApplied = vi.fn()) {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(GlobalPromptFiles, { onApplied })));
	return onApplied;
}

function edit(selector: string, value: string) {
	const input = document.querySelector<HTMLTextAreaElement>(selector)!;
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	return input;
}

describe("global prompt files settings view", () => {
	it("lists registered files and saves an edited Pi file with its revision", async () => {
		const onApplied = await mount();
		expect(document.body.textContent).toContain("/tmp/agent/SYSTEM.md");
		expect(document.body.textContent).toContain("/tmp/home/.claude/CLAUDE.md");

		const head = document.querySelector<HTMLButtonElement>(".global-prompt-file-head")!;
		act(() => head.click());
		const input = document.querySelector<HTMLTextAreaElement>(".global-prompt-editor")!;
		expect(input.value).toBe("global soul");
		edit(".global-prompt-editor", "updated soul");
		vi.mocked(requestJson).mockResolvedValueOnce({
			file: { ...catalog.files[0], content: "updated soul", revision: "2:13" },
		});
		const save = Array.from(document.querySelectorAll<HTMLButtonElement>(".global-prompt-file-foot button")).at(-1)!;
		await act(async () => save.click());

		expect(requestJson).toHaveBeenLastCalledWith("/api/global-prompts", {
			method: "PUT",
			body: { id: "pi:system", content: "updated soul", expectedRevision: "1:11" },
		});
		expect(onApplied).toHaveBeenCalledOnce();
	});

	it("keeps dirty drafts on rescan and clears the saved badge after a new edit", async () => {
		await mount();
		act(() => document.querySelector<HTMLButtonElement>(".global-prompt-file-head")!.click());
		edit(".global-prompt-editor", "dirty draft");
		vi.mocked(requestJson).mockResolvedValueOnce({
			...catalog,
			files: [{ ...catalog.files[0], content: "external change", revision: "9:16" }, catalog.files[1]],
		});
		const refresh = Array.from(document.querySelectorAll<HTMLButtonElement>(".global-prompts-toolbar button"))[0]!;
		await act(async () => refresh.click());
		expect(document.querySelector<HTMLTextAreaElement>(".global-prompt-editor")!.value).toBe("dirty draft");

		vi.mocked(requestJson).mockResolvedValueOnce({
			file: { ...catalog.files[0], content: "dirty draft", revision: "10:11" },
		});
		const save = Array.from(document.querySelectorAll<HTMLButtonElement>(".global-prompt-file-foot button")).at(-1)!;
		await act(async () => save.click());
		expect(document.body.textContent).toContain("globalPromptSaved");
		edit(".global-prompt-editor", "another edit");
		expect(document.body.textContent).not.toContain("globalPromptSaved");
	});

	it("allows creating a missing built-in file", async () => {
		await mount();
		const heads = document.querySelectorAll<HTMLButtonElement>(".global-prompt-file-head");
		act(() => heads[1]!.click());
		const input = document.querySelector<HTMLTextAreaElement>(".global-prompt-editor")!;
		expect(input.value).toBe("");
		expect(input.disabled).toBe(false);
		vi.mocked(requestJson).mockResolvedValueOnce({
			file: { ...catalog.files[1], exists: true, content: "claude global", revision: "3:14" },
		});
		const save = Array.from(document.querySelectorAll<HTMLButtonElement>(".global-prompt-file-foot button")).at(-1)!;
		await act(async () => save.click());
		expect(requestJson).toHaveBeenLastCalledWith("/api/global-prompts", {
			method: "PUT",
			body: { id: "claude:context", content: "", expectedRevision: "missing" },
		});
	});
});
