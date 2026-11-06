import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

const CSS_NO_COMMENT = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

function allRules(src: string): { selector: string; body: string }[] {
	const out: { selector: string; body: string }[] = [];
	const stack: { sel: string; start: number }[] = [];
	let buf = "";
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") {
			stack.push({ sel: buf.trim(), start: i + 1 });
			buf = "";
		} else if (ch === "}") {
			const top = stack.pop();
			if (top) {
				if (top.sel.startsWith("@")) {
					if (!/^@(keyframes|font-face)/.test(top.sel)) out.push(...allRules(src.slice(top.start, i)));
				} else {
					out.push({ selector: top.sel, body: src.slice(top.start, i) });
				}
			}
			buf = "";
		} else if (ch === ";" && stack.length === 0) {
			buf = "";
		} else {
			buf += ch;
		}
	}
	return out;
}

const RULES = allRules(CSS_NO_COMMENT);

function bodyOf(selector: string): string {
	let acc = "";
	for (const { selector: sel, body } of RULES) {
		const parts = sel.split(",").map((s) => s.trim());
		if (parts.some((s) => s === selector)) acc += `${body}\n`;
	}
	if (acc) return acc;
	for (const { selector: sel, body } of RULES) {
		if (sel.endsWith(` ${selector}`) || sel.includes(`, ${selector}`)) acc += body;
	}
	return acc;
}

const WRAPS = /overflow-wrap\s*:\s*(anywhere|break-word)|word-break\s*:\s*(break-word|break-all)/;
const ELLIPSIS = (body: string) =>
	/overflow(-x|-y)?\s*:\s*hidden/.test(body) && /text-overflow\s*:\s*ellipsis/.test(body);

const TEXT_CONTAINERS = [
	".md",
	".msg-text",
	".thinking-body",
	".trunc-note",
	".msg-model",
	".attachcard-content",
	".attachcard-refnote",
	".attachcard-bridgenote",
	".widget-lines",
	".tool-info-text",
	".delegate-sec-text",
	".present-note",
	".set-tip-bubble",
	".source-default-text",
	".setup-detail",
	".set-prompt-view-text",
	".dialog-body",
	".dialog-prompt",
	".dialog-option",
	".msg-error",
	".goalbar-stale",
	".goalbar-round > span",
	".notice-text",
];

const SINGLE_LINE_IN_ROW = [
	".chead-title",
	".goalbar-detail",
	".present-item-name",
	".gs-item-title",
	".attachcard-path",
	".msg-editor-file-name",
	".bashblock-command code",
	".goalbar-lock-hint",
	".goalbar-chip",
	".goalbar-hint span",
	".toolcall-timeout",
	".toolcall-path",
	".toolcall-cmd",
	".toolcall-agent",
	".msg-collapsed-preview",
	".msg-collapsed-chip",
	".question-collapsed-preview",
	".dialog-title",
];

const ROW_CONTAINERS = [".goalbar", ".goalbar-row", ".goalbar-active-row", ".bashblock-command"];

describe("长 token 断行口径（窄屏横向溢出体检）", () => {
	it.each(TEXT_CONTAINERS)("%s 要能断行（overflow-wrap/word-break）", (selector) => {
		const body = bodyOf(selector);
		expect(body, `${selector} 在 styles.css 里没有声明`).not.toBe("");
		expect(
			WRAPS.test(body) || ELLIPSIS(body),
			`${selector} 缺断行口径：加 overflow-wrap: anywhere（或 overflow:hidden + text-overflow:ellipsis）`,
		).toBe(true);
	});

	it.each(SINGLE_LINE_IN_ROW)("%s 单行收着（overflow:hidden + ellipsis）", (selector) => {
		const body = bodyOf(selector);
		expect(body, `${selector} 在 styles.css 里没有声明`).not.toBe("");
		expect(ELLIPSIS(body), `${selector} 缺单行收着口径：overflow:hidden + text-overflow:ellipsis`).toBe(true);
	});

	it.each(ROW_CONTAINERS)("%s 行容器不外溢（min-width:0 + max-width:100%）", (selector) => {
		const body = bodyOf(selector);
		expect(body, `${selector} 在 styles.css 里没有声明`).not.toBe("");
		expect(
			/min-width\s*:\s*0/.test(body) && /max-width\s*:\s*100%/.test(body),
			`${selector} 可能被长子项顶宽：加 min-width: 0 + max-width: 100%（flex 行必写）`,
		).toBe(true);
	});

	it("行内 pre 文本（工具参数/工具输出/终端输出/裸 pre）自己横向滚动，不外溢", () => {
		for (const selector of [
			".toolcall-args pre",
			".toolcall-output pre",
			".bashblock-output",
			".codeblock pre",
			".md > pre",
			".msg-text pre",
		]) {
			const body = bodyOf(selector);
			expect(body, `${selector} 在 styles.css 里没有声明`).not.toBe("");
			expect(/overflow(-x)?\s*:\s*(auto|scroll)/.test(body), `${selector} 缺 overflow-x: auto`).toBe(true);
		}
	});
});

describe("卡片头右端按钮列（窄屏对齐 / 不外溢）", () => {
	it(".chead 行容器不外溢（min-width:0 + max-width:100%）", () => {
		const body = bodyOf(".chead");
		expect(body).not.toBe("");
		expect(
			/min-width\s*:\s*0/.test(body) && /max-width\s*:\s*100%/.test(body),
			".chead 可能被长子项（路径/命令/插件徽标）顶宽：加 min-width: 0 + max-width: 100%",
		).toBe(true);
	});

	it.each([".toolcall-path", ".toolcall-cmd", ".toolcall-agent", ".toolcall-timeout"])(
		"%s 可缩（min-width: 0，别写 flex-shrink: 0）",
		(selector) => {
			const body = bodyOf(selector);
			expect(body, `${selector} 在 styles.css 里没有声明`).not.toBe("");
			expect(/min-width\s*:\s*0/.test(body), `${selector} 缺 min-width: 0（不许撑破卡头行）`).toBe(true);
			expect(
				/flex-shrink\s*:\s*0\b/.test(body),
				`${selector} 写回了 flex-shrink: 0（放不下时不让步 → 整行顶宽 → 右端按钮被顶出卡头）`,
			).toBe(false);
		},
	);

	it("右端复制键在流内时钉死宽度（flex: none，否则不是对齐基准）", () => {
		const body = bodyOf(".chead > .chead-copy");
		expect(body).not.toBe("");
		expect(/flex\s*:\s*none/.test(body), ".chead > .chead-copy 缺 flex: none（触屏在流内，宽度必须固定）").toBe(true);
	});

	it("路径是卡头里最先让位的一项（shrink 权重高于其它提示文本）", () => {
		const weight = (selector: string) => Number(bodyOf(selector).match(/flex:\s*0\s+(\d+)\s+auto/)?.[1] ?? 1);
		const path = weight(".toolcall-path");
		expect(path, ".toolcall-path 的 flex 简写里没有 shrink 权重（写成 flex: 0 1 auto 以外的形式也行）").toBeGreaterThan(
			0,
		);
		for (const other of [".toolcall-cmd", ".toolcall-agent", ".toolcall-timeout"]) {
			expect(path, `路径必须比 ${other} 先让位`).toBeGreaterThan(weight(other));
		}
	});

	it("工具名带地板地收缩（短名字永远完整：min-width ≥ 4ch，不许 flex: none）", () => {
		const body = bodyOf(".chead-title.toolcall-name");
		expect(body, ".chead-title.toolcall-name 在 styles.css 里没有声明").not.toBe("");
		expect(/flex\s*:\s*0\s+1\s+auto/.test(body), "工具名应 flex: 0 1 auto（可缩，带地板）").toBe(true);
		const floor = body.match(/min-width\s*:\s*(\d+(?:\.\d+)?)ch/);
		expect(floor, "工具名必须有 ch 级 min-width 地板（短工具名不许被挤成省略号）").not.toBeNull();
		expect(Number(floor?.[1]), "工具名地板至少 4ch（read/bash 约 4 个字符宽）").toBeGreaterThanOrEqual(4);
	});

	it("路径有下限（可以短，不许缩到 0 消失）与上隐（不许吃掉整行）", () => {
		const body = bodyOf(".toolcall-path");
		const floor = body.match(/min-width\s*:\s*(\d+(?:\.\d+)?)ch/);
		expect(floor, "路径缺 ch 级 min-width 地板").not.toBeNull();
		expect(Number(floor?.[1]), "地板 7ch 左右：再大就把 320px 手机的按钮簇顶出去了").toBeLessThanOrEqual(9);
		expect(/max-width\s*:/.test(body), "路径缺 max-width 上限").toBe(true);
		expect(/overflow\s*:\s*hidden/.test(body), "路径要显式收着（overflow: hidden）").toBe(true);
	});

	it("思考标题仍可缩（.thinking-label 只许改 flex 成长，不许钉死）", () => {
		const body = bodyOf(".thinking-label");
		expect(body, ".thinking-label 在 styles.css 里没有声明").not.toBe("");
		expect(/flex\s*:\s*none/.test(body), ".thinking-label 不许 flex: none").toBe(false);
		expect(/flex-shrink\s*:\s*0\b/.test(body), ".thinking-label 不许 flex-shrink: 0").toBe(false);
		expect(ELLIPSIS(bodyOf(".chead-title")), ".chead-title 缺 ellipsis 收着口径").toBe(true);
		expect(/min-width\s*:\s*0/.test(bodyOf(".chead-title")), ".chead-title 缺 min-width: 0").toBe(true);
	});
});

describe("滚动容器防穿透与滚动链放行区分", () => {
	it.each([".toolcall-output pre", ".toolcall-args pre", ".codemode-code"])(
		"%s 不得声明 overscroll-behavior: contain，防止滚动黑洞锁死外部对话流",
		(selector) => {
			const body = bodyOf(selector);
			expect(body, `${selector} 在 styles.css 里没有声明`).not.toBe("");
			expect(
				/overscroll-behavior(?:-y)?\s*:\s*contain/.test(body),
				`${selector} 不得声明 overscroll-behavior: contain（流内卡片若声明 contain 会截断滚轮链式传递，即便内部不可滚动也会导致整个对话流被锁死；吸底保护由 MessageList.handleWheel 判定层统一守护）`,
			).toBe(false);
		},
	);

	it.each([
		".plan-board-steps",
		".sandbox-diff-list",
		".compacted-history-messages",
		".bash-terminal-viewport",
		".generic-inspector-viewport",
	])("%s 独立面板列表声明 overscroll-behavior: contain 防止整页滚动穿透", (selector) => {
		const body = bodyOf(selector);
		expect(body, `${selector} 在 styles.css 里没有声明`).not.toBe("");
		expect(
			/overscroll-behavior(?:-y)?\s*:\s*contain/.test(body),
			`${selector} 缺少 overscroll-behavior: contain（独立浮层/面板列表滚到底顶时应防穿透）`,
		).toBe(true);
	});
});

describe("工具调用检查器视口滚动能力（Tool Inspector Modal Viewports）", () => {
	it.each([".bash-terminal-viewport", ".generic-inspector-viewport"])(
		"%s 视口容器拥有 height: 100% 与 overflow: auto 确保长输出可正常滚动",
		(selector) => {
			const body = bodyOf(selector);
			expect(body, `${selector} 在 styles.css 里没有声明`).not.toBe("");
			expect(/height\s*:\s*100%/.test(body), `${selector} 缺 height: 100%`).toBe(true);
			expect(/overflow(-y)?\s*:\s*auto/.test(body), `${selector} 缺 overflow: auto`).toBe(true);
		},
	);

	it("file-diff-inspector-body 直接子视口全覆盖滚动规则", () => {
		const requiredViewports = [
			".read-inspector-viewport",
			".file-diff-raw-body",
			".diff-unified-view",
			".diff-code-table",
			".thinking-inspector-content",
			".bash-terminal-viewport",
			".generic-inspector-viewport",
			".file-diff-pre",
		];
		for (const vp of requiredViewports) {
			const sel = `.file-diff-inspector-body > ${vp}`;
			const body = bodyOf(sel);
			expect(body, `${sel} 未设置滚动规则`).not.toBe("");
			expect(/overflow(-y)?\s*:\s*auto/.test(body), `${sel} 缺 overflow: auto`).toBe(true);
			expect(/height\s*:\s*auto/.test(body), `${sel} 应随内容自然增高`).toBe(true);
			expect(/min-height\s*:\s*0/.test(body), `${sel} 必须允许收缩以滚动长内容`).toBe(true);
		}
	});
});
