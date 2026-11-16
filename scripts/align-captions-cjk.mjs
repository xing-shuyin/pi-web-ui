#!/usr/bin/env node
// align-captions-cjk：把口播稿的 display token 对齐到 ASR 词级时间戳（中文/中英混排安全）。
//
//   node scripts/align-captions-cjk.mjs --tokens script-tokens.json --words transcript.json \
//        --out captions.json [--tail 0.6] [--min-coverage 0.35]
//
// 治的是什么：插件市场里的 align-captions.mjs 用 /[^a-z0-9]/ 归一化，中文会被整段剥空，
// 于是每个 token 的 spoken 形式为空、时间全部塌到第一个词的 start，而脚本仍打印 "clean"、
// 退出码 0 —— 字幕挤在 0 秒且没有任何告警。这里保留 \p{L}\p{N}，做字符级单调 DP 对齐，
// 再用线性插值跨过 ASR 的错字/繁体差异：时间只取 ASR，字幕文字始终用稿子的 display 层。
//
// 入参：
//   tokens: { lines: [ { id, tokens: [ "词" | { display, spoken } ] } ] }
//   words:  [ { text, start, end } ]  或  { words: [ ... ] }
// 产出：
//   { lines: [ { id, end, w: [ [display, start], ... ] } ] }  ← 直接喂字幕轨的 LINES 数组
//
// 退出码：0 正常（允许告警）/ 2 入参有问题 / 3 覆盖率低于 --min-coverage

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = argv.indexOf("--" + name);
	return i >= 0 ? argv[i + 1] : fallback;
};
const die = (msg) => {
	console.error("align-captions-cjk:", msg);
	process.exit(2);
};

const tokensFile = flag("tokens", null) ?? die("--tokens required");
const wordsFile = flag("words", null) ?? die("--words required");
const outFile = flag("out", "captions.json");
const tail = Number(flag("tail", "0.6"));
const minCoverage = Number(flag("min-coverage", "0.35"));

const script = JSON.parse(readFileSync(tokensFile, "utf8"));
const parsedWords = JSON.parse(readFileSync(wordsFile, "utf8"));
const stream = Array.isArray(parsedWords) ? parsedWords : (parsedWords.words ?? []);

if (!script?.lines?.length) die("tokens file has no lines[]");
if (!stream.length) die("words file has no words[] / is empty");

// 保留任意书写系统的字母与数字：中文、日文、拉丁、数字都不丢。
const norm = (s) =>
	String(s ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");

// ---- 听到的一侧：每个字符带插值后的时间 ----
const heard = [];
for (const w of stream) {
	const chars = [...norm(w.text)];
	if (!chars.length) continue;
	const start = Number(w.start) || 0;
	const end = Number.isFinite(Number(w.end)) ? Number(w.end) : start;
	const span = Math.max(end - start, 0);
	chars.forEach((ch, i) => heard.push({ ch, t: start + (span * i) / chars.length }));
}
if (!heard.length) die("words file normalizes to no characters");

// ---- 稿子的一侧：每个字符记住它属于哪个 token ----
const target = [];
const tokenStart = []; // 扁平 token 序号 -> 它在 target 里的首字符下标
let tokenCount = 0;
for (const line of script.lines) {
	for (const tok of line.tokens) {
		const spoken = typeof tok === "string" ? tok : (tok.spoken ?? tok.display);
		tokenStart[tokenCount] = target.length;
		const chars = [...norm(spoken)];
		for (const ch of chars) target.push({ ch, token: tokenCount });
		// 纯标点 token 归一化后为空，但仍要占一个锚点，否则 tokenStart 会错位。
		if (!chars.length) target.push({ ch: "", token: tokenCount, empty: true });
		tokenCount++;
	}
}
if (!target.length) die("tokens normalize to no characters");

// ---- 单调对齐（编辑距离 DP，回溯时只把字符相等的位置当作锚点）----
const n = target.length;
const m = heard.length;
const MATCH = 2;
const MISMATCH = -1;
const GAP = -1;

// dir：0 = 对角（匹配/失配），1 = 上（跳过稿子字符），2 = 左（跳过听到的字符）
let dir = null;
if (n * m <= 4_000_000) {
	dir = new Uint8Array((n + 1) * (m + 1));
	let prev = new Int32Array(m + 1);
	for (let j = 0; j <= m; j++) prev[j] = j * GAP;
	for (let i = 1; i <= n; i++) {
		const cur = new Int32Array(m + 1);
		cur[0] = i * GAP;
		dir[i * (m + 1)] = 1;
		for (let j = 1; j <= m; j++) {
			const same = target[i - 1].ch && target[i - 1].ch === heard[j - 1].ch;
			const diag = prev[j - 1] + (same ? MATCH : MISMATCH);
			const up = prev[j] + GAP;
			const left = cur[j - 1] + GAP;
			let best = diag;
			let d = 0;
			if (up > best) {
				best = up;
				d = 1;
			}
			if (left > best) {
				best = left;
				d = 2;
			}
			cur[j] = best;
			dir[i * (m + 1) + j] = d;
		}
		prev = cur;
	}
}

const times = new Array(n).fill(null);
if (dir) {
	let i = n;
	let j = m;
	for (;;) {
		if (i === 0 && j === 0) break;
		const d = dir[i * (m + 1) + j];
		if (i > 0 && j > 0 && d === 0) {
			if (target[i - 1].ch && target[i - 1].ch === heard[j - 1].ch) times[i - 1] = heard[j - 1].t;
			i--;
			j--;
		} else if (i > 0 && (d === 1 || j === 0)) {
			i--;
		} else {
			j--;
		}
	}
} else {
	// 超长稿子：小窗口贪心单调走位，顺序保证不变，精度略降。
	let i = 0;
	let j = 0;
	const LOOK = 4;
	while (i < n && j < m) {
		if (target[i].ch && target[i].ch === heard[j].ch) {
			times[i] = heard[j].t;
			i++;
			j++;
			continue;
		}
		let skipTarget = -1;
		let skipHeard = -1;
		for (let d = 1; d <= LOOK; d++) {
			if (skipHeard < 0 && j + d < m && target[i].ch === heard[j + d].ch) skipHeard = d;
			if (skipTarget < 0 && i + d < n && target[i + d].ch === heard[j].ch) skipTarget = d;
		}
		if (skipHeard > 0 && (skipTarget < 0 || skipHeard <= skipTarget)) j += skipHeard;
		else if (skipTarget > 0) i += skipTarget;
		else {
			i++;
			j++;
		}
	}
}

let matched = 0;
for (const t of times) if (t !== null) matched++;
const coverage = matched / n;

// ---- 补洞：锚点之间线性插值，首尾按平均字时长外推 ----
const known = [];
for (let i = 0; i < n; i++) if (times[i] !== null) known.push(i);
if (!known.length) {
	const first = heard[0].t;
	const last = heard[heard.length - 1].t;
	const step = n > 1 ? (last - first) / (n - 1) : 0;
	for (let i = 0; i < n; i++) times[i] = first + step * i;
} else {
	for (let i = 0; i < known[0]; i++) times[i] = times[known[0]];
	for (let k = 0; k < known.length - 1; k++) {
		const a = known[k];
		const b = known[k + 1];
		const ta = times[a];
		const tb = times[b];
		for (let i = a + 1; i < b; i++) times[i] = ta + ((tb - ta) * (i - a)) / (b - a);
	}
	const lastKnown = known[known.length - 1];
	const perChar = Math.max((heard[heard.length - 1].t - heard[0].t) / Math.max(m - 1, 1), 0.05);
	for (let i = lastKnown + 1; i < n; i++) times[i] = times[lastKnown] + perChar * (i - lastKnown);
}

// ---- 出字幕行 ----
const round = (x) => Math.round(x * 100) / 100;
const audioEnd = heard[heard.length - 1].t;
const out = { lines: [] };
let flat = 0;
for (let li = 0; li < script.lines.length; li++) {
	const line = script.lines[li];
	const w = [];
	const starts = [];
	for (const tok of line.tokens) {
		const display = typeof tok === "string" ? tok : tok.display;
		const at = tokenStart[flat++] ?? n - 1;
		const t = times[Math.min(at, n - 1)] ?? 0;
		starts.push(t);
		w.push([display, round(t)]);
	}
	const isLast = li === script.lines.length - 1;
	const firstOfNext = isLast ? audioEnd + tail : (times[tokenStart[flat] ?? n - 1] ?? audioEnd + tail);
	const end = Math.max(isLast ? audioEnd + tail : firstOfNext, starts.at(-1) ?? 0);
	out.lines.push({ id: line.id ?? li, w, end: round(end) });
}

// 单调性自检：字幕开始时间必须全程不倒退，否则字幕轨会叠字。
let monotonic = true;
let prevT = -Infinity;
for (const line of out.lines) {
	for (const [, t] of line.w) {
		if (t < prevT - 1e-6) monotonic = false;
		prevT = t;
	}
}

writeFileSync(outFile, JSON.stringify(out, null, 1));

const pct = (coverage * 100).toFixed(0);
console.error(`align-captions-cjk: ${n} display chars ↔ ${m} heard chars, matched ${matched} (${pct}%) → ${outFile}`);
if (!monotonic) console.error("align-captions-cjk: WARNING 时间非单调，检查 token 顺序是否与口播一致");
if (coverage < minCoverage) {
	console.error(
		`align-captions-cjk: coverage ${pct}% < ${(minCoverage * 100).toFixed(0)}% —— 时间基本靠插值。换更大的 ASR 模型（hyperframes transcribe -m small|medium），或确认 --words 与这份稿子是同一段口播。`,
	);
	process.exit(3);
}
if (coverage < 0.7) {
	console.error(`align-captions-cjk: note coverage ${pct}% —— 缺口用锚点插值补的，字幕可用，建议抽 2-3 行复核。`);
}
