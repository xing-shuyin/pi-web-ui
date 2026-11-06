import type { BookSource } from "../types";
import { checkSource, type CheckOptions } from "./check";
import { probeSource, type ProbeOptions, type ProbeResult } from "./probe";
import {
	evalElement,
	evalFirst,
	evalItemList,
	evalList,
	ruleErrorStats,
	ruleErrors,
	type RuleCtx,
} from "./analyzeRule";
import { getScope } from "./js";
import { fetchText, setProxyTransport, setSyncTransport } from "./request";

export { setProxyTransport, setSyncTransport };
export { probeSource, checkSource };
export { searchBooks, getBookInfo, getChapterList, getContent, discoverBooks, htmlToText } from "./webBook";
export { fetchText, parseHeader } from "./request";
export { ruleErrors, ruleErrorStats };
export { detectPageProblem, detectContentNotice, classifyError, isNetworkError } from "./pageProblem";
export { evalFirst, evalList, evalElement, evalItemList };
export { getScope };
export type { ProbeResult, ProbeOptions };

export interface RunRuleOptions {
	key?: string;
	page?: number;
	baseUrl?: string;
	source?: BookSource;
	listRule?: string;
}

export function runRule(
	body: string,
	rule: string,
	opts: RunRuleOptions = {},
): { list: string[]; first: string; items?: string[] } {
	const source: BookSource =
		opts.source ?? ({ bookSourceUrl: opts.baseUrl ?? "", bookSourceName: "(试规则)", bookSourceType: 0 } as BookSource);
	const ctx: RuleCtx = {
		baseUrl: opts.baseUrl ?? source.bookSourceUrl ?? "",
		key: opts.key ?? "",
		page: Number(opts.page ?? 1),
		scope: getScope(source.bookSourceUrl ?? ""),
		source,
		book: { origin: source.bookSourceUrl, originName: source.bookSourceName },
	};
	if (opts.listRule !== undefined) {
		const items = evalItemList(body, opts.listRule, ctx);
		const list = items.map((it) => evalFirst(it, rule, ctx)).filter((x) => x !== "");
		return { list, first: list[0] ?? "", items: items.slice(0, 5) };
	}
	const list = evalList(body, rule, ctx).filter((x) => x !== "");
	return { list, first: list[0] ?? "" };
}

export function resetRuleErrors(): void {
	ruleErrors.length = 0;
	ruleErrorStats.total = 0;
}

export type EngineJob =
	| { kind: "check"; source: BookSource; options?: CheckOptions }
	| { kind: "probe"; source: BookSource; options?: ProbeOptions }
	| {
			kind: "rule";
			url?: string;
			body?: string;
			rule: string;
			listRule?: string;
			charset?: string;
			key?: string;
			sourceUrl?: string;
			sourceName?: string;
			dump?: "none" | "snippet" | "full";
			dumpMax?: number;
	  };

async function runRuleJob(job: Extract<EngineJob, { kind: "rule" }>) {
	let body = job.body ?? "";
	let request: { url: string; status?: number; bytes: number } | undefined;
	if (job.url) {
		const res = await fetchText(job.url, { charset: job.charset });
		body = res.body;
		request = { url: res.url, status: res.status, bytes: res.body.length };
	}
	const source =
		job.sourceUrl || job.sourceName
			? ({ bookSourceUrl: job.sourceUrl ?? "", bookSourceName: job.sourceName ?? "(试规则)" } as BookSource)
			: undefined;
	const out = runRule(body, job.rule, { listRule: job.listRule, key: job.key, baseUrl: job.url, source });
	const dump = job.dump ?? "snippet";
	const cap = Math.max(200, Math.min(Number(job.dumpMax ?? 3000) || 3000, 200_000));
	return {
		request,
		pageSize: body.length,
		snippet:
			dump === "none"
				? undefined
				: body.length > cap
					? `${body.slice(0, cap)}\n…（共 ${body.length} 字，已截断）`
					: body,
		...out,
		ruleErrors: ruleErrors.slice(-20),
	};
}

export async function runJob(job: EngineJob): Promise<unknown> {
	resetRuleErrors();
	if (job.kind === "check") return checkSource(job.source, job.options ?? {});
	if (job.kind === "probe") return probeSource(job.source, job.options ?? {});
	if (job.kind === "rule") return runRuleJob(job);
	throw new Error(`未知任务类型：${(job as { kind?: string }).kind ?? ""}`);
}
