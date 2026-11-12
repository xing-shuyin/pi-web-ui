/**
 * 意图编译器（Ask）
 *
 * 流程：自然语言 → 结构化检索计划 → 多源召回 → 品味排序 → 有预算的取证 → 可引用的答案。
 *
 * 三条硬规则：
 * 1) 宁可弃权也不凑数：最优分低于阈值时返回 abstained，并列 nearMiss 说明差在哪。
 * 2) 预算是显式的：最多看多少候选、最多取证几条、超时后降级为"只看元数据"并标注 degraded。
 * 3) 引用必须带时间戳：答案里的每句话都能落到 ?t=秒，不给"我看完了"式的空口结论。
 */
import { deepLink } from "./indexer.mjs?v=2.4.0";
import { dayKey } from "./store.mjs?v=2.4.0";
import { fmtSeconds, jaccard, parseDurationSec, tokens } from "./taste.mjs?v=2.4.0";

const STOP =
	/(我想|想看|想找|想要|帮我|给我|找点|找找|推荐|有没有|一些|最近|这两天|视频|内容|值得|看看|关于|那种|可以|什么|怎么|如何|是不是|吗|呢|吧|的|了|和|与|或者|不要|别|不看)/g;

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function numFrom(text) {
	const t = String(text || "");
	if (/^\d+$/.test(t)) return Number(t);
	return CN_NUM[t] || 0;
}

/** 无 LLM 时的兜底：从中文请求里抽 2-4 个可直接站内搜索的词。 */
export function extractKeywords(intent, { knownTopics = [] } = {}) {
	const text = String(intent || "");
	const found = [];
	const push = (x) => {
		let v = String(x || "").trim();
		v = v.replace(/^[找看想要学求做用玩讲说聊读买搜给帮]+/, "").replace(/[的了吗呢吧啊呀]+$/, "");
		if ([...v].length < 2 || [...v].length > 24) return;
		if (!found.includes(v)) found.push(v);
	};
	for (const m of text.matchAll(/[「《"“]([^」》"”]{2,24})[」》"”]/g)) push(m[1]);
	for (const m of text.matchAll(/[a-zA-Z][a-zA-Z0-9+#._-]{1,20}/g)) push(m[0]);
	for (const t of knownTopics) if (text.includes(t)) push(t);

	const cleaned = text.replace(/[，。！？、；：,.!?;:（）()【】\[\]]/g, " ").replace(STOP, " ");
	for (const chunk of cleaned.split(/\s+/)) {
		if (!chunk) continue;
		const parts = chunk.split(/[和与或及]/).filter(Boolean);
		for (const p of parts) {
			const run = (p.match(/[\u4e00-\u9fff]+/g) || []).join("");
			if (!run) continue;
			if (run.length <= 10) push(run);
			else {
				// 长句：取开头 6 字 + 结尾 4 字，作为两个检索词
				push(run.slice(0, 6));
				push(run.slice(-4));
			}
		}
	}
	return found.slice(0, 4);
}

/** 规则版计划（也是 LLM 计划的合并底座）。 */
export function heuristicPlan(intent, { settings = {}, profile = null } = {}) {
	const text = String(intent || "");
	const knownTopics = (profile?.positives || []).map((t) => t.topic);
	const keywords = String(settings.keywords || "DeepSeek,大模型,AI智能体,开源项目")
		.split(/[,，\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
	const negatives = String(settings.excludeKeywords || "短剧,八卦,引流")
		.split(/[,，\n]/)
		.map((s) => s.trim())
		.filter(Boolean);

	const topics = extractKeywords(text, { knownTopics });
	const plan = {
		topics: topics.length ? topics : keywords.slice(0, 2),
		mustAny: [],
		mustAll: [],
		mustNot: negatives.slice(),
		durationMin: 0,
		durationMax: 0,
		recencyDays: 0,
		discovery: true,
		depth: "brief",
		maxEvidence: Math.max(1, Math.min(8, Math.floor(Number(settings.askMaxEvidence) || 4))),
		maxCandidates: 30,
		sort: String(settings.defaultOrder || "totalrank"),
	};

	const dur = /(\d{1,3}|[一二两三四五六七八九十]{1,3})\s*(?:分钟|min)/i.exec(text);
	if (dur) {
		const n = numFrom(dur[1]) || 10;
		plan.durationMax = n * 60 + 180;
		plan.durationMin = Math.max(0, n * 60 - 240);
	}
	if (/短|睡前|通勤|碎片|十分钟|5分钟|五分钟/.test(text)) {
		plan.durationMax = plan.durationMax || 900;
	}
	if (/系统|深入|长|完整|从零|源码级|精读/.test(text)) {
		plan.durationMin = Math.max(plan.durationMin, 600);
		plan.depth = "deep";
	}
	if (/最新|本周|这周|最近|这两天|刚出|新出/.test(text)) plan.recencyDays = 7;
	else if (/这个月|近期/.test(text)) plan.recencyDays = 30;

	const notPart = /(?:不要|不看|别推|排除|不想看)([^。！？；\n]+)/.exec(text);
	if (notPart) {
		for (const w of notPart[1].split(/[、,，和与或]/)) {
			const v = w.trim();
			if ([...v].length >= 2 && [...v].length <= 20) plan.mustNot.push(v);
		}
	}
	const mustPart = /(?:必须|一定要|只要|只看)([^。！？；\n]+)/.exec(text);
	if (mustPart) {
		for (const w of mustPart[1].split(/[、,，和与或]/)) {
			const v = w.trim();
			if ([...v].length >= 2 && [...v].length <= 20) plan.mustAll.push(v);
		}
	}
	if (plan.recencyDays) plan.sort = "pubdate";
	return plan;
}

function sanitizePlan(raw, base) {
	const p = { ...base };
	if (!raw || typeof raw !== "object") return base;
	if (Array.isArray(raw.topics)) {
		const t = raw.topics
			.map((x) => String(x || "").trim())
			.filter((x) => [...x].length >= 2 && [...x].length <= 40)
			.slice(0, 4);
		if (t.length) p.topics = t;
	}
	for (const k of ["mustAny", "mustAll", "mustNot"]) {
		if (Array.isArray(raw[k])) {
			const list = raw[k]
				.map((x) => String(x || "").trim())
				.filter((x) => [...x].length >= 1 && [...x].length <= 30)
				.slice(0, 6);
			p[k] = [...new Set([...(base[k] || []), ...list])];
		}
	}
	const num = (v, lo, hi, dflt) => {
		const n = Number(v);
		return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
	};
	p.durationMin = num(raw.durationMin, 0, 4 * 3600, base.durationMin);
	p.durationMax = num(raw.durationMax, 0, 4 * 3600, base.durationMax);
	if (p.durationMax && p.durationMin > p.durationMax) [p.durationMin, p.durationMax] = [0, p.durationMax];
	p.recencyDays = num(raw.recencyDays, 0, 3650, base.recencyDays);
	p.maxEvidence = num(raw.maxEvidence, 1, 8, base.maxEvidence);
	p.maxCandidates = num(raw.maxCandidates, 5, 60, base.maxCandidates);
	p.discovery = raw.discovery === false ? false : base.discovery;
	p.depth = raw.depth === "deep" ? "deep" : base.depth;
	if (["totalrank", "pubdate", "click", "dm"].includes(raw.sort)) p.sort = raw.sort;
	return p;
}

export class AskEngine {
	constructor({ store, api, host, taste, index, settings = {}, readVideoContent = null, log = () => {} } = {}) {
		this.store = store;
		this.api = api;
		this.host = host;
		this.taste = taste;
		this.index = index;
		this.settings = settings;
		this.readVideoContent = readVideoContent;
		this.log = log;
	}

	get #cfg() {
		try {
			return { ...this.settings() };
		} catch {
			return {};
		}
	}

	/** LLM 编译计划；失败或没模型就退回规则版。 */
	async compile(intent, { profile = null, signal = undefined } = {}) {
		const base = heuristicPlan(intent, { settings: this.#cfg, profile });
		const llm = this.host?.llm;
		if (!llm?.complete) return { plan: base, via: "rules" };
		try {
			const known = (profile?.positives || []).slice(0, 12).map((t) => t.topic);
			const r = await llm.complete({
				system: [
					"你把用户对 B 站视频的一句请求，编译成站内检索计划。只输出纯 JSON，不要解释、不要代码块。",
					'字段：{"topics":["2-4个可直接站内搜索的关键词"],"mustAll":[],"mustNot":[],"durationMin":0,"durationMax":0,"recencyDays":0,"discovery":true,"depth":"brief|deep","maxEvidence":4,"sort":"totalrank|pubdate|click"}',
					"topics 必须是可以直接搜的词（不要整句、不要语气词）。duration 单位秒。recencyDays=0 表示不限时间。",
					"用户没有明确要求时 maxEvidence 用 4、discovery 用 true、depth 用 brief。",
				].join("\n"),
				prompt: JSON.stringify({ request: intent, known_interest_topics: known }),
				maxChars: 600,
				timeoutMs: 20000,
				signal,
			});
			if (r?.ok && r.text) {
				const m = /\{[\s\S]*\}/.exec(r.text);
				if (m) return { plan: sanitizePlan(JSON.parse(m[0]), base), via: "llm" };
			}
		} catch (err) {
			this.log("warn", `意图编译失败，用规则版：${err.message}`);
		}
		return { plan: base, via: "rules" };
	}

	#prefilter(cand, plan, seenSet) {
		if (!cand?.bvid) return "invalid";
		if (seenSet.has(cand.bvid)) return "seen";
		const text = `${cand.title || ""} ${cand.description ?? cand.desc ?? ""}`;
		for (const bad of plan.mustNot || []) if (bad && text.includes(bad)) return `mustNot:${bad}`;
		const dur = parseDurationSec(cand.durationSec ?? cand.duration ?? 0);
		if (dur && plan.durationMin && dur < plan.durationMin) return "too_short";
		if (dur && plan.durationMax && dur > plan.durationMax) return "too_long";
		if (plan.recencyDays && Number(cand.pubdate)) {
			const age = (Date.now() / 1000 - Number(cand.pubdate)) / 86400;
			if (age > plan.recencyDays) return "too_old";
		}
		return "";
	}

	/**
	 * 多源召回。每个源单独 try/catch，单个源失败不影响整体。
	 * @returns {Promise<{candidates:Array, stats:Object}>}
	 */
	async retrieve(plan, { emit = () => {}, seen = null, signal = undefined, profile = null } = {}) {
		const seenSet = seen instanceof Set ? seen : this.store.seenBvids();
		const map = new Map();
		const stats = { sources: {}, filtered: {}, scanned: 0 };
		const add = (arr, source) => {
			let n = 0;
			for (const item of arr || []) {
				if (!item?.bvid) continue;
				const why = this.#prefilter(item, plan, seenSet);
				if (why) {
					stats.filtered[why] = (stats.filtered[why] || 0) + 1;
					continue;
				}
				const cur = map.get(item.bvid);
				if (cur) {
					if (!cur.sources.includes(source)) cur.sources.push(source);
					continue;
				}
				map.set(item.bvid, { ...item, sources: [source], source });
				n += 1;
			}
			stats.sources[source] = (stats.sources[source] || 0) + n;
			stats.scanned += (arr || []).length;
			return n;
		};

		const topics = (plan.topics || []).slice(0, 3);
		for (const kw of topics) {
			signal?.throwIfAborted?.();
			emit({ step: "search", message: `🔍 检索「${kw}」…` });
			const variants = [kw];
			// 长词搜不到时用首/尾 6 字再试一次，避免一句长短语把结果卡成 0
			if ([...kw].length > 7) {
				variants.push([...kw].slice(0, 6).join(""), [...kw].slice(-6).join(""));
			}
			for (const v of variants) {
				try {
					const list = await this.api.searchVideos(v, { page: 1, pageSize: 10, order: plan.sort });
					const n = add(list, `search:${v}`);
					emit({ step: "search_result", message: `  └─ 「${v}」${list.length} 条，新候选 ${n} 条` });
					if (n > 0) break;
				} catch (err) {
					emit({ step: "search_err", message: `  └─ 检索「${v}」失败：${err.message}` });
				}
			}
		}

		if (plan.discovery && map.size < 14) {
			emit({ step: "popular", message: "🔥 候选偏少，补一轮热门/排行…" });
			try {
				const pop = await this.api.getPopularVideos({ pn: 1, ps: 20 });
				emit({ step: "popular_result", message: `  └─ 热门补充 ${add(pop, "popular")} 条新候选` });
			} catch {}
			try {
				const rank = await this.api.getRankVideos({ rid: 0, type: "all" });
				add(rank, "rank");
			} catch {}
		}

		// 顺藤摸瓜：拿当前候选里质量最高的两条去摸关联，扩大同好圈
		if (map.size && plan.discovery) {
			const seeds = [...map.values()].sort((a, b) => Number(b.play || 0) - Number(a.play || 0)).slice(0, 2);
			for (const seed of seeds) {
				signal?.throwIfAborted?.();
				try {
					const rel = await this.api.getRelatedVideos(seed.bvid);
					const n = add(rel, `related:${seed.bvid}`);
					if (n) emit({ step: "roam_expand", message: `  └─ 由 [${seed.bvid}] 漫游引入 ${n} 条` });
				} catch {}
			}
		}

		// 可信 UP 的新作
		const trusted = profile ? [...profile.mids.entries()].filter(([, v]) => v.weight > 0.4).slice(0, 2) : [];
		for (const [mid] of trusted) {
			signal?.throwIfAborted?.();
			try {
				const ups = await this.api.getUpVideos(Number(mid), 6);
				const n = add(ups, `up:${mid}`);
				if (n) emit({ step: "up_feed", message: `  └─ 关注的 UP(${mid}) 新作 ${n} 条` });
			} catch {}
		}

		const candidates = [...map.values()];
		return { candidates, stats, seenSet };
	}

	/** 取证：先查索引（便宜），必要时才跑完整内容流水线（贵）。 */
	async evidence(bvid, { meta = null, plan, signal = undefined } = {}) {
		const cfg = this.#cfg;
		let ing = { ok: false, source: "disabled", limitations: [] };
		if (cfg.indexEnabled !== false) {
			ing = await this.index.ingest(bvid, { meta, signal });
		}
		const limits = [...(ing.limitations || [])];
		if (ing.ok) {
			const quotes = this.index.quote(bvid, (plan.topics || []).join(" "), { limit: 2 });
			return {
				ok: true,
				source: ing.source,
				chars: ing.text.length,
				cached: ing.cached,
				text: ing.text,
				quotes,
				limitations: limits,
			};
		}
		if (plan.depth === "deep" && this.readVideoContent) {
			try {
				const r = await this.readVideoContent(bvid, { signal });
				if (r?.ok && r.fullText) {
					const n = this.index.putPlainText ? this.index.putPlainText(bvid, r.fullText, { kind: "asr", meta }) : 0;
					limits.push("audio_transcript_no_timestamps");
					return {
						ok: true,
						source: r.source,
						chars: r.fullText.length,
						cached: false,
						text: r.fullText,
						quotes: [],
						limitations: [...limits, ...(r.limitations || [])],
						untimed: !n,
					};
				}
			} catch (err) {
				limits.push(`deep_evidence_failed:${err.message}`);
			}
		}
		return { ok: false, source: "none", chars: 0, text: "", quotes: [], limitations: limits };
	}

	/**
	 * 完整问答。
	 * @param {string} intent 自然语言请求
	 * @param {{emit?:Function, signal?:AbortSignal, maxEvidence?:number, seen?:Set}} opts
	 */
	async run(intent, { emit = () => {}, signal = undefined, maxEvidence = 0, seen = null } = {}) {
		const t0 = Date.now();
		const profile = this.taste.profile();
		const { plan, via } = await this.compile(intent, { profile, signal });
		if (maxEvidence) plan.maxEvidence = Math.max(1, Math.min(8, Math.floor(maxEvidence)));
		emit({
			step: "plan",
			message: `🧭 计划（${via === "llm" ? "模型编译" : "规则编译"}）：主题 ${plan.topics.join(" / ") || "无"}${plan.recencyDays ? `，${plan.recencyDays} 天内` : ""}${plan.maxEvidence ? `，最多取证 ${plan.maxEvidence} 条` : ""}`,
		});

		// 用户主动问过的话题，记一条弱正反馈（0.2，45 天衰减）
		this.taste.learnTopics(plan.topics, { weight: 0.2, origin: "ask" });

		const { candidates, stats, seenSet } = await this.retrieve(plan, { emit, seen, signal, profile });
		if (!candidates.length) {
			emit({ step: "abstain", message: "🫗 没有可核验的候选，按规则弃权，不硬凑。" });
			const res = {
				ok: true,
				askId: "",
				intent,
				plan,
				via,
				abstained: true,
				reason: "检索后没有任何未看过的候选（可能都被判重或被排除词过滤掉了）",
				items: [],
				nearMiss: [],
				budget: { candidates: 0, filtered: stats.filtered, evidence: 0, elapsedMs: Date.now() - t0 },
			};
			return res;
		}

		const known = this.store.knownTexts({ days: 45, limit: 120 }).map((k) => ({ ...k, tokens: tokens(k.text) }));
		const ranked = this.taste.rank(candidates, profile, {
			limit: Math.min(candidates.length, plan.maxEvidence * 3 + 4),
			maxPerTopic: Math.max(1, Math.min(3, Math.floor(Number(this.#cfg.diversityPerTopic) || 2))),
			known,
			plan,
		});
		emit({
			step: "score",
			message: `📊 ${candidates.length} 条候选 → 去重/多样性后 ${ranked.length} 条进入取证（${stats.filtered ? `已过滤 ${JSON.stringify(stats.filtered)}` : "无过滤"}）`,
		});

		const items = [];
		let evidenceUsed = 0;
		let degraded = false;
		const deadline = t0 + Math.max(15000, Number(this.#cfg.askTimeoutMs) || 90000);
		for (const cand of ranked) {
			if (items.length >= plan.maxEvidence) break;
			signal?.throwIfAborted?.();
			if (Date.now() > deadline) {
				degraded = true;
				emit({ step: "degraded", message: "⏱ 取证时间到上限，后面的候选只比元数据，结果标 degraded。" });
				break;
			}
			evidenceUsed += 1;
			const ev = await this.evidence(cand.bvid, { meta: cand, plan, signal });
			if (!ev.ok) {
				emit({ step: "no_evidence", message: `  └─ [${cand.bvid}] 取不到可核验正文，跳过` });
				continue;
			}
			const evText = ev.text;
			const missing = (plan.mustAll || []).filter((w) => w && !evText.includes(w));
			if (missing.length) {
				emit({ step: "must_miss", message: `  └─ [${cand.bvid}] 缺少必须词 ${missing.join("/")}，跳过` });
				continue;
			}
			const evidenceBoost = Math.min(1, evText.length / 4000);
			const score = 0.78 * cand.score + 0.22 * evidenceBoost;
			items.push({
				bvid: cand.bvid,
				title: cand.title,
				author: cand.author,
				mid: cand.mid ?? cand.owner?.mid ?? 0,
				duration: cand.duration,
				durationSec: parseDurationSec(cand.duration ?? cand.durationSec ?? 0),
				play: cand.play,
				pubdate: cand.pubdate || null,
				url: cand.url || `https://www.bilibili.com/video/${cand.bvid}`,
				score: Number(score.toFixed(3)),
				parts: cand.parts,
				topic: cand.topic,
				sources: cand.sources,
				reasons: cand.reasons,
				quotes: (ev.quotes || []).map((q) => ({ ...q, url: deepLink(cand.bvid, q.t) })),
				evidence: {
					ok: true,
					source: ev.source,
					chars: ev.chars,
					cached: ev.cached,
					untimed: Boolean(ev.untimed),
					limitations: ev.limitations,
				},
				_at: Date.now(),
			});
			emit({
				step: "picked",
				message: `  └─ ✅ [${cand.bvid}] 分 ${score.toFixed(2)}｜${cand.reasons?.[0] || "无明确理由"}`,
			});
		}

		items.sort((a, b) => b.score - a.score);

		// 内容级去重：同一件事被多条讲时，只留代表条目，其他折叠成 duplicates
		let finalItems = items;
		try {
			if (items.length > 1 && this.index) {
				const groups = this.index.cluster(items, { threshold: 0.55 });
				const keep = new Map(groups.map((g) => [g.representative.bvid, g.others]));
				finalItems = items
					.filter((i) => keep.has(i.bvid))
					.map((i) => ({
						...i,
						duplicates: (keep.get(i.bvid) || []).map((o) => ({ bvid: o.bvid, title: o.title, similarity: o._sim })),
					}));
				const folded = finalItems.reduce((n, i) => n + (i.duplicates?.length || 0), 0);
				if (folded) emit({ step: "cluster", message: `🧩 ${folded} 条与已选内容高度重合，已折叠到代表条目` });
			}
		} catch {}

		const best = finalItems[0]?.score ?? -1;
		const abstained = !finalItems.length || best < 0.12;
		const res = {
			ok: true,
			askId: "",
			intent,
			plan,
			via,
			abstained,
			reason: abstained
				? finalItems.length
					? `最优候选分只有 ${best.toFixed(2)}，低于弃权阈值 0.12`
					: ranked.length
						? "进入取证链的候选都取不到可核验正文（无字幕/转写失败）"
						: `召回 ${candidates.length} 条，全部被过滤（判重 / 排除词 / 时长 / 时间窗）`
				: "",
			items: abstained ? [] : finalItems,
			nearMiss: abstained
				? ranked.slice(0, 3).map((c) => ({
						bvid: c.bvid,
						title: c.title,
						score: Number(c.score.toFixed(3)),
						reason: c.reasons?.[0] || "",
						duration: c.duration,
					}))
				: finalItems.slice(1, 4).map((c) => ({ bvid: c.bvid, title: c.title, score: c.score })),
			budget: {
				candidates: candidates.length,
				scored: ranked.length,
				evidence: evidenceUsed,
				filtered: stats.filtered,
				elapsedMs: Date.now() - t0,
				degraded,
			},
			coverage: {
				note: "只对通过预筛的候选取证；未取证的不代表差，只代表没花预算。",
				seenAt: dayKey(),
			},
		};
		const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		res.askId = id;
		try {
			this.store.saveAsk({
				id,
				intent,
				plan,
				shortlist: res.items.length ? res.items : res.nearMiss,
				answer: res.reason || "",
			});
		} catch {}
		return res;
	}

	/** 深读：把某条候选按时间轴展开成章节 + 引用。 */
	async deepen({ askId = "", index: nth = 1, bvid = "", signal = undefined } = {}) {
		let item = null;
		let ask = null;
		if (bvid) {
			item = { bvid };
		} else {
			ask = askId ? this.store.getAsk(askId) : this.store.latestAsk();
			const list = ask?.shortlist || [];
			item = list[Math.max(0, Math.min(list.length - 1, Math.floor(nth) - 1))] || null;
		}
		if (!item?.bvid) return { ok: false, error: "没有可深读的对象；先 bili_ask，或直接给 bvid" };
		const ing = await this.index.ingest(item.bvid, { signal });
		const segs = this.store.segmentsFor(item.bvid);
		if (!segs.length) {
			return {
				ok: false,
				bvid: item.bvid,
				error: "这条视频没有可用的字幕/ASR 索引",
				hint: "可以先用 bili_video_content 取完整证据，或打开原片",
				url: item.url || `https://www.bilibili.com/video/${item.bvid}`,
			};
		}
		const chapters = [];
		let bucket = null;
		for (const s of segs) {
			const t = Number.isFinite(s.t0) ? s.t0 : null;
			if (t === null) continue;
			const start = Math.floor(t / 120) * 120;
			if (!bucket || bucket.t0 !== start) {
				bucket = { t0: start, at: fmtSeconds(start), lines: [], url: deepLink(item.bvid, start) };
				chapters.push(bucket);
			}
			bucket.lines.push(s.text);
		}
		const outline = chapters.map((c) => ({
			at: c.at,
			t: c.t0,
			url: c.url,
			head: c.lines[0].slice(0, 60),
			chars: c.lines.join("").length,
		}));
		const picks = [];
		const step = Math.max(1, Math.floor(segs.length / 8));
		for (let i = 0; i < segs.length && picks.length < 8; i += step) {
			const s = segs[i];
			if (!Number.isFinite(s.t0)) continue;
			picks.push({ at: fmtSeconds(s.t0), t: s.t0, text: s.text, url: deepLink(item.bvid, s.t0) });
		}
		return {
			ok: true,
			bvid: item.bvid,
			title: item.title || this.store.getVideo(item.bvid)?.title || "",
			askId: ask?.id || askId || "",
			source: ing.source,
			untimed: segs.every((s) => !Number.isFinite(s.t0)),
			chars: segs.reduce((n, s) => n + s.text.length, 0),
			outline,
			quotes: picks,
			limits: ["章节按 2 分钟切分，只覆盖已索引的第一 P 正文。", "引用是原字幕/ASR 的逐段摘录，未做二次改写。"],
		};
	}
}
