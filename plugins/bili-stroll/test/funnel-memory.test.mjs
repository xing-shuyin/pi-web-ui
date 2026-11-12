import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseViewPoints } from "../bilibili-api.mjs";
import { BiliStore } from "../lib/store.mjs";
import { composeCrowdSystem, composeImpressionSystem, composePreviewSystem, describePrompts } from "../lib/prompts.mjs";
import { BiliDutyEngine } from "../duty.mjs";

const BVID = "BV1pn411f7Hb";

function seedStore() {
	const dir = mkdtempSync(join(tmpdir(), "bili-stroll-mem-"));
	const store = new BiliStore(join(dir, "db"));
	return { dir, store };
}

// ── 官方章节解析 ─────────────────────────────────────────────

test("parseViewPoints：过滤脏数据并按 from 排序", () => {
	const out = parseViewPoints([
		{ from: 300, to: 400, content: "  手写 attention  " },
		{ from: -5, to: 1, content: "负数丢弃" },
		{ from: 0, to: 60, content: "开场" },
		{ content: "没有 from 丢弃" },
		"字符串丢弃",
		null,
	]);
	assert.deepEqual(out, [
		{ from: 0, to: 60, content: "开场" },
		{ from: 300, to: 400, content: "手写 attention" },
	]);
	assert.deepEqual(parseViewPoints(null), []);
	assert.deepEqual(parseViewPoints("nope"), []);
});

// ── 提示词单源：三段漏斗契约齐全 ─────────────────────────────

test("漏斗提示词：组装结果包含 JSON 契约与安全句", () => {
	for (const fn of [composeImpressionSystem, composePreviewSystem, composeCrowdSystem]) {
		const sys = fn({});
		assert.match(sys, /纯 JSON/, fn.name);
		assert.match(sys, /不可信/, fn.name);
	}
	const described = describePrompts({});
	for (const key of ["impression", "preview", "crowd"]) {
		assert.ok(described[key]?.default, `${key} 有默认文本`);
		assert.ok(described[key]?.fixed, `${key} 有固定追加`);
	}
});

// ── 记忆系统：手记 / 系列 / 好奇心 ────────────────────────────

test("观看手记：写入幂等，next 序列化往返", () => {
	const { dir, store } = seedStore();
	try {
		const saved = store.saveWatchNote({
			bvid: BVID,
			title: "样例",
			author: "UP",
			whyClicked: "标题里有 attention",
			whereHooked: "05:12 真跑起来了",
			whereLost: "",
			crowd: "群众叫好",
			next: ["bvid:BV1xxxx", "keyword:whisper"],
		});
		assert.equal(saved.bvid, BVID);
		assert.deepEqual(saved.next, ["bvid:BV1xxxx", "keyword:whisper"]);
		const again = store.saveWatchNote({ bvid: BVID, title: "样例2", whyClicked: "改写" });
		assert.equal(again.why_clicked, "改写");
		assert.equal(store.recentWatchNotes({ limit: 5 }).length, 1);
		assert.equal(store.saveWatchNote({ bvid: "bad" }), null);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("系列追踪：同一 UP 同一系列计数递增", () => {
	const { dir, store } = seedStore();
	try {
		const r1 = store.upsertSeries({ upKey: "123", series: "手写LLM", bvid: BVID, title: "手写LLM（一）" });
		assert.equal(r1.count, 1);
		const r2 = store.upsertSeries({ upKey: "123", series: "手写LLM", bvid: BVID, title: "手写LLM（二）" });
		assert.equal(r2.count, 2);
		assert.equal(r2.last_title, "手写LLM（二）");
		assert.equal(store.listSeries().length, 1);
		assert.equal(store.upsertSeries({ upKey: "", series: "" }), null);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("好奇心队列：去重、按分取、解决", () => {
	const { dir, store } = seedStore();
	try {
		const id1 = store.enqueueCuriosity({ sourceBvid: BVID, kind: "keyword", target: "whisper", score: 0.9 });
		const id2 = store.enqueueCuriosity({ sourceBvid: BVID, kind: "keyword", target: "whisper", score: 0.1 });
		assert.equal(id1, id2, "同 target 去重");
		assert.equal(store.enqueueCuriosity({ sourceBvid: BVID, kind: "bvid", target: "bad" }), null);
		store.enqueueCuriosity({ sourceBvid: BVID, kind: "bvid", target: "BV1ab1234cde", score: 0.2 });
		const open = store.nextCuriosities(10);
		assert.equal(open.length, 2);
		assert.equal(open[0].target, "whisper", "高分排前");
		store.resolveCuriosity(id1);
		assert.equal(store.pendingCuriosityCount(), 1);
		assert.equal(store.nextCuriosities(10).length, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stats 含记忆表计数", () => {
	const { dir, store } = seedStore();
	try {
		store.saveWatchNote({ bvid: BVID });
		store.upsertSeries({ upKey: "u", series: "s" });
		store.enqueueCuriosity({ kind: "keyword", target: "x" });
		const stats = store.stats();
		assert.equal(stats.watchNotes, 1);
		assert.equal(stats.series, 1);
		assert.equal(stats.curiosity, 1);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extractSeries：标题启发式", () => {
	const dir = mkdtempSync(join(tmpdir(), "bili-stroll-duty-"));
	try {
		const engine = new BiliDutyEngine({ storageDir: dir, apiClient: {}, host: { broadcast() {}, log() {} } });
		assert.equal(engine.extractSeries("【手写LLM】从零实现 attention"), "手写LLM");
		assert.equal(engine.extractSeries("手写LLM 第3集 推理优化"), "手写LLM");
		assert.equal(engine.extractSeries("纯随手拍的一个视频"), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
