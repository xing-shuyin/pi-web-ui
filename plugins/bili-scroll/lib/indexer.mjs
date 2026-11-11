/**
 * 内容索引：把"每次现读字幕"换成"读一次、切片、入库、之后检索"。
 *
 * 关键点：
 * - 只索引真正的正文证据（字幕轨 / ASR）；简介和 B 站 AI 总结单独存，默认不参与检索，
 *   免得被当成"看过视频"。
 * - 切片保留时间戳，报告和回答可以给到 ?t=754 这种秒级深链。
 * - 检索优先 FTS5(trigram)，不可用时 store 内部退回 LIKE。
 * - 同一 bvid 的 ingest 做并发合流，避免巡检和聊天同时抓同一条。
 */
import { jaccard, tokens } from "./taste.mjs?v=2.4.0";

const MAX_TEXT = 40_000;

/** 解析 `[mm:ss] 正文`（分钟可以超过 59，B 站字幕就是这样）。 */
export function parseTimestamped(text) {
	const out = [];
	const re = /^\[(\d{1,3}):(\d{2})\]\s*(.+)$/;
	for (const raw of String(text || "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const m = re.exec(line);
		if (!m) continue;
		const t = Number(m[1]) * 60 + Number(m[2]);
		const body = m[3].replace(/\s+/g, " ").trim();
		if (!body) continue;
		out.push({ t, text: body });
	}
	return out;
}

/** 把细碎字幕行合并成 ~20-45s、≤220 字的检索片段。 */
export function chunkLines(lines, { targetChars = 180, maxSpan = 45, gap = 12 } = {}) {
	const out = [];
	let cur = null;
	const flush = () => {
		if (!cur) return;
		const text = cur.parts.join(" ").replace(/\s+/g, " ").trim();
		if (text) out.push({ t0: cur.t0, t1: cur.t1 + 3, text: text.slice(0, 600) });
		cur = null;
	};
	for (const { t, text } of lines) {
		if (!cur) {
			cur = { t0: t, t1: t, parts: [text], len: text.length };
			continue;
		}
		const tooLong = cur.len + text.length > targetChars * 1.35;
		const tooWide = t - cur.t0 > maxSpan;
		const hole = t - cur.t1 > gap;
		if (tooLong || tooWide || hole) {
			flush();
			cur = { t0: t, t1: t, parts: [text], len: text.length };
			continue;
		}
		cur.parts.push(text);
		cur.t1 = t;
		cur.len += text.length;
	}
	flush();
	return out;
}

export function deepLink(bvid, t) {
	const base = `https://www.bilibili.com/video/${bvid}`;
	const sec = Number(t);
	return Number.isFinite(sec) && sec > 0 ? `${base}?t=${Math.floor(sec)}` : base;
}

function fmtT(t) {
	if (!Number.isFinite(Number(t))) return "";
	const n = Math.max(0, Math.floor(Number(t)));
	const m = Math.floor(n / 60);
	const s = n % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export class ContentIndex {
	constructor({ store, api, log = () => {} } = {}) {
		this.store = store;
		this.api = api;
		this.log = log;
		this.inflight = new Map();
	}

	/**
	 * 建索引（幂等）。已有片段且 force=false 直接返回缓存。
	 * @returns {Promise<{ok:boolean,bvid:string,count:number,source:string,cached:boolean,text:string,limitations:string[]}>}
	 */
	async ingest(bvid, { meta = null, force = false, signal = undefined } = {}) {
		const id = String(bvid);
		if (!/^BV[0-9A-Za-z]{10}$/.test(id)) {
			return {
				ok: false,
				bvid: id,
				count: 0,
				source: "invalid",
				cached: false,
				text: "",
				limitations: ["invalid_bvid"],
			};
		}
		if (!force) {
			const n = this.store.segmentCount(id);
			if (n > 0) return this.#cached(id, n);
		}
		if (this.inflight.has(id)) return this.inflight.get(id);

		const job = this.#ingestOnce(id, meta, signal).finally(() => this.inflight.delete(id));
		this.inflight.set(id, job);
		return job;
	}

	#cached(bvid, count) {
		const segs = this.store.segmentsFor(bvid);
		const text = segs
			.map((s) => (Number.isFinite(s.t0) ? `[${fmtT(s.t0)}] ${s.text}` : s.text))
			.join("\n")
			.slice(0, MAX_TEXT);
		return {
			ok: segs.length > 0,
			bvid,
			count,
			source: segs[0]?.kind || "subtitle",
			cached: true,
			text,
			limitations: [],
		};
	}

	async #ingestOnce(bvid, meta, signal) {
		let info = meta || null;
		if (!info?.title) {
			try {
				info = await this.api.getVideoInfo(bvid);
			} catch {}
		}
		let sub = null;
		try {
			sub = await this.api.getVideoSubtitle(bvid);
		} catch (err) {
			this.log("warn", `索引 ${bvid} 取字幕失败：${err.message}`);
		}
		signal?.throwIfAborted?.();

		const limitations = [];
		let segments = [];
		let source = "none";
		if (sub?.timestampedText) {
			segments = chunkLines(parseTimestamped(sub.timestampedText)).map((s) => ({ ...s, kind: "subtitle" }));
			source = "subtitle_track";
		} else if (sub?.source === "ai_conclusion" || sub?.source === "description_fallback") {
			// 只留作"检索提示"，不当作内容证据
			limitations.push("no_subtitle_track");
			const hint = String(sub.fullText || "").slice(0, 4000);
			if (hint) {
				segments = [{ text: hint, kind: sub.source === "ai_conclusion" ? "ai_conclusion" : "description", untimed: 1 }];
			}
		}
		if (sub && sub.source !== "subtitle_track") limitations.push("仅简介/总结，不能作为实际内容证据");

		if (info?.bvid || info?.title) {
			this.store.upsertVideo({
				...info,
				bvid,
				author: info.author || info.owner?.name,
				mid: info.mid || info.owner?.mid,
				pubdate: info.pubdate,
				description: info.description ?? info.desc,
			});
		}
		if (segments.length) this.store.replaceSegments(bvid, segments, { lang: sub?.language || null });

		const evidence = segments.filter((s) => s.kind === "subtitle");
		const text = evidence
			.map((s) => (Number.isFinite(s.t0) ? `[${fmtT(s.t0)}] ${s.text}` : s.text))
			.join("\n")
			.slice(0, MAX_TEXT);
		return {
			ok: evidence.length > 0,
			bvid,
			count: evidence.length,
			source,
			cached: false,
			text,
			limitations,
			chars: text.length,
			durationSec: Number(info?.duration) || null,
			title: info?.title || "",
		};
	}

	/** 直接写入外部已拿到的字幕正文（duty 的 ASR 路径复用它）。 */
	putTimedText(bvid, timestampedText, { kind = "asr", meta = null } = {}) {
		const segs = chunkLines(parseTimestamped(timestampedText)).map((s) => ({ ...s, kind }));
		if (!segs.length) return 0;
		if (meta) this.store.upsertVideo({ ...meta, bvid });
		this.store.replaceSegments(bvid, segs);
		return segs.length;
	}

	/** 写入没有时间戳的正文（本地 Whisper 转写没有 word 级时间轴）。 */
	putPlainText(bvid, text, { kind = "asr", meta = null, chunk = 500 } = {}) {
		const clean = String(text || "").trim();
		if (!clean) return 0;
		const segs = [];
		for (let i = 0; i < clean.length; i += chunk) {
			segs.push({ text: clean.slice(i, i + chunk), kind, untimed: 1 });
		}
		if (meta) this.store.upsertVideo({ ...meta, bvid });
		this.store.replaceSegments(bvid, segs);
		return segs.length;
	}

	search(query, { limit = 8, bvid = null } = {}) {
		return this.store.searchSegments(query, { limit, bvid }).map((r) => ({
			...r,
			at: fmtT(r.t0),
			url: deepLink(r.bvid, r.t0),
		}));
	}

	/**
	 * 视频里最能回答 query 的时间点（用于报告/回答里的引用）。
	 * 额外补一条片尾段落：口播视频的结论常在最后 15%。
	 */
	quote(bvid, query = "", { limit = 2 } = {}) {
		const segs = this.store.segmentsFor(bvid).filter((s) => Number.isFinite(s.t0));
		if (!segs.length) return [];
		const qt = tokens(query);
		const scored = segs.map((s, i) => {
			const sim = qt.size ? jaccard(qt, tokens(s.text)) : 0;
			const pos = i / Math.max(1, segs.length - 1);
			const bonus = pos > 0.85 ? 0.12 : pos < 0.06 ? 0.06 : 0;
			return { s, score: sim + bonus, i };
		});
		scored.sort((a, b) => b.score - a.score);
		const picked = [];
		for (const x of scored) {
			if (picked.length >= limit) break;
			if (picked.some((p) => Math.abs(p.i - x.i) < 2)) continue;
			picked.push(x);
		}
		const last = segs.at(-1);
		if (last && !picked.some((p) => p.i === segs.length - 1) && picked.length < limit + 1) {
			picked.push({ s: last, i: segs.length - 1 });
		}
		return picked
			.sort((a, b) => a.s.t0 - b.s.t0)
			.map(({ s }) => ({
				t: s.t0,
				at: fmtT(s.t0),
				text: s.text.length > 140 ? `${s.text.slice(0, 138)}…` : s.text,
				url: deepLink(bvid, s.t0),
			}));
	}

	/** 一段时间里被索引到的、和 topic 相关的视频，按发布时间倒序。 */
	timeline(topic, { days = 30, limit = 20 } = {}) {
		const since = Date.now() / 1000 - days * 86400;
		const rows = this.store.searchSegments(topic, { limit: Math.min(300, limit * 8) });
		const byBvid = new Map();
		for (const r of rows) {
			const cur = byBvid.get(r.bvid) || { bvid: r.bvid, hits: 0, firstT: r.t0, sample: r.text };
			cur.hits += 1;
			if (Number.isFinite(r.t0) && (!Number.isFinite(cur.firstT) || r.t0 < cur.firstT)) {
				cur.firstT = r.t0;
				cur.sample = r.text;
			}
			byBvid.set(r.bvid, cur);
		}
		const out = [];
		for (const v of byBvid.values()) {
			const meta = this.store.getVideo(v.bvid);
			if (!meta) continue;
			if (Number(meta.pubdate) && Number(meta.pubdate) < since) continue;
			out.push({
				bvid: v.bvid,
				title: meta.title,
				author: meta.author,
				pubdate: meta.pubdate,
				hits: v.hits,
				at: fmtT(v.firstT),
				quote: v.sample,
				url: deepLink(v.bvid, v.firstT),
			});
		}
		out.sort((a, b) => (Number(b.pubdate) || 0) - (Number(a.pubdate) || 0));
		return out.slice(0, limit);
	}

	/** 两条视频的内容相似度：优先用已索引的片段文本，否则退回标题。 */
	similarity(a, b) {
		const ta = this.#contentTokens(a);
		const tb = this.#contentTokens(b);
		return jaccard(ta, tb);
	}

	#contentTokens(item) {
		const bvid = typeof item === "string" ? item : item?.bvid;
		if (bvid) {
			const segs = this.store.segmentsFor(bvid);
			if (segs.length) {
				const sample = segs
					.slice(0, 40)
					.map((s) => s.text)
					.join(" ");
				if (sample.length > 40) return tokens(sample);
			}
		}
		const text = typeof item === "string" ? "" : `${item?.title || ""} ${item?.description || ""}`;
		return tokens(text);
	}

	/**
	 * 内容级去重：同一件事被 5 个视频讲时，指出"看哪条就够"。
	 * @returns {Array<{representative:Object, others:Object[], similarity:number}>}
	 */
	cluster(items, { threshold = 0.5 } = {}) {
		const list = (items || []).filter((x) => x?.bvid);
		const groups = [];
		for (const item of list) {
			const tk = this.#contentTokens(item);
			let best = null;
			let bestSim = 0;
			for (const g of groups) {
				const sim = jaccard(tk, g.tokens);
				if (sim > bestSim) {
					bestSim = sim;
					best = g;
				}
			}
			if (best && bestSim >= threshold) {
				best.members.push({ item, sim: bestSim });
				for (const t of tk) best.tokens.add(t);
			} else {
				groups.push({ tokens: new Set(tk), members: [{ item, sim: 1 }] });
			}
		}
		return groups
			.map((g) => {
				const sorted = g.members.slice().sort((a, b) => (b.item.score || 0) - (a.item.score || 0));
				return {
					representative: sorted[0].item,
					others: sorted.slice(1).map((m) => ({ ...m.item, _sim: Number(m.sim.toFixed(2)) })),
					similarity: Number((sorted[1]?.sim || 1).toFixed(2)),
				};
			})
			.sort((a, b) => b.others.length - a.others.length);
	}
}
