// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ChatInput } from "../../web/src/components/ChatInput.js";
import { TemplateProvider } from "../../web/src/components/PromptTemplates.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider, zh } from "../../web/src/i18n.js";

/**
 * ChatInput 发送失败提示（jsdom）：websocket 关闭时提交不能静默吞字。
 * 回归目标：appSend 返回 false / 未连接时文本原样保留 + 一条 error notice
 *（此前两条路径都直接 return，字还留在框里且无任何提示，看起来与草稿恢复
 * 竞态一模一样）。全部确定性、零 token、零端口。
 */

let root: Root | null = null;

function mount(opts: {
	ready: boolean;
	sendResult: boolean;
	onNotice: (level: string, text: string) => void;
	onSent: () => void;
}) {
	setAppGlobals({ ready: opts.ready });
	setAppSend(() => opts.sendResult);
	try {
		localStorage.setItem("pi-web-ui:lang", "zh");
	} catch {
		/* ignore */
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(TemplateProvider, {
					currentModelId: null,
					children: createElement(ChatInput, {
						sessionId: "sess-1",
						streaming: false,
						messages: [],
						slashCommands: [],
						modelState: null,
						models: [],
						modelsLoading: false,
						attachments: [],
						onRemoveAttachment: () => {},
						onAddImageFiles: () => {},
						onAddLocalFiles: () => {},
						onNotice: opts.onNotice,
						onSent: opts.onSent,
						onManageModels: () => {},
						providerKeys: {},
						quickPhrases: [],
						quickPhrasesEnabled: false,
					}),
				}),
			),
		);
	});
	return container;
}

/** 受控 textarea：走原生 setter + input 事件（与 dsh-question-dialog 的 click 同路）。 */
function typeText(container: HTMLElement, value: string) {
	const ta = container.querySelector("textarea") as HTMLTextAreaElement;
	if (!ta) throw new Error("cannot find textarea");
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
	act(() => {
		setter.call(ta, value);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function clickSend(container: HTMLElement) {
	const btn = container.querySelector(".btn.send") as HTMLElement;
	if (!btn) throw new Error("cannot find .btn.send");
	act(() => {
		btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

function pressEnter(container: HTMLElement, eventInit?: KeyboardEventInit) {
	const ta = container.querySelector("textarea") as HTMLTextAreaElement;
	if (!ta) throw new Error("cannot find textarea");
	act(() => {
		ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...eventInit }));
	});
}

function dispatchCompositionEnd(container: HTMLElement) {
	const ta = container.querySelector("textarea") as HTMLTextAreaElement;
	if (!ta) throw new Error("cannot find textarea");
	act(() => {
		ta.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
	});
}

afterEach(() => {
	resetAppGlobals();
	setAppSend(null); // 断开全局发送器，避免串到下一个用例
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("ChatInput 发送失败提示", () => {
	it("已连接但 appSend 返回 false（ws 已关）：error notice + 文本保留", () => {
		const notices: [string, string][] = [];
		const onSent = vi.fn();
		const c = mount({ ready: true, sendResult: false, onNotice: (l, t) => notices.push([l, t]), onSent });

		typeText(c, "hello");
		clickSend(c);

		expect(notices).toEqual([["error", zh.netDisconnected]]);
		expect(onSent).not.toHaveBeenCalled();
		// 文本保留，供重连后重发。
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello");
	});

	it("未连接时 Enter 提交：error notice + 文本保留（不静默吞掉）", () => {
		const notices: [string, string][] = [];
		const onSent = vi.fn();
		const c = mount({ ready: true, sendResult: true, onNotice: (l, t) => notices.push([l, t]), onSent });

		typeText(c, "hello");
		// 发送中途断连：ready 翻 false 后再按 Enter（act 内翻转，保证重渲染先生效）。
		act(() => {
			setAppGlobals({ ready: false });
		});
		pressEnter(c);

		expect(notices).toEqual([["error", zh.netDisconnected]]);
		expect(onSent).not.toHaveBeenCalled();
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello");
	});

	it("发送成功：无 error notice，文本清空并调 onSent（既有行为不退化）", () => {
		const notices: [string, string][] = [];
		const onSent = vi.fn();
		const c = mount({ ready: true, sendResult: true, onNotice: (l, t) => notices.push([l, t]), onSent });

		typeText(c, "hello");
		clickSend(c);

		expect(notices).toEqual([]);
		expect(onSent).toHaveBeenCalledTimes(1);
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
	});

	it("输入法组合状态中按 Enter（isComposing 为 true）：不发送（issue #248）", () => {
		const notices: [string, string][] = [];
		const onSent = vi.fn();
		const c = mount({ ready: true, sendResult: true, onNotice: (l, t) => notices.push([l, t]), onSent });

		typeText(c, "nihao");
		pressEnter(c, { isComposing: true });

		expect(onSent).not.toHaveBeenCalled();
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("nihao");
	});

	it("macOS 中文输入法敲英文 Enter 上屏（compositionend 刚结束时）：拦截误提交（issue #248）", () => {
		const notices: [string, string][] = [];
		const onSent = vi.fn();
		const c = mount({ ready: true, sendResult: true, onNotice: (l, t) => notices.push([l, t]), onSent });

		typeText(c, "hello");
		// 模拟 macOS 中文输入法：先触发 compositionend，随后浏览器派发 Enter (isComposing=false)
		dispatchCompositionEnd(c);
		pressEnter(c, { isComposing: false });

		expect(onSent).not.toHaveBeenCalled();
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello");
	});
});
