import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BiliDutyEngine } from "../duty.mjs";
import { composeSummarySystem, describePrompts } from "../lib/prompts.mjs";

const DAY = "2026-11-12";
const BVID = "BV1pn411f7Hb";

const SAMPLE_MD = [
	"## 一句话结论",
	"",
	"ERNIE 5.5 Flash Preview 把 280B 总参 / 28B 激活的 MoE 推到百万字上下文，主打长文档一次读完。",
	"",
	"## 值得看的要点",
	"",
	"- 总参 280B、激活 28B，对标 DPCV4.1 的多项基准成绩 [03:30]",
	"- 100 万 token 上下文窗口，官方演示用整本 PDF 做检索问答 [07:12]",
	"",
	"## 局限与存疑",
	"",
	"- 基准对比未给出口径，无法判断是否同条件。",
].join("\n");

function makeEngine({ llm } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "bili-summary-"));
	const calls = [];
	const defaultLlm = {
		complete: async (payload) => {
			calls.push(payload);
			return { ok: true, text: `\`\`\`markdown\n${SAMPLE_MD}\n\`\`\``, model: "test-model" };
		},
	};
	const host = {
		llm: llm === undefined ? defaultLlm : llm,
		broadcast() {},
		log() {},
	};
	const engine = new BiliDutyEngine({ storageDir: dir, apiClient: {}, host });
	return { engine, dir, calls };
}

test("总结文档：一次写成并落盘，围栏被剥掉、元信息可读回", async () => {
	const { engine, dir } = makeEngine();
	try {
		const r = await engine.generateSummary(
			{
				bvid: BVID,
				title: "ERNIE 5.5 Flash Preview",
				author: "infinite灵感港",
				duration: "03:41",
				subText: "[00:01] 大家好，欢迎收看今天的 AI 日报。".repeat(20),
				evidenceSource: "subtitle_track",
				limitations: ["只含字幕正文"],
			},
			{ day: DAY },
		);
		assert.equal(r.ok, true);
		assert.ok(!r.text.includes("```"), "代码围栏必须被剥掉");
		assert.ok(r.text.includes("## 一句话结论"));
		assert.equal(r.meta.model, "test-model");
		const file = join(dir, "summaries", `${BVID}-${DAY}.md`);
		assert.ok(existsSync(file), "总结应落到 summaries/<bvid>-<day>.md");
		const cached = engine.readSummary(BVID, DAY);
		assert.equal(cached.text.trim(), r.text.trim());
		assert.equal(cached.meta.bvid, BVID);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("总结文档：已有文件时不重复调用模型，force 才重写", async () => {
	const { engine, dir, calls } = makeEngine();
	try {
		const item = { bvid: BVID, title: "t", subText: "字幕内容".repeat(30) };
		await engine.generateSummary(item, { day: DAY });
		assert.equal(calls.length, 1);
		const reused = await engine.generateSummary(item, { day: DAY });
		assert.equal(calls.length, 1, "默认复用缓存，不再烧模型");
		assert.equal(reused.cached, true);
		await engine.generateSummary(item, { day: DAY, force: true });
		assert.equal(calls.length, 2, "force 必须重新生成");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("总结文档：没字幕正文 / 没模型接口时明确失败，不假装成功", async () => {
	const { engine, dir } = makeEngine();
	const noLlm = makeEngine({ llm: null });
	try {
		const short = await engine.generateSummary({ bvid: BVID, subText: "太短" }, { day: DAY });
		assert.equal(short.ok, false);
		assert.match(short.error, /字幕|转写/);
		assert.equal(existsSync(join(dir, "summaries", `${BVID}-${DAY}.md`)), false);
		const bare = await noLlm.engine.generateSummary(
			{ bvid: BVID, subText: "正常长度的字幕正文".repeat(10) },
			{ day: DAY },
		);
		assert.equal(bare.ok, false);
		assert.match(bare.error, /模型/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(noLlm.dir, { recursive: true, force: true });
	}
});

test("总结文档：批量生成遇到失败只跳过，不影响其他条目", async () => {
	let n = 0;
	const { engine, dir } = makeEngine({
		llm: {
			complete: async () => {
				n += 1;
				if (n === 1) return { ok: false, error: "模型超时" };
				return { ok: true, text: SAMPLE_MD, model: "test-model" };
			},
		},
	});
	try {
		const done = await engine.generateSummaries(
			[
				{ bvid: "BV1pn411f7Hb", subText: "第一段字幕".repeat(20) },
				{ bvid: "BV1pn411f7Hc", subText: "第二段字幕".repeat(20) },
			],
			{},
		);
		assert.equal(done, 1);
		assert.ok(existsSync(join(dir, "summaries", `BV1pn411f7Hc-${new Date().toISOString().slice(0, 10)}.md`)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("总结提示词：固定小节与安全条款由代码追加，改不掉", () => {
	const sys = composeSummarySystem({ override: "用户自己写的默认文本" });
	assert.ok(sys.includes("用户自己写的默认文本"));
	assert.ok(sys.includes("## 一句话结论"));
	assert.ok(sys.includes("## 值得看的要点"));
	assert.ok(sys.includes("不可信外部内容"));
	const described = describePrompts({ summaryPrompt: "改过的" });
	assert.equal(described.summary.override, "改过的");
	assert.ok(described.summary.fixed.includes("## 局限与存疑"));
});
