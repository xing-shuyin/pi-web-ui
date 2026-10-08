// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { DshQuestionDialog } from "../../web/src/components/DshQuestionDialog.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";

/**
 * DshQuestionDialog 测试（jsdom）：验证
 *   1. 富渲染：question/detail 按 markdown（rawHtml），选项描述/预览富文本
 *   2. 向导式：一次只显示一题；单选点选项自动切下一题；末题点选项自动提交
 *   3. 上一步可回头修改；底部取消发送 cancelled 回答
 * 全部确定性、零 token、零模型 —— 不依赖 DSH 引擎是否真发 preview。
 */

type Question = Parameters<typeof DshQuestionDialog>[0]["question"];

const baseQuestion: Question = {
	id: "q1",
	questions: [
		{
			id: "c1",
			question: "Which **one**?",
			detail: "Pick an <em>option</em> below.",
			options: [
				{ label: "A", description: "Opt **A**", preview: "**preview A**\n\n- a1\n- a2" },
				{ label: "B", description: "Opt B" },
			],
		},
	],
};

const wizardQuestion: Question = {
	id: "q2",
	questions: [
		{ id: "c1", question: "Q1", options: [{ label: "A" }, { label: "B" }] },
		{ id: "c2", question: "Q2", options: [{ label: "X" }, { label: "Y" }] },
	],
};

let root: Root | null = null;

function mount(question: Question = baseQuestion, send: (msg: unknown) => boolean = () => true) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: unknown[] = [];
	// 组件不再接 send prop——发消息走全局发送器（web/src/app-globals.ts 的 appSend），
	// 测试在这里注入实现并记录（这也是全局化后组件可测的方式）。
	setAppSend((msg) => {
		sent.push(msg);
		return send(msg);
	});
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(DshQuestionDialog, {
					question,
				}),
			),
		);
	});
	return { container, sent };
}

function click(container: HTMLElement, sel: string | HTMLElement) {
	const el = typeof sel === "string" ? (container.querySelector(sel) as HTMLElement) : sel;
	if (!el) throw new Error(`cannot find ${sel}`);
	act(() => {
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

/** 把 IME 预编辑文本写进 DOM（真实输入法走的是同一条 input 链路）。 */
function setNativeValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new CompositionEvent("input", { bubbles: true, data: value }));
	});
}

/** 派发一个 keydown（默认 Enter），isComposing 可控。 */
function pressEnter(input: HTMLInputElement, isComposing = false) {
	act(() => {
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing }));
	});
}

afterEach(() => {
	setAppSend(null); // 断开全局发送器，避免串到下一个用例
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
});

describe("DshQuestionDialog rich rendering", () => {
	it("question 按 markdown 渲染（**粗体** → <strong>）", () => {
		const { container } = mount();
		const strong = container.querySelector(".question-head strong");
		expect(strong?.textContent).toBe("one");
	});

	it("detail 里的内嵌 HTML 按 rawHtml 渲染成 <em>", () => {
		const c = mount();
		expect(c.container.querySelector(".set-hint em")?.textContent).toBe("option");
	});

	it("选项描述按 markdown 渲染", () => {
		const c = mount();
		expect(c.container.querySelector(".question-option .set-row-desc strong")?.textContent).toBe("A");
	});

	it("未选中带 preview 选项时无预览框，选中后出现富文本预览", () => {
		const c = mount();
		expect(c.container.querySelector(".question-preview")).toBeNull();

		// 点击带 preview 的选项 A（单选 → 自动提交；组件不被卸载，预览仍在）
		click(c.container, ".question-option");

		const preview = c.container.querySelector(".question-preview");
		expect(preview).not.toBeNull();
		expect(preview?.querySelector(".question-preview-label")?.textContent?.length).toBeGreaterThan(0);
		// preview markdown 渲染：**preview A** → <strong>，列表 → <li>
		expect(preview?.querySelector("strong")?.textContent).toBe("preview A");
		expect(preview?.querySelectorAll("li").length).toBe(2);
	});
});

describe("DshQuestionDialog wizard", () => {
	it("多题时每次只显示一题，点选项直接进入下一题", () => {
		const c = mount(wizardQuestion);
		expect(c.container.textContent).toContain("Q1");
		expect(c.container.textContent).not.toContain("Q2");

		click(c.container, ".question-option"); // 选第一题 A

		expect(c.container.textContent).toContain("Q2");
		expect(c.container.textContent).not.toContain("Q1");
		// 进度指示可见
		expect(c.container.querySelector(".question-progress")?.textContent).toContain("2");
		expect(c.container.textContent).toContain("2 /");
	});

	it("单选点选项即选中（标记 ●），上一步可返回并已记住选择", () => {
		const c = mount(wizardQuestion);
		click(c.container, ".question-option"); // 第一题选 A → 切到第二题

		// 回退后第一题仍在，且 A 已选中
		click(c.container, ".dialog-prev");
		expect(c.container.textContent).toContain("Q1");
		const activeRows = c.container.querySelectorAll(".question-option.active").length;
		expect(activeRows).toBe(1);
	});

	it("第一题禁用「上一步」", () => {
		const c = mount(wizardQuestion);
		const prev = c.container.querySelector(".dialog-prev") as HTMLButtonElement;
		expect(prev.disabled).toBe(true);
	});

	it("最后一题点选项自动提交全部答案（含前几题的选择）", () => {
		const c = mount(wizardQuestion);
		click(c.container, ".question-option"); // Q1 → A
		click(c.container, ".question-option"); // Q2 → X（最后一题 → 自动提交）

		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { type: string; answers: unknown[]; cancelled?: boolean };
		expect(msg.type).toBe("question_answer");
		expect(msg.cancelled ?? false).toBe(false);
		expect(msg.answers).toEqual([
			{ id: "c1", selected: ["A"] },
			{ id: "c2", selected: ["X"] },
		]);
	});

	it("单题问卷点选项即自动提交", () => {
		const c = mount(baseQuestion);
		click(c.container, ".question-option"); // 唯一题的选项 A
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { answers: unknown[] };
		expect(msg.answers).toEqual([{ id: "c1", selected: ["A"] }]);
	});

	it("底部「取消」发送 cancelled 回答", () => {
		const c = mount(wizardQuestion);
		click(c.container, ".dialog-dismiss-inline");
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { cancelled?: boolean; answers: unknown[] };
		expect(msg.cancelled).toBe(true);
		expect(msg.answers).toEqual([]);
	});

	it("多选题点选项只切换勾选、不前进；下一步/提交推进", () => {
		const q: Question = {
			id: "q3",
			questions: [
				{
					id: "c1",
					question: "M1",
					multiSelect: true,
					options: [{ label: "A" }, { label: "B" }],
				},
				{ id: "c2", question: "Q2", options: [{ label: "X" }] },
			],
		};
		const c = mount(q);
		const opts = () => Array.from(c.container.querySelectorAll(".question-option")) as HTMLElement[];
		click(c.container, ".question-option"); // 勾选 A
		click(c.container, opts()[1]); // 勾选 B（仍在第一题）
		expect(c.container.textContent).toContain("M1");
		expect(c.container.textContent).not.toContain("Q2");

		// 下一题按钮可用 → 推进
		const nextBtn = c.container.querySelector(".dialog-submit") as HTMLButtonElement;
		expect(nextBtn.disabled).toBe(false);
		click(c.container, ".dialog-submit");
		expect(c.container.textContent).not.toContain("M1");
		expect(c.container.textContent).toContain("Q2");

		// 最后一题点选项 → 提交，选中含多选两项
		click(c.container, ".question-option");
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { answers: { id: string; selected: string[] }[] };
		expect(msg.answers[0]).toEqual({ id: "c1", selected: ["A", "B"] });
	});

	it("无选项的自定义题：未输入文字也可提交（空提交 = 跳过）", () => {
		const q: Question = {
			id: "q4",
			questions: [{ id: "fill", question: "补充说明（可选）", options: [] }],
		};
		const c = mount(q);
		const submit = c.container.querySelector(".dialog-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(false); // 无选项 → 空提交允许
		click(c.container, ".dialog-submit");
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { answers: unknown[]; cancelled?: boolean };
		expect(msg.cancelled ?? false).toBe(false);
		expect(msg.answers).toEqual([{ id: "fill", selected: [] }]); // 无 custom 键
	});

	it("有选项但未选、也未填字：提交仍禁用（可选题≠可跳过）", () => {
		const c = mount(baseQuestion);
		const submit = c.container.querySelector(".dialog-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(true); // 有选项仍须作答
	});
});

/**
 * 选项详情浮层回归：描述曾经是 `.question-option` 里的 absolute 层
 * （`bottom: calc(100% + 6px)`），被 `.dialog-inline{max-height:45vh; overflow-y:auto}`
 * 在上方裁掉、滚也滚不到。改用 HoverDetail（portal 到 body + fixed）后，
 * 浮层必须挂在对话框子树之外，才谈得上「不受任何祖先 overflow 裁剪」。
 */
describe("DshQuestionDialog 选项详情浮层", () => {
	const tip = () => document.body.querySelector(".question-desc-tip");

	it("hover 选项时以顶层浮层渲染：内容富文本，且不在对话框子树里", () => {
		const c = mount();
		expect(tip()).toBeNull();

		const row = c.container.querySelector(".question-option") as HTMLElement;
		act(() => {
			row.dispatchEvent(new MouseEvent("mouseenter"));
		});

		const el = tip();
		expect(el).not.toBeNull();
		expect(el?.getAttribute("role")).toBe("tooltip");
		// 关键：不在 .dialog-inline 内 —— 因此不受它的 max-height / overflow 裁剪
		expect(c.container.querySelector(".question-desc-tip")).toBeNull();
		expect(el?.querySelector("strong")?.textContent).toBe("A"); // "Opt **A**" 走 markdown
	});

	it("指针移开后留宽限期再收起（浮层可悬停/滚动）", () => {
		vi.useFakeTimers();
		try {
			const c = mount();
			const row = c.container.querySelector(".question-option") as HTMLElement;
			act(() => {
				row.dispatchEvent(new MouseEvent("mouseenter"));
			});
			expect(tip()).not.toBeNull();

			act(() => {
				row.dispatchEvent(new MouseEvent("mouseleave"));
			});
			expect(tip()).not.toBeNull(); // 宽限期内仍在（指针可移入浮层继续读）

			act(() => {
				vi.advanceTimersByTime(500);
			});
			expect(tip()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("鼠标移进浮层时不收起：relatedTarget 在浮层内（真实浏览器里这条 leave 晚于浮层 enter）", () => {
		vi.useFakeTimers();
		try {
			const c = mount();
			const row = c.container.querySelector(".question-option") as HTMLElement;
			act(() => {
				row.dispatchEvent(new MouseEvent("mouseenter"));
			});
			const inner = tip()?.querySelector("strong") as HTMLElement;
			expect(inner).toBeTruthy();

			// 浮层 portal 到 body，DOM 上不在选项行子树里 —— 指针移进浮层时锚点照样收到
			// mouseleave，且实测它派发在浮层的 onMouseEnter 之后。以 relatedTarget 判定，
			// 不能只看事件先后（否则宽限期定时器会把浮层关掉）。
			act(() => {
				row.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: inner }));
			});
			act(() => {
				vi.advanceTimersByTime(500);
			});
			expect(tip()).not.toBeNull();

			// 真正离开（relatedTarget 落在浮层外）才收起。
			act(() => {
				row.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: row }));
			});
			act(() => {
				vi.advanceTimersByTime(500);
			});
			expect(tip()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("DshQuestionDialog 对话名字展示", () => {
	it("当 question 携带 conversationTitle 时在头部展示", () => {
		const q: Question = {
			...baseQuestion,
			conversationTitle: "测试对话名字",
		};
		const { container } = mount(q);
		const titleEl = container.querySelector(".question-conv-title");
		expect(titleEl).not.toBeNull();
		expect(titleEl?.textContent?.trim()).toBe("测试对话名字");
		expect(titleEl?.getAttribute("title")).toBe("测试对话名字");
	});

	it("当未提供 conversationTitle 时不渲染对话名字元素", () => {
		const { container } = mount(baseQuestion);
		const titleEl = container.querySelector(".question-conv-title");
		expect(titleEl).toBeNull();
	});

	it("当通过 conversationTitle prop 提供时在头部展示（兜底场景）", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		setAppSend(() => true);
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(DshQuestionDialog, {
						question: baseQuestion,
						conversationTitle: "兜底对话名字",
					}),
				),
			);
		});
		const titleEl = container.querySelector(".question-conv-title");
		expect(titleEl).not.toBeNull();
		expect(titleEl?.textContent?.trim()).toBe("兜底对话名字");
	});
});

describe("DshQuestionDialog 折叠与展开", () => {
	it("默认处于展开状态，显示题目与操作栏", () => {
		const { container } = mount(baseQuestion);
		const inline = container.querySelector(".dialog-inline");
		expect(inline?.classList.contains("collapsed")).toBe(false);
		expect(container.querySelector(".set-section")).not.toBeNull();
		expect(container.querySelector(".dialog-nav")).not.toBeNull();
		expect(container.querySelector(".question-collapsed-preview")).toBeNull();

		const toggleBtn = container.querySelector(".dialog-toggle-collapse") as HTMLButtonElement;
		expect(toggleBtn).not.toBeNull();
		expect(["折叠", "Collapse"]).toContain(toggleBtn.getAttribute("title"));
	});

	it("点击折叠按钮后进入收起态，隐藏题目主体并展示头部简要", () => {
		const { container } = mount(baseQuestion);
		click(container, ".dialog-toggle-collapse");

		const inline = container.querySelector(".dialog-inline");
		expect(inline?.classList.contains("collapsed")).toBe(true);
		expect(container.querySelector(".set-section")).toBeNull();
		expect(container.querySelector(".dialog-nav")).toBeNull();

		const preview = container.querySelector(".question-collapsed-preview");
		expect(preview).not.toBeNull();
		expect(preview?.textContent).toContain("Which **one**?");

		const toggleBtn = container.querySelector(".dialog-toggle-collapse") as HTMLButtonElement;
		expect(["展开", "Expand"]).toContain(toggleBtn.getAttribute("title"));
	});

	it("在收起态点击展开按钮可恢复完整题目面板", () => {
		const { container } = mount(baseQuestion);
		click(container, ".dialog-toggle-collapse");
		expect(container.querySelector(".dialog-inline")?.classList.contains("collapsed")).toBe(true);

		click(container, ".dialog-toggle-collapse");
		expect(container.querySelector(".dialog-inline")?.classList.contains("collapsed")).toBe(false);
		expect(container.querySelector(".set-section")).not.toBeNull();
		expect(container.querySelector(".dialog-nav")).not.toBeNull();
	});

	it("在收起态点击头部整行可直接展开", () => {
		const { container } = mount(baseQuestion);
		click(container, ".dialog-toggle-collapse");
		expect(container.querySelector(".dialog-inline")?.classList.contains("collapsed")).toBe(true);

		const head = container.querySelector(".dialog-head") as HTMLElement;
		click(container, head);
		expect(container.querySelector(".dialog-inline")?.classList.contains("collapsed")).toBe(false);
		expect(container.querySelector(".set-section")).not.toBeNull();
	});

	it("折叠并重新展开后，用户输入与选项勾选状态完整保留", () => {
		const { container } = mount(baseQuestion);
		// 勾选选项 A
		const optA = container.querySelector(".question-option") as HTMLElement;
		click(container, optA);
		expect(optA.classList.contains("active")).toBe(true);

		// 输入自定义文本
		const input = container.querySelector(".question-custom") as HTMLInputElement;
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		act(() => {
			setter.call(input, "my custom reply");
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});

		// 折叠
		click(container, ".dialog-toggle-collapse");
		expect(container.querySelector(".set-section")).toBeNull();

		// 重新展开
		click(container, ".dialog-toggle-collapse");
		const optAReopened = container.querySelector(".question-option") as HTMLElement;
		expect(optAReopened.classList.contains("active")).toBe(true);
		const inputReopened = container.querySelector(".question-custom") as HTMLInputElement;
		expect(inputReopened.value).toBe("my custom reply");
	});

	it("新提问到来时自动重置为展开状态", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		setAppSend(() => true);

		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(DshQuestionDialog, {
						question: baseQuestion,
					}),
				),
			);
		});

		// 先折叠
		click(container, ".dialog-toggle-collapse");
		expect(container.querySelector(".dialog-inline")?.classList.contains("collapsed")).toBe(true);

		// 收到新提问 id
		const nextQuestion: Question = {
			id: "q_next",
			questions: [{ id: "step1", question: "Next question?" }],
		};
		act(() => {
			root!.render(
				createElement(
					LanguageProvider,
					null,
					createElement(DshQuestionDialog, {
						question: nextQuestion,
					}),
				),
			);
		});

		expect(container.querySelector(".dialog-inline")?.classList.contains("collapsed")).toBe(false);
		expect(container.querySelector(".set-section")).not.toBeNull();
	});
});

/**
 * issue #560：macOS 中文输入法（鼠须管）下，「补充回答」输入框里敲英文按回车是**上屏**，
 * 不是提交。修复前只看 `e.key === "Enter"`，文字刚上屏就把问卷答案发给模型，面板随之收起
 * 且无法修改。本组用例锁住两条漏判路径（与 #248 同源）。
 */
describe("DshQuestionDialog 输入法上屏回车不提交（issue #560）", () => {
	it("组合态回车（isComposing=true）不提交，仅让文字上屏", () => {
		const { container, sent } = mount(baseQuestion);
		const input = container.querySelector(".question-custom") as HTMLInputElement;

		act(() => {
			input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
		});
		setNativeValue(input, "hello");
		pressEnter(input, true);

		expect(sent).toEqual([]);
		expect(input.value).toBe("hello");
		// 面板仍在（没有提交就没有收起）
		expect(container.querySelector(".question-custom")).not.toBeNull();
	});

	it("compositionend 刚结束时那个 isComposing=false 的回车也不提交（#248 的 macOS 变体）", () => {
		const { container, sent } = mount(baseQuestion);
		const input = container.querySelector(".question-custom") as HTMLInputElement;

		setNativeValue(input, "hello");
		act(() => {
			input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "hello" }));
		});
		pressEnter(input, false);

		expect(sent).toEqual([]);
		expect(input.value).toBe("hello");
	});

	it("上屏回车之后再按一次回车才是提交（答案含刚上屏的文本）", () => {
		const { container, sent } = mount(baseQuestion);
		const input = container.querySelector(".question-custom") as HTMLInputElement;

		setNativeValue(input, "hello");
		act(() => {
			input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "hello" }));
		});
		pressEnter(input, false); // 上屏用
		expect(sent).toEqual([]);

		// 等过 50ms 宽限期：跨过时间窗后同一个键就是正常提交
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 1000);
		pressEnter(input, false);
		vi.useRealTimers();

		expect(sent).toHaveLength(1);
		const msg = sent[0] as { type: string; answers: { id: string; custom?: string }[] };
		expect(msg.type).toBe("question_answer");
		expect(msg.answers[0]?.custom).toBe("hello");
	});
});
