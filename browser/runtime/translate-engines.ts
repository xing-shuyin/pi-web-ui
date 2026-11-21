/**
 * 网页翻译的两个免费引擎（腾讯 transmart / Google 网页翻译）。
 *
 * 为什么不再用 sidecar 的大模型：一条整页翻译要几十次请求、几十秒，模型成本与延迟都不划算，
 * 而这两个引擎翻「网页正文」这类短句质量足够，还不用 API key。两边都只在**主进程**里 fetch：
 * 页面脚本只拿译文字符串（`browser/preload.cts` 的 `__piTranslate` → `pi-browser:translate`），
 * 拿不到任何凭据、请求头或其它标签页的内容。
 *
 * 为什么不再有 `edge`（微软翻译）：它靠匿名 `edge.microsoft.com/translate/auth` 取 JWT，
 * 该端点已被厂商下线（2026-11 起由服务端直接返回 404，与网络无关），整条链路因此必然失败。
 * 现在默认走国内可直连的腾讯前端端点，`google` 留作备选；两者互为**自动回退**，
 * 主引擎整批失败时换另一个再试一次（见 `translateTexts`），避免「一个端点挂了 = 翻译一直失败」。
 *
 * 边界：两个接口都是浏览器前端在用的公开端点（无 key）。厂商改协议会立刻表现为翻译失败，
 * 所以解析全部写成「认不出就当没翻」——宁可留着原文，也不把坏数据写回页面。
 */

/** 引擎：`tencent` 腾讯翻译（国内可直连，默认），`google` 谷歌网页翻译。 */
export const TRANSLATE_ENGINES = ["tencent", "google"] as const;
export type TranslateEngine = (typeof TRANSLATE_ENGINES)[number];

/** 目标语言白名单：与设置面板的下拉项一一对应。 */
export const TRANSLATE_TARGETS = [
	"zh-CN",
	"zh-TW",
	"en",
	"ja",
	"ko",
	"fr",
	"de",
	"es",
	"ru",
	"pt",
	"it",
	"tr",
] as const;
export type TranslateTarget = (typeof TRANSLATE_TARGETS)[number];

export const DEFAULT_TRANSLATE_ENGINE: TranslateEngine = "tencent";
export const DEFAULT_TRANSLATE_TARGET: TranslateTarget = "zh-CN";

/** 一次请求的边界：与页面侧批量（5000 字/60 节点/4 路）对齐。 */
export const MAX_TEXTS = 120;
export const MAX_TEXT_CHARS = 12_000;
export const MAX_TOTAL_CHARS = 24_000;

const TENCENT_API_URL = "https://transmart.qq.com/api/imt";
const GOOGLE_API_URL = "https://translate.googleapis.com/translate_a/single";

/**
 * 腾讯前端用的 client_key（公开值，形如 `browser-<chrome 版本>-<系统>-<32 位 hex>`）。
 * 端点只校验格式，服务器不认具体设备。
 */
const TENCENT_CLIENT_KEY = "browser-chrome-124.0.0-Windows-10-0000000000000000000000000000000";

/**
 * 单请求上限：腾讯是**整批** `outOfLimit`（一条超限整批拒），实测 6000 字贴边、6500 就拒，
 * 所以按 5000 字保守切块，块内条数同样受 `MAX_TEXTS` 约束。
 */
export const TENCENT_MAX_CHARS = 5_000;

/** 页面一次最多 3–4 路并发，两块引擎都照这个节奏：Google 单段请求、腾讯分块请求靠它并行。 */
const CONCURRENCY = 3;

/** 腾讯的语言码是 BCP-47 的前缀写法（简繁分开），Google 用 zh-CN / zh-TW。 */
const TENCENT_LANG: Record<TranslateTarget, string> = {
	"zh-CN": "zh",
	"zh-TW": "zh-TW",
	en: "en",
	ja: "ja",
	ko: "ko",
	fr: "fr",
	de: "de",
	es: "es",
	ru: "ru",
	pt: "pt",
	it: "it",
	tr: "tr",
};

export interface TranslateRequest {
	texts: string[];
	engine: TranslateEngine;
	target: TranslateTarget;
}

/** 页面桥只要文本与目标语言：引擎由设置定，页面无权选。 */
export interface TranslateBridgeRequest {
	texts: string[];
	target: TranslateTarget;
}

/** 旧设置里的 `edge` 已下线：静默迁到当前默认引擎，不把死通道留在设置面板里。 */
const LEGACY_ENGINES: Record<string, TranslateEngine> = { edge: DEFAULT_TRANSLATE_ENGINE };

export function normalizeTranslateEngine(value: unknown): TranslateEngine {
	const raw = String(value ?? "");
	if ((TRANSLATE_ENGINES as readonly string[]).includes(raw)) return raw as TranslateEngine;
	return LEGACY_ENGINES[raw] ?? DEFAULT_TRANSLATE_ENGINE;
}

export function normalizeTranslateTarget(value: unknown): TranslateTarget {
	return (TRANSLATE_TARGETS as readonly string[]).includes(String(value))
		? (value as TranslateTarget)
		: DEFAULT_TRANSLATE_TARGET;
}

/**
 * 校验页面桥请求：`{ texts, target? }`。`target` 只接受白名单里的目标语言，
 * 缺省 / `auto` 一律落到 `fallbackTarget`（设置里的目标语言）。
 */
export function parseTranslateBridgeRequest(value: unknown, fallbackTarget: TranslateTarget): TranslateBridgeRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid translation request");
	const input = value as Record<string, unknown>;
	if (!Array.isArray(input.texts) || !input.texts.length || input.texts.length > MAX_TEXTS)
		throw new Error(`texts must be 1-${MAX_TEXTS} items`);
	let total = 0;
	const texts = input.texts.map((text) => {
		if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_CHARS)
			throw new Error(`Each text must be non-empty and <= ${MAX_TEXT_CHARS} chars`);
		total += text.length;
		return text;
	});
	if (total > MAX_TOTAL_CHARS) throw new Error(`Total text exceeds ${MAX_TOTAL_CHARS} chars`);
	const wanted = input.target === undefined || input.target === "auto" ? fallbackTarget : input.target;
	if (!(TRANSLATE_TARGETS as readonly string[]).includes(String(wanted))) throw new Error("Invalid target language");
	return { texts, target: wanted as TranslateTarget };
}

/** 切出来的待译片：`index` 是它在原始 `texts` 里的位置，同一条的超长文本会切成多片并按顺序拼回。 */
export interface TencentPiece {
	index: number;
	text: string;
}

/** 句子边界（尽量不在词中间硬切）；找不到就落到字符上限。 */
const SENTENCE_BREAK = /[.!?。！？;；\n]/g;

function splitText(text: string, maxChars: number): string[] {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars);
		let cut = -1;
		SENTENCE_BREAK.lastIndex = 0;
		for (let match = SENTENCE_BREAK.exec(window); match; match = SENTENCE_BREAK.exec(window))
			if (match.index > maxChars * 0.5) cut = match.index + 1;
		const end = cut > 0 ? cut : maxChars;
		parts.push(rest.slice(0, end));
		rest = rest.slice(end);
	}
	if (rest) parts.push(rest);
	return parts;
}

/** 把待译文本摊平成片：正常一条一片；超 `maxChars` 的一条切成多片，各自译完再顺序拼回。 */
export function tencentPieces(texts: string[], maxChars = TENCENT_MAX_CHARS): TencentPiece[] {
	const pieces: TencentPiece[] = [];
	texts.forEach((text, index) => {
		for (const part of splitText(text, maxChars)) pieces.push({ index, text: part });
	});
	return pieces;
}

/**
 * 腾讯端点要整批塞进一个 JSON body，且**整批**超限就 `outOfLimit`（一条超了所有条一起失败）：
 * 按 `TENCENT_MAX_CHARS`（累计字符）与 `MAX_TEXTS`（条数）顺切成块，返回每块的片下标。
 */
export function tencentChunks(pieces: TencentPiece[], maxChars = TENCENT_MAX_CHARS): number[][] {
	const chunks: number[][] = [];
	let current: number[] = [];
	let chars = 0;
	pieces.forEach((piece, position) => {
		if (current.length && (chars + piece.text.length > maxChars || current.length >= MAX_TEXTS)) {
			chunks.push(current);
			current = [];
			chars = 0;
		}
		current.push(position);
		chars += piece.text.length;
	});
	if (current.length) chunks.push(current);
	return chunks;
}

/** 腾讯请求体：`header.fn=auto_translation` + 文本数组，目标语言在 `target.lang`。 */
export function tencentBody(texts: string[], target: TranslateTarget): string {
	return JSON.stringify({
		header: { fn: "auto_translation", client_key: TENCENT_CLIENT_KEY },
		type: "plain",
		model_category: "normal",
		text_domain: "",
		source: { lang: "auto", text_list: texts },
		target: { lang: TENCENT_LANG[target] },
	});
}

/**
 * 腾讯响应：`{ header: { ret_code }, auto_translation: string[] }`。
 * `ret_code !== "succ"` 或条数对不上就是协议/配额变了 → 抛错（调用方回原文，不写半截译文）。
 */
export function parseTencentResponse(json: unknown, expected: number): string[] {
	const entry = json as { header?: { ret_code?: unknown }; message?: unknown; auto_translation?: unknown } | null;
	const code = entry?.header?.ret_code;
	if (code !== "succ") {
		const detail = typeof entry?.message === "string" ? `: ${entry.message}` : "";
		throw new Error(`Tencent translate failed (${String(code ?? "unknown")})${detail}`);
	}
	const list = entry?.auto_translation;
	if (!Array.isArray(list) || list.length !== expected) throw new Error("Unexpected Tencent translate response");
	return list.map((text) => {
		if (typeof text !== "string") throw new Error("Unexpected Tencent translate response");
		return text;
	});
}

/** Google 端点（不带文本）：`dt=t` 只要译文，`client=gtx` 是不需要 key 的那个前端客户端。 */
export function googleEndpoint(target: TranslateTarget): string {
	const url = new URL(GOOGLE_API_URL);
	url.searchParams.set("client", "gtx");
	url.searchParams.set("sl", "auto");
	url.searchParams.set("tl", target);
	url.searchParams.set("dt", "t");
	return url.href;
}

/** 待译文本走 POST 的 form body：长段落（上万字）塞进 query string 会被 URL 长度上限截断。 */
export function googleBody(text: string): string {
	return `q=${encodeURIComponent(text)}`;
}

/**
 * Google 响应：`[[[译文, 原文, ...], [seg, ...]], ...]`。
 * 多段句子的译文分散在 `[0][i][0]` 里，按顺序拼起来才是完整一段。
 */
export function parseGoogleResponse(json: unknown): string {
	if (!Array.isArray(json) || !Array.isArray(json[0])) throw new Error("Unexpected Google translate response");
	const parts: string[] = [];
	for (const segment of json[0] as unknown[]) {
		const text = Array.isArray(segment) ? segment[0] : undefined;
		if (typeof text === "string" && text) parts.push(text);
	}
	if (!parts.length) throw new Error("Unexpected Google translate response");
	return parts.join("");
}

export interface TranslateDeps {
	fetch?: typeof fetch;
}

/** 两个厂商的服务端都会看 UA：裸 `node` / `electron` 的 UA 容易被当成机器人（403），给一个普通浏览器 UA。 */
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const ENGINE_MODEL: Record<TranslateEngine, string> = { tencent: "腾讯翻译", google: "Google 翻译" };

async function tencentTranslate(request: TranslateRequest, deps: TranslateDeps): Promise<string[]> {
	const doFetch = deps.fetch ?? fetch;
	const pieces = tencentPieces(request.texts);
	const chunks = tencentChunks(pieces);
	// 同一条被切成多片时按片下标回位（片可能分布在不同并发块里，不能靠 push 顺序）
	const collected: Record<number, string>[] = request.texts.map(() => ({}));
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < chunks.length) {
			const positions = chunks[cursor++];
			const response = await doFetch(TENCENT_API_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					Referer: "https://transmart.qq.com/zh-CN/index",
					"User-Agent": BROWSER_UA,
				},
				body: tencentBody(
					positions.map((position) => pieces[position].text),
					request.target,
				),
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) throw new Error(`Tencent translate failed (HTTP ${response.status})`);
			const translations = parseTencentResponse(await response.json(), positions.length);
			positions.forEach((position, offset) => {
				collected[pieces[position].index][position] = translations[offset];
			});
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
	return collected.map((slots, index) => {
		const keys = Object.keys(slots)
			.map(Number)
			.sort((a, b) => a - b);
		if (!keys.length) throw new Error(`Tencent translate missed text #${index}`);
		return keys.map((key) => slots[key]).join("");
	});
}

async function googleTranslate(request: TranslateRequest, deps: TranslateDeps): Promise<string[]> {
	const doFetch = deps.fetch ?? fetch;
	const out: string[] = new Array(request.texts.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < request.texts.length) {
			const index = cursor++;
			const response = await doFetch(googleEndpoint(request.target), {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
					Accept: "application/json",
					"User-Agent": BROWSER_UA,
				},
				body: googleBody(request.texts[index]),
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) throw new Error(`Google translate failed (HTTP ${response.status})`);
			out[index] = parseGoogleResponse(await response.json());
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, request.texts.length) }, worker));
	return out;
}

const ENGINE_RUN: Record<TranslateEngine, (request: TranslateRequest, deps: TranslateDeps) => Promise<string[]>> = {
	tencent: tencentTranslate,
	google: googleTranslate,
};

/** 先走设置里的引擎，失败再试另一个（只有一个备选，次数固定为 1）。 */
function engineOrder(primary: TranslateEngine): TranslateEngine[] {
	return primary === "google" ? ["google", "tencent"] : ["tencent", "google"];
}

/** 只给单测用：把跨引擎回退关掉，单独钉住某一个引擎的行为。 */
export interface TranslateOptions extends TranslateDeps {
	fallback?: boolean;
}

/**
 * 翻译一批文本，返回与 `texts` 等长的译文数组。
 * 主引擎整批失败时会换另一个引擎重试一次（回退本身也失败才抛错）；两个都失败就整批抛出，
 * 调用方把这一段留成原文并计入 failed——不做静默降级、也不写半截译文。
 * `model` 是**实际生效**的引擎标签（回退时与设置里的不同）。
 */
export async function translateTexts(
	request: TranslateRequest,
	options: TranslateOptions = {},
): Promise<{ translations: string[]; model: string }> {
	const order = options.fallback === false ? [request.engine] : engineOrder(request.engine);
	let failure: unknown;
	for (const engine of order) {
		try {
			const translations = await ENGINE_RUN[engine]({ ...request, engine }, options);
			return { translations, model: ENGINE_MODEL[engine] };
		} catch (error) {
			failure ??= error;
		}
	}
	throw failure instanceof Error ? failure : new Error("Translation failed");
}
