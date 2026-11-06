/// <reference lib="dom" />

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
		} catch {}
	}
	return cssSource(rules);
}

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
