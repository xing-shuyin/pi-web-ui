// @vitest-environment jsdom
/**
 * 设置 →「智能体」：起草提示词自定义视图 + 提示词模板拼接。
 *
 * 守三件事：
 * 1. 输入修改后离开焦点才提交 `botDraftPrompt`；
 * 2. 正在编辑（focused）时不因外部快照刷新丢失本地草稿；
 * 3. 「恢复默认」提交空串 `""`，并重置本地草稿；
 * 4. `buildBotDraftPrompt` 正确替换 `{{request}}`，未写占位符时自动附加在末尾。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BotDraftSettings, type BotDraftPatch } from "../../web/src/components/BotDraftSettings.js";
import { buildBotDraftPrompt } from "../../web/src/bot-create.js";
import type { UiSettingsState } from "../../web/src/types.js";

vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));

let root: Root | undefined;
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

function settings(overrides: Record<string, unknown> = {}): UiSettingsState {
	return {
		botDraftPrompt: "",
		botDraftDefaultPrompt: "default: {{request}}",
		...overrides,
	} as unknown as UiSettingsState;
}

async function mount(onChange: (patch: BotDraftPatch) => void, value = settings()) {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(BotDraftSettings, { settings: value, onChange })));
}

describe("起草设置视图", () => {
	it("显示默认提示词占位符，修改后 blur 提交", async () => {
		const changes: BotDraftPatch[] = [];
		await mount((patch) => changes.push(patch));
		const textarea = document.querySelector<HTMLTextAreaElement>('textarea[id$="-prompt"]')!;
		expect(textarea.placeholder).toBe("default: {{request}}");

		act(() => {
			textarea.focus();
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
				textarea,
				"custom {{request}}",
			);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(changes).toEqual([]);

		act(() => {
			textarea.blur();
		});
		expect(changes).toEqual([{ botDraftPrompt: "custom {{request}}" }]);
	});

	it("点击恢复默认按钮提交空串并禁用按钮", async () => {
		const changes: BotDraftPatch[] = [];
		await mount((patch) => changes.push(patch), settings({ botDraftPrompt: "custom {{request}}" }));
		const resetBtn = document.querySelector<HTMLButtonElement>("button.quick-ask-settings-reset")!;
		expect(resetBtn.disabled).toBe(false);

		act(() => {
			resetBtn.click();
		});
		expect(changes).toEqual([{ botDraftPrompt: "" }]);
		const textarea = document.querySelector<HTMLTextAreaElement>('textarea[id$="-prompt"]')!;
		expect(textarea.value).toBe("");
	});

	it("已为默认状态时恢复默认按钮禁用", async () => {
		await mount(() => {});
		const resetBtn = document.querySelector<HTMLButtonElement>("button.quick-ask-settings-reset")!;
		expect(resetBtn.disabled).toBe(true);
	});
});

describe("buildBotDraftPrompt", () => {
	it("优先使用自定义模板并替换 {{request}}", () => {
		expect(buildBotDraftPrompt("请帮我设计：{{request}}，谢谢", "default {{request}}", "pr处理")).toBe(
			"请帮我设计：pr处理，谢谢",
		);
	});

	it("模板未包含 {{request}} 时自动附加到末尾", () => {
		expect(buildBotDraftPrompt("请先调研仓库再调用 agent_bot", "default {{request}}", "pr处理")).toBe(
			"请先调研仓库再调用 agent_bot\n\npr处理",
		);
	});

	it("自定义模板为空时回退默认模板", () => {
		expect(buildBotDraftPrompt("   ", "默认：{{request}}", "pr处理")).toBe("默认：pr处理");
	});
});
