/**
 * 品味账本（Taste Graph）
 *
 * 把"兴趣 = 一串关键词"换成"事件 + 衰减 + 可解释打分"：
 * - 存事件（喜欢/收藏/深读/忽略/静音），权重按半衰期衰减后聚合到 topic 和 UP。
 * - 排序不是黑盒 tier，而是可拆的四项：相关性 / 新鲜度 / 质量先验 / 新颖度。
 * - 每条推荐必须给出可核对的理由（引用具体信号、播放量、时长、重合度），不许写"符合你的兴趣"。
 *
 * 边界：只用插件真实能观测到的动作，不推测"看完了"。没有信号的候选照样能靠质量先验排，
 * 冷启动不会把候选全部判死。
 */
import { DAY_MS } from "./store.mjs?v=2.4.0";

export const SIGNAL_WEIGHTS = {
	pin: 2.0,
	fav: 1.5,
	deep: 1.2,
	like: 1.0,
	reply: 0.6,
	ask: 0.4,
	ignore: -0.6,
	ban: -2.2,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function normalizeText(s) {
	return String(s ?? "")
		.toLowerCase()
		.replace(/[\u3000\s]+/g, " ")
		.trim();
}

/** 拉丁词 + 中文 bigram；用于相似度与新颖度，不追求分词精度。 */
export function tokens(s) {
	const text = normalizeText(s);
	const set = new Set();
	for (const w of text.match(/[a-z][a-z0-9+#._-]{1,}/g) || []) set.add(w);
	for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
		if (run.length <= 6) set.add(run);
		for (let i = 0; i < run.length - 1; i++) set.add(run.slice(i, i + 2));
	}
	return set;
}

export function jaccard(a, b) {
	if (!a?.size || !b?.size) return 0;
	let inter = 0;
	const [small, big] = a.size < b.size ? [a, b] : [b, a];
	for (const x of small) if (big.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

/** 播放量可能是数字，也可能是 "12.3万" / "1.2亿"。 */
export function parseCount(v) {
	if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v);
	const s = String(v ?? "").trim();
	if (!s) return 0;
	const m = /^([\d.]+)\s*([万亿wW])?/.exec(s);
	if (!m) return 0;
	const n = Number(m[1]) || 0;
	if (m[2] === "万" || m[2] === "w" || m[2] === "W") return Math.round(n * 10_000);
	if (m[2] === "亿") return Math.round(n * 100_000_000);
	return Math.round(n);
}

/** "12:34" / "1:02:03" / 754 → 秒。 */
export function parseDurationSec(v) {
	if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(v));
	const s = String(v ?? "").trim();
	if (!s) return 0;
	if (s.includes(":")) {
		const parts = s.split(":").map((x) => Number(x) || 0);
		return parts.reduce((acc, n) => acc * 60 + n, 0);
	}
	return Number(s) || 0;
}

export function fmtSeconds(sec) {
	const t = Math.max(0, Math.round(Number(sec) || 0));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
		: `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export class TasteEngine {
	constructor({ store, now = () => Date.now(), log = () => {} } = {}) {
		this.store = store;
		this.now = now;
		this.log = log;
	}

	/** 记一条信号。weight 不给就按 kind 的默认强度。 */
	signal(kind, { topic = "", bvid = "", mid = 0, reason = "", origin = "chat", weight = null } = {}) {
		const w = Number.isFinite(weight) ? weight : (SIGNAL_WEIGHTS[kind] ?? 0);
		if (!w && kind !== "ask") return null;
		this.store.addSignal({
			kind,
			topic: topic ? String(topic).trim().toLowerCase().slice(0, 40) : null,
			bvid: /^BV[0-9A-Za-z]{10}$/.test(String(bvid)) ? bvid : null,
			mid: Number(mid) || null,
			weight: w,
			reason: String(reason || "").slice(0, 200),
			origin,
		});
		return { kind, weight: w, topic, bvid, mid };
	}

	/** 从候选里抽出最匹配的兴趣 topic；用户显式 pin 的排前面。 */
	matchTopics(text, profile) {
		const hay = normalizeText(text);
		const hits = [];
		for (const t of profile.positives) if (hay.includes(t.topic)) hits.push({ ...t, sign: 1 });
		for (const t of profile.negatives) if (hay.includes(t.topic)) hits.push({ ...t, sign: -1 });
		hits.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
		return hits;
	}

	/**
	 * 聚合兴趣画像。
	 * @returns {{positives:Array, negatives:Array, mids:Map<string,{weight:number,count:number}>, examples:Array, signalCount:number}}
	 */
	profile({ halfLifeDays = 45, sinceDays = 240 } = {}) {
		const now = this.now();
		const rows = this.store.recentSignals({ sinceMs: sinceDays * DAY_MS, limit: 5000 });
		const topics = new Map();
		const mids = new Map();
		for (const r of rows) {
			const decay = Math.exp(-(now - r.ts) / (halfLifeDays * DAY_MS));
			const w = (Number.isFinite(r.weight) ? r.weight : (SIGNAL_WEIGHTS[r.kind] ?? 0)) * decay;
			if (!w) continue;
			if (r.topic) {
				const t = topics.get(r.topic) || { topic: r.topic, weight: 0, count: 0, lastTs: 0, reasons: [] };
				t.weight += w;
				t.count += 1;
				t.lastTs = Math.max(t.lastTs, r.ts);
				if (r.reason && t.reasons.length < 3) t.reasons.push(r.reason);
				topics.set(r.topic, t);
			}
			if (r.mid) {
				const m = mids.get(String(r.mid)) || { weight: 0, count: 0 };
				m.weight += w;
				m.count += 1;
				mids.set(String(r.mid), m);
			}
		}
		const all = [...topics.values()].sort((a, b) => b.weight - a.weight);
		const examples = this.store.signaledTexts({ limit: 40 }).map((r) => ({
			bvid: r.bvid,
			title: r.title,
			tokens: tokens(r.title),
		}));
		return {
			positives: all.filter((t) => t.weight > 0.15),
			negatives: all.filter((t) => t.weight < -0.15).sort((a, b) => a.weight - b.weight),
			all,
			mids,
			examples,
			signalCount: rows.length,
		};
	}

	/** 把新出现的候选词并进兴趣图（弱信号，只在用户显式问过时记）。 */
	learnTopics(topics, { origin = "ask", weight = 0.25 } = {}) {
		for (const topic of topics || []) {
			const t = String(topic || "").trim();
			if (t.length >= 2 && t.length <= 40) this.signal("ask", { topic: t, weight, origin });
		}
	}

	/**
	 * 单条候选打分。所有分项都在 0..1（相关性可负），最终 score 可负。
	 * @returns {{score:number, parts:Object, reasons:string[], topic:string, novelty:number, duration:number, play:number}}
	 */
	score(cand, profile, { known = [], plan = null } = {}) {
		const title = String(cand.title || "");
		const desc = String(cand.description ?? cand.desc ?? "");
		const text = `${title} ${desc}`;
		const hay = normalizeText(text);
		const now = this.now();

		const hits = this.matchTopics(text, profile);
		let relRaw = 0;
		const reasons = [];
		for (const h of hits) {
			if (h.sign > 0) relRaw += Math.min(2.5, h.weight) * (0.6 + 0.4 * Math.min(1, h.count / 3));
			else relRaw += h.weight * 1.6;
		}

		// 与正反馈过的视频标题相似（没有 topic 命中时的兜底，避免冷启动全 0）
		const myTokens = tokens(text);
		let bestEx = null;
		let bestExSim = 0;
		if (!hits.length && profile.examples.length) {
			for (const ex of profile.examples) {
				const sim = jaccard(myTokens, ex.tokens);
				if (sim > bestExSim) {
					bestExSim = sim;
					bestEx = ex;
				}
			}
			if (bestExSim >= 0.22) relRaw += Math.min(0.8, bestExSim * 1.2);
		}
		const rel = clamp(Math.tanh(relRaw / 1.6), -1, 1);

		const pubdate = Number(cand.pubdate) || 0;
		const ageDays = pubdate > 0 ? Math.max(0, (now / 1000 - pubdate) / 86400) : null;
		const fresh = ageDays === null ? 0.5 : Math.exp(-ageDays / 21);

		const play = parseCount(cand.play ?? cand.stat?.view ?? 0);
		const duration = parseDurationSec(cand.durationSec ?? cand.duration ?? 0);
		const playScore = clamp(Math.log10(play + 1) / 6.8, 0, 1);
		let durScore = 0.75;
		if (duration) {
			if (duration < 90) durScore = 0.35;
			else if (duration > 7200) durScore = 0.6;
			else if (duration > 3600) durScore = 0.85;
			else durScore = 1;
		}
		const midKey = String(cand.mid ?? cand.owner?.mid ?? "");
		const up = midKey ? profile.mids.get(midKey) : null;
		const upBonus = up ? clamp(up.weight * 0.08, -0.4, 0.2) : 0;
		const qual = clamp(0.62 * playScore + 0.38 * durScore + upBonus, 0, 1);

		let novelty = 1;
		let dupOf = null;
		if (known.length) {
			let maxSim = 0;
			for (const k of known) {
				const sim = jaccard(myTokens, k.tokens || tokens(k.text || k.title || ""));
				if (sim > maxSim) {
					maxSim = sim;
					dupOf = k;
				}
			}
			novelty = clamp(1 - maxSim, 0, 1);
		}

		const score = 0.38 * rel + 0.16 * fresh + 0.24 * qual + 0.22 * novelty;

		// 解释：只留最强的几条，每条都能被核对
		for (const h of hits.slice(0, 2)) {
			const when = new Date(h.lastTs).toISOString().slice(0, 10);
			if (h.sign > 0) {
				reasons.push(`「${h.topic}」在你的兴趣账本里累计 ${h.weight.toFixed(1)}（${h.count} 条信号，最近 ${when}）`);
			} else {
				reasons.push(`「${h.topic}」被你标记过 ${Math.abs(h.count)} 次负反馈，这条命中，降权`);
			}
		}
		if (!hits.length && bestEx && bestExSim >= 0.22) {
			reasons.push(`和你正反馈过的《${bestEx.title}》标题相似度 ${(bestExSim * 100).toFixed(0)}%`);
		}
		if (up && up.weight > 0.3) reasons.push(`UP 主被你喜欢过 ${up.count} 次，可信度加分`);
		if (up && up.weight < -0.3) reasons.push(`UP 主被静音/忽略过 ${up.count} 次，扣分`);
		if (play) reasons.push(`播放 ${play.toLocaleString("zh-CN")}，时长 ${duration ? fmtSeconds(duration) : "未知"}`);
		if (ageDays !== null && ageDays <= 7) reasons.push(`发布 ${Math.max(1, Math.round(ageDays))} 天内，够新`);
		if (dupOf && novelty < 0.55) {
			reasons.push(
				`与已看过的《${dupOf.title || dupOf.bvid}》内容重合约 ${((1 - novelty) * 100).toFixed(0)}%，优先跳过`,
			);
		} else if (known.length && novelty > 0.85) {
			reasons.push("和近 45 天看过的内容重合度低");
		}

		return {
			score,
			parts: { relevance: rel, freshness: fresh, quality: qual, novelty },
			reasons,
			topic: hits[0]?.topic || "其他",
			novelty,
			duration,
			play,
		};
	}

	/**
	 * 排序 + 多样性选择：同一 topic 最多 maxPerTopic 条，标题几乎重复的直接丢掉。
	 * @returns {Array} 原候选 + score/parts/reasons/topic
	 */
	rank(candidates, profile, { limit = 10, maxPerTopic = 2, minScore = -Infinity, known = [], plan = null } = {}) {
		const scored = [];
		for (const c of candidates || []) {
			if (!c?.bvid) continue;
			const s = this.score(c, profile, { known, plan });
			if (s.score < minScore) continue;
			scored.push({ ...c, ...s });
		}
		scored.sort((a, b) => b.score - a.score);

		const out = [];
		const perTopic = new Map();
		const chosenTokens = [];
		for (const item of scored) {
			if (out.length >= limit) break;
			const t = item.topic || "其他";
			const used = perTopic.get(t) || 0;
			if (used >= maxPerTopic && t !== "其他") continue;
			const tk = tokens(`${item.title} ${item.description || ""}`);
			if (chosenTokens.some((x) => jaccard(tk, x) > 0.82)) continue;
			perTopic.set(t, used + 1);
			chosenTokens.push(tk);
			out.push(item);
		}
		return out;
	}

	/** 状态面板用：兴趣图摘要。 */
	summary({ top = 6 } = {}) {
		const p = this.profile();
		return {
			signalCount: p.signalCount,
			positive: p.positives.slice(0, top).map((t) => ({
				topic: t.topic,
				weight: Number(t.weight.toFixed(2)),
				count: t.count,
			})),
			negative: p.negatives.slice(0, top).map((t) => ({
				topic: t.topic,
				weight: Number(t.weight.toFixed(2)),
				count: t.count,
			})),
			trustedUps: [...p.mids.entries()]
				.filter(([, v]) => v.weight > 0.3)
				.sort((a, b) => b[1].weight - a[1].weight)
				.slice(0, top)
				.map(([mid, v]) => ({ mid, weight: Number(v.weight.toFixed(2)), count: v.count })),
		};
	}
}
