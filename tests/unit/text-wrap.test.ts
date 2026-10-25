/**
 * 长英文 / 长路径「窄屏溢出」静态体检。
 *
 * 背景（三个真 bug 同源）：
 *   1. `.messages` 是 `overflow-y: auto`，按 CSS 计算规则未显式声明的
 *      `overflow-x: visible` 会被算成 `auto` —— 所以**任何**子元素横向溢出，
 *      表现都是整条消息区冒出横向滚动条，手机端最明显；
 *   2. 模型原文里大量无空格长 token（长单词、绝对路径、URL、model id、
 *      标识符）。`white-space: pre-wrap` 只在已有空白处折行，挡不住它们；
 *   3. 行级 flex 子项默认 `min-width: auto`，不肯缩到内容宽度以下 ——
 *      于是一个长单词就能把整张卡片（看板行 / head 行 / bash 命令行）顶宽。
 *
 * 修法口径（与 `.msg-text`、`.msg-error`、`.fp-markdown` 早已在用的写法一致）：
 *   · 要么 `overflow-wrap: anywhere`（`word-break` 同族）允许断行；
 *   · 要么显式单行收着：`overflow: hidden` + `text-overflow: ellipsis`
 *     （flex 行里 overflow 非 visible 时 `min-width: auto` 自动解析为 0，
 *     `min-width: 0` 写出来只是更明确，不作硬要求）。
 *
 * 本测试是**静态**体检：只读 web/src/styles.css，毫秒级、零端口、零浏览器
 * （CI 必跑）。清单是「渲染模型 / 用户文本的容器」——新增这类容器时把它
 * 加进来，或至少照上面的口径写声明。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 锚到仓库根（不用 process.cwd()，同 css-tokens.test.ts 的理由）。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

/** 去注释后的整份 CSS（解析前先抹掉注释，免得注释里的括号影响配对）。 */
const CSS_NO_COMMENT = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 全部规则（selector, 声明体），@media / @supports 里的递归展开，@keyframes 子规则忽略。
 * 按大括号配对：开括号进栈、关括号出栈，嵌套层级不会把选择器串味。
 * （旧的按「行首是 }」配平那版会把 @media 里的规则与基础规则抢同一个 key，
 *  谁后写谁赢 —— 卡片头这套规则一半写在 @media 里，读出来是残缺的。）
 */
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
			buf = ""; // @import / @charset 之后重新起头
		} else {
			buf += ch;
		}
	}
	return out;
}

const RULES = allRules(CSS_NO_COMMENT);

/**
 * 收集某类的全部声明：精确选择器（含写在分组选择器 `.a,\n.foo` 里的），
 * 再退一步收后代写法（`.parent .foo`）。只看「有没有」，不判优先级。
 */
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

/** 断行口径：允许在任意位置折断长 token。 */
const WRAPS = /overflow-wrap\s*:\s*(anywhere|break-word)|word-break\s*:\s*(break-word|break-all)/;
/**
 * 单行收着口径：`overflow: hidden` + `text-overflow: ellipsis`。
 * 按 CSS Flex 规范，overflow 非 visible 时 `min-width: auto` 解析为 0，
 * 所以这类元素在 flex 行里已经能缩（现有 .chead-title / .goalbar-detail
 * 等都没写 min-width:0，照样安全）。
 */
const ELLIPSIS = (body: string) =>
	/overflow(-x|-y)?\s*:\s*hidden/.test(body) && /text-overflow\s*:\s*ellipsis/.test(body);

/** 渲染模型 / 用户文本的容器：必须能断行，或显式单行省略。 */
const TEXT_CONTAINERS = [
	".md", // 基线：所有 markdown 容器（消息、摘要、skillcard、问卷、present）
	".msg-text",
	".thinking-body",
	".trunc-note",
	".msg-model", // model id（provider/vendor/model-2026-xx）
	".attachcard-content",
	".attachcard-refnote", // 内插文件名
	".attachcard-bridgenote", // 内插文件名
	".widget-lines",
	".tool-info-text",
	".delegate-sec-text",
	".present-note",
	".set-tip-bubble", // pre-line + 绝对定位气泡
	".source-default-text",
	".setup-detail",
	".set-prompt-view-text",
	".dialog-body",
	".dialog-prompt",
	".dialog-option",
	".msg-error", // 长报错（URL / 报错码）
	".goalbar-stale", // 旧后端告警（整句，能断行）
	".goalbar-round > span", // 「最大轮数」标签（窄屏可压）
	".notice-text", // 顶部通知/提示条文本（可断行）
];

/** 行级 flex 里的单行文本：必须显式收着（overflow:hidden + ellipsis）。 */
const SINGLE_LINE_IN_ROW = [
	".chead-title",
	".goalbar-detail",
	".present-item-name",
	".gs-item-title",
	".attachcard-path",
	".msg-editor-file-name",
	".bashblock-command code",
	// 目标条（goal bar）：每个渲染长文案 / 无空格 token 的元素都得自己收，
	// 否则一行长文案就把整条目标条顶宽、消息区冒出横向滚动条（窄屏实报）。
	".goalbar-lock-hint", // 「锁定：应用到后续所有回合」这类长句
	".goalbar-chip", // 「第 12/50 轮」/ 判决胶囊
	".goalbar-hint span", // 收起态药丸里的标题
	// 工具调用 / 折叠行：命令、路径、超时徽标、文件徽标
	".toolcall-timeout",
	".toolcall-path",
	".toolcall-cmd",
	".toolcall-agent",
	".msg-collapsed-preview",
	".msg-collapsed-chip",
	".question-collapsed-preview",
	".dialog-title",
];

/** 横向不许外溢的**行容器**（flex 行/列本身必须钉在列宽内）。
 *  病根：行级 flex 子项默认 min-width:auto，长子项会把整行顶宽；列容器的
 *  overflow 未声明时计算成 auto → 整条消息区出横向滚动条（AGENTS §9）。 */
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

/* ---- 卡片头（.chead：思考 / 工具 / 附件 / 技能 / 压缩摘要共用）----
 * 窄屏实报过的两个病：① 工具行的右端按钮列**列不齐**（每行按路径长度各自
 * 右移）；② 整条消息区被顶出横向滚动条。两者同一个病根：卡头是 flex 行，
 * 右端常驻着一列按钮（触屏 @media (hover:none) 把它改回在流内），左边的
 * 提示文本却写着 flex-shrink:0 —— 放不下时它们不让步，整行被顶宽，按钮被
 * 顶出卡头右缘（.toolcall overflow:hidden 裁掉，点了没反应）。
 * 修法：提示文本可缩（min-width:0 + 省略号），按钮簇钉死宽度当对齐基准。 */
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
		// 口径：路径最次（整行放不下时先让到 0 宽），命令 / 派单模板 / 超时其次，
		// 工具名与右端按钮列一步不让。权重写在 flex 简写第二位：flex: 0 N auto。
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
		// flex: none 会让长名字（如 delegate_task + 4 个常驻按钮）把右端按钮簇
		// 顶出卡头；无底线（min-width: 0）又会把 "read" 挤成 "rea…"。口径是
		// 「可缩 + 5ch 地板」：常规行不缩，极端行让一点。
		const body = bodyOf(".chead-title.toolcall-name");
		expect(body, ".chead-title.toolcall-name 在 styles.css 里没有声明").not.toBe("");
		expect(/flex\s*:\s*0\s+1\s+auto/.test(body), "工具名应 flex: 0 1 auto（可缩，带地板）").toBe(true);
		const floor = body.match(/min-width\s*:\s*(\d+(?:\.\d+)?)ch/);
		expect(floor, "工具名必须有 ch 级 min-width 地板（短工具名不许被挤成省略号）").not.toBeNull();
		expect(Number(floor?.[1]), "工具名地板至少 4ch（read/bash 约 4 个字符宽）").toBeGreaterThanOrEqual(4);
	});

	it("路径有下限（可以短，不许缩到 0 消失）与上隐（不许吃掉整行）", () => {
		const body = bodyOf(".toolcall-path");
		// 地板：路径可以短，不许整体消失（缩到 0 就认不出是哪个文件了）。
		const floor = body.match(/min-width\s*:\s*(\d+(?:\.\d+)?)ch/);
		expect(floor, "路径缺 ch 级 min-width 地板").not.toBeNull();
		expect(Number(floor?.[1]), "地板 7ch 左右：再大就把 320px 手机的按钮簇顶出去了").toBeLessThanOrEqual(9);
		// 上限 + 显式收着：有余量时也只显示一截，不写满整行。
		expect(/max-width\s*:/.test(body), "路径缺 max-width 上限").toBe(true);
		expect(/overflow\s*:\s*hidden/.test(body), "路径要显式收着（overflow: hidden）").toBe(true);
	});

	it("思考标题仍可缩（.thinking-label 只许改 flex 成长，不许钉死）", () => {
		// 思考标题装的是模型原文（长英文/长路径），钉死宽度 = 顶宽整条卡头。
		const body = bodyOf(".thinking-label");
		expect(body, ".thinking-label 在 styles.css 里没有声明").not.toBe("");
		expect(/flex\s*:\s*none/.test(body), ".thinking-label 不许 flex: none").toBe(false);
		expect(/flex-shrink\s*:\s*0\b/.test(body), ".thinking-label 不许 flex-shrink: 0").toBe(false);
		// 收着口径继承 .chead-title（同一元素上的另一个类），这里钉一下别被拆掉。
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

	it.each([".plan-board-steps", ".sandbox-diff-list", ".compacted-history-messages"])(
		"%s 独立面板列表声明 overscroll-behavior: contain 防止整页滚动穿透",
		(selector) => {
			const body = bodyOf(selector);
			expect(body, `${selector} 在 styles.css 里没有声明`).not.toBe("");
			expect(
				/overscroll-behavior(?:-y)?\s*:\s*contain/.test(body),
				`${selector} 缺少 overscroll-behavior: contain（独立浮层/面板列表滚到底顶时应防穿透）`,
			).toBe(true);
		},
	);
});
