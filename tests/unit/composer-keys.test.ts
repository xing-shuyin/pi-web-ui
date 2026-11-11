// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
	_resetSendKeyCacheForTest,
	loadSendKeyPref,
	resolveEffectiveSendKey,
	resolveEnterAction,
	saveSendKeyPref,
	SEND_KEY_STORAGE_KEY,
} from "../../web/src/composer-keys.js";
import { ChatInput } from "../../web/src/components/ChatInput.js";
import { TemplateProvider } from "../../web/src/components/PromptTemplates.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider, zh } from "../../web/src/i18n.js";

describe("composer-keys resolveEffectiveSendKey", () => {
	it("显式设置优先于设备探测", () => {
		expect(resolveEffectiveSendKey("enter", true)).toBe("enter");
		expect(resolveEffectiveSendKey("enter", false)).toBe("enter");
		expect(resolveEffectiveSendKey("mod-enter", true)).toBe("mod-enter");
		expect(resolveEffectiveSendKey("mod-enter", false)).toBe("mod-enter");
	});

	it("未设置时：触屏设备缺省为 mod-enter，桌面缺省为 enter", () => {
		expect(resolveEffectiveSendKey(null, true)).toBe("mod-enter");
		expect(resolveEffectiveSendKey(null, false)).toBe("enter");
		expect(resolveEffectiveSendKey(undefined, true)).toBe("mod-enter");
		expect(resolveEffectiveSendKey(undefined, false)).toBe("enter");
	});
});

describe("composer-keys resolveEnterAction", () => {
	it("非 Enter 键一律忽略返回 ignore", () => {
		expect(resolveEnterAction({ key: "a" })).toBe("ignore");
		expect(resolveEnterAction({ key: "Escape" })).toBe("ignore");
		expect(resolveEnterAction({ key: "Tab" })).toBe("ignore");
	});

	describe("enter 模式（Enter 发送，Shift+Enter 换行）", () => {
		it("普通 Enter 发送", () => {
			expect(resolveEnterAction({ key: "Enter", pref: "enter" })).toBe("send");
			expect(resolveEnterAction({ key: "Enter", isTouch: false })).toBe("send");
		});

		it("Shift+Enter 换行", () => {
			expect(resolveEnterAction({ key: "Enter", shiftKey: true, pref: "enter" })).toBe("newline");
			expect(resolveEnterAction({ key: "Enter", shiftKey: true, isTouch: false })).toBe("newline");
		});

		it("Ctrl+Enter 与 Cmd/Meta+Enter 兼容发送", () => {
			expect(resolveEnterAction({ key: "Enter", ctrlKey: true, pref: "enter" })).toBe("send");
			expect(resolveEnterAction({ key: "Enter", metaKey: true, pref: "enter" })).toBe("send");
		});

		it("Ctrl+Shift+Enter 换行（Shift 优先）", () => {
			expect(resolveEnterAction({ key: "Enter", ctrlKey: true, shiftKey: true, pref: "enter" })).toBe("newline");
		});
	});

	describe("mod-enter 模式（Enter 换行，Ctrl/Cmd+Enter 发送）", () => {
		it("普通 Enter 换行", () => {
			expect(resolveEnterAction({ key: "Enter", pref: "mod-enter" })).toBe("newline");
			expect(resolveEnterAction({ key: "Enter", isTouch: true })).toBe("newline");
		});

		it("Shift+Enter 换行", () => {
			expect(resolveEnterAction({ key: "Enter", shiftKey: true, pref: "mod-enter" })).toBe("newline");
			expect(resolveEnterAction({ key: "Enter", shiftKey: true, isTouch: true })).toBe("newline");
		});

		it("Ctrl+Enter 发送", () => {
			expect(resolveEnterAction({ key: "Enter", ctrlKey: true, pref: "mod-enter" })).toBe("send");
			expect(resolveEnterAction({ key: "Enter", ctrlKey: true, isTouch: true })).toBe("send");
		});

		it("Cmd/Meta+Enter 发送", () => {
			expect(resolveEnterAction({ key: "Enter", metaKey: true, pref: "mod-enter" })).toBe("send");
			expect(resolveEnterAction({ key: "Enter", metaKey: true, isTouch: true })).toBe("send");
		});

		it("带 Shift 组合时不发送（换行）", () => {
			expect(resolveEnterAction({ key: "Enter", ctrlKey: true, shiftKey: true, pref: "mod-enter" })).toBe("newline");
			expect(resolveEnterAction({ key: "Enter", metaKey: true, shiftKey: true, pref: "mod-enter" })).toBe("newline");
		});
	});
});

describe("composer-keys storage", () => {
	const store = new Map<string, string>();

	beforeEach(() => {
		store.clear();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
			clear: () => store.clear(),
		});
		_resetSendKeyCacheForTest();
	});

	it("初始未设置返回 null", () => {
		expect(loadSendKeyPref()).toBeNull();
	});

	it("正常写入与读取", () => {
		saveSendKeyPref("mod-enter");
		expect(store.get(SEND_KEY_STORAGE_KEY)).toBe("mod-enter");
		expect(loadSendKeyPref()).toBe("mod-enter");

		saveSendKeyPref("enter");
		expect(store.get(SEND_KEY_STORAGE_KEY)).toBe("enter");
		expect(loadSendKeyPref()).toBe("enter");
	});

	it("异常值安全回退 null", () => {
		store.set(SEND_KEY_STORAGE_KEY, "invalid-key");
		expect(loadSendKeyPref()).toBeNull();
	});
});

describe("ChatInput 回车语义与文案联动（issue #664）", () => {
	let root: Root | null = null;
	const store = new Map<string, string>();

	function mountChatInput(opts: { onSent: () => void }) {
		setAppGlobals({ ready: true });
		setAppSend(() => true);
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
							sessionId: "sess-test",
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
							onNotice: () => {},
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

	function typeText(container: HTMLElement, value: string) {
		const ta = container.querySelector("textarea") as HTMLTextAreaElement;
		if (!ta) throw new Error("cannot find textarea");
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
		act(() => {
			setter.call(ta, value);
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	function pressKey(container: HTMLElement, key: string, eventInit?: KeyboardEventInit) {
		const ta = container.querySelector("textarea") as HTMLTextAreaElement;
		if (!ta) throw new Error("cannot find textarea");
		act(() => {
			ta.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...eventInit }));
		});
	}

	beforeEach(() => {
		store.clear();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
			clear: () => store.clear(),
		});
		_resetSendKeyCacheForTest();
		store.set("pi-web-ui:lang", "zh");
	});

	afterEach(() => {
		resetAppGlobals();
		setAppSend(null);
		if (root) {
			act(() => root!.unmount());
			root = null;
		}
		document.body.innerHTML = "";
		vi.restoreAllMocks();
	});

	it("默认（enter 模式）：placeholder 和 sendTip 显示 Enter，Enter 触发发送", () => {
		const onSent = vi.fn();
		const c = mountChatInput({ onSent });

		const ta = c.querySelector("textarea") as HTMLTextAreaElement;
		const sendBtn = c.querySelector(".btn.send") as HTMLElement;

		expect(ta.placeholder).toBe(zh.placeholderIdle.replace("{name}", "pi"));
		expect(sendBtn.title).toBe(zh.sendTip);

		typeText(c, "test message");
		pressKey(c, "Enter");

		expect(onSent).toHaveBeenCalledTimes(1);
		expect(ta.value).toBe("");
	});

	it("Shift+Enter 在 enter 模式下不发送", () => {
		const onSent = vi.fn();
		const c = mountChatInput({ onSent });
		const ta = c.querySelector("textarea") as HTMLTextAreaElement;

		typeText(c, "test message");
		pressKey(c, "Enter", { shiftKey: true });

		expect(onSent).not.toHaveBeenCalled();
		expect(ta.value).toBe("test message");
	});

	it("切换到 mod-enter 模式：文案即时更新，普通 Enter 不发送，Ctrl/Cmd+Enter 发送", () => {
		const onSent = vi.fn();
		const c = mountChatInput({ onSent });
		const ta = c.querySelector("textarea") as HTMLTextAreaElement;
		const sendBtn = c.querySelector(".btn.send") as HTMLElement;

		act(() => {
			saveSendKeyPref("mod-enter");
		});

		expect(ta.placeholder).toBe(zh.placeholderIdleMod.replace("{name}", "pi"));
		expect(sendBtn.title).toBe(zh.sendTipMod);

		typeText(c, "hello mod");

		pressKey(c, "Enter");
		expect(onSent).not.toHaveBeenCalled();
		expect(ta.value).toBe("hello mod");

		pressKey(c, "Enter", { shiftKey: true });
		expect(onSent).not.toHaveBeenCalled();

		pressKey(c, "Enter", { ctrlKey: true });
		expect(onSent).toHaveBeenCalledTimes(1);
		expect(ta.value).toBe("");

		typeText(c, "hello mac");
		pressKey(c, "Enter", { metaKey: true });
		expect(onSent).toHaveBeenCalledTimes(2);
		expect(ta.value).toBe("");
	});

	it("macOS 中文输入法上屏 Enter 在 mod-enter 模式下亦不误触发送", () => {
		const onSent = vi.fn();
		const c = mountChatInput({ onSent });
		const ta = c.querySelector("textarea") as HTMLTextAreaElement;

		act(() => {
			saveSendKeyPref("mod-enter");
		});

		typeText(c, "inputting");
		pressKey(c, "Enter", { isComposing: true, ctrlKey: true });
		expect(onSent).not.toHaveBeenCalled();
		expect(ta.value).toBe("inputting");
	});
});
