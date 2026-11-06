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
	quickAskTranslateEnabled: true,
	quickAskTranslateTarget: "auto",
	quickAskTranslateStyle: "natural",
	quickAskTranslatePrompt: "Translate {{input}} into {{targetLanguage}}",
	quickAskShowOriginal: false,
	quickAskReferenceMenus: true,
	quickAskConversationScope: "recent",
	quickAskFolderScope: "listing",
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

function SettingsHarness({
	onChange,
	value = settings,
}: {
	onChange: (patch: QuickAskPatch) => void;
	value?: UiSettingsState;
}) {
	const [open, setOpen] = useState(true);
	useEscapeKey(() => setOpen(false), open);
	return open ? createElement(QuickAskSettings, { settings: value, onChange }) : null;
}

async function mount(onChange: (patch: QuickAskPatch) => void) {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(SettingsHarness, { onChange })));
}
function click(selector: string) {
	const button = document.querySelector<HTMLButtonElement>(selector)!;
	expect(button).not.toBeNull();
	act(() => button.click());
}
function edit(field: string, value: string) {
	if (!document.querySelector(`textarea[id$="-${field}"]`)) click(`button[aria-controls$="-${field}-editor"]`);
	const input = document.querySelector<HTMLTextAreaElement>(`textarea[id$="-${field}"]`)!;
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
		["system", "quickAskSystemPrompt", "  ", "  "],
		["explain", "quickAskExplainPrompt", "Explain {{input}} briefly", "Explain {{input}} briefly"],
		["explain", "quickAskExplainPrompt", "  ", "解释下: {{input}}"],
		["translate", "quickAskTranslatePrompt", "Translate {{input}} literally", "Translate {{input}} literally"],
		[
			"translate",
			"quickAskTranslatePrompt",
			"  ",
			"将以下文字翻译成{{targetLanguage}}，只输出译文，保留代码与专有名词。\n{{input}}",
		],
	])("saves the focused %s draft when Escape unmounts settings without blur (%j)", async (field, key, draft, saved) => {
		const onChange = vi.fn();
		await mount(onChange);
		const input = edit(field, draft);
		expect(document.activeElement).toBe(input);
		expect(onChange).not.toHaveBeenCalled();
		escape();
		expect(document.querySelector("textarea")).toBeNull();
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ [key]: saved });
	});

	it("does not submit an already saved blur draft again when closing", async () => {
		const onChange = vi.fn();
		await mount(onChange);
		const input = edit("system", "Saved on blur");
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

	it("shows four compact groups with collapsed scopes and prompt editors", async () => {
		await mount(vi.fn());
		expect([...document.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
			"quickAskBasics",
			"quickAskSelectionTranslation",
			"quickAskAttach",
			"quickAskPrompts",
		]);
		expect(document.querySelectorAll("textarea")).toHaveLength(0);
		expect(document.querySelector('select[id$="-conversation-scope"]')).toBeNull();
		expect(document.querySelector('select[id$="-model"]')!.parentElement!.parentElement).toBe(
			document.querySelector('select[id$="-thinking"]')!.parentElement!.parentElement,
		);
		expect(document.querySelector('select[id$="-target"]')!.parentElement!.parentElement).toBe(
			document.querySelector('select[id$="-style"]')!.parentElement!.parentElement,
		);
	});

	it("saves drafts when switching and collapsing editors, keeping only one open", async () => {
		const onChange = vi.fn();
		await mount(onChange);
		edit("system", "New system rules");
		edit("explain", "New explanation {{input}}");
		expect(document.querySelectorAll("textarea")).toHaveLength(1);
		expect(onChange).toHaveBeenNthCalledWith(1, { quickAskSystemPrompt: "New system rules" });
		edit("translate", "New translation {{input}} {{targetLanguage}}");
		expect(onChange).toHaveBeenNthCalledWith(2, { quickAskExplainPrompt: "New explanation {{input}}" });
		click('button[aria-controls$="-translate-editor"]');
		expect(document.querySelectorAll("textarea")).toHaveLength(0);
		expect(onChange).toHaveBeenNthCalledWith(3, {
			quickAskTranslatePrompt: "New translation {{input}} {{targetLanguage}}",
		});
		click('button[aria-controls$="-system-editor"]');
		expect(document.querySelector<HTMLTextAreaElement>('textarea[id$="-system"]')!.value).toBe("New system rules");
		escape();
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	it("keeps a focused draft when another saved setting refreshes", async () => {
		const onChange = vi.fn();
		await mount(onChange);
		edit("translate", "Unsaved translation {{input}}");
		await act(async () =>
			root!.render(
				createElement(SettingsHarness, {
					onChange,
					value: {
						...settings,
						quickAskSystemPrompt: "External change",
						quickAskTranslatePrompt: "External translation",
					},
				}),
			),
		);
		expect(document.querySelector<HTMLTextAreaElement>('textarea[id$="-translate"]')!.value).toBe(
			"Unsaved translation {{input}}",
		);
		escape();
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ quickAskTranslatePrompt: "Unsaved translation {{input}}" });
	});

	it.each([
		["system", "quickAskSystemPrompt", ""],
		["explain", "quickAskExplainPrompt", "解释下: {{input}}"],
		[
			"translate",
			"quickAskTranslatePrompt",
			"将以下文字翻译成{{targetLanguage}}，只输出译文，保留代码与专有名词。\n{{input}}",
		],
	])("resets only the %s prompt", async (field, key, fallback) => {
		const onChange = vi.fn();
		await mount(onChange);
		edit(field, "A pending custom prompt");
		click(".quick-ask-settings-reset");
		expect(onChange).toHaveBeenCalledExactlyOnceWith({ [key]: fallback });
		expect(document.querySelector<HTMLTextAreaElement>(`textarea[id$="-${field}"]`)!.value).toBe(fallback);
		escape();
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("persists checkbox values independently", async () => {
		const onChange = vi.fn();
		await mount(onChange);
		for (const [suffix, patch] of [
			["enabled", { quickAskEnabled: false }],
			["translate-enabled", { quickAskTranslateEnabled: false }],
			["original", { quickAskShowOriginal: true }],
			["reference-menus", { quickAskReferenceMenus: false }],
		] as const) {
			click(`input[id$="-${suffix}"]`);
			expect(onChange).toHaveBeenLastCalledWith(patch);
		}
	});

	it("persists select values instead of translated labels, including optional scopes", async () => {
		const onChange = vi.fn();
		await mount(onChange);
		click('button[aria-controls$="-scope"]');
		for (const [suffix, value, key] of [
			["target", "zh-TW", "quickAskTranslateTarget"],
			["style", "technical", "quickAskTranslateStyle"],
			["thinking", "high", "quickAskThinking"],
			["conversation-scope", "full", "quickAskConversationScope"],
			["folder-scope", "content", "quickAskFolderScope"],
		] as const) {
			const select = document.querySelector<HTMLSelectElement>(`select[id$="-${suffix}"]`)!;
			act(() => {
				select.value = value;
				select.dispatchEvent(new Event("change", { bubbles: true }));
			});
			expect(onChange).toHaveBeenLastCalledWith({ [key]: value });
		}
		const target = document.querySelector<HTMLSelectElement>('select[id$="-target"]')!;
		expect([...target.options].map((option) => option.value)).toEqual([
			"auto",
			"zh-CN",
			"zh-TW",
			"en",
			"ja",
			"ko",
			"de",
			"fr",
			"es",
			"ru",
			"pt",
			"it",
			"tr",
		]);
	});
});
