import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readVideoContent } from "../lib/video-content.mjs";

const BVID = "BV1pn411f7Hb";

function apiWithSubtitle() {
	let calls = 0;
	return {
		calls: () => calls,
		getVideoSubtitle: async () => {
			calls += 1;
			return {
				ok: true,
				source: "subtitle_track",
				hasSubtitle: true,
				fullText: "[00:01] 大家好，今天讲 MoE 推理。\n[03:30] 280B 总参、28B 激活。".repeat(3),
				segmentsCount: 6,
			};
		},
	};
}

test("快路径：有字幕轨就返回，不进入媒体抽帧", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bili-vc-"));
	const api = apiWithSubtitle();
	const started = Date.now();
	try {
		const r = await readVideoContent({ api, host: {}, storageDir: dir, bvid: BVID, subtitleOnly: true });
		assert.equal(r.ok, true);
		assert.equal(r.source, "subtitle_track");
		assert.ok(r.fullText.includes("280B 总参"));
		assert.equal(api.calls(), 1);
		// 没有 python 环境时，若误入媒体流水线会抛错/长时间等待
		assert.ok(Date.now() - started < 3000, "快路径必须在秒级返回");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("快路径：没字幕轨时明确说明跳过媒体提取，而不是假装有内容", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bili-vc-"));
	try {
		const r = await readVideoContent({
			api: { getVideoSubtitle: async () => ({ ok: false }) },
			host: {},
			storageDir: dir,
			bvid: BVID,
			subtitleOnly: true,
		});
		assert.equal(r.ok, false);
		assert.equal(r.fullText, "");
		assert.ok(r.limitations.some((l) => String(l).includes("subtitle_only_mode")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("非法 bvid 直接拒绝，不发起任何取字幕请求", async () => {
	const api = apiWithSubtitle();
	const r = await readVideoContent({ api, host: {}, storageDir: tmpdir(), bvid: "BVbad", subtitleOnly: true });
	assert.equal(r.ok, false);
	assert.equal(api.calls(), 0);
});
