/// <reference lib="dom" />
/**
 * 源码定位适配器链。
 *
 * 技术栈不确定（用户可能同时写着 React 后台和 Vue 站点、也有纯 HTML/CSS 的页面），
 * 所以做成**链式 + 静默降级**：按顺序试，第一个给出文件路径的胜出；适配器内部抛错
 * 只是这个适配器失效，绝不会影响拾取本身（拿不到源码位置照样能用选择器 + 样式定位）。
 *
 * 优先级：react → vue → css（样式命中位置）。
 * css 排最后是因为它只说「样式写在哪」，对「改结构/改交互」没有 react/vue 精准。
 */

import type { MatchedRule, SourceRef } from "../../shared/contract.js";
import { reactSource } from "./react.js";
import { vueSource } from "./vue.js";

export type SourceAdapter = (el: Element) => SourceRef | undefined;

const ADAPTERS: SourceAdapter[] = [reactSource, vueSource];

export function collectSource(el: Element, rules?: MatchedRule[]): SourceRef | undefined {
	for (const adapter of ADAPTERS) {
		try {
			const ref = adapter(el);
			if (ref?.file) return ref;
		} catch {
			/* 适配器坏了不影响拾取 */
		}
	}
	return cssSource(rules);
}

/** 兜底：把「命中的 CSS 里声明最多的那条」当作源码位置（改样式场景最直接）。 */
function cssSource(rules?: MatchedRule[]): SourceRef | undefined {
	const candidates = (rules ?? []).filter((r) => r.file);
	if (candidates.length === 0) return undefined;
	const best = candidates.reduce((a, b) => (declarationCount(b) > declarationCount(a) ? b : a));
	return {
		kind: "css",
		file: best.file,
		...(best.line ? { line: best.line } : {}),
	};
}

function declarationCount(rule: MatchedRule): number {
	return rule.declarations ? rule.declarations.split(";").length : 0;
}
