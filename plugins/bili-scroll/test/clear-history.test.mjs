import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BiliDutyEngine } from "../duty.mjs";
import { BiliStore } from "../lib/store.mjs";

const BVID = "BV1pn411f7Hb";

function seed() {
	const dir = mkdtempSync(join(tmpdir(), "bili-store-clear-"));
	const store = new BiliStore(join(dir, "db"));
	store.upsertVideo({ bvid: BVID, title: "样例", author: "UP" });
	store.markSeen({ bvid: BVID, title: "样例", status: "收(值得看)" });
	store.addPick({ bvid: BVID, tier: "值得看", why: "理由" });
	store.replaceSegments(BVID, [{ t0: 1, t1: 5, text: "片段正文", kind: "subtitle" }]);
	store.createDelivery({ id: "d1", kind: "comment", bvid: BVID, uid: 9, text: "已发评论" });
	return { dir, store };
}

test("清空历史：视频/判重/片段/挑中记录归零", () => {
	const { dir, store } = seed();
	try {
		assert.ok(store.getVideo(BVID));
		assert.equal(store.seenBvids().size, 1);
		const removed = store.clearHistory();
		assert.equal(removed.videos, 1);
		assert.equal(removed.seen, 1);
		assert.equal(removed.picks, 1);
		assert.equal(store.getVideo(BVID), null);
		assert.equal(store.seenBvids().size, 0);
		assert.equal(store.segmentsFor(BVID).length, 0);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清空历史：默认保留已发评论/私信记录，避免重复打扰", () => {
	const { dir, store } = seed();
	try {
		store.clearHistory();
		const kept = store.deliveriesForVideo(BVID);
		assert.equal(kept.length, 1);
		assert.equal(kept[0].text, "已发评论");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清空历史：keepDeliveries=false 时才连投递记录一起删", () => {
	const { dir, store } = seed();
	try {
		const removed = store.clearHistory({ keepDeliveries: false });
		assert.equal(removed.deliveries, 1);
		assert.equal(store.deliveriesForVideo(BVID).length, 0);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("清空历史（duty）：日报/笔记/总结/判重表全删，判重表立即重建", () => {
	const dir = mkdtempSync(join(tmpdir(), "bili-duty-clear-"));
	try {
		const engine = new BiliDutyEngine({
			storageDir: dir,
			apiClient: {},
			host: { broadcast() {}, log() {} },
		});
		writeFileSync(join(engine.outDir, "2026-11-12.md"), "# 日报\n", "utf8");
		writeFileSync(join(engine.reportsDir, `${BVID}-2026-11-12.md`), "# 笔记\n", "utf8");
		writeFileSync(join(engine.summaryDir, `${BVID}-2026-11-12.md`), "## 结论\n", "utf8");
		writeFileSync(join(engine.digestDir, "2026-11.md"), "月度清单\n", "utf8");
		engine.markSeenVideo(BVID, "样例", "UP", "收(值得看)");
		assert.equal(engine.getSeenBvids().size, 1);

		const removed = engine.clearHistory();
		assert.equal(removed.reports, 1);
		assert.equal(removed.notes, 1);
		assert.equal(removed.summaries, 1);
		assert.equal(removed.digest, 1);
		assert.equal(engine.getSeenBvids().size, 0, "判重表要清空");
		assert.ok(existsSync(engine.seenFile), "清完要重建带表头的判重表");
		assert.equal(engine.readSummary(BVID, "2026-11-12"), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
