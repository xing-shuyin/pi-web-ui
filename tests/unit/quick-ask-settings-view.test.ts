// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QuickAskSettings, type QuickAskPatch } from "../../web/src/components/QuickAskSettings.js";
import { useEscapeKey } from "../../web/src/shortcut-stack.js";
import type { UiSettingsState } from "../../web/src/types.js";

vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));

let root: Root | undefined;
const settings = {
	quickAskEnabled: true,
	quickAskModel: null,
	quickAskThinking: "off",
	quickAskSystemPrompt: "Original system prompt",
	quickAskExplainPrompt: "Original {{input}}",
	subagentModels: [],
} as any as UiSettingsState;

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }));
});
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

function SettingsHarness({ onChange }: { onChange: (patch: QuickAskPatch) => void }) {
	const [open, setOpen] = useState(true);
	useEscapeKey(() => setOpen(false), open);
	return open ? createElement(QuickAskSettings, { settings, onChange }) : null;
}

async function mount(onChange: (patch: QuickAskPatch) => void) {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(SettingsHarness, { onChange })));
}
function edit(selector: string, value: string) {
	const input = document.querySelector<HTMLTextAreaElement>(selector)!;
	act(() => input.focus());
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	return input;
}
function escape() {
	act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
}

describe("quick ask settings draft flush on close", () => {
	it.each([
		["system", "quickAskSystemPrompt", "Changed popup instructions", "Changed popup instructions"],
		["system", "quickAskSystemPrompt", "", ""],
		["explain", "quickAskExplainPrompt", "Explain {{input}} briefly", "Explain {{input}} briefly"],
		["explain", "quickAskExplainPrompt", "  ", "解释下: {{input}}"],
	])("saves the focused %s draft when Escape unmounts settings without blur (%j)", async (field, key, draft, saved) => {
		const onChange = vi.fn();
		await mount(onChange);
		const input = edit(`textarea[id$="-${field}"]`, draft);
		expect(document.activeElement).toBe(input);
		expect(onChange).not.toHaveBeenCalled();
		escape();
		expect(document.querySelector("textarea")).toBeNull();
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ [key]: saved });
	});

	it("does not submit an already saved blur draft again when closing", async () => {
		const onChange = vi.fn();
		await mount(onChange);
		const input = edit('textarea[id$="-system"]', "Saved on blur");
		act(() => input.blur());
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ quickAskSystemPrompt: "Saved on blur" });
		escape();
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("does not submit untouched settings when closing", async () => {
		const onChange = vi.fn();
		await mount(onChange);
		escape();
		expect(onChange).not.toHaveBeenCalled();
	});
});
