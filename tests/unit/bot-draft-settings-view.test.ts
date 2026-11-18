// @vitest-environment jsdom
/**
 * 设置 →「智能体」：起草模型 + 思考强度。
 *
 * 守三件事：
 * 1. 默认「跟随默认模型」提交的是 `null`（服务端据此回落到默认模型，而不是存一个空串）；
 * 2. 已保存但当前模型列表里没有的值不能被悄悄改掉（`stale` 选项要留一个）；
 * 3. 思考强度只给协议里那 6 档，不含子代理的 `max`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BotDraftSettings, type BotDraftPatch } from "../../web/src/components/BotDraftSettings.js";
import type { UiSettingsState } from "../../web/src/types.js";

vi.mock("../../web/src/i18n", () => ({ useT: () => (key: string) => key }));

let root: Root | undefined;
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

const models = [
	{ provider: "opencode-go", id: "glm-5.3-flash", label: "GLM 5.3 Flash" },
	{ provider: "opencode-go", id: "deepseek-v4.1-flash", label: "DeepSeek" },
];

function settings(overrides: Record<string, unknown> = {}): UiSettingsState {
	return {
		botDraftModel: null,
		botDraftThinking: "off",
		subagentModels: models,
		...overrides,
	} as unknown as UiSettingsState;
}

async function mount(onChange: (patch: BotDraftPatch) => void, value = settings()) {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(BotDraftSettings, { settings: value, onChange })));
}

function select(idSuffix: string, value: string) {
	const element = document.querySelector<HTMLSelectElement>(`select[id$="-${idSuffix}"]`)!;
	expect(element).not.toBeNull();
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

describe("起草设置视图", () => {
	it("选模型提交 provider/id，选「跟随默认」提交 null", async () => {
		const changes: BotDraftPatch[] = [];
		await mount((patch) => changes.push(patch));
		select("model", "opencode-go/glm-5.3-flash");
		select("model", "");
		expect(changes).toEqual([{ botDraftModel: "opencode-go/glm-5.3-flash" }, { botDraftModel: null }]);
	});

	it("思考强度只给 6 档协议值", async () => {
		await mount(() => {});
		const values = [...document.querySelectorAll<HTMLSelectElement>('select[id$="-thinking"] option')].map(
			(option) => option.value,
		);
		expect(values).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("已保存但目录里没有的模型保留为可选项", async () => {
		await mount(() => {}, settings({ botDraftModel: "opencode-go/ghost-model" }));
		const selectElement = document.querySelector<HTMLSelectElement>('select[id$="-model"]')!;
		expect(selectElement.value).toBe("opencode-go/ghost-model");
		expect([...selectElement.options].some((option) => option.value === "opencode-go/ghost-model")).toBe(true);
	});

	it("没有可用模型时给出提示", async () => {
		await mount(() => {}, settings({ subagentModels: [] }));
		expect(document.body.textContent).toContain("botDraftNoModels");
	});
});
