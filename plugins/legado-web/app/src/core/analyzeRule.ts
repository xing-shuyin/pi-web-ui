import * as cheerio from "cheerio";
import { JSONPath } from "jsonpath-plus";
import xpath from "xpath";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { applyTemplate, evalJsRule, isJsRule, setJavaRuleHooks, type JsContext, type Scope } from "./js";

export interface RuleCtx extends JsContext {
	baseUrl: string;
	scope: Scope;
}

export interface RuleError {
	source: string;
	rule: string;
	error: string;
	time: number;
}

export const ruleErrors: RuleError[] = [];

export const ruleErrorStats = { total: 0 };

function warnRule(ctx: RuleCtx | undefined, kind: string, rule: string, e: unknown) {
	const msg = e instanceof Error ? e.message : String(e);
	const source = (ctx?.source as { bookSourceName?: string } | undefined)?.bookSourceName ?? "";
	ruleErrorStats.total++;
	if (ruleErrors.length < 100) {
		ruleErrors.push({ source, rule: rule.slice(0, 200), error: msg.slice(0, 200), time: Date.now() });
	}
	console.warn(`[规则失败][${kind}]${source ? `[${source}]` : ""} ${rule.slice(0, 160)} || ${msg.slice(0, 160)}`);
}

function findTopLevelSep(s: string, seps: string[]): { sep: string; index: number } | null {
	let bDepth = 0;
	let pDepth = 0;
	let cDepth = 0;
	let quote: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "[") bDepth++;
		else if (c === "]") bDepth = Math.max(0, bDepth - 1);
		else if (c === "(") pDepth++;
		else if (c === ")") pDepth = Math.max(0, pDepth - 1);
		else if (c === "{") cDepth++;
		else if (c === "}") cDepth = Math.max(0, cDepth - 1);
		if (bDepth === 0 && pDepth === 0 && cDepth === 0) {
			for (const sep of seps) {
				if (s.startsWith(sep, i)) return { sep, index: i };
			}
		}
	}
	return null;
}

function splitTopAware(s: string, seps: string[]): { parts: string[]; sep: string | null } {
	const found = findTopLevelSep(s, seps);
	if (!found) return { parts: [s], sep: null };
	const { sep } = found;
	const parts: string[] = [];
	let bDepth = 0;
	let pDepth = 0;
	let cDepth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "[") bDepth++;
		else if (c === "]") bDepth = Math.max(0, bDepth - 1);
		else if (c === "(") pDepth++;
		else if (c === ")") pDepth = Math.max(0, pDepth - 1);
		else if (c === "{") cDepth++;
		else if (c === "}") cDepth = Math.max(0, cDepth - 1);
		if (bDepth === 0 && pDepth === 0 && cDepth === 0 && s.startsWith(sep, i)) {
			parts.push(s.slice(start, i));
			start = i + sep.length;
			i += sep.length - 1;
		}
	}
	parts.push(s.slice(start));
	return { parts: parts.map((x) => x.trim()).filter((x) => x !== ""), sep };
}

function splitRegexSuffix(rule: string): {
	main: string;
	pattern?: string;
	replacement?: string;
	replaceFirst?: boolean;
} {
	const parts = rule.split("##");
	if (parts.length === 1) return { main: rule };
	return { main: parts[0] ?? "", pattern: parts[1], replacement: parts[2], replaceFirst: parts.length > 3 };
}

export type ForcedMode = "css" | "xpath" | "json" | null;

function parseLooseJsonObject(text: string): Record<string, unknown> | null {
	const s = text.trim();
	try {
		const v = JSON.parse(s) as unknown;
		if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
	} catch {}
	try {
		let t = s;
		t = t.replace(/'([^']*)'/g, (_m, inner: string) => `"${String(inner).replace(/"/g, '\\"')}"`);
		t = t.replace(/([{,[]\s*)([A-Za-z_$][\w$.-]*)(\s*:)/g, '$1"$2"$3');
		t = t.replace(/(:\s*)([^"'\s{}\][,][^,}]*?)(\s*[,}])/g, (m, pre: string, val: string, post: string) => {
			const v = val.trim();
			if (
				v === "" ||
				/^-?\d+(\.\d+)?$/.test(v) ||
				/^(true|false|null)$/.test(v) ||
				v.startsWith('"') ||
				v.startsWith("{") ||
				v.startsWith("[")
			) {
				return m;
			}
			return `${pre}"${v.replace(/"/g, '\\"')}"${post}`;
		});
		const v = JSON.parse(t) as unknown;
		if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
	} catch {}
	return null;
}

function extractPutRules(body: string, rule: string, ctx: RuleCtx): string {
	return rule.replace(/@put:(\{[^}]*?\})/gi, (_m, json: string) => {
		try {
			const obj = parseLooseJsonObject(json);
			if (!obj) return "";
			for (const [k, v] of Object.entries(obj)) {
				ctx.scope.put(k, evalFirst(body, String(v), ctx));
			}
		} catch {}
		return "";
	});
}

function substituteGets(rule: string, ctx: RuleCtx, content?: unknown): string {
	const r = rule.replace(/@get:\{([^}]*)\}/gi, (_m, key: string) => ctx.scope.get(key.trim()));
	const c = content ?? ctx.result;
	return applyTemplate(r, { ...ctx, result: c }, ctx.scope, (expr, result) => {
		const e = expr.trim();
		if (/^(\$\.|@|<js>|@js:|\/\/|@@|@css:|@xpath:|@json:|\()/i.test(e)) {
			const b = typeof result === "string" ? result : JSON.stringify(result ?? "");
			return evalFirst(b, e, ctx);
		}
		return undefined;
	});
}

function splitJsSegments(rule: string): Array<{ type: "text" | "js"; code: string }> {
	const segs: Array<{ type: "text" | "js"; code: string }> = [];
	const re = /<js>([\s\S]*?)<\/js>|@js:([\s\S]*)$/gi;
	let last = 0;
	let m: RegExpExecArray | null;
	re.lastIndex = 0;
	while ((m = re.exec(rule)) !== null) {
		if (m.index > last) segs.push({ type: "text", code: rule.slice(last, m.index) });
		segs.push({ type: "js", code: m[1] ?? m[2] ?? "" });
		last = m.index + m[0].length;
		if (m[0].length === 0) break;
	}
	if (last < rule.length) segs.push({ type: "text", code: rule.slice(last) });
	return segs.filter((s) => s.type === "js" || s.code.trim() !== "");
}
function isTemplateRule(rule: string): boolean {
	const idx = rule.search(/@get:\{|{{/i);
	if (idx < 0) return false;
	return !rule.slice(0, idx).includes("##");
}

function stripModePrefix(rule: string): { sel: string; forced: ForcedMode } {
	const r = rule.trim();
	if (r.startsWith("@@")) return { sel: r.slice(2), forced: "css" };
	if (/^@css:/i.test(r)) return { sel: r.slice(5), forced: "css" };
	if (/^@xpath:/i.test(r)) return { sel: r.slice(7), forced: "xpath" };
	if (/^@json:/i.test(r)) return { sel: r.slice(6), forced: "json" };
	return { sel: r, forced: null };
}

function isWebJs(rule: string): boolean {
	const r = rule.trim().toLowerCase();
	return r.startsWith("<webjs>") || r.startsWith("@webjs:");
}

function translateNumericPseudo(sel: string): { sel: string; changed: boolean } {
	let out = "";
	let changed = false;
	let bDepth = 0;
	let pDepth = 0;
	let quote: string | null = null;
	let i = 0;
	while (i < sel.length) {
		const c = sel[i]!;
		if (quote) {
			out += c;
			if (c === "\\") {
				out += sel[i + 1] ?? "";
				i += 2;
				continue;
			}
			if (c === quote) quote = null;
			i++;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			out += c;
			i++;
			continue;
		}
		if (c === "\\") {
			out += sel.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c === "[") bDepth++;
		else if (c === "]") bDepth = Math.max(0, bDepth - 1);
		else if (c === "(") pDepth++;
		else if (c === ")") pDepth = Math.max(0, pDepth - 1);
		if (c === ":" && bDepth === 0 && pDepth === 0 && sel[i - 1] !== ":" && sel[i - 1] !== "\\") {
			const m = /^:(\d+)(?![\w\-(])/.exec(sel.slice(i));
			if (m) {
				out += `:eq(${m[1]})`;
				i += m[0].length;
				changed = true;
				continue;
			}
		}
		out += c;
		i++;
	}
	return { sel: out, changed };
}

function applyRegex(values: string[], pattern?: string, replacement?: string, replaceFirst = false): string[] {
	if (!pattern) return values;
	let re: RegExp | null = null;
	try {
		re = new RegExp(pattern, replaceFirst ? "" : "gs");
	} catch {
		re = null;
	}
	const out: string[] = [];
	for (const v of values) {
		if (!re) {
			out.push(v.split(pattern).join(replacement ?? ""));
			continue;
		}
		if (replacement === undefined) {
			out.push(v.replace(re, ""));
			continue;
		}
		if (replaceFirst) {
			re.lastIndex = 0;
			const m = re.exec(v);
			if (!m) {
				out.push(replacement);
				continue;
			}
			try {
				out.push(m[0].replace(new RegExp(pattern, ""), replacement));
			} catch {
				out.push(replacement);
			}
			continue;
		}
		out.push(v.replace(re, replacement));
	}
	return out;
}

function isJsonText(t: string): boolean {
	const s = t.trim();
	return (s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"));
}

function normalizeJsonPath(rule: string): string {
	const r = rule.trim();
	return r.startsWith("$") ? r : `$.${r}`;
}

function decideMode(body: string, rule: string, forced: ForcedMode): "json" | "xpath" | "css" {
	if (forced) return forced;
	const r = rule.trim();
	if (r.startsWith("$")) return "json";
	if (isJsonText(body)) return "json";
	if (r.startsWith("/") || r.startsWith("(")) return "xpath";
	return "css";
}

function splitKeepEmpty(s: string, seps: string[]): string[] {
	const parts: string[] = [];
	let bDepth = 0;
	let pDepth = 0;
	let cDepth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "[") bDepth++;
		else if (c === "]") bDepth = Math.max(0, bDepth - 1);
		else if (c === "(") pDepth++;
		else if (c === ")") pDepth = Math.max(0, pDepth - 1);
		else if (c === "{") cDepth++;
		else if (c === "}") cDepth = Math.max(0, cDepth - 1);
		if (bDepth === 0 && pDepth === 0 && cDepth === 0) {
			for (const sep of seps) {
				if (s.startsWith(sep, i)) {
					parts.push(s.slice(start, i).trim());
					start = i + sep.length;
					i += sep.length - 1;
					break;
				}
			}
		}
	}
	parts.push(s.slice(start).trim());
	return parts;
}

function effectiveSel($scope: cheerio.CheerioAPI, sel: string): string {
	try {
		$scope(sel);
		return sel;
	} catch (e) {
		const t = translateNumericPseudo(sel);
		if (t.changed) {
			try {
				const r = $scope(t.sel);
				if (r.length > 0) {
					console.info(`[规则兼容] ${sel} → ${t.sel}`);
					return t.sel;
				}
			} catch {}
		}
		throw e;
	}
}

type IdxPart = { t: "n"; v: number } | { t: "r"; s: number | null; e: number | null; step: number };

interface SegParsed {
	base: string;
	filter: { exclude: boolean; parts: IdxPart[] } | null;
}

function parseBracketIndex(seg: string): SegParsed | null {
	const s = seg.trimEnd();
	if (!s.endsWith("]")) return null;
	const items: IdxPart[] = [];
	let exclude = false;
	let curList: Array<number | null> = [];
	let l = "";
	let minus = false;
	const pushNum = (): number | null => (l === "" ? null : minus ? -parseInt(l, 10) : parseInt(l, 10));
	const pushItem = (): boolean => {
		const n = pushNum();
		l = "";
		minus = false;
		if (curList.length === 0) {
			if (n === null) return false;
			items.push({ t: "n", v: n });
		} else {
			items.push({
				t: "r",
				s: n,
				e: curList[curList.length - 1] ?? null,
				step: curList.length === 2 ? (curList[0] ?? 1) : 1,
			});
			curList = [];
		}
		return true;
	};
	for (let i = s.length - 2; i >= 0; i--) {
		const c = s[i]!;
		if (c === " ") continue;
		if (c >= "0" && c <= "9") {
			l = c + l;
			continue;
		}
		if (c === "-") {
			minus = true;
			continue;
		}
		if (c === ":") {
			curList.push(pushNum());
			l = "";
			minus = false;
			continue;
		}
		if (c === ",") {
			if (!pushItem()) return null;
			continue;
		}
		if (c === "[") {
			if (!pushItem()) return null;
			return { base: s.slice(0, i), filter: { exclude, parts: items } };
		}
		if (c === "!") {
			exclude = true;
			continue;
		}
		return null;
	}
	return null;
}

function parseLegacyIndex(seg: string): SegParsed | null {
	const ids: number[] = [];
	let l = "";
	let minus = false;
	for (let i = seg.length - 1; i >= 0; i--) {
		const c = seg[i]!;
		if (c === " ") continue;
		if (c >= "0" && c <= "9") {
			l = c + l;
			continue;
		}
		if (c === "-") {
			minus = true;
			continue;
		}
		if (c === ":") {
			if (l === "") return null;
			ids.push(minus ? -parseInt(l, 10) : parseInt(l, 10));
			l = "";
			minus = false;
			continue;
		}
		if (c === "." || c === "!") {
			if (l === "") return null;
			ids.push(minus ? -parseInt(l, 10) : parseInt(l, 10));
			return { base: seg.slice(0, i), filter: { exclude: c === "!", parts: ids.map((v) => ({ t: "n" as const, v })) } };
		}
		return null;
	}
	return null;
}

function parseCssSegment(seg: string): SegParsed {
	return parseBracketIndex(seg) ?? parseLegacyIndex(seg) ?? { base: seg, filter: null };
}

function applyIndexFilter(els: unknown[], filter: NonNullable<SegParsed["filter"]>): unknown[] {
	const len = els.length;
	if (!len) return [];
	const ordered: number[] = [];
	const seen = new Set<number>();
	const push = (i: number) => {
		if (!seen.has(i)) {
			seen.add(i);
			ordered.push(i);
		}
	};
	const norm = (v: number): number | null => {
		if (v >= 0) return v < len ? v : null;
		return len >= -v ? v + len : null;
	};
	for (let k = filter.parts.length - 1; k >= 0; k--) {
		const p = filter.parts[k]!;
		if (p.t === "n") {
			const i = norm(p.v);
			if (i !== null) push(i);
		} else {
			let s = p.s ?? 0;
			if (s < 0) s += len;
			let e = p.e ?? len - 1;
			if (e < 0) e += len;
			if ((s < 0 && e < 0) || (s >= len && e >= len)) continue;
			s = Math.min(Math.max(s, 0), len - 1);
			e = Math.min(Math.max(e, 0), len - 1);
			if (s === e || p.step >= len) {
				push(s);
				continue;
			}
			const st = p.step > 0 ? p.step : -p.step < len ? p.step + len : 1;
			if (e > s) {
				for (let i = s; i <= e; i += st) push(i);
			} else {
				for (let i = s; i >= e; i -= st) push(i);
			}
		}
	}
	if (filter.exclude) {
		const drop = new Set(ordered);
		return els.filter((_, i) => !drop.has(i));
	}
	return ordered.map((i) => els[i]);
}

function ownTextOf($scope: cheerio.CheerioAPI, el: unknown): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const $el = $scope(el as any) as any;
		return String($el.clone().children().remove().end().text() ?? "").trim();
	} catch {
		return "";
	}
}

function baseSelect($scope: cheerio.CheerioAPI, els: unknown[], base: string): unknown[] {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const anyScope = $scope as any;
	const kids = (el: unknown): unknown[] => {
		try {
			return anyScope(el).children().toArray();
		} catch {
			return [];
		}
	};
	const b = base.trim();
	if (!b) return els.flatMap((el) => kids(el));
	const dots = b.split(".");
	const h = dots[0]!;
	if (h === "children") return els.flatMap((el) => kids(el));
	if (dots.length > 1 && dots[1] && (h === "class" || h === "tag" || h === "id" || h === "text")) {
		const arg = dots[1]!;
		if (h === "text") {
			const out: unknown[] = [];
			const walk = (el: unknown) => {
				if (ownTextOf($scope, el).includes(arg)) out.push(el);
				for (const k of kids(el)) walk(k);
			};
			els.forEach(walk);
			return out;
		}
		const out: unknown[] = [];
		for (const el of els) {
			const $el = anyScope(el);
			try {
				const selfHit =
					h === "class"
						? Boolean($el.hasClass(arg))
						: h === "tag"
							? String(($el.get(0) as { tagName?: string } | undefined)?.tagName ?? "").toLowerCase() ===
								arg.toLowerCase()
							: String($el.attr("id") ?? "") === arg;
				if (selfHit) out.push(el);
			} catch {}
			try {
				const sel = h === "class" ? "." + arg : h === "tag" ? arg : "#" + arg;
				out.push(...$el.find(effectiveSel($scope, sel)).toArray());
			} catch {}
		}
		return out;
	}
	const sel = effectiveSel($scope, b);
	const out: unknown[] = [];
	for (const el of els) {
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

function cssNarrow($scope: cheerio.CheerioAPI, els: unknown[], seg: string): unknown[] {
	const t = seg.trim();
	if (!t) return els;
	const { base, filter } = parseCssSegment(t);
	const found = baseSelect($scope, els, base);
	if (!filter) return found;
	return applyIndexFilter(found, filter);
}

function cssRoots($scope: cheerio.CheerioAPI, html: string): unknown[] {
	if (/<html[\s>]/i.test(html)) return $scope.root().children().toArray();
	const kids = $scope("body").children().toArray();
	return kids.length ? kids : $scope.root().children().toArray();
}

function cssOutput($scope: cheerio.CheerioAPI, els: unknown[], output: string): string[] {
	const out: string[] = [];
	const seenAttr = new Set<string>();
	for (const el of els) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const $el = $scope(el as any) as any;
		const o = output || "text";
		if (o === "text") {
			const t = String($el.text() ?? "").trim();
			if (t) out.push(t);
		} else if (o === "textNodes") {
			const tn: string[] = [];
			for (const node of $el.contents().toArray() as Array<{ type?: string; data?: string }>) {
				if (node.type === "text") {
					const t = String(node.data ?? "").trim();
					if (t) tn.push(t);
				}
			}
			if (tn.length) out.push(tn.join("\n"));
		} else if (o === "ownText") {
			const t = String($el.clone().children().remove().end().text() ?? "").trim();
			if (t) out.push(t);
		} else if (o === "html") {
			const $c = $el.clone();
			$c.find("script").remove();
			$c.find("style").remove();
			const h = String($c.html() ?? "").trim();
			if (h) out.push(h);
		} else if (o === "all") {
			out.push(String($el.toString() ?? ""));
		} else {
			const v = String($el.attr(o) ?? "").trim();
			if (v && !seenAttr.has(v)) {
				seenAttr.add(v);
				out.push(v);
			}
		}
	}
	return out;
}

const CSS_OUTPUT_KEYWORDS = new Set(["text", "textnodes", "owntext", "html", "all"]);

function cssSelectWithin($scope: cheerio.CheerioAPI, roots: unknown[], sel: string): unknown[] {
	const { sel: translated } = translateNumericPseudo(sel);
	const out: unknown[] = [];
	for (const root of roots) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const $root = $scope(root as any) as any;
		try {
			if ($root.is(translated)) out.push(root);
		} catch {}
		try {
			out.push(...$root.find(translated).toArray());
		} catch {}
	}
	return out;
}

function cssPick(html: string, rule: string, ctx?: RuleCtx): string[] {
	try {
		const $scope = cheerio.load(html);
		const roots = cssRoots($scope, html);
		let r = rule.trim();
		while (r.startsWith("@")) r = r.slice(1).trimStart();
		const parts = splitKeepEmpty(r, ["@"]);
		if (parts.length <= 1) {
			const w = (parts[0] ?? "").trim();
			if (!w) return [];
			if (CSS_OUTPUT_KEYWORDS.has(w.toLowerCase())) return cssOutput($scope, roots, w);
			const found = cssSelectWithin($scope, roots, w);
			if (found.length) return cssOutput($scope, found, "text");
			return cssOutput($scope, roots, w);
		}
		let els = roots;
		for (const s of parts.slice(0, -1)) els = cssNarrow($scope, els, s);
		return cssOutput($scope, els, parts[parts.length - 1] ?? "");
	} catch (e) {
		warnRule(ctx, "CSS", rule, e);
		return [];
	}
}

function jsonPick(data: unknown, sel: string, ctx?: RuleCtx): string[] {
	try {
		const r = JSONPath({ path: sel, json: data as object }) as unknown as unknown[];
		return r.map((v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)));
	} catch (e) {
		warnRule(ctx, "JSON", sel, e);
		return [];
	}
}

function sanitizeForXml(html: string): string {
	let s = html;
	s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
	s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
	s = s.replace(/<!--[\s\S]*?-->/g, "");
	s = s.replace(/<!doctype[^>]*>/gi, "");
	s = s.replace(
		/<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)((?:\s[^<>]*?)?)>/gi,
		(_m, tag: string, attrs: string) => (attrs.trimEnd().endsWith("/") ? _m : `<${tag}${attrs}/>`),
	);
	s = s.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[a-zA-Z][a-zA-Z0-9]*;/g, " ");
	s = s.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
	s = s.replace(/<(?![a-zA-Z!/ ?])/g, "&lt;");
	return s;
}

const xmlDocCache = new Map<string, unknown>();
function getXmlDoc(html: string): unknown {
	const hit = xmlDocCache.get(html);
	if (hit !== undefined) return hit ?? null;
	let doc: unknown = null;
	try {
		const d = new DOMParser().parseFromString(`<root>${sanitizeForXml(html)}</root>`, "text/xml") as unknown as {
			documentElement?: unknown;
		};
		if (d?.documentElement) doc = d;
	} catch {
		doc = null;
	}
	if (xmlDocCache.size >= 5) {
		const first = xmlDocCache.keys().next();
		if (!first.done) xmlDocCache.delete(first.value);
	}
	xmlDocCache.set(html, doc);
	return doc;
}

function xpathNodeToString(n: unknown, outMode: "text" | "html"): string {
	if (n == null) return "";
	if (typeof n !== "object") return String(n);
	const node = n as {
		nodeType?: number;
		value?: unknown;
		data?: unknown;
		textContent?: unknown;
		childNodes?: ArrayLike<unknown>;
	};
	if (node.nodeType === 2) return String(node.value ?? "");
	if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8) {
		return String(node.data ?? "");
	}
	if (node.nodeType === 1) {
		if (outMode === "html") {
			try {
				const ser = new XMLSerializer();
				const kids = node.childNodes ?? [];
				let s = "";
				for (let i = 0; i < kids.length; i++) s += ser.serializeToString(kids[i] as never);
				return s.trim();
			} catch {}
		}
		return String(node.textContent ?? "").trim();
	}
	return String(node.textContent ?? node.value ?? "").trim();
}

function xpathPickFull(docHtml: string, expr: string, outMode: "text" | "html", ctx?: RuleCtx): string[] {
	const e = expr.trim();
	if (!e) return [docHtml.trim()];
	try {
		const doc = getXmlDoc(docHtml);
		if (!doc) return [];
		const nodes = xpath.select(e, doc as unknown as Node) as unknown[];
		return (nodes ?? []).map((n) => xpathNodeToString(n, outMode));
	} catch (err) {
		warnRule(ctx, "XPath", e, err);
		return [];
	}
}

function xpathPick(docHtml: string, sel: string, attr: string, ctx?: RuleCtx): string[] {
	const m = /\/@(text|html|all)$/i.exec(sel);
	if (m) {
		const expr = sel.slice(0, m.index);
		return xpathPickFull(docHtml, expr, m[1]!.toLowerCase() === "text" ? "text" : "html", ctx);
	}
	void attr;
	return xpathPickFull(docHtml, sel, "text", ctx);
}

function substituteGroupRefs(rule: string, body: string): { rule: string; done: boolean } {
	if (!/\$\d/.test(rule)) return { rule, done: false };
	let arr: unknown[] | null = null;
	try {
		const v = JSON.parse(body) as unknown;
		if (Array.isArray(v)) arr = v;
	} catch {}
	if (!arr) return { rule, done: false };
	const out = rule.replace(/\$(\d{1,2})/g, (_m, d: string) => {
		const v = arr![parseInt(d, 10)];
		return v == null ? "" : String(v);
	});
	return { rule: out, done: out !== rule };
}

function evalTextSegment(body: string, text: string, ctx: RuleCtx): string[] {
	try {
		const r0 = extractPutRules(body, text, ctx).trim();
		if (!r0) return [];
		const g = substituteGroupRefs(r0, body);
		if (g.done) return g.rule ? [g.rule] : [];
		const r = g.rule;
		if (isWebJs(r)) {
			warnRule(ctx, "WebJS", r, new Error("WebJS 渲染暂不支持"));
			return [];
		}
		if (isJsRule(r)) {
			const v = evalJsRule(r, { ...ctx, result: body }, ctx.scope);
			if (v == null) return [];
			if (Array.isArray(v)) return v.map((x) => String(x));
			return [String(v)];
		}
		if (isTemplateRule(r)) {
			const sub = substituteGets(r, ctx, body);
			const { main, pattern, replacement, replaceFirst } = splitRegexSuffix(sub);
			const out = main.trim();
			return applyRegex(out ? [out] : [], pattern, replacement, replaceFirst);
		}
		const sub = substituteGets(r, ctx, body);
		const { main, pattern, replacement, replaceFirst } = splitRegexSuffix(sub);
		const { sel: noPrefix, forced } = stripModePrefix(main.trim());
		const mode = decideMode(body, noPrefix, forced);
		if (mode === "xpath") {
			return applyRegex(xpathPick(body, noPrefix, "text", ctx), pattern, replacement, replaceFirst);
		}
		if (mode === "json") {
			try {
				return applyRegex(
					jsonPick(JSON.parse(body), normalizeJsonPath(noPrefix), ctx),
					pattern,
					replacement,
					replaceFirst,
				);
			} catch {
				return [];
			}
		}
		return applyRegex(cssPick(body, noPrefix, ctx), pattern, replacement, replaceFirst);
	} catch (e) {
		warnRule(ctx, "规则", text, e);
		return [];
	}
}

function evalCombined(body: string, text: string, ctx: RuleCtx): string[] {
	const { parts, sep } = splitTopAware(text, ["%%", "||", "&&"]);
	if (!sep) return evalTextSegment(body, text, ctx);
	if (sep === "||") {
		for (const b of parts) {
			const v = evalCombined(body, b, ctx).filter((x) => x !== "");
			if (v.length) return v;
		}
		return [];
	}
	if (sep === "&&") {
		return parts.flatMap((b) => evalCombined(body, b, ctx));
	}
	const lists = parts.map((b) => evalCombined(body, b, ctx));
	return zipLists(lists);
}

function zipLists(lists: string[][]): string[] {
	const max = Math.max(0, ...lists.map((l) => l.length));
	const out: string[] = [];
	for (let i = 0; i < max; i++) {
		for (const l of lists) {
			if (i < l.length) out.push(l[i]!);
		}
	}
	return out;
}

export function evalList(body: string, rule: string | undefined, ctx: RuleCtx): string[] {
	if (!rule?.trim()) return [];
	try {
		const segs = splitJsSegments(rule);
		if (segs.length === 1 && segs[0]!.type === "text") {
			return evalCombined(body, segs[0]!.code, ctx);
		}
		let cur: unknown = body;
		let curList: string[] | null = null;
		for (const seg of segs) {
			if (seg.type === "js") {
				const input = curList ? curList.join("\n") : typeof cur === "string" ? cur : JSON.stringify(cur ?? "");
				cur = evalJsRule(seg.code, { ...ctx, result: input }, ctx.scope);
				if (ctx.scope.contentOverride !== undefined) {
					cur = ctx.scope.contentOverride;
					ctx.scope.contentOverride = undefined;
				}
				curList = null;
				if (cur == null) return [];
			} else {
				const s = seg.code.trim();
				if (!s) continue;
				const input = curList ? curList.join("\n") : typeof cur === "string" ? cur : JSON.stringify(cur ?? "");
				curList = evalCombined(input, s, ctx);
				cur = null;
			}
		}
		if (curList) return curList;
		if (cur == null) return [];
		if (Array.isArray(cur)) return cur.map((x) => String(x));
		const out = String(cur);
		return out ? [out] : [];
	} catch (e) {
		warnRule(ctx, "规则", rule, e);
		return [];
	}
}

export function evalFirst(body: string, rule: string | undefined, ctx: RuleCtx): string {
	const v = evalList(body, rule, ctx).filter((x) => x !== "");
	return v[0] ?? "";
}

function evalItemBranch(body: string, branch: string, ctx: RuleCtx): string[] {
	try {
		const { main } = splitRegexSuffix(branch);
		const { sel: noPrefix, forced } = stripModePrefix(main.trim());
		const s = noPrefix;
		if (!s) return [];
		if (decideMode(body, s, forced) === "json" && isJsonText(body)) {
			const arr = JSONPath({ path: normalizeJsonPath(s), json: JSON.parse(body) as object }) as unknown as unknown[];
			const flat: unknown[] = [];
			for (const m of arr ?? []) {
				if (Array.isArray(m)) flat.push(...m);
				else flat.push(m);
			}
			return flat.map((x) => (typeof x === "string" ? x : JSON.stringify(x ?? "")));
		}
		if (decideMode(body, s, forced) === "xpath" && !isJsonText(body)) {
			const doc = getXmlDoc(body);
			if (!doc) return [];
			const nodes = xpath.select(s, doc as unknown as Node) as unknown[];
			const ser = new XMLSerializer();
			return (nodes ?? [])
				.map((n) => {
					if ((n as { nodeType?: number })?.nodeType === 1) {
						try {
							return ser.serializeToString(n as never);
						} catch {
							return "";
						}
					}
					return xpathNodeToString(n, "html");
				})
				.filter((x) => x !== "");
		}
		const $ = cheerio.load(body);
		const out: string[] = [];
		try {
			const { base, filter } = parseCssSegment(s);
			let els = baseSelect($, cssRoots($, body), base);
			if (filter) els = applyIndexFilter(els, filter);
			for (const el of els) {
				const h = $.html(el as never) ?? "";
				if (h) out.push(h);
			}
		} catch (e) {
			warnRule(ctx, "CSS-列表", s, e);
		}
		return out;
	} catch (e) {
		warnRule(ctx, "列表", branch, e);
		return [];
	}
}

export function evalItemList(body: string, listRule: string | undefined, ctx: RuleCtx): string[] {
	if (!listRule?.trim()) return [];
	const rawMode = listRule.trimStart().startsWith(":");
	const pre = rawMode ? listRule.trim() : substituteGets(extractPutRules(body, listRule, ctx), ctx, body).trim();
	if (!pre) return [];
	if (isWebJs(pre)) {
		warnRule(ctx, "WebJS", pre, new Error("WebJS 渲染暂不支持"));
		return [];
	}
	try {
		const segs = splitJsSegments(pre);
		if (segs.length === 1 && segs[0]!.type === "text") {
			return rawMode ? evalRegexList(body, segs[0]!.code, ctx) : evalItemCombined(body, segs[0]!.code, ctx);
		}
		let cur: unknown = body;
		let curList: string[] | null = null;
		const firstText = segs.find((s) => s.type === "text");
		const chainRegex = rawMode && firstText ? true : false;
		for (const seg of segs) {
			if (seg.type === "js") {
				const input = curList ?? (typeof cur === "string" ? cur : JSON.stringify(cur ?? ""));
				cur = evalJsRule(seg.code, { ...ctx, result: input }, ctx.scope);
				curList = null;
				if (cur == null) return [];
			} else {
				const s = seg.code.trim();
				if (!s) continue;
				if (chainRegex) {
					const input = curList ? curList.join("\n") : typeof cur === "string" ? cur : JSON.stringify(cur ?? "");
					curList = evalRegexList(input, s, ctx);
					cur = null;
				} else {
					const input = curList ? curList.join("\n") : typeof cur === "string" ? cur : JSON.stringify(cur ?? "");
					curList = evalItemCombined(input, s, ctx);
					cur = null;
				}
			}
		}
		if (curList) return curList;
		if (cur == null) return [];
		if (Array.isArray(cur)) return cur.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
		const out = String(cur);
		return out ? [out] : [];
	} catch (e) {
		warnRule(ctx, "列表", pre, e);
		return [];
	}
}

function evalRegexList(body: string, pattern: string, ctx: RuleCtx): string[] {
	const p0 = pattern.trimStart().replace(/^:/, "");
	const pats = p0
		.split("&&")
		.map((x) => x.trim())
		.filter((x) => x !== "");
	if (!pats.length) return [];
	try {
		let text = body;
		for (let i = 0; i < pats.length; i++) {
			const re = new RegExp(pats[i]!, "gs");
			const ms = [...text.matchAll(re)];
			if (i === pats.length - 1) {
				return ms.map((m) => JSON.stringify([m[0] ?? "", ...m.slice(1).map((g) => g ?? "")]));
			}
			if (!ms.length) return [];
			text = ms.map((m) => m[0] ?? "").join("");
		}
		return [];
	} catch (e) {
		warnRule(ctx, "正则列表", pattern, e);
		return [];
	}
}

function evalItemCombined(body: string, text: string, ctx: RuleCtx): string[] {
	const { parts, sep } = splitTopAware(text, ["%%", "||", "&&"]);
	if (!sep) return evalItemBranch(body, text, ctx);
	if (sep === "||") {
		for (const b of parts) {
			const v = evalItemCombined(body, b, ctx).filter((x) => x !== "");
			if (v.length) return v;
		}
		return [];
	}
	if (sep === "&&") {
		return parts.flatMap((b) => evalItemCombined(body, b, ctx));
	}
	return zipLists(parts.map((b) => evalItemCombined(body, b, ctx)));
}

export function evalElement(body: string, rule: string | undefined, ctx: RuleCtx): string {
	if (!rule?.trim()) return "";
	try {
		const r = extractPutRules(body, rule, ctx).trim();
		if (!r || isWebJs(r)) return "";
		if (r.startsWith(":")) {
			const pats = r
				.replace(/^:/, "")
				.split("&&")
				.map((x) => x.trim())
				.filter((x) => x !== "");
			try {
				let text = body;
				for (let i = 0; i < pats.length; i++) {
					const re = new RegExp(pats[i]!, "gs");
					const ms = [...text.matchAll(re)];
					if (!ms.length) return "";
					if (i === pats.length - 1) {
						const g = ms[0]!;
						return g[0] ?? "";
					}
					text = ms.map((m) => m[0] ?? "").join("");
				}
				return "";
			} catch (e) {
				warnRule(ctx, "正则取元", rule, e);
				return "";
			}
		}
		if (isJsRule(r)) {
			const v = evalJsRule(r, { ...ctx, result: body }, ctx.scope);
			if (v == null) return "";
			return typeof v === "string" ? v : JSON.stringify(v);
		}
		const sub = substituteGets(r, ctx, body);
		const { main } = splitRegexSuffix(sub);
		const { sel: noPrefix, forced } = stripModePrefix(main.trim());
		if (!noPrefix) return "";
		const mode = decideMode(body, noPrefix, forced);
		if (mode === "json") {
			if (!isJsonText(body)) return "";
			const arr = JSONPath({
				path: normalizeJsonPath(noPrefix),
				json: JSON.parse(body) as object,
			}) as unknown as unknown[];
			const first = arr?.[0];
			if (first == null) return "";
			return typeof first === "string" ? first : JSON.stringify(first);
		}
		if (mode === "xpath") {
			const doc = getXmlDoc(body);
			if (!doc) return "";
			const nodes = xpath.select(noPrefix, doc as unknown as Node) as unknown[];
			const n = nodes?.[0];
			if (n == null) return "";
			if ((n as { nodeType?: number })?.nodeType === 1) {
				try {
					return new XMLSerializer().serializeToString(n as never);
				} catch {
					return "";
				}
			}
			return xpathNodeToString(n, "html");
		}
		const $ = cheerio.load(body);
		const { base, filter } = parseCssSegment(noPrefix);
		let els = baseSelect($, cssRoots($, body), base);
		if (filter) els = applyIndexFilter(els, filter);
		const first = els[0];
		return first !== undefined ? ($.html(first as never) ?? "") : "";
	} catch (e) {
		warnRule(ctx, "取元", rule, e);
		return "";
	}
}

export function absUrl(base: string, href: string): string {
	const h = (href ?? "").trim();
	if (!h) return "";
	if (/^https?:\/\//i.test(h)) return h;
	try {
		return new URL(h, base).toString();
	} catch {
		return h;
	}
}

function jsBody(ctx: JsContext): string {
	return typeof ctx.result === "string" ? ctx.result : JSON.stringify(ctx.result ?? "");
}

setJavaRuleHooks({
	elements: (ctx, rule) => {
		const rc = ctx as RuleCtx;
		if (!rc?.scope) return [];
		return evalItemList(jsBody(ctx), rule, rc);
	},
	string: (ctx, rule) => {
		const rc = ctx as RuleCtx;
		if (!rc?.scope) return "";
		return evalFirst(jsBody(ctx), rule, rc);
	},
	list: (ctx, rule) => {
		const rc = ctx as RuleCtx;
		if (!rc?.scope) return [];
		return evalList(jsBody(ctx), rule, rc);
	},
});
