import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

interface Rule {
	selector: string;
	body: string;
	media: string;
}

function parseRules(css: string): Rule[] {
	const out: Rule[] = [];
	const stack: string[] = [];
	let prelude = "";
	for (let i = 0; i < css.length; i++) {
		const ch = css[i]!;
		if (ch === "{") {
			const sel = prelude
				.replace(/\/\*[\s\S]*?\*\//g, " ")
				.replace(/\s+/g, " ")
				.trim();
			prelude = "";
			if (sel.startsWith("@")) {
				stack.push(sel.startsWith("@media") ? sel.replace(/^@media\s*/, "") : "");
				continue;
			}
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
				const one2 = one.trim();
				if (!one2) continue;
				out.push({ selector: one2, body, media: stack[stack.length - 1] ?? "" });
			}
			continue;
		}
		if (ch === "}") {
			stack.pop();
			prelude = "";
			continue;
		}
		if (ch === ";") {
			prelude = "";
			continue;
		}
		prelude += ch;
	}
	return out;
}

const RULES = parseRules(CSS);
const MOBILE = "(max-width: 768px)";

function bodyOf(selector: string, mobileOnly = false): string {
	const hit = RULES.filter((r) => r.selector === selector && (mobileOnly ? r.media === MOBILE : r.media === ""));
	if (hit.length === 0) {
		throw new Error(`styles.css 里没有 ${mobileOnly ? "窄屏 " : ""}规则：${selector}`);
	}
	return hit[hit.length - 1]!.body;
}

describe("chip 标签豁免名单（`.chip > span` 那组 `:not()` 链）", () => {
	const lists = RULES.filter(
		(r) =>
			/\.chip\s*>\s*span:/.test(r.selector) &&
			!/\.tb-tab|\.plugin-topbar-item|\.panel-toggle/.test(r.selector) &&
			r.selector.includes(":not("),
	).map((r) => ({
		selector: `${r.media ? `${r.media} ` : ""}${r.selector}`,
		names: [...r.selector.matchAll(/:not\(\s*\.([\w-]+)\s*\)/g)].map((m) => m[1]!).sort(),
	}));

	it("名单条目在五处落地（窄屏全局隐藏 + 窄屏三处豁免 + 基础 no-labels）", () => {
		expect(lists.length, `实际只找到 ${lists.length} 处`).toBeGreaterThanOrEqual(5);
	});

	it("五条规则的名单必须完全一致（写长写短都会打平后靠源码顺序反超）", () => {
		const first = lists[0]!.names;
		for (const rule of lists) {
			expect(rule.names, `豁免名单与第一条不一致：${rule.selector}`).toEqual(first);
		}
	});

	it("名单里有 .goalbar-opt（目标条模型选择器藏不得）", () => {
		for (const rule of lists) {
			expect(rule.names, `缺 :not(.goalbar-opt)：${rule.selector}`).toContain("goalbar-opt");
		}
	});
});

describe("目标条窄屏排版", () => {
	it("窄屏藏 chip 标签的规则必须豁免 .goalbar-opt（否则模型选择器只剩箭头）", () => {
		const hiding = RULES.filter((r) => r.media === MOBILE && /^\.chip\s*>\s*span:/.test(r.selector));
		expect(hiding.length, "没找到窄屏 .chip > span 规则，styles.css 结构变了？").toBeGreaterThan(0);
		for (const rule of hiding) {
			expect(rule.selector, "窄屏 chip 标签规则漏了 :not(.goalbar-opt) 豁免").toContain(":not(.goalbar-opt)");
		}
	});

	it("偏好行里的模型下拉整块不收缩（放不下就换行，不压成空盒子）", () => {
		expect(bodyOf(".goalbar-opts > .dropdown")).toMatch(/flex:\s*0 0 auto/);
		expect(bodyOf(".goalbar-opts > .dropdown > .chip")).toMatch(/text-align:\s*left/);
		expect(bodyOf(".goalbar-opt b")).toMatch(/text-overflow:\s*ellipsis/);
		expect(bodyOf(".goalbar-opt-label")).toMatch(/flex:\s*0 0 auto/);
	});

	it("手机：输入框独占一行 + 按钮行平分宽度", () => {
		expect(bodyOf(".goalbar-input", true)).toMatch(/flex:\s*1 1 calc\(/);
		expect(bodyOf(".goalbar-row > .goalbar-btn", true)).toMatch(/flex:\s*1 1 auto/);
	});

	it("手机：两个模型下拉 + 最大轮数并排一行（三只同款方框，行宽填满）", () => {
		expect(bodyOf(".goalbar-opts > .dropdown", true)).toMatch(/flex:\s*1 1 0;/);
		expect(bodyOf(".goalbar-opt", true)).toMatch(/align-items:\s*stretch/);
		const round = bodyOf(".goalbar-round", true);
		expect(round).toMatch(/flex:\s*0 0 \d+px/);
		expect(round).toMatch(/flex-direction:\s*column/);
		expect(round).toMatch(/border:\s*1px solid var\(--border\)/);
		expect(round).toMatch(/border-radius:/);
		expect(bodyOf(".goalbar-round input", true)).toMatch(/border:\s*none/);
		expect(round).toMatch(/height:\s*33px/);
		expect(bodyOf(".goalbar-opts > .dropdown > .chip", true)).toMatch(/min-height:\s*33px/);
		expect(bodyOf(".goalbar-opt", true)).toMatch(/padding:\s*0/);
		expect(bodyOf(".goalbar-lock-hint", true)).toMatch(/flex:\s*1 1 100%/);
	});

	it("手机：活动态分行 + order（✕ 留在标题行，不被 chip 一起带下去）", () => {
		expect(bodyOf(".goalbar-active-row", true)).toMatch(/flex-wrap:\s*wrap/);
		expect(bodyOf(".goalbar-active-row .goalbar-x", true)).toMatch(/order:\s*2/);
		expect(bodyOf(".goalbar-active-row .goalbar-chip", true)).toMatch(/order:\s*3/);
		expect(bodyOf(".goalbar-active-row .goalbar-text", true)).toMatch(/max-width:\s*calc\(/);
	});
});
