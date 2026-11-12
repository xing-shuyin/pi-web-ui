import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BiliDutyEngine } from "../duty.mjs";
import { AskEngine, extractKeywords, heuristicPlan } from "../lib/ask.mjs";
import { DeliverySystem, parseReply } from "../lib/delivery.mjs";
import { chunkLines, ContentIndex, parseTimestamped } from "../lib/indexer.mjs";
import { BiliStore } from "../lib/store.mjs";
import { TasteEngine } from "../lib/taste.mjs";

const BV = {
	a: "BV1xx411c7mD",
	b: "BV1yy411c7mE",
	c: "BV1zz411c7mF",
	d: "BV1ww411c7mG",
};

const SUBTITLES = {
	[BV.a]: [
		"[00:12] 今天我们讲大模型智能体开发的完整流程",
		"[00:40] 先做工具调用，再讲状态机和重试策略",
		"[01:30] 这里有一个坑：上下文超了会静默截断",
		"[02:10] 最后给出可以跑的代码和仓库地址",
	].join("\n"),
	[BV.b]: [
		"[00:05] 大模型智能体开发实战，从零写一个插件",
		"[00:50] 插件注册工具、权限和路由都在这里",
		"[01:20] 注意不要在主进程里阻塞事件循环",
	].join("\n"),
	[BV.c]: ["[00:03] 十分钟讲清楚状态机", "[00:30] 重试要指数退避，别直接 sleep"].join("\n"),
};

function fakeApi({ list = [], subtitles = SUBTITLES, sendFail = false } = {}) {
	const api = {
		sent: [],
		comments: [],
		searches: [],
		async searchVideos(kw, { order = "totalrank" } = {}) {
			api.searches.push({ kw, order });
			return list.filter((v) => `${v.title} ${v.description || ""}`.includes(kw) || kw === "*");
		},
		async getPopularVideos() {
			return [];
		},
		async getRankVideos() {
			return [];
		},
		async getRelatedVideos() {
			return [];
		},
		async getUpVideos() {
			return [];
		},
		async getVideoInfo(bvid) {
			const v = list.find((x) => x.bvid === bvid);
			return {
				bvid,
				aid: 1,
				title: v?.title || bvid,
				desc: v?.description || "",
				duration: 600,
				pubdate: Math.floor(Date.now() / 1000) - 3600,
				owner: { mid: v?.mid || 9, name: v?.author || "UP" },
			};
		},
		async getVideoSubtitle(bvid) {
			const text = subtitles[bvid];
			if (!text)
				return { ok: true, bvid, hasSubtitle: false, source: "description_fallback", fullText: "【视频简介】无字幕" };
			return {
				ok: true,
				bvid,
				hasSubtitle: true,
				source: "subtitle_track",
				language: "中文",
				timestampedText: text,
				fullText: text.replace(/\[\d{1,3}:\d{2}\]\s*/g, "").replace(/\n/g, " "),
			};
		},
		async sendMessage(uid, text) {
			if (sendFail) throw new Error("dm blocked");
			api.sent.push({ uid, text });
			return { ok: true };
		},
		async replyVideo(bvid, text) {
			api.comments.push({ bvid, text });
			return { rpid: 987654321 };
		},
	};
	return api;
}

function fakeHost({ llm = null } = {}) {
	return {
		dataDir: "",
		llm,
		broadcast() {},
		log() {},
	};
}

function verdictHost() {
	return fakeHost({
		llm: {
			complete: async () => ({
				ok: true,
				text: JSON.stringify({
					tier: "值得看",
					whyWorth: "讲了工具调用与重试策略，并给出可运行代码。",
					insights: "工具调用；状态机；重试退避。",
					comment: "这段状态机的处理挺实用。",
				}),
			}),
		},
	});
}

function tmp() {
	const dir = mkdtempSync(join(tmpdir(), "bili-intel-"));
	return {
		dir,
		clean: () => {
			try {
				rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
			} catch {}
		},
	};
}

function setup(apiOverrides = {}, hostOverrides = {}) {
	const { dir, clean } = tmp();
	const api = fakeApi(apiOverrides);
	const host = fakeHost(hostOverrides);
	const store = new BiliStore(join(dir, "db"));
	const taste = new TasteEngine({ store });
	const index = new ContentIndex({ store, api });
	const settings = { keywords: "大模型,智能体", excludeKeywords: "短剧", askMaxEvidence: 3, dmDailyLimit: 2 };
	const ask = new AskEngine({ store, api, host, taste, index, settings: () => settings });
	const delivery = new DeliverySystem({
		store,
		api,
		favOps: { addVideo: async () => ({ ok: true }) },
		taste,
		ask,
		index,
		settings: () => settings,
	});
	return {
		dir,
		clean: () => {
			try {
				store.close();
			} catch {}
			clean();
		},
		api,
		host,
		store,
		taste,
		index,
		ask,
		delivery,
		settings,
	};
}

test("字幕切片：保留时间戳并合并成可检索片段", () => {
	const lines = parseTimestamped("[00:12] 第一句\n[00:20] 第二句\n\n[01:40] 隔了很久的一句");
	assert.equal(lines.length, 3);
	assert.equal(lines[2].t, 100);
	const chunks = chunkLines(lines, { targetChars: 40, maxSpan: 30, gap: 12 });
	assert.ok(chunks.length >= 2, "应因跨度或字数切段");
	assert.equal(chunks[0].t0, 12);
	assert.ok(chunks[0].text.includes("第二句"));
});

test("状态库：seen.md 迁移、判重与投递幂等", () => {
	const { dir, clean } = tmp();
	try {
		const store = new BiliStore(join(dir, "db"));
		const seen = join(dir, "seen.md");
		writeFileSync(seen, `| 2026-01-02 10:00 | ${BV.a} | 标题 | UP | 收(值得看) |\n`, "utf8");
		assert.equal(store.importSeenMd(seen), 1);
		assert.equal(store.importSeenMd(seen), 0, "只迁移一次");
		assert.ok(store.seenBvids().has(BV.a));
		store.createDelivery({ id: "dm:1:42", kind: "dm_digest", uid: 42, text: "first" });
		store.createDelivery({ id: "dm:1:42", kind: "dm_digest", uid: 42, text: "second" });
		assert.equal(store.delivery("dm:1:42").text, "first", "同一天同一 UID 不覆盖");
		store.close();
	} finally {
		clean();
	}
});

test("内容索引：入库后可检索到秒级时间点", async () => {
	const s = setup();
	try {
		const r = await s.index.ingest(BV.a);
		assert.equal(r.ok, true);
		assert.ok(r.count >= 2);
		const again = await s.index.ingest(BV.a);
		assert.equal(again.cached, true, "第二次应命中缓存");
		const hits = s.index.search("状态机");
		assert.ok(hits.length >= 1);
		assert.match(hits[0].url, /\?t=\d+$/);
		const quotes = s.index.quote(BV.a, "状态机 重试", { limit: 2 });
		assert.ok(quotes.length >= 1);
		assert.ok(quotes.every((q) => q.url.includes("?t=")));
	} finally {
		s.clean();
	}
});

test("品味账本：正负信号改变排序，并给出可核对理由", async () => {
	const s = setup({ list: [] });
	try {
		s.taste.signal("like", { topic: "大模型", reason: "手动点赞" });
		s.taste.signal("ban", { topic: "短剧", reason: "不想看" });
		const profile = s.taste.profile();
		const good = s.taste.score(
			{ bvid: BV.a, title: "大模型智能体实战", description: "", play: 120000, duration: "12:00" },
			profile,
		);
		const bad = s.taste.score(
			{ bvid: BV.b, title: "短剧合集", description: "", play: 120000, duration: "12:00" },
			profile,
		);
		assert.ok(good.score > bad.score);
		assert.ok(good.reasons.some((r) => r.includes("大模型")));
		assert.ok(bad.reasons.some((r) => r.includes("短剧")));
		const ranked = s.taste.rank(
			[
				{ bvid: BV.b, title: "短剧合集", play: 1000 },
				{ bvid: BV.a, title: "大模型智能体实战", play: 1000 },
			],
			profile,
			{ limit: 2, minScore: -1 },
		);
		assert.equal(ranked[0].bvid, BV.a);
	} finally {
		s.clean();
	}
});

test("意图编译：无模型时也能从中文请求抽出检索词与约束", () => {
	const kws = extractKeywords("帮我找点十分钟内能上手的大模型智能体教程，不要纯概念");
	assert.ok(kws.length >= 1);
	const plan = heuristicPlan("找点十分钟内能上手的大模型智能体教程，不要纯概念", { settings: { keywords: "大模型" } });
	assert.ok(plan.topics.length >= 1);
	assert.ok(plan.durationMax > 0, "应识别十分钟");
	assert.ok(plan.mustNot.includes("纯概念"), "应识别排除词");
});

test("询问：多源召回 → 取证 → 带引用的结果；没货时弃权", async () => {
	const s = setup({
		list: [
			{
				bvid: BV.a,
				title: "大模型智能体开发实战",
				description: "工具调用与状态机",
				play: 50000,
				duration: "12:00",
				mid: 9,
			},
			{
				bvid: BV.b,
				title: "大模型智能体插件从零写",
				description: "插件注册与路由",
				play: 80000,
				duration: "15:00",
				mid: 9,
			},
			{ bvid: BV.c, title: "十分钟讲清楚状态机", description: "重试与退避", play: 20000, duration: "10:00", mid: 8 },
		],
	});
	try {
		const r = await s.ask.run("找大模型智能体开发的实战教程");
		assert.equal(r.ok, true);
		assert.equal(r.abstained, false, JSON.stringify(r.nearMiss));
		assert.ok(r.items.length >= 1);
		assert.ok(r.items[0].quotes.length >= 1);
		assert.ok(r.items[0].evidence.chars > 0);
		assert.ok(r.plan.topics.length >= 1);
		assert.ok(s.store.getAsk(r.askId), "ask 应落库");

		const empty = await s.ask.run("找一个完全不存在的主题 zzzz");
		assert.equal(empty.ok, true);
		assert.equal(empty.abstained, true);
		assert.ok(empty.nearMiss || empty.reason);
	} finally {
		s.clean();
	}
});

test("深读：章节与 8 条引用，全部带时间戳", async () => {
	const s = setup({
		list: [{ bvid: BV.a, title: "大模型智能体开发实战", play: 1000, duration: "12:00" }],
	});
	try {
		const r = await s.ask.run("大模型智能体教程");
		const d = await s.ask.deepen({ askId: r.askId, index: 1 });
		assert.equal(d.ok, true);
		assert.ok(d.quotes.length >= 1);
		assert.ok(d.outline.length >= 1);
		assert.ok(d.quotes.every((q) => q.url.includes("?t=")));
	} finally {
		s.clean();
	}
});

test("回执语法：只认短指令，正常聊天不误判", () => {
	assert.equal(parseReply("1").action, "deep");
	assert.equal(parseReply("2").ordinal, 2);
	assert.equal(parseReply("x").action, "ban");
	assert.equal(parseReply("？").action, "why");
	assert.equal(parseReply("f").action, "fav");
	assert.equal(parseReply("n").action, "mute");
	assert.equal(parseReply("0").action, "ignore");
	assert.equal(parseReply("这个视频讲得挺好的，能再展开讲讲第三部分吗")?.action, undefined);
	assert.equal(parseReply("这个视频讲得挺好的，能再展开讲讲第三部分吗"), null);
});

test("投递：一天一条、预算封顶、回执驱动偏好与收藏", async () => {
	const s = setup({
		list: [
			{ bvid: BV.a, title: "大模型智能体开发实战", play: 1000, duration: "12:00", mid: 9 },
			{ bvid: BV.b, title: "大模型智能体插件从零写", play: 1000, duration: "12:00", mid: 9 },
		],
	});
	try {
		s.settings.dmDailyLimit = 1;
		const items = [{ bvid: BV.a, title: "大模型智能体开发实战", topic: "大模型", mid: 9 }];
		const first = await s.delivery.sendDigest({ uid: 42, items, text: "今天刷到这几条" });
		assert.equal(first.ok, true);
		assert.equal(s.api.sent.length, 1);
		assert.ok(s.api.sent[0].text.includes("回 1/2 深读"), "应带回调菜单");
		const dup = await s.delivery.sendDigest({ uid: 42, items, text: "重复" });
		assert.equal(dup.duplicate, true);
		assert.equal(s.api.sent.length, 1);

		const handled = await s.delivery.handleIncoming({ uid: 42, messages: [{ fromMe: false, text: "1" }] });
		assert.equal(handled.handled, true);
		assert.ok(s.api.sent.length >= 2, "深读应回一条带引用的消息");
		assert.ok(s.store.recentSignals().some((x) => x.kind === "deep"));

		const fav = await s.delivery.handleIncoming({ uid: 42, messages: [{ fromMe: false, text: "f" }] });
		assert.equal(fav.action, "fav");
		assert.ok(s.store.recentSignals().some((x) => x.kind === "fav"));

		const chat = await s.delivery.handleIncoming({ uid: 42, messages: [{ fromMe: false, text: "你好呀，在吗" }] });
		assert.equal(chat.handled, false, "普通聊天交给原自动回复");
	} finally {
		s.clean();
	}
});

test("巡检全链路：索引取证 → 品味排序 → 报告带定位 → 产物落库", async () => {
	const { dir, clean } = tmp();
	try {
		const api = fakeApi({
			list: [
				{
					bvid: BV.a,
					title: "大模型智能体开发实战",
					description: "工具调用与状态机",
					play: 50000,
					duration: "12:00",
					mid: 9,
					pubdate: Math.floor(Date.now() / 1000) - 3600,
				},
				{
					bvid: BV.b,
					title: "大模型智能体插件从零写",
					description: "插件注册",
					play: 80000,
					duration: "15:00",
					mid: 9,
					pubdate: Math.floor(Date.now() / 1000) - 3600,
				},
			],
		});
		const store = new BiliStore(join(dir, "db"));
		const taste = new TasteEngine({ store });
		const index = new ContentIndex({ store, api });
		const settings = {
			keywords: "大模型,智能体",
			excludeKeywords: "短剧",
			dmMode: "off",
			perDay: 5,
			indexEnabled: true,
		};
		const ask = new AskEngine({ store, api, host: verdictHost(), taste, index, settings: () => settings });
		const delivery = new DeliverySystem({ store, api, taste, ask, index, settings: () => settings });
		const duty = new BiliDutyEngine({
			storageDir: dir,
			apiClient: api,
			host: verdictHost(),
			intel: { store, taste, index, ask, delivery },
		});
		await duty.runCuration({ force: true, trigger: "test" });
		await new Promise((r) => setTimeout(r, 600));
		const d = new Date();
		const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		const report = readFileSync(join(dir, "out", `${day}.md`), "utf8");
		assert.match(report, /### BV/);
		assert.match(report, /- \*\*定位\*\*：\[\d{2}:\d{2}\]\(https:\/\/www\.bilibili\.com\/video\/BV\w+\?t=\d+\)/);
		assert.ok(store.picksSince(Date.now() - 86_400_000).length >= 1, "精选应落库");
		assert.ok(store.segmentCount(BV.a) > 0, "巡检应把字幕写进索引");
		store.close();
	} finally {
		clean();
	}
});
