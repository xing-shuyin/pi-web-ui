import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 按下态的样式守卫（issue #961）。
 *
 * 这条测试只能证明「规则存在且顺序对」，证明不了「看得见」；
 * 语义上的验证要靠浏览器里比 computed style（见 issue 复现脚本）。
 * 但它挡住的是真正反复发生的那种回归：状态由 `aria-pressed` 表达，
 * 样式却谁都没写，`active` 类加了却没有视觉后果。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

interface Rule {
	selector: string;
	body: string;
}

function parseRules(css: string): Rule[] {
	const out: Rule[] = [];
	let prelude = "";
	for (let i = 0; i < css.length; i++) {
		const ch = css[i]!;
		if (ch === "{") {
			const sel = prelude
				.replace(/\/\*[\s\S]*?\*\//g, " ")
				.replace(/\s+/g, " ")
				.trim();
			prelude = "";
			if (sel.startsWith("@")) continue;
			let depth = 1;
			let body = "";
			for (i++; i < css.length && depth > 0; i++) {
				if (css[i] === "{") depth++;
				else if (css[i] === "}") {
					depth--;
					if (depth === 0) break;
				}
				body += css[i];
			}
			for (const one of sel.split(",")) {
				const selector = one.trim();
				if (selector) out.push({ selector, body });
			}
			continue;
		}
		if (ch === "}") {
			prelude = "";
			continue;
		}
		prelude += ch;
	}
	return out;
}

const RULES = parseRules(CSS);
const bodyOf = (selector: string): string => {
	const rule = RULES.find((r) => r.selector === selector);
	expect(rule, `styles.css 缺少规则 ${selector}`).toBeDefined();
	return rule!.body;
};
const indexOfSelector = (needle: string): number => {
	const at = CSS.indexOf(needle);
	expect(at, `styles.css 缺少 ${needle}`).toBeGreaterThan(-1);
	return at;
};

describe("按下态样式：goalbar（#961）", () => {
	it("`提炼` / `计划` 的基态不再穿实心强调色（否则「开」没有更强的视觉可去）", () => {
		for (const selector of [".goalbar-btn.action", ".goalbar-btn.action.wizard", ".goalbar-btn.action.plan"]) {
			const body = bodyOf(selector);
			expect(body, `${selector} 基态不能是 accent/amber 实底`).not.toMatch(/background:\s*var\(--(accent|amber)\)\s*;/);
		}
	});

	it("按下态键在 aria-pressed（语义属性是状态的单源）", () => {
		const body = bodyOf('.goalbar-btn[aria-pressed="true"]');
		expect(body).toMatch(/background:\s*var\(--accent-soft\)/);
		expect(body).toMatch(/border-color:\s*var\(--accent\)/);
		const wizard = bodyOf('.goalbar-btn.wizard[aria-pressed="true"]');
		expect(wizard).toMatch(/border-color:\s*var\(--amber\)/);
		// `.action` 是 (0,3,0)，单靠 `.goalbar-btn[aria-pressed]`(0,2,0) 会被基态压住，
		// 必须同时有同特异性的 `.goalbar-btn.action[aria-pressed="true"]`（计划按钮就靠它）。
		expect(bodyOf('.goalbar-btn.action[aria-pressed="true"]')).toMatch(/background:\s*var\(--accent-soft\)/);
	});

	it("pressed 规则排在变体基态之后：同特异性靠后赢，顺序反了会静默失效", () => {
		const pressed = indexOfSelector('.goalbar-btn.action[aria-pressed="true"]');
		const pressedWizard = indexOfSelector('.goalbar-btn.wizard[aria-pressed="true"]');
		expect(pressed).toBeGreaterThan(indexOfSelector(".goalbar-btn.action.wizard"));
		expect(pressedWizard).toBeGreaterThan(indexOfSelector(".goalbar-btn.action.wizard"));
		expect(pressedWizard).toBeGreaterThan(indexOfSelector(".goalbar-btn.action.plan"));
	});
});

describe("按下态样式：输入框控件（#961）", () => {
	it("输入框内控件有按下态（`.goal-toggle` 就靠它，不再是一条规则都没有）", () => {
		const body = bodyOf('.inputbox .btn[aria-pressed="true"]');
		expect(body).toMatch(/background:\s*var\(--accent-soft\)/);
		expect(body).toMatch(/color:\s*var\(--accent\)/);
		expect(body).toMatch(/border-color:\s*var\(--accent\)/);
	});

	it("按下态与 hover 可区分：hover 的边框已经是 accent，所以按下态必须另有底色", () => {
		const hover = bodyOf('.inputbox .btn[aria-pressed="true"]:hover:not(:disabled)');
		expect(hover).toMatch(/background:\s*color-mix\(/);
	});

	it("顺序：必须写在 `.btn:hover:not(:disabled)` 之后（同特异性后写道赢）", () => {
		expect(indexOfSelector('.inputbox .btn[aria-pressed="true"]')).toBeGreaterThan(
			indexOfSelector(".btn:hover:not(:disabled)"),
		);
	});
});

describe("状态单源：aria-pressed 是唯一视觉键（#961）", () => {
	const goalbar = readFileSync(join(ROOT, "web/src/components/GoalBar.tsx"), "utf8");
	const chatInput = readFileSync(join(ROOT, "web/src/components/ChatInput.tsx"), "utf8");

	it("GoalBar 不再拼 active 类：开了 = aria-pressed=true，样式只认它", () => {
		expect(goalbar).not.toMatch(/\? " active"/);
	});

	it("ChatInput 的 goal-toggle 不再拼 active 类", () => {
		const line = chatInput
			.split("\n")
			.map((one) => one.trim())
			.find((one) => one.includes("goal-toggle"));
		expect(line).toBe('className="btn goal-toggle"');
	});

	it("styles.css 没有 goalbar 的 .active 并行规则（含已合并掉的 .mode.active）", () => {
		// 先去掉注释：注释里会提到旧规则名，不能把它当成实现。
		const declarations = CSS.replace(/\/\*[\s\S]*?\*\//g, " ");
		expect(declarations).not.toMatch(/\.goalbar-btn[^\s{,]*\.active/);
	});
});
