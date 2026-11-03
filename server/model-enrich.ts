/**
 * model-enrich — 用公开模型目录给自定义供应商的模型行补参数。
 *
 * 背景：很多反代（如 Antigravity-Manager 的 /v1/models）只返回模型 id，没有
 * 任何元数据；id 又是别名（gemini-3-pro-high），不能直接用。本模块做三件事：
 * 规范化 id → 目录模糊匹配 → 只返回目录真实给出的字段（绝不编造）。
 * 数据源：OpenRouter 主（轻量，上下文/识图/输出上限），models.dev 辅
 * （全字段 + reasoning 布尔值，4.7MB，懒加载 + 24h 缓存）。
 * 纯函数 + 可注入的抓取层（fetchFn/pageFetch），单测覆盖零网络。
 */
import type { UiEnrichResult } from "./protocol.js";
import { resolveModelReasoningSpec } from "./reasoning-registry.js";

/** 目录里归一化后的一个模型（已抹平两源字段差异）。 */
export interface CatalogModel {
	/** 去掉 provider 前缀的小写 id，如 "gemini-3.8-flash"。 */
	id: string;
	provider: string;
	/** 目录原始 id（含前缀），展示/建议用。 */
	rawId: string;
	name: string;
	family?: string;
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
	reasoning?: boolean;
}

export type EnrichLang = "zh" | "en";

export interface EnrichProgress {
	phase: "catalog" | "page" | "matching";
	current?: number;
	total?: number;
	message?: string;
}

const t = (lang: EnrichLang, zh: string, en: string): string => (lang === "zh" ? zh : en);

/** 反代路由档位后缀（只在精确匹配失败后剥离；-pro/-flash/-lite 等真实
 *  家族区分绝不在此列）。 */
const TIER_SUFFIXES = ["-thinking", "-high", "-low", "-max", "-preview", "-latest", "-exp"];

/** 小写 + 下划线转横线 + 去 provider 前缀（a/b → b）。 */
export function normalizeModelId(id: string): string {
	let s = id.trim().toLowerCase().replace(/_/g, "-");
	const slash = s.lastIndexOf("/");
	if (slash >= 0) s = s.slice(slash + 1);
	return s;
}

/** 剥离路由档位与日期后缀（-0813 / -20250929），精确匹配失败后的回退用。 */
export function stripTierSuffix(id: string): string {
	let s = normalizeModelId(id);
	for (let i = 0; i < 3; i++) {
		let next = s.replace(/-((0[1-9]|1[0-2])\d{2}|\d{6,8})$/, "");
		for (const suf of TIER_SUFFIXES) {
			if (next.endsWith(suf) && next.length > suf.length + 2) {
				next = next.slice(0, -suf.length);
				break;
			}
		}
		if (next === s) return s;
		s = next;
	}
	return s;
}

export interface CatalogIndex {
	byId: Map<string, CatalogModel[]>;
	byName: Map<string, CatalogModel[]>;
	all: CatalogModel[];
}

export function buildIndex(models: CatalogModel[]): CatalogIndex {
	const byId = new Map<string, CatalogModel[]>();
	const byName = new Map<string, CatalogModel[]>();
	for (const m of models) {
		const idKey = normalizeModelId(m.id);
		if (idKey) {
			const arr = byId.get(idKey) ?? [];
			arr.push(m);
			byId.set(idKey, arr);
		}
		const nameKey = m.name.trim().toLowerCase();
		if (nameKey && nameKey !== idKey) {
			const arr = byName.get(nameKey) ?? [];
			arr.push(m);
			byName.set(nameKey, arr);
		}
	}
	return { byId, byName, all: models };
}

/** OpenRouter /api/v1/models → CatalogModel[]（缺字段即缺席，不编造）。 */
export function parseOpenRouterCatalog(json: unknown): CatalogModel[] {
	const data = (json as { data?: unknown })?.data;
	if (!Array.isArray(data)) return [];
	const out: CatalogModel[] = [];
	for (const item of data) {
		const r = (item ?? {}) as Record<string, unknown>;
		if (typeof r.id !== "string" || !r.id.trim()) continue;
		const norm = normalizeModelId(r.id);
		const slash = norm.lastIndexOf("/");
		// OpenRouter id 形如 anthropic/claude-sonnet-4-5（normalize 已去前缀，
		// provider 从原始 id 取）。
		const raw = r.id.trim();
		const rawSlash = raw.lastIndexOf("/");
		const provider = rawSlash >= 0 ? raw.slice(0, rawSlash).toLowerCase() : "";
		const tail = slash >= 0 ? norm.slice(slash + 1) : norm;
		const arch = (r.architecture ?? {}) as Record<string, unknown>;
		const inputs = Array.isArray(arch.input_modalities)
			? arch.input_modalities.filter((x): x is string => typeof x === "string")
			: [];
		const top = (r.top_provider ?? {}) as Record<string, unknown>;
		const num = (v: unknown): number | undefined =>
			typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
		const params = Array.isArray(r.supported_parameters)
			? r.supported_parameters.filter((x): x is string => typeof x === "string")
			: [];
		out.push({
			id: tail,
			provider,
			rawId: raw,
			name: typeof r.name === "string" ? r.name : tail,
			contextWindow: num(top.context_length) ?? num(r.context_length),
			maxTokens: num(top.max_completion_tokens),
			vision: inputs.includes("image") ? true : undefined,
			reasoning: params.includes("reasoning") || params.includes("include_reasoning") ? true : undefined,
		});
	}
	return out;
}

/** models.dev /api.json → CatalogModel[]（{ provider: { models: {...} } }）。 */
export function parseModelsDevCatalog(json: unknown): CatalogModel[] {
	const root = (json ?? {}) as Record<string, Record<string, unknown>>;
	const out: CatalogModel[] = [];
	const num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
	for (const [providerKey, entry] of Object.entries(root)) {
		const models = (entry as { models?: unknown })?.models;
		if (!models || typeof models !== "object") continue;
		for (const [key, item] of Object.entries(models as Record<string, unknown>)) {
			const r = (item ?? {}) as Record<string, unknown>;
			const rawId = typeof r.id === "string" && r.id.trim() ? r.id.trim() : key;
			const norm = normalizeModelId(rawId);
			const slash = norm.lastIndexOf("/");
			const tail = slash >= 0 ? norm.slice(slash + 1) : norm;
			if (!tail) continue;
			const limit = (r.limit ?? {}) as Record<string, unknown>;
			const modalities = (r.modalities ?? {}) as Record<string, unknown>;
			const inputs = Array.isArray(modalities.input)
				? modalities.input.filter((x): x is string => typeof x === "string")
				: [];
			out.push({
				id: tail,
				provider: (slash >= 0 ? norm.slice(0, slash) : providerKey).toLowerCase(),
				rawId,
				name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : tail,
				family: typeof r.family === "string" ? r.family.toLowerCase() : undefined,
				contextWindow: num(limit.context),
				maxTokens: num(limit.output),
				vision: inputs.includes("image") ? true : undefined,
				reasoning: r.reasoning === true ? true : undefined,
			});
		}
	}
	return out;
}

type FetchFn = typeof fetch;

async function fetchJson(
	fetchFn: FetchFn,
	url: string,
	maxBytes: number,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	if (signal?.aborted) throw new Error("aborted");
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	const onAbort = () => ac.abort();
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetchFn(url, {
			signal: ac.signal,
			headers: { "user-agent": "pi-web-ui model-enrich" },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		if (text.length > maxBytes) throw new Error("response too large");
		return JSON.parse(text) as unknown;
	} catch (err) {
		if (signal?.aborted) throw new Error("aborted");
		if ((err as Error).name === "AbortError") throw new Error("timeout");
		throw err;
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

// 手写 TTL 缓存而非通用 memoize：双键（openrouter/modelsdev）共享一个 Map，
// 且 compute 是 async fetch——单值同步的 memoizeWithTtl 覆盖不了（issue #470 处置说明）。
/** 目录抓取缓存（24h TTL，进程内；首跑后无感）。 */
const catalogCache = new Map<string, { at: number; data: CatalogModel[] }>();
const CATALOG_TTL_MS = 24 * 3600 * 1000;

export async function getOpenRouterCatalog(fetchFn: FetchFn = fetch, signal?: AbortSignal): Promise<CatalogModel[]> {
	const hit = catalogCache.get("openrouter");
	if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.data;
	const data = parseOpenRouterCatalog(
		await fetchJson(fetchFn, "https://openrouter.ai/api/v1/models", 5_000_000, 25000, signal),
	);
	catalogCache.set("openrouter", { at: Date.now(), data });
	return data;
}

export async function getModelsDevCatalog(fetchFn: FetchFn = fetch, signal?: AbortSignal): Promise<CatalogModel[]> {
	const hit = catalogCache.get("modelsdev");
	if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.data;
	const data = parseModelsDevCatalog(
		await fetchJson(fetchFn, "https://models.dev/api.json", 25_000_000, 30000, signal),
	);
	catalogCache.set("modelsdev", { at: Date.now(), data });
	return data;
}

/** 从网页正文提取参数（hint URL 兜底；只认上下文/输出上限/识图，不认推理）。 */
export function extractParamsFromHtml(html: string): {
	contextWindow?: number;
	maxTokens?: number;
	vision?: boolean;
} {
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.slice(0, 200_000);
	const toNum = (n: string, unit?: string): number | undefined => {
		const base = Number(n.replace(/[,，]/g, ""));
		if (!Number.isFinite(base) || base <= 0) return undefined;
		const mult = unit?.toLowerCase() === "m" ? 1_000_000 : unit?.toLowerCase() === "k" ? 1000 : 1;
		const v = Math.round(base * mult);
		return v >= 1000 && v <= 100_000_000 ? v : undefined;
	};
	const out: { contextWindow?: number; maxTokens?: number; vision?: boolean } = {};
	const ctx =
		text.match(/(\d[\d,.]*)\s*([kKmM])\s*(?:token\s*)?context/i) ??
		text.match(/(\d[\d,.]*)\s*tokens?\s+context/i) ??
		text.match(/context(?:\s+window)?[^.\n]{0,50}?(\d[\d,.]*)\s*([kKmM])?\s*tokens?/i);
	if (ctx) {
		const v = toNum(ctx[1], ctx[2]);
		if (v !== undefined) out.contextWindow = v;
	}
	const max =
		text.match(/(\d[\d,.]*)\s*([kKmM])\s*(?:max(?:imum)?\s+)?output/i) ??
		text.match(/(\d[\d,.]*)\s*tokens?\s+(?:max(?:imum)?\s+)?output/i) ??
		text.match(/(?:max(?:imum)?\s+output|output\s+limit)[^.]{0,50}?(\d[\d,.]*)\s*([kKmM])?\s*tokens?/i);
	if (max) {
		const v = toNum(max[1], max[2]);
		if (v !== undefined) out.maxTokens = v;
	}
	if (/image\s*(input|understanding|support)/i.test(text)) out.vision = true;
	return out;
}

async function fetchPageText(fetchFn: FetchFn, url: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new Error("aborted");
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 15000);
	const onAbort = () => ac.abort();
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetchFn(url, {
			signal: ac.signal,
			headers: { "user-agent": "pi-web-ui model-enrich" },
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		if (text.length > 2_000_000) throw new Error("response too large");
		return text;
	} catch (err) {
		if (signal?.aborted) throw new Error("aborted");
		if ((err as Error).name === "AbortError") throw new Error("timeout");
		throw err;
	} finally {
		clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onAbort);
	}
}

/** 单个 id 在给定索引里的精确/别名命中（exact → normalized）。 */
function lookupIndex(
	norm: string,
	index: CatalogIndex,
): { model: CatalogModel; matchType: "exact" | "normalized" } | null {
	const exact = index.byId.get(norm);
	if (exact?.length) return { model: exact[0], matchType: "exact" };
	const stripped = stripTierSuffix(norm);
	if (stripped !== norm) {
		const hit = index.byId.get(stripped);
		if (hit?.length) return { model: hit[0], matchType: "normalized" };
	}
	const nameHit = index.byName.get(norm);
	if (nameHit?.length) return { model: nameHit[0], matchType: "exact" };
	return null;
}

/** 家族候选（只做建议，不自动填）：family 字符串与 id 互含。 */
function familySuggestions(norm: string, indexes: CatalogIndex[], cap = 6): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const index of indexes) {
		for (const m of index.all) {
			if (!m.family || out.length >= cap) break;
			if (norm.includes(m.family) || m.family.includes(norm)) {
				if (!seen.has(m.rawId)) {
					seen.add(m.rawId);
					out.push(m.rawId);
				}
			}
		}
		if (out.length >= cap) break;
	}
	return out;
}

function toResult(
	lang: EnrichLang,
	id: string,
	model: CatalogModel,
	source: string,
	matchType: "exact" | "normalized" | "hint" | "hint-url",
): UiEnrichResult {
	const reasoningSpec = resolveModelReasoningSpec(id) ?? resolveModelReasoningSpec(model.id);
	const isReasoning = Boolean(model.reasoning || reasoningSpec);
	return {
		id,
		status: "matched",
		...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
		...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
		...(model.vision ? { input: ["text", "image"] } : {}),
		...(isReasoning ? { reasoning: true } : {}),
		...(reasoningSpec?.thinkingLevelMap ? { thinkingLevelMap: reasoningSpec.thinkingLevelMap } : {}),
		...(reasoningSpec?.type ? { reasoningType: reasoningSpec.type } : {}),
		...(model.name && model.name.toLowerCase() !== id.toLowerCase() ? { name: model.name } : {}),
		source: `${source}${matchType === "exact" || matchType === "hint" ? "" : t(lang, "（别名）", " (alias)")}`,
		matchType,
	};
}

export interface EnrichBatchOpts {
	fetchFn?: FetchFn;
	/** 预置目录（单测注入；线上走抓取 + 缓存）。 */
	catalogs?: { openrouter: CatalogModel[]; modelsdev: CatalogModel[] };
	lang?: EnrichLang;
	/** hint URL 抓取（单测注入；默认走 fetchFn）。 */
	pageFetch?: (url: string) => Promise<string>;
	signal?: AbortSignal;
	onProgress?: (progress: EnrichProgress) => void;
}

function isUrl(s: string): boolean {
	return /^https?:\/\//i.test(s.trim());
}

/** 批量补参数：hint（目录 id / URL）优先，否则 OpenRouter → models.dev 自动匹配。 */
export async function enrichBatch(
	ids: string[],
	hints: Record<string, string>,
	opts: EnrichBatchOpts = {},
): Promise<UiEnrichResult[]> {
	const lang = opts.lang ?? "en";
	const fetchFn = opts.fetchFn ?? fetch;
	const uniq = [...new Set(ids.map((s) => (s ?? "").trim()).filter(Boolean))].slice(0, 100);

	const results: UiEnrichResult[] = [];
	const throwAbort = () => {
		const err = new Error("aborted");
		(err as unknown as { partialResults: UiEnrichResult[] }).partialResults = results;
		throw err;
	};
	if (opts.signal?.aborted) throwAbort();

	let orModels: CatalogModel[] | null = null;
	let mdModels: CatalogModel[] | null = null;
	let orIndex: CatalogIndex | null = null;
	let mdIndex: CatalogIndex | null = null;
	if (opts.catalogs) {
		orModels = opts.catalogs.openrouter;
		mdModels = opts.catalogs.modelsdev;
		orIndex = buildIndex(orModels);
		mdIndex = buildIndex(mdModels);
	} else {
		opts.onProgress?.({
			phase: "catalog",
			message: t(lang, "正在获取 OpenRouter 模型目录…", "Fetching OpenRouter catalog…"),
		});
		try {
			orModels = await getOpenRouterCatalog(fetchFn, opts.signal);
		} catch (err) {
			if (opts.signal?.aborted || (err as Error).message === "aborted") throwAbort();
			orModels = [];
		}
		orIndex = buildIndex(orModels);
	}
	const ensureMd = async (): Promise<CatalogIndex> => {
		if (opts.signal?.aborted) throwAbort();
		if (!mdIndex) {
			if (!opts.catalogs) {
				opts.onProgress?.({
					phase: "catalog",
					message: t(lang, "正在拉取 models.dev 目录（约 25MB）…", "Fetching models.dev catalog (~25MB)…"),
				});
			}
			try {
				mdModels = opts.catalogs ? opts.catalogs.modelsdev : await getModelsDevCatalog(fetchFn, opts.signal);
			} catch (err) {
				if (opts.signal?.aborted || (err as Error).message === "aborted") throwAbort();
				mdModels = [];
			}
			mdIndex = buildIndex(mdModels ?? []);
		}
		return mdIndex;
	};
	const indexes = (): CatalogIndex[] => (mdIndex ? [orIndex as CatalogIndex, mdIndex] : [orIndex as CatalogIndex]);

	if (!opts.catalogs && orModels.length === 0) {
		// 主源不可达时仍试一次辅源；都空才报错。
		await ensureMd();
		if ((mdModels ?? []).length === 0) {
			throw new Error(
				t(
					lang,
					"参考源不可达（OpenRouter / models.dev），请检查网络后重试",
					"Reference catalogs unreachable (OpenRouter / models.dev); check your network and retry",
				),
			);
		}
	}

	const total = uniq.length;
	for (let i = 0; i < total; i++) {
		if (opts.signal?.aborted) throwAbort();
		const id = uniq[i];
		opts.onProgress?.({
			phase: "matching",
			current: i + 1,
			total,
			message: t(lang, `正在匹配参数 (${i + 1}/${total})：${id}`, `Matching params (${i + 1}/${total}): ${id}`),
		});
		const norm = normalizeModelId(id);
		const hint = (hints[id] ?? hints[norm] ?? "").trim();
		// -- 依据分支 ---------------------------------------------------------
		if (hint) {
			if (isUrl(hint)) {
				opts.onProgress?.({
					phase: "page",
					current: i + 1,
					total,
					message: t(
						lang,
						`正在抓取依据网页 (${i + 1}/${total})：${hint}`,
						`Fetching evidence page (${i + 1}/${total}): ${hint}`,
					),
				});
				try {
					const html = opts.pageFetch ? await opts.pageFetch(hint) : await fetchPageText(fetchFn, hint, opts.signal);
					const ext = extractParamsFromHtml(html);
					if (ext.contextWindow === undefined && ext.maxTokens === undefined && ext.vision === undefined) {
						results.push({
							id,
							status: "unmatched",
							note: t(lang, "网页未提取到可用参数", "No usable params extracted from the page"),
						});
						continue;
					}
					results.push({
						id,
						status: "matched",
						...(ext.contextWindow ? { contextWindow: ext.contextWindow } : {}),
						...(ext.maxTokens ? { maxTokens: ext.maxTokens } : {}),
						...(ext.vision ? { input: ["text", "image"] } : {}),
						source: t(lang, "网页", "Web page"),
						matchType: "hint-url",
					});
				} catch (err) {
					if (opts.signal?.aborted || (err as Error).message === "aborted") throwAbort();
					results.push({
						id,
						status: "unmatched",
						note: t(lang, "依据网页抓取失败", "Failed to fetch the evidence page"),
					});
				}
				continue;
			}
			const hNorm = normalizeModelId(hint);
			const hStripped = stripTierSuffix(hNorm);
			const hit =
				(orIndex as CatalogIndex).byId.get(hNorm)?.[0] ??
				(orIndex as CatalogIndex).byId.get(hStripped)?.[0] ??
				(orIndex as CatalogIndex).byName.get(hNorm)?.[0];
			if (hit) {
				results.push(toResult(lang, id, hit, t(lang, "依据", "Evidence"), "hint"));
				continue;
			}
			const md = await ensureMd();
			const mdHit = md.byId.get(hNorm)?.[0] ?? md.byId.get(hStripped)?.[0] ?? md.byName.get(hNorm)?.[0];
			if (mdHit) {
				results.push(toResult(lang, id, mdHit, t(lang, "依据", "Evidence"), "hint"));
				continue;
			}
			results.push({
				id,
				status: "unmatched",
				note: t(lang, `依据「${hint}」在目录中未命中`, `Evidence "${hint}" not found in catalogs`),
			});
			continue;
		}
		// -- 自动匹配分支 -----------------------------------------------------
		const orHit = lookupIndex(norm, orIndex as CatalogIndex);
		if (orHit) {
			const r = toResult(lang, id, orHit.model, "OpenRouter", orHit.matchType);
			// OpenRouter 的推理信号弱；models.dev 有明确布尔值时补上。
			if (!orHit.model.reasoning) {
				const md = await ensureMd();
				const mdHit = md.byId.get(normalizeModelId(orHit.model.id))?.[0];
				if (mdHit?.reasoning) r.reasoning = true;
			}
			results.push(r);
			continue;
		}
		const md = await ensureMd();
		const mdHit = lookupIndex(norm, md);
		if (mdHit) {
			results.push(toResult(lang, id, mdHit.model, "models.dev", mdHit.matchType));
			continue;
		}
		const suggestions = familySuggestions(norm, indexes());
		const reasoningSpec = resolveModelReasoningSpec(id);
		results.push({
			id,
			status: suggestions.length ? "suggested" : "unmatched",
			...(reasoningSpec
				? { reasoning: true, thinkingLevelMap: reasoningSpec.thinkingLevelMap, reasoningType: reasoningSpec.type }
				: {}),
			...(suggestions.length ? { suggestions, matchType: "family" as const } : {}),
			note: suggestions.length
				? t(lang, "家族相近，可用其 id 作依据重试", "Close family match — retry with its id as evidence")
				: t(
						lang,
						"目录无此模型，可填官方文档 URL 作依据重试",
						"Not in catalogs — retry with an official docs URL as evidence",
					),
		});
	}
	return results;
}
