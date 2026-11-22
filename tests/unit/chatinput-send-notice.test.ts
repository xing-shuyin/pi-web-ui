// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ChatInput } from "../../web/src/components/ChatInput.js";
import { TemplateProvider } from "../../web/src/components/PromptTemplates.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { setGoalCompose, setGoalPlan, setGoalRefine } from "../../web/src/goal-compose.js";
import { LanguageProvider, zh } from "../../web/src/i18n.js";

let root: Root | null = null;

beforeEach(() => {
	// 带附件会挂上尺寸观察（jsdom 没有 ResizeObserver），见 group-conversation.test.ts 同款桩。
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});

function mount(opts: {
	ready: boolean;
	sendResult: boolean;
	onNotice: (level: string, text: string) => void;
	onSent: () => void;
	attachments?: { path: string; name: string; imageData?: string; key?: string }[];
	onRemoveAttachment?: (key: string) => void;
	sentMessages?: unknown[];
}) {
	setAppGlobals({ ready: opts.ready });
	setAppSend((m) => {
		opts.sentMessages?.push(m);
		return opts.sendResult;
	});
	try {
		localStorage.setItem("pi-web-ui:lang", "zh");
	} catch {}
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
						attachments: opts.attachments ?? [],
						onRemoveAttachment: opts.onRemoveAttachment ?? (() => {}),
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
	setGoalCompose(false);
	setGoalPlan(false);
	setGoalRefine(false);
	setAppSend(null);
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
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
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello");
	});

	it("未连接时 Enter 提交：error notice + 文本保留（不静默吞掉）", () => {
		const notices: [string, string][] = [];
		const onSent = vi.fn();
		const c = mount({ ready: true, sendResult: true, onNotice: (l, t) => notices.push([l, t]), onSent });

		typeText(c, "hello");
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
		dispatchCompositionEnd(c);
		pressEnter(c, { isComposing: false });

		expect(onSent).not.toHaveBeenCalled();
		expect((c.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello");
	});
});

describe("ChatInput 目标撰写态 × 附件（issue #962：不再拦截，改走 materials 指针）", () => {
	it("带可寻址附件的目标可以发送：路径作 materials 出现在 set_goal 里，发送后调 onSent（清空附件）", () => {
		const notices: [string, string][] = [];
		const sent: unknown[] = [];
		const onSent = vi.fn();
		const c = mount({
			ready: true,
			sendResult: true,
			onNotice: (l, t) => notices.push([l, t]),
			onSent,
			attachments: [{ path: "docs/spec.md", name: "spec.md", key: "k1" }],
			sentMessages: sent,
		});
		// compose 在 mount 的 effect 里会被重置，必须挂载后再点亮
		act(() => setGoalCompose(true));

		typeText(c, "按 spec.md 把接口补完");
		const send = c.querySelector(".btn.send") as HTMLButtonElement;
		expect(send.disabled).toBe(false);
		clickSend(c);

		expect(notices).toEqual([]);
		expect(onSent).toHaveBeenCalledTimes(1);
		expect(sent).toHaveLength(1);
		const msg = sent[0] as { type: string; goal: string; materials?: string[] };
		expect(msg.type).toBe("set_goal");
		expect(msg.goal).toBe("按 spec.md 把接口补完");
		expect(msg.materials).toEqual(["docs/spec.md"]);
		// 附件随普通发送一样在发送成功后清空（App 的 onSent 负责），这里以 onSent 为契约。
	});

	it("只有 base64 没有路径的图片：随消息上传成 materialBlobs，不阻断发送、也不误报为不支持", () => {
		const notices: [string, string][] = [];
		const sent: unknown[] = [];
		const onSent = vi.fn();
		const c = mount({
			ready: true,
			sendResult: true,
			onNotice: (l, t) => notices.push([l, t]),
			onSent,
			attachments: [
				{ path: "shot.png", name: "shot.png", imageData: "AAA", key: "k1" },
				{ path: "spec.md", name: "spec.md", key: "k2" },
			],
			sentMessages: sent,
		});
		act(() => setGoalCompose(true));

		typeText(c, "看着截图修一下");
		clickSend(c);

		expect(notices).toEqual([]);
		expect(onSent).toHaveBeenCalledTimes(1);
		const msg = sent[0] as { materials?: string[]; materialBlobs?: { name?: string; data: string }[] };
		expect(msg.materials).toEqual(["spec.md"]);
		expect(msg.materialBlobs).toEqual([{ name: "shot.png", data: "AAA" }]);
	});

	it("目标态 + 只有附件没有文字：不发送（目标是一个字符串，材料不能代替它）", () => {
		const onSent = vi.fn();
		const sent: unknown[] = [];
		const c = mount({
			ready: true,
			sendResult: true,
			onNotice: vi.fn(),
			onSent,
			attachments: [{ path: "spec.md", name: "spec.md", key: "k1" }],
			sentMessages: sent,
		});
		act(() => setGoalCompose(true));

		const send = c.querySelector(".btn.send") as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		pressEnter(c);

		expect(sent).toEqual([]);
		expect(onSent).not.toHaveBeenCalled();
	});

	it("目标调研（wizard）也带 materials：提炼阶段就能看到文件", () => {
		const sent: unknown[] = [];
		const onSent = vi.fn();
		const c = mount({
			ready: true,
			sendResult: true,
			onNotice: vi.fn(),
			onSent,
			attachments: [{ path: "docs/spec.md", name: "spec.md", key: "k1" }],
			sentMessages: sent,
		});
		act(() => setGoalCompose(true));
		act(() => setGoalRefine(true));

		typeText(c, "围绕 spec 定个目标");
		clickSend(c);

		const msg = sent[0] as { type: string; materials?: string[] };
		expect(msg.type).toBe("start_goal_wizard");
		expect(msg.materials).toEqual(["docs/spec.md"]);
		expect(onSent).toHaveBeenCalledTimes(1);
	});

	it("「计划」是一次性修饰：目标发送后自动熄灭，不留常亮 flag（#961）", () => {
		const sent: unknown[] = [];
		const c = mount({
			ready: true,
			sendResult: true,
			onNotice: vi.fn(),
			onSent: vi.fn(),
			sentMessages: sent,
		});
		act(() => setGoalCompose(true));
		act(() => setGoalPlan(true));
		expect(localStorage.getItem("pi-web-ui:goal-plan")).toBe("1");

		typeText(c, "把目标做完");
		clickSend(c);

		expect(sent.map((m) => (m as { type: string }).type)).toEqual(["set_goal", "set_plan_mode"]);
		expect(localStorage.getItem("pi-web-ui:goal-plan")).toBe("0");
	});
});
