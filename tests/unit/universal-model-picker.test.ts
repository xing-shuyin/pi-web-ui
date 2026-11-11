// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { LanguageProvider } from "../../web/src/i18n.js";
import { setAppSend } from "../../web/src/app-globals.js";
import {
	UniversalModelPicker,
	matchesModelId,
	providerLabel,
	resolveCurrentModelRef,
} from "../../web/src/components/UniversalModelPicker.js";
import type { ModelInfo } from "../../web/src/types.js";

let root: Root | null = null;

afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	document.body.innerHTML = "";
	setAppSend(null);
});

const models: ModelInfo[] = [
	{ id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic", reasoning: false, vision: false },
	{ id: "anthropic/claude-opus", name: "Claude Opus", provider: "anthropic", reasoning: true, vision: false },
	{ id: "openai/gpt-5", name: "GPT-5", provider: "openai", reasoning: false, vision: true, enabled: false },
];

const providerKeys = {
	anthropic: [
		{ name: "keyA", active: true },
		{ name: "keyB", active: false },
	],
};

function renderPicker(extraProps: Record<string, unknown> = {}) {
	const onEnsureModels = vi.fn();
	const onRefresh = vi.fn();
	const onPickModel = vi.fn();
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const props = {
		models,
		providerKeys,
		currentModelId: "anthropic/claude-sonnet",
		active: true,
		onEnsureModels,
		onRefresh,
		onPickModel,
		...extraProps,
	};
	act(() => {
		root!.render(createElement(LanguageProvider, null, createElement(UniversalModelPicker, props as never)));
	});
	return { onEnsureModels, onRefresh, onPickModel };
}

const rows = () => Array.from(document.body.querySelectorAll(".dd-model-scroll .dd-item"));
const rowNames = () => rows().map((r) => r.querySelector(".dd-model-name")?.textContent);

describe("matchesModelId", () => {
	it("裸 id / provider 前缀 / 后缀三种口径都能命中", () => {
		const m = models[0];
		expect(matchesModelId(m, "anthropic/claude-sonnet")).toBe(true);
		expect(matchesModelId(m, "anthropic/claude-sonnet")).toBe(true);
		expect(matchesModelId(m, null)).toBe(false);
		expect(matchesModelId(m, "openai/gpt-5")).toBe(false);
	});
});

const providers = [
	{ id: "anthropic", name: "Anthropic 官方" },
	{ id: "openai", name: "OpenAI" },
];

describe("providerLabel / resolveCurrentModelRef", () => {
	it("服务商显示名优先，缺失时回退到 provider id", () => {
		expect(providerLabel("anthropic", providers)).toBe("Anthropic 官方");
		expect(providerLabel("my-relay", providers)).toBe("my-relay");
		expect(providerLabel("anthropic", undefined)).toBe("anthropic");
		expect(providerLabel("", providers)).toBe("");
	});

	it("解析当前模型：名称 / 服务商显示名 / 多 key 下的激活 key", () => {
		const ref = resolveCurrentModelRef("anthropic/claude-sonnet", models, providers, providerKeys);
		expect(ref).toEqual({
			modelName: "Claude Sonnet",
			modelId: "claude-sonnet",
			provider: "anthropic",
			providerLabel: "Anthropic 官方",
			keyName: "keyA",
		});
	});

	it("无当前模型 / 模型不在列表时降级但不报错", () => {
		expect(resolveCurrentModelRef(null, models, providers, providerKeys)).toBeNull();
		expect(resolveCurrentModelRef("  ", models, providers, providerKeys)).toBeNull();
		const missing = resolveCurrentModelRef("my-relay/ghost-1", models, providers, providerKeys);
		expect(missing?.modelName).toBe("ghost-1");
		expect(missing?.providerLabel).toBe("my-relay");
		expect(missing?.keyName).toBeNull();
	});

	it("单 key 的服务商不占位居所（不显 key 名）", () => {
		const ref = resolveCurrentModelRef("openai/gpt-5", models, providers, {
			openai: [{ name: "唯一", active: true }],
		});
		expect(ref?.keyName).toBeNull();
	});

	it("模型 id 自带斜杠（如 openrouter）时仍归属到正确的服务商", () => {
		const slashyModels: ModelInfo[] = [
			{
				id: "openrouter/anthropic/claude-3.5-sonnet",
				name: "Claude 3.5 Sonnet",
				provider: "openrouter",
				reasoning: false,
				vision: false,
			},
		];
		const ref = resolveCurrentModelRef("openrouter/anthropic/claude-3.5-sonnet", slashyModels, providers, {});
		expect(ref?.provider).toBe("openrouter");
		expect(ref?.modelName).toBe("Claude 3.5 Sonnet");
		expect(ref?.providerLabel).toBe("openrouter");
	});
});

describe("UniversalModelPicker 通用模型菜单", () => {
	it("默认只列启用模型；scope 开关展开后显示全部", () => {
		renderPicker();
		expect(rowNames()).toEqual(["Claude Sonnet", "Claude Opus"]);
		const toggle = document.body.querySelector(".dd-scope-toggle") as HTMLButtonElement;
		expect(toggle).toBeTruthy();
		act(() => {
			toggle.click();
		});
		expect(rowNames()).toEqual(["Claude Sonnet", "Claude Opus", "GPT-5"]);
	});

	it("搜索框按名称过滤；服务商侧栏出现并可筛选", () => {
		renderPicker();
		const input = document.body.querySelector(".dd-search") as HTMLInputElement;
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "opus");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(rowNames()).toEqual(["Claude Opus"]);

		act(() => {
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => {
			(document.body.querySelector(".dd-scope-toggle") as HTMLButtonElement).click();
		});
		const sidebar = Array.from(document.body.querySelectorAll(".dd-provider-item"));
		expect(sidebar.length).toBe(4);
		act(() => {
			(sidebar[3] as HTMLButtonElement).click();
		});
		expect(rowNames()).toEqual(["GPT-5"]);
	});

	it("点击行回调 onPickModel（多 key 下带出 active key）；默认模型星标可交互", () => {
		const onToggleDefault = vi.fn();
		const { onPickModel } = renderPicker({
			defaultModel: "anthropic/claude-sonnet",
			onToggleDefault,
		});
		expect(document.body.querySelector(".dd-header-default-name")?.textContent).toContain("claude-sonnet");
		const star = document.body.querySelector(".dd-star-btn") as HTMLButtonElement;
		expect(star.tagName).toBe("BUTTON");
		act(() => {
			star.click();
		});
		expect(onToggleDefault).toHaveBeenCalledWith(models[0], true);

		act(() => {
			(rows()[1] as HTMLElement).click();
		});
		expect(onPickModel).toHaveBeenCalledTimes(1);
		expect(onPickModel.mock.calls[0][0]).toEqual(models[1]);
		expect(onPickModel.mock.calls[0][1]).toEqual({ name: "keyA", active: true });
	});

	it("无 onToggleDefault 时星标只展示；关闭弹窗重置过滤态", () => {
		const props = {
			models,
			providerKeys,
			currentModelId: "anthropic/claude-sonnet",
			active: true,
			onEnsureModels: vi.fn(),
			onRefresh: vi.fn(),
			onPickModel: vi.fn(),
		};
		const holder = document.createElement("div");
		document.body.appendChild(holder);
		root = createRoot(holder);
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(UniversalModelPicker, { ...props, defaultModel: "openai/gpt-5" } as never),
				),
			);
		});
		const stars = Array.from(document.body.querySelectorAll(".dd-star-btn"));
		expect(stars.length).toBeGreaterThan(0);
		expect(stars.every((s) => s.tagName === "SPAN")).toBe(true);
	});

	it("active 切换时加载使用次数并确保模型列表；关闭重置过滤", () => {
		const onEnsureModels = vi.fn();
		const holder = document.createElement("div");
		document.body.appendChild(holder);
		root = createRoot(holder);
		const base = {
			models,
			providerKeys,
			currentModelId: null,
			active: false,
			onEnsureModels,
			onRefresh: vi.fn(),
			onPickModel: vi.fn(),
		};
		act(() => {
			root!.render(createElement(LanguageProvider, null, createElement(UniversalModelPicker, base as never)));
		});
		expect(onEnsureModels).not.toHaveBeenCalled();
		act(() => {
			root!.render(
				createElement(LanguageProvider, null, createElement(UniversalModelPicker, { ...base, active: true } as never)),
			);
		});
		expect(onEnsureModels).toHaveBeenCalledTimes(1);
		const input = document.body.querySelector(".dd-search") as HTMLInputElement;
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "opus");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(rowNames()).toEqual(["Claude Opus"]);
		act(() => {
			root!.render(
				createElement(LanguageProvider, null, createElement(UniversalModelPicker, { ...base, active: false } as never)),
			);
		});
		act(() => {
			root!.render(
				createElement(LanguageProvider, null, createElement(UniversalModelPicker, { ...base, active: true } as never)),
			);
		});
		expect(rowNames()).toEqual(["Claude Sonnet", "Claude Opus"]);
		expect(onEnsureModels).toHaveBeenCalledTimes(2);
	});

	it("顶部「当前使用」摘要显示模型名与服务商显示名，行内带「当前」徽标", () => {
		renderPicker({ providers });
		const summary = document.body.querySelector(".dd-current-row");
		expect(summary).toBeTruthy();
		expect(summary!.querySelector(".dd-current-name")?.textContent).toBe("Claude Sonnet");
		expect(summary!.querySelector(".dd-current-provider")?.textContent).toBe("Anthropic 官方");
		expect(summary!.querySelector(".dd-current-provider")?.getAttribute("title")).toBe("anthropic");
		expect(summary!.querySelector(".dd-current-key")?.textContent).toBe("keyA");

		const activeRow = rows()[0];
		expect(activeRow.classList.contains("active")).toBe(true);
		expect(activeRow.querySelector(".dd-model-current")?.textContent).toBeTruthy();
		expect(activeRow.querySelector(".dd-model-provider")?.textContent).toBe("Anthropic 官方");
		expect(rows()[1].querySelector(".dd-model-current")).toBeNull();
	});

	it("无当前模型时不渲染摘要行；服务商侧栏回退到 provider id", () => {
		renderPicker({ currentModelId: null, providerKeys: {}, providers: [{ id: "anthropic", name: "" }] });
		expect(document.body.querySelector(".dd-current-row")).toBeNull();
		act(() => {
			(document.body.querySelector(".dd-scope-toggle") as HTMLButtonElement).click();
		});
		const sidebar = Array.from(document.body.querySelectorAll(".dd-provider-name"));
		expect(sidebar.map((n) => n.textContent)).toEqual(["anthropic", "openai"]);
	});
});
