/**
 * 投递协议：把"发出去就完事"变成有状态、可回执的消息。
 *
 * 状态机：drafted → sent → acked → acted / expired；失败保留记录，状态不明不重发。
 * 回执语法（私信里回一个字符就够）：
 *   1/2/3 深读第 n 条 · 2 收藏 · x 静音这个 UP · n 别再推这个主题 · ? 为什么推我
 * 打扰预算：每天私信类投递有上限，超了就静默，不再问"要不要继续"。
 *
 * 边界：回执只改本插件的偏好账本与收藏夹，不执行任何外部命令；解析不了就当普通私信交给原流程。
 */
import { dayKey } from "./store.mjs?v=2.4.0";

const REPLY_FOOTER = "\n\n回 1/2 深读 · f 收藏 · x 静音 · ? 为什么";

const CODE_MAP = [
	{ re: /^(?:x|X)$/, action: "ban" },
	{ re: /^(?:n|N)$/, action: "mute" },
	{ re: /^(?:\?|？)$/, action: "why" },
	{ re: /^(?:0|忽略|不用|算了)$/, action: "ignore" },
	{ re: /^(?:f|F|收藏|存起来)$/, action: "fav" },
];

const WORD_MAP = [
	{ words: ["静音", "拉黑", "别推这个up", "别推这个UP", "屏蔽"], action: "ban" },
	{ words: ["别再推", "不感兴趣", "换话题", "别推这个主题"], action: "mute" },
	{ words: ["为什么", "为啥", "理由"], action: "why" },
	{ words: ["收藏", "存起来"], action: "fav" },
	{ words: ["深读", "细看", "展开", "详细"], action: "deep", ordinal: 1 },
	{ words: ["忽略", "不用了", "算了"], action: "ignore" },
];

/**
 * 解析回执。只在"短消息"上生效，正常聊天不会被误判。
 * @returns {{action:string, ordinal:number, raw:string}|null}
 */
export function parseReply(text) {
	const raw = String(text || "").trim();
	if (!raw) return null;
	const t = String(raw)
		.replace(/^[。.,，!！\s]+/, "")
		.replace(/[。.,，!！\s]+$/, "")
		.trim();
	// 纯数字回执：1/2/3 = 深读第 n 条。长消息不当回执，避免误判。
	const ord = /^([1-9])(?:\s|$|[.、])/.exec(t);
	if (ord && t.length <= 8) {
		const n = Number(ord[1]);
		return { action: "deep", ordinal: n, raw };
	}
	for (const c of CODE_MAP) if (c.re.test(t)) return { action: c.action, ordinal: c.ordinal || 1, raw };
	if (t.length <= 12) {
		for (const w of WORD_MAP) {
			if (w.words.some((x) => t.includes(x))) return { action: w.action, ordinal: w.ordinal || 1, raw };
		}
	}
	return null;
}

export class DeliverySystem {
	constructor({
		store,
		api,
		favOps = null,
		taste = null,
		ask = null,
		index = null,
		settings = () => ({}),
		log = () => {},
	}) {
		this.store = store;
		this.api = api;
		this.favOps = favOps;
		this.taste = taste;
		this.ask = ask;
		this.index = index;
		this.settings = settings;
		this.log = log;
	}

	#cfg() {
		try {
			return this.settings() || {};
		} catch {
			return {};
		}
	}

	/** 私信正文尾部加一行回执菜单（可关）。 */
	decorate(text) {
		const body = String(text || "").trim();
		if (this.#cfg().replyGrammar === false) return body;
		if (body.includes("回 1 深读")) return body;
		const room = 480 - REPLY_FOOTER.length;
		return `${body.slice(0, room)}${REPLY_FOOTER}`;
	}

	/** 今天已经发了几条私信类消息。 */
	usedToday() {
		try {
			return this.store.deliveriesForDay(dayKey()).filter((d) => d.kind.startsWith("dm") && d.state !== "failed")
				.length;
		} catch {
			return 0;
		}
	}

	budget() {
		const limit = Math.max(1, Math.min(50, Math.floor(Number(this.#cfg().dmDailyLimit) || 6)));
		const used = this.usedToday();
		return { limit, used, remaining: Math.max(0, limit - used), allowed: used < limit };
	}

	/**
	 * 发一条精选私信（一天一条，重复调用不会重复发）。
	 * @param {{uid:number, items:Array, text:string}} opts
	 */
	async sendDigest({ uid, items = [], text = "" }) {
		const target = Number(uid) || 0;
		if (!target) return { ok: false, skipped: "no_uid" };
		if (!items.length) return { ok: false, skipped: "no_items" };
		const day = dayKey();
		const id = `dm:${day}:${target}`;
		const existing = this.store.delivery(id);
		if (existing?.state === "sent") return { ok: true, duplicate: true, id };
		const b = this.budget();
		if (!b.allowed && existing?.state !== "drafted") return { ok: false, skipped: "budget", budget: b };

		const body = this.decorate(text);
		this.store.createDelivery({
			id,
			kind: "dm_digest",
			bvid: "",
			uid: target,
			text: body,
			meta: { items: items.map((x) => ({ bvid: x.bvid, title: x.title, topic: x.topic || "", mid: x.mid || 0 })) },
		});
		try {
			const r = await this.api.sendMessage(target, body.slice(0, 500));
			this.store.updateDelivery(id, { state: "sent", error: null });
			return { ok: true, id, sent: true, budget: this.budget(), result: r };
		} catch (err) {
			const prev = this.store.delivery(id);
			this.store.updateDelivery(id, {
				state: "failed",
				error: String(err?.message || err).slice(0, 200),
				attempts: (prev?.attempts || 0) + 1,
			});
			return { ok: false, id, error: String(err?.message || err), state: "failed" };
		}
	}

	/** 发一条公开评论；同一天同一个视频不会重复发。 */
	async sendComment({ bvid, text }) {
		if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid || ""))) return { ok: false, skipped: "bad_bvid" };
		const body = String(text || "").trim();
		if (!body) return { ok: false, skipped: "empty" };
		const day = dayKey();
		const id = `c:${day}:${bvid}`;
		const existing = this.store.delivery(id);
		if (existing?.state === "sent") return { ok: true, duplicate: true, id, rpid: existing.rpid };
		if (existing?.state === "failed" && (existing.attempts || 0) >= 2)
			return { ok: false, skipped: "too_many_attempts", id };

		this.store.createDelivery({ id, kind: "comment", bvid, uid: 0, text: body });
		try {
			const r = await this.api.replyVideo(bvid, body);
			if (!r?.rpid) throw new Error("评论接口没有返回 rpid");
			this.store.updateDelivery(id, { state: "sent", rpid: Number(r.rpid), error: null });
			return { ok: true, id, rpid: Number(r.rpid) };
		} catch (err) {
			const prev = this.store.delivery(id);
			this.store.updateDelivery(id, {
				state: "failed",
				error: String(err?.message || err).slice(0, 200),
				attempts: (prev?.attempts || 0) + 1,
			});
			return { ok: false, id, error: String(err?.message || err) };
		}
	}

	#itemFromDelivery(delivery, ordinal) {
		const items = delivery?.meta?.items || [];
		if (!items.length) return null;
		const idx = Math.max(0, Math.min(items.length - 1, (Number(ordinal) || 1) - 1));
		return items[idx];
	}

	/** 为什么推这条：只用当时落库的理由，不现编。 */
	explain(item) {
		const pick = this.store.picksSince(Date.now() - 7 * 86_400_000, { limit: 200 }).find((p) => p.bvid === item?.bvid);
		const reasons = [];
		if (pick?.why) reasons.push(pick.why);
		if (this.taste && item?.bvid) {
			const profile = this.taste.profile();
			const meta = this.store.getVideo(item.bvid);
			if (meta) {
				const s = this.taste.score({ ...meta, description: meta.description || "" }, profile, { known: [] });
				reasons.push(...s.reasons.slice(0, 2));
			}
		}
		return reasons.length ? reasons.slice(0, 3) : ["当时按质量与新鲜度排序，没有更强的个性化信号"];
	}

	/**
	 * 处理一条新私信回执。返回 handled=true 时，调用方不要再走 LLM 自动回复。
	 * @returns {Promise<{handled:boolean, action?:string, reply?:string}>}
	 */
	async handleIncoming({ uid, messages = [] } = {}) {
		const inbound = (messages || []).filter((m) => !m.fromMe && typeof m.text === "string");
		if (!inbound.length) return { handled: false };
		const last = inbound.at(-1);
		const parsed = parseReply(last.text);
		if (!parsed) return { handled: false };
		const delivery = this.store.lastDeliveryTo(uid);
		if (!delivery) return { handled: false };
		const item = this.#itemFromDelivery(delivery, parsed.ordinal);
		if (!item?.bvid) return { handled: false };

		const cfg = this.#cfg();
		const meta = this.store.getVideo(item.bvid);
		const mid = Number(item.mid || meta?.mid || 0);
		const topic = item.topic || "";
		let reply = "";

		switch (parsed.action) {
			case "deep": {
				if (this.ask && this.index) {
					const d = await this.ask.deepen({ bvid: item.bvid });
					if (d.ok) {
						const lines = (d.quotes || []).slice(0, 4).map((q) => `· [${q.at}] ${q.text}\n  ${q.url}`);
						reply = `《${d.title || item.title}》深读线索：\n${lines.join("\n")}`;
					} else reply = `这条暂时取不到正文索引（${d.error}）。原片：https://www.bilibili.com/video/${item.bvid}`;
				}
				this.taste?.signal("deep", { bvid: item.bvid, topic, mid, reason: "私信回 1 深读", origin: "dm" });
				this.store.updateDelivery(delivery.id, { state: "acted" });
				break;
			}
			case "fav": {
				const fid = Number(cfg.favFolderId) || 0;
				if (fid > 0 && this.favOps) {
					const r = await this.favOps.addVideo(item.bvid, fid);
					reply = r?.ok ? "已放进收藏夹。" : `收藏失败：${r?.error || "未知错误"}`;
				} else {
					reply = "还没设置收藏夹（设置 → 偏好），先在网页收一下也行。";
				}
				this.taste?.signal("fav", { bvid: item.bvid, topic, mid, reason: "私信回 2 收藏", origin: "dm" });
				this.store.updateDelivery(delivery.id, { state: "acted" });
				break;
			}
			case "ban": {
				if (topic) this.taste?.signal("ban", { topic, reason: "私信回 x 静音主题", origin: "dm" });
				if (mid) this.taste?.signal("ban", { mid, reason: "私信回 x 静音 UP", origin: "dm" });
				reply = "好，这个 UP 和这个话题都降权了，后面少推。";
				this.store.updateDelivery(delivery.id, { state: "acted" });
				break;
			}
			case "mute": {
				if (topic) this.taste?.signal("ban", { topic, reason: "私信回 n 别推该主题", origin: "dm" });
				reply = topic ? `好，「${topic}」先不推了。` : "好，这个话题先不推了。";
				this.store.updateDelivery(delivery.id, { state: "acted" });
				break;
			}
			case "why": {
				const why = this.explain(item);
				reply = `推这条的原因：\n${why.map((x) => `· ${x}`).join("\n")}`;
				break;
			}
			case "ignore": {
				if (topic) this.taste?.signal("ignore", { topic, reason: "私信回 0 忽略", origin: "dm" });
				this.store.updateDelivery(delivery.id, { state: "acted" });
				return { handled: true, action: parsed.action, silent: true };
			}
			default:
				return { handled: false };
		}

		try {
			if (reply) await this.api.sendMessage(Number(uid), reply.slice(0, 480));
		} catch (err) {
			this.log("warn", `回执反馈发送失败：${err.message}`);
		}
		return { handled: true, action: parsed.action, reply };
	}

	status() {
		const rows = this.store.deliveriesForDay(dayKey());
		return {
			budget: this.budget(),
			today: rows.slice(0, 20).map((d) => ({
				id: d.id,
				kind: d.kind,
				bvid: d.bvid,
				state: d.state,
				rpid: d.rpid,
				at: new Date(d.created_at).toLocaleTimeString("zh-CN", { hour12: false }),
			})),
			grammar: ["1/2 深读", "f 收藏", "x 静音UP", "n 别推主题", "? 为什么", "0 忽略"],
		};
	}
}
