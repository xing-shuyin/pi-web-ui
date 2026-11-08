/**
 * 页面脚本（Page script）纯逻辑：类型、校验、URL 匹配、注入代码拼装。
 *
 * 设计取向：**脚本不做能力限制**——不设代码体积/条数/匹配数上限，不做正则白名单，
 * 需要多能干就让脚本多能干（它就在目标页面的主世界/隔离世界里跑，拿不到宿主桥）。
 * 这里只负责把"记录"翻译成可直接 executeJavaScript 的代码，并保证：
 * - 同一文档同一脚本只跑一次（WeakMap per-document 标记）；
 * - 重跑/删除前先调用上一轮的 cleanup（脚本顶层 `return function () {...}` 即是清理钩子）；
 * - 每次注入带 `//# sourceURL=pi-script://<id>/<name>.js`，DevTools 里可单独断点。
 */

export type PageScriptRunAt = "document-start" | "dom-ready";
export type PageScriptWorld = "main" | "isolated";
export type PageScriptSource = "agent" | "user";

export interface PageScript {
	id: string;
	/** 幂等键：同名同 id 视为同一条记录，重复 create 会更新而不是再注入一遍 */
	name: string;
	/** 匹配表达式；空数组 = 所有 http(s) 页面 */
	matches: string[];
	code: string;
	css: string;
	runAt: PageScriptRunAt;
	world: PageScriptWorld;
	/** 同文档路由变化后是否重跑（history/URL 轮询） */
	spa: boolean;
	enabled: boolean;
	/** true = 落盘永久生效；false = 仅在本次浏览器进程内有效 */
	persistent: boolean;
	createdBy: PageScriptSource;
	createdAt: string;
	updatedAt: string;
}

/** 页面里的脚本注册表：`{ [id]: { cleanup, rerun, error } }` */
export const PAGE_SCRIPT_REGISTRY = "__piPageScripts";
const SEEN_REGISTRY = "__piPageScriptsSeen";

const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

function runAt(value: unknown, fallback: PageScriptRunAt): PageScriptRunAt {
	return value === "document-start" || value === "dom-ready" ? value : fallback;
}

function world(value: unknown, fallback: PageScriptWorld): PageScriptWorld {
	return value === "main" || value === "isolated" ? value : fallback;
}

function matches(value: unknown, fallback: string[]): string[] {
	if (value === undefined) return [...fallback];
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (!Array.isArray(value)) return [...fallback];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((s) => s.trim());
}

function source(value: unknown, fallback: PageScriptSource): PageScriptSource {
	return value === "user" || value === "agent" ? value : fallback;
}

/**
 * 归一化一条脚本记录。`base` 是已存在的记录（更新场景），未提供的字段沿用旧值。
 * 不校验代码体积、不校验条数、不校验匹配表达式形态——按产品要求不做限制。
 */
export function normalizePageScript(value: unknown, base?: PageScript): PageScript {
	if (!object(value)) throw new Error("Invalid page script payload");
	const now = new Date().toISOString();
	const code = text(value.code, base?.code ?? "");
	const css = text(value.css, base?.css ?? "");
	if (!code.trim() && !css.trim() && !base) throw new Error("A page script needs `code` or `css`");
	const name = (text(value.name, base?.name ?? "") || code.slice(0, 40) || "script").trim();
	if (!name) throw new Error("A page script needs a name");
	return {
		id: text(value.id, base?.id ?? "") || `s-${Math.random().toString(36).slice(2, 10)}`,
		name,
		matches: matches(value.matches, base?.matches ?? []),
		code,
		css,
		runAt: runAt(value.runAt, base?.runAt ?? "dom-ready"),
		world: world(value.world, base?.world ?? "main"),
		spa: typeof value.spa === "boolean" ? value.spa : (base?.spa ?? false),
		enabled: typeof value.enabled === "boolean" ? value.enabled : (base?.enabled ?? true),
		persistent: typeof value.persistent === "boolean" ? value.persistent : (base?.persistent ?? false),
		createdBy: source(value.createdBy, base?.createdBy ?? "agent"),
		createdAt: text(value.createdAt, base?.createdAt ?? now),
		updatedAt: now,
	};
}

/** 读取落盘数据（容忍任意脏字段，逐条丢弃非法项而不是整体失败）。 */
export function readPageScripts(value: unknown): PageScript[] {
	const list = Array.isArray(value)
		? value
		: object(value) && Array.isArray((value as { scripts?: unknown }).scripts)
			? ((value as { scripts: unknown[] }).scripts ?? [])
			: [];
	const scripts: PageScript[] = [];
	for (const item of list) {
		try {
			scripts.push({ ...normalizePageScript(item), persistent: true });
		} catch {}
	}
	return scripts;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const globCache = new Map<string, RegExp | null>();

function glob(pattern: string): RegExp | null {
	if (globCache.has(pattern)) return globCache.get(pattern) ?? null;
	let compiled: RegExp | null = null;
	try {
		compiled = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, ".*")}$`, "i");
	} catch {
		compiled = null;
	}
	globCache.set(pattern, compiled);
	return compiled;
}

const regexCache = new Map<string, RegExp | null>();

function userRegExp(source: string): RegExp | null {
	if (regexCache.has(source)) return regexCache.get(source) ?? null;
	let compiled: RegExp | null = null;
	try {
		compiled = new RegExp(source, "i");
	} catch {
		compiled = null;
	}
	regexCache.set(source, compiled);
	return compiled;
}

export function isScriptableUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * 匹配表达式（任意一条命中即注入）：
 * - `*` / `<all_urls>`：所有 http(s) 页面
 * - `re:<正则>`：自定义正则，匹配完整 URL
 * - 其余按"宽松 glob"：同时对比 host、host+path、完整 URL，`*` 为通配
 * 空数组 = 所有 http(s) 页面。
 */
export function matchPageScript(script: Pick<PageScript, "matches">, url: string): boolean {
	if (!isScriptableUrl(url)) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const patterns = script.matches.map((item) => item.trim()).filter(Boolean);
	if (!patterns.length) return true;
	const candidates = [parsed.href, parsed.host, parsed.hostname, `${parsed.host}${parsed.pathname}`];
	return patterns.some((pattern) => {
		if (pattern === "*" || pattern === "<all_urls>") return true;
		if (pattern.startsWith("re:")) {
			const re = userRegExp(pattern.slice(3));
			return re ? re.test(parsed.href) : false;
		}
		const compiled = glob(pattern);
		return compiled ? candidates.some((candidate) => compiled.test(candidate)) : false;
	});
}

/** sourceURL 里用的安全名字（DevTools 面板可读，且不会破坏注释行）。 */
export function scriptSourceName(script: Pick<PageScript, "name">): string {
	const safe = script.name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
	return (safe || "script").slice(0, 60);
}

/**
 * 生成一次注入的代码。
 *
 * `token` 是"这次注入的身份"：同一 document 内 token 相同的注入只会真正执行一次，
 * 因此 dom-ready 与 document-start 两条通道同时存在也不会重复跑（两者都用自身的固定 token），
 * 而 `script.run` 用一次性 token 就能强制重跑（重跑前先调用上一轮 cleanup）。
 */
export function buildInjectionCode(script: PageScript, token: string): string {
	return [
		"(function () {",
		`  var ID = ${JSON.stringify(script.id)};`,
		`  var TOKEN = ${JSON.stringify(token)};`,
		`  var SPA = ${script.spa ? "true" : "false"};`,
		`  var NAME = ${JSON.stringify(scriptSourceName(script))};`,
		`  var reg = window.${PAGE_SCRIPT_REGISTRY} || (window.${PAGE_SCRIPT_REGISTRY} = Object.create(null));`,
		`  var seenDocs = window.${SEEN_REGISTRY} || (window.${SEEN_REGISTRY} = new WeakMap());`,
		"  var marks = seenDocs.get(document);",
		"  if (!marks) { marks = Object.create(null); seenDocs.set(document, marks); }",
		"  if (marks[ID] === TOKEN) return { ok: true, reused: true };",
		"  marks[ID] = TOKEN;",
		"  function run() {",
		"    return (function () {",
		script.code,
		"    }).call(window);",
		"  }",
		"  var prev = reg[ID];",
		"  if (prev && typeof prev.cleanup === 'function') { try { prev.cleanup(); } catch (__e) {} }",
		"  try {",
		"    var cleanup = run();",
		"    reg[ID] = {",
		"      name: NAME,",
		"      cleanup: typeof cleanup === 'function' ? cleanup : null,",
		"      rerun: SPA ? run : null,",
		"      error: null",
		"    };",
		"  } catch (error) {",
		"    reg[ID] = { name: NAME, cleanup: null, rerun: null, error: String((error && error.stack) || error) };",
		"    if (window.console) console.error('[pi:script:' + NAME + ']', error);",
		"    throw error;",
		"  }",
		"  if (SPA) {",
		"    var watch = reg.__spa;",
		"    if (!watch) watch = reg.__spa = { href: location.href, ids: Object.create(null), timer: 0 };",
		"    watch.ids[ID] = true;",
		"    if (!watch.timer && typeof setInterval === 'function') {",
		"      watch.timer = setInterval(function () {",
		"        if (location.href === watch.href) return;",
		"        watch.href = location.href;",
		"        for (var key in watch.ids) {",
		"          var entry = reg[key];",
		"          if (entry && typeof entry.rerun === 'function') {",
		"            try { entry.rerun(); } catch (error) { if (window.console) console.error('[pi:script:' + key + ']', error); }",
		"          }",
		"        }",
		"      }, 400);",
		"    }",
		"  }",
		"  return { ok: true };",
		"})();",
		`//# sourceURL=pi-script://${script.id}/${scriptSourceName(script)}.js`,
	].join("\n");
}

/** 生成清理代码：调用每个脚本的 cleanup 并从注册表摘掉。 */
export function buildCleanupCode(ids: string[]): string {
	return [
		"(function () {",
		`  var reg = window.${PAGE_SCRIPT_REGISTRY};`,
		"  if (!reg) return { cleaned: [] };",
		`  var ids = ${JSON.stringify(ids)};`,
		"  var cleaned = [];",
		"  for (var i = 0; i < ids.length; i += 1) {",
		"    var id = ids[i];",
		"    var entry = reg[id];",
		"    if (!entry) continue;",
		"    try {",
		"      if (typeof entry.cleanup === 'function') { entry.cleanup(); cleaned.push(id); }",
		"    } catch (error) {",
		"      if (window.console) console.error('[pi:script:' + id + '] cleanup failed', error);",
		"    }",
		"    if (reg.__spa && reg.__spa.ids) delete reg.__spa.ids[id];",
		"    delete reg[id];",
		"  }",
		"  return { cleaned: cleaned };",
		"})();",
	].join("\n");
}

export interface ScriptRunIssue {
	scriptId: string;
	tabId: string;
	error: string;
}

export interface ScriptRunReport {
	applied: Array<{ scriptId: string; tabId: string; url: string }>;
	skipped: Array<{ scriptId: string; tabId: string; reason: string }>;
	errors: ScriptRunIssue[];
}

export function emptyReport(): ScriptRunReport {
	return { applied: [], skipped: [], errors: [] };
}
