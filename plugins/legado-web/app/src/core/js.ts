import { buildProxyUrl, getSyncTransport } from "./request";
import * as cheerio from "cheerio";
import md5 from "js-md5";

export interface JsContext {
	result?: unknown;
	baseUrl?: string;
	key?: string;
	page?: number;
	source?: unknown;
	book?: unknown;
	chapter?: unknown;
	title?: string;
	infoMap?: unknown;
	[k: string]: unknown;
}

export class Scope {
	vars = new Map<string, string>();
	jsScope: Record<string, unknown> = {};
	contentOverride: unknown = undefined;
	infoMap: unknown = undefined;
	put(key: string, value: unknown): string {
		const v = value == null ? "" : String(value);
		this.vars.set(key, v);
		return v;
	}
	get(key: string): string {
		if (key === "bookName") return "";
		return this.vars.get(key) ?? "";
	}
}

const scopes = new Map<string, Scope>();
export function getScope(sourceUrl: string): Scope {
	let s = scopes.get(sourceUrl);
	if (!s) {
		s = new Scope();
		scopes.set(sourceUrl, s);
	}
	return s;
}

export function isJsRule(rule?: string): boolean {
	if (!rule) return false;
	const r = rule.trim();
	return r.startsWith("@js:") || (r.startsWith("<js>") && r.endsWith("</js>"));
}

function stripJsWrapper(code: string): string {
	let body = code.trim();
	if (body.startsWith("@js:")) body = body.slice(4);
	body = body
		.replace(/^<js>/, "")
		.replace(/<\/js>$/, "")
		.trim();
	body = body.replace(/\[([^[\]]*)\]\s*=>/g, "([$1]) =>");
	return body;
}

function syncProxy(target: string, method = "GET", headers: Record<string, string> = {}, body?: string): string {
	checkRuleDeadline();
	const injected = getSyncTransport();
	if (injected) return injected(target, method, headers, body);
	const xhr = new XMLHttpRequest();
	xhr.open(method, buildProxyUrl(target), false);
	for (const [k, v] of Object.entries(headers)) {
		try {
			xhr.setRequestHeader(k, v);
		} catch {}
	}
	xhr.send(body ?? null);
	if (xhr.status >= 200 && xhr.status < 300) {
		try {
			const data = JSON.parse(xhr.responseText) as { body?: string; error?: string };
			if (data.error) throw new Error(data.error);
			return data.body ?? "";
		} catch (e) {
			if (e instanceof SyntaxError) return xhr.responseText;
			throw e;
		}
	}
	throw new Error(`ajax ${xhr.status} ${target}`);
}

function parseHeaders(h: unknown): Record<string, string> {
	if (!h) return {};
	if (typeof h === "string") {
		try {
			const o = JSON.parse(h) as Record<string, string>;
			return o && typeof o === "object" ? o : {};
		} catch {
			return {};
		}
	}
	if (typeof h === "object") return h as Record<string, string>;
	return {};
}

const jsCache = new Map<string, string>();

function readCache(key: string): string | undefined {
	return jsCache.get(key);
}

function writeCache(key: string, value: string) {
	jsCache.set(key, value);
}

export interface JavaRuleHooks {
	elements?: (ctx: JsContext, rule: string) => string[];
	list?: (ctx: JsContext, rule: string) => string[];
	string?: (ctx: JsContext, rule: string) => string;
}

let javaHooks: JavaRuleHooks = {};
export function setJavaRuleHooks(h: JavaRuleHooks) {
	javaHooks = h;
}

function makeJava(scope: Scope, ctx: JsContext) {
	return {
		put: (k: string, v: unknown) => scope.put(k, v),
		get: (a: unknown, b?: unknown, c?: unknown) =>
			b === undefined && c === undefined
				? scope.get(String(a ?? ""))
				: syncProxy(String(a ?? ""), "GET", parseHeaders(b)),
		log: (m: unknown) => {
			console.log("[js]", m);
			return m;
		},
		toast: (m: unknown) => {
			console.log("[toast]", m);
			return String(m ?? "");
		},
		ajax: (url: unknown) => syncProxy(String(url)),
		cache: {
			get: (key: unknown): string | null => readCache(String(key ?? "")) ?? null,
			getFile: (key: unknown): string | null => readCache(String(key ?? "")) ?? null,
			put: (key: unknown, value: unknown): string => {
				writeCache(String(key ?? ""), String(value ?? ""));
				return String(value ?? "");
			},
			putFile: (key: unknown, value: unknown): string => {
				writeCache(String(key ?? ""), String(value ?? ""));
				return String(value ?? "");
			},
			delete: (key: unknown): void => {
				jsCache.delete(String(key ?? ""));
			},
		},
		connect: (url: unknown, header?: unknown) => syncProxy(String(url), "GET", parseHeaders(header)),
		post: (url: unknown, body?: unknown, headers?: unknown) =>
			syncProxy(
				String(url),
				"POST",
				{ "Content-Type": "application/x-www-form-urlencoded", ...parseHeaders(headers) },
				String(body ?? ""),
			),
		getCookie: (_tag: unknown, _key?: unknown) => "",
		base64Encode: (s: unknown) => {
			const bytes = new TextEncoder().encode(String(s ?? ""));
			let bin = "";
			for (const b of bytes) bin += String.fromCharCode(b);
			return btoa(bin);
		},
		base64Decode: (s: unknown) => {
			const bin = atob(String(s ?? "").trim());
			const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
			return new TextDecoder().decode(bytes);
		},
		md5Encode: (s: unknown) => md5(String(s ?? "")),
		t2s: (s: unknown) => String(s ?? ""),
		s2t: (s: unknown) => String(s ?? ""),
		getElement: (rule: unknown) => wrapEList(javaHooks.elements ? javaHooks.elements(ctx, String(rule ?? "")) : []),
		getElements: (rule: unknown) => wrapEList(javaHooks.elements ? javaHooks.elements(ctx, String(rule ?? "")) : []),
		getString: (rule: unknown) => (javaHooks.string ? javaHooks.string(ctx, String(rule ?? "")) : ""),
		getStringList: (rule: unknown) => (javaHooks.list ? javaHooks.list(ctx, String(rule ?? "")) : []),
		setContent: (v: unknown) => {
			scope.contentOverride = v;
			return "";
		},
	};
}

export type JavaApi = ReturnType<typeof makeJava>;

function defineProp(o: object, name: string, value: unknown) {
	try {
		Object.defineProperty(o, name, { value, writable: true, configurable: true, enumerable: false });
	} catch {}
}

function augmentList(arr: unknown[]): unknown[] {
	if ((arr as unknown as Record<string, unknown>).__legadoAug) return arr;
	defineProp(arr, "__legadoAug", true);
	defineProp(arr, "toArray", function (this: unknown[]) {
		return [...this];
	});
	defineProp(arr, "size", function (this: unknown[]) {
		return this.length;
	});
	defineProp(arr, "get", function (this: unknown[], i: number) {
		return this[i];
	});
	return arr;
}

function matchTops($: cheerio.CheerioAPI, tops: unknown[], sel: string): unknown[] {
	const out: unknown[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const anyScope = $ as any;
	for (const el of tops) {
		const $el = anyScope(el);
		try {
			if ($el.is(sel)) out.push(el);
		} catch {}
		try {
			out.push(...$el.find(sel).toArray());
		} catch {}
	}
	return out;
}

function loadTops(html: string): { $: cheerio.CheerioAPI; tops: unknown[] } | null {
	try {
		const $ = cheerio.load(html);
		const kids = $("body").children().toArray();
		return { $, tops: kids.length ? kids : $.root().children().toArray() };
	} catch {
		return null;
	}
}

export function wrapEl(html: string): String {
	const o = new String(html) as String & Record<string, (...args: never[]) => unknown>;
	defineProp(o, "select", (sel: unknown) => {
		try {
			const l = loadTops(html);
			if (!l) return wrapEList([]);
			const found = matchTops(l.$, l.tops, String(sel ?? ""));
			return wrapEList(found.map((el) => l.$(el as never).toString()));
		} catch {
			return wrapEList([]);
		}
	});
	defineProp(o, "attr", (name: unknown) => {
		try {
			const l = loadTops(html);
			const first = l?.tops[0];
			if (!l || first === undefined) return "";
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return String((l.$(first as any) as any).attr(String(name ?? "")) ?? "");
		} catch {
			return "";
		}
	});
	defineProp(o, "text", () => {
		try {
			const $ = cheerio.load(html);
			const t = $("body").text();
			return String((t || $.root().text()) ?? "").trim();
		} catch {
			return "";
		}
	});
	defineProp(o, "html", () => {
		try {
			const l = loadTops(html);
			const first = l?.tops[0];
			if (!l || first === undefined) return "";
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return String((l.$(first as any) as any).html() ?? "");
		} catch {
			return "";
		}
	});
	defineProp(o, "outerHtml", () => html);
	defineProp(o, "size", () => 1);
	defineProp(o, "get", (i: unknown) => (i === 0 ? o : undefined));
	return o;
}

export function wrapEList(items: unknown[]): unknown[] {
	const arr: unknown[] = (items ?? []).map((x) => (typeof x === "string" ? wrapEl(x) : x));
	augmentList(arr);
	const first = (): String | undefined => arr.find((x) => typeof x === "object" && x !== null) as String | undefined;
	defineProp(arr, "select", (sel: unknown) => {
		const out: unknown[] = [];
		for (const x of arr) {
			if (typeof x === "object" && x !== null) {
				const r = (x as Record<string, (s: unknown) => unknown>).select?.(sel) as unknown[] | undefined;
				if (Array.isArray(r)) out.push(...r);
			}
		}
		return wrapEList(out.map((x) => String(x)));
	});
	defineProp(arr, "attr", (name: unknown) => {
		const f = first();
		return f ? String((f as unknown as Record<string, (n: unknown) => unknown>).attr?.(name) ?? "") : "";
	});
	defineProp(arr, "text", () =>
		arr
			.map((x) =>
				typeof x === "object" && x !== null
					? String((x as unknown as Record<string, () => unknown>).text?.() ?? "")
					: String(x ?? ""),
			)
			.join(" "),
	);
	defineProp(arr, "html", () => {
		const f = first();
		return f ? String((f as unknown as Record<string, () => unknown>).html?.() ?? "") : "";
	});
	return arr;
}

function augmentInput(r: unknown): unknown {
	if (Array.isArray(r)) return wrapEList(r as unknown[]);
	return r;
}

const JS_PARAMS = [
	"result",
	"baseUrl",
	"key",
	"page",
	"java",
	"source",
	"book",
	"chapter",
	"title",
	"cookie",
	"cache",
	"infoMap",
] as const;

const RULE_JS_BUDGET_MS = 3_000;

let ruleDeadlineAt = 0;

function ruleTimeoutError(): Error {
	const e = new Error(`规则 JS 执行超时（>${RULE_JS_BUDGET_MS / 1000}s），已中止本次求值`);
	e.name = "RuleJsTimeout";
	return e;
}

function checkRuleDeadline(): void {
	if (ruleDeadlineAt && Date.now() > ruleDeadlineAt) throw ruleTimeoutError();
}

const SANDBOX_RESERVED = new Set<string>([
	...JS_PARAMS,
	"JSON",
	"Math",
	"Date",
	"String",
	"Number",
	"Boolean",
	"Array",
	"Object",
	"RegExp",
	"Error",
	"Promise",
	"Map",
	"Set",
	"Symbol",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"encodeURIComponent",
	"decodeURIComponent",
	"encodeURI",
	"decodeURI",
	"btoa",
	"atob",
	"console",
	"eval",
	"Function",
	"arguments",
	"undefined",
	"NaN",
	"Infinity",
	"globalThis",
	"window",
]);

function makeSandbox(jsScope: Record<string, unknown>): Record<string, unknown> {
	return new Proxy(jsScope, {
		has: (_t, k) => {
			checkRuleDeadline();
			return typeof k === "string" && !SANDBOX_RESERVED.has(k) && !k.startsWith("__legado_");
		},
		get: (t, k) => {
			checkRuleDeadline();
			return k === Symbol.unscopables ? undefined : (t as Record<string | symbol, unknown>)[k];
		},
		set: (t, k, v) => {
			checkRuleDeadline();
			(t as Record<string | symbol, unknown>)[k] = v;
			return true;
		},
	});
}

function withRuleBudget<T>(fn: () => T): T {
	const nested = ruleDeadlineAt !== 0;
	if (!nested) ruleDeadlineAt = Date.now() + RULE_JS_BUDGET_MS;
	try {
		return fn();
	} finally {
		if (!nested) ruleDeadlineAt = 0;
	}
}

export function evalJsRule(code: string, ctx: JsContext, scope: Scope): unknown {
	const body = stripJsWrapper(code).trim();
	if (!body) return ctx.result ?? "";
	return withRuleBudget(() => {
		const v = evalJsRuleBody(body, ctx, scope);
		checkRuleDeadline();
		return v;
	});
}

function evalJsRuleBody(body: string, ctx: JsContext, scope: Scope): unknown {
	const java = makeJava(scope, ctx);
	const cookie = { getCookie: (_t: unknown, _k?: unknown) => readCache("cookie." + String(_t ?? "")) ?? "" };
	const cache = (java as unknown as { cache: Record<string, unknown> }).cache;
	const vals = [
		augmentInput(ctx.result ?? ""),
		ctx.baseUrl ?? "",
		ctx.key ?? "",
		ctx.page ?? 1,
		java,
		ctx.source ?? null,
		ctx.book ?? null,
		ctx.chapter ?? null,
		ctx.title ?? "",
		cookie,
		cache,
		ctx.infoMap ?? scope.infoMap ?? {},
	];
	try {
		const efn = new Function(
			...JS_PARAMS,
			"__legado_scope_7f3a",
			"__legado_code_7f3a",
			"with(__legado_scope_7f3a){ return eval(__legado_code_7f3a); }",
		);
		const v = efn(...vals, makeSandbox(scope.jsScope), body);
		return v === undefined ? (ctx.result ?? "") : v;
	} catch (e) {
		const msg = String((e as Error)?.message ?? e);
		if (!/SyntaxError|Unexpected token|Invalid or unexpected|return/i.test(msg)) throw e;
	}
	try {
		const ffn = new Function(...JS_PARAMS, body);
		const v = ffn(...vals);
		return v === undefined ? (ctx.result ?? "") : v;
	} catch {}
	const xfn = new Function(...JS_PARAMS, `return (${body});`);
	return xfn(...vals);
}

export function applyTemplate(
	tpl: string,
	ctx: JsContext,
	scope?: Scope,
	nested?: (expr: string, result: unknown) => string | undefined,
): string {
	return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => {
		const e = expr.trim();
		if (e === "key") return String(ctx.key ?? "");
		if (e === "page") return String(ctx.page ?? 1);
		if (e === "baseUrl") return String(ctx.baseUrl ?? "");
		if (e === "result") return String(ctx.result ?? "");
		if (nested) {
			const nv = nested(e, ctx.result);
			if (nv !== undefined) return nv;
		}
		try {
			return withRuleBudget(() => {
				const java = scope ? makeJava(scope, ctx) : undefined;
				const v = new Function("key", "page", "baseUrl", "result", "java", "source", "book", `return (${e});`)(
					ctx.key ?? "",
					ctx.page ?? 1,
					ctx.baseUrl ?? "",
					augmentInput(ctx.result ?? ""),
					java,
					ctx.source ?? null,
					ctx.book ?? null,
				);
				return v == null ? "" : String(v);
			});
		} catch {
			return "";
		}
	});
}
