import type { BookSource } from "../types";
import { sourceStore } from "../store";

export type AiFixScene = "content" | "toc" | "detail" | "search" | "explore" | "source" | "check" | "new";

let statusReporter: (msg: string) => void = () => {};
export function setAiFixStatusReporter(fn: (msg: string) => void): void {
	statusReporter = fn;
}

export interface AiFixContext {
	scene: AiFixScene;
	sourceUrl: string;
	sourceName?: string;
	bookName?: string;
	bookUrl?: string;
	url?: string;
	error?: string;
	reason?: string;
	steps?: string;
}

const pending: AiFixContext[] = [];

export function isEmbedded(): boolean {
	try {
		return window.parent !== window;
	} catch {
		return false;
	}
}

function rulesOf(sourceUrl: string): Record<string, unknown> | undefined {
	try {
		const s = sourceStore.all().find((x) => x.bookSourceUrl === sourceUrl);
		if (!s) return undefined;
		const pick = (v: unknown) => (v && typeof v === "object" && Object.keys(v as object).length ? v : undefined);
		return {
			searchUrl: s.searchUrl ?? undefined,
			ruleSearch: pick(s.ruleSearch),
			ruleBookInfo: pick(s.ruleBookInfo),
			ruleToc: pick(s.ruleToc),
			ruleContent: pick(s.ruleContent),
		};
	} catch {
		return undefined;
	}
}

export function registerAiFix(ctx: AiFixContext): number {
	pending.push(ctx);
	return pending.length - 1;
}

export function aiFixButton(ctx: AiFixContext, label = "🤖 AI 修复源"): string {
	const idx = registerAiFix(ctx);
	return `<button class="ghost aifix" data-aifix="${idx}" title="让 AI 诊断并修好这个书源（在 pi-web-ui 的对话里自动开新对话）">${label}</button>`;
}

export function requestAiFix(ctx: AiFixContext): boolean {
	if (!isEmbedded()) {
		statusReporter("这个功能（AI 修复/新建书源）要在 pi-web-ui 的插件视图里用（当前是单独打开的页面）");
		return false;
	}
	const source = sourceStore.all().find((s) => s.bookSourceUrl === ctx.sourceUrl);
	const payload = {
		type: "legado:ai-fix",
		context: {
			...ctx,
			sourceName: ctx.sourceName ?? source?.bookSourceName,
			rules: rulesOf(ctx.sourceUrl),
		},
	};
	try {
		window.parent.postMessage(payload, window.location.origin);
		statusReporter("已把这本书的现场发给 AI，正在打开对话…");
		return true;
	} catch (e) {
		statusReporter(`发送失败：${String(e)}`);
		return false;
	}
}

export function installAiFixHandler(): void {
	document.addEventListener("click", (e) => {
		const el = (e.target as HTMLElement | null)?.closest?.("[data-aifix]") as HTMLElement | null;
		if (!el) return;
		const idx = Number(el.dataset.aifix);
		const ctx = pending[idx];
		e.preventDefault();
		if (ctx) requestAiFix(ctx);
	});
}

export function checkFixContext(
	bookSourceUrl: string,
	bookSourceName: string,
	reason: string,
	steps: { name: string; ok: boolean; ms: number; info?: string; error?: string }[] = [],
): AiFixContext {
	return {
		scene: "check",
		sourceUrl: bookSourceUrl,
		sourceName: bookSourceName,
		reason,
		steps: steps
			.map(
				(s) =>
					`${s.ok ? "✔" : "✘"} ${s.name} ${s.ms}ms${s.info ? ` (${s.info})` : ""}${s.error ? ` — ${s.error}` : ""}`,
			)
			.join(" · "),
	};
}

export function sourceFixContext(s: BookSource): AiFixContext {
	return { scene: "source", sourceUrl: s.bookSourceUrl, sourceName: s.bookSourceName };
}

export function newSourceFixContext(url: string, note?: string): AiFixContext {
	return { scene: "new", sourceUrl: url, error: note };
}
