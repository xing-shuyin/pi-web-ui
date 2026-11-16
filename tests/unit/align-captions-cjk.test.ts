import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// scripts/align-captions-cjk.mjs 守的是「中文字幕时间不能塌成一个点」：
// 插件版 align-captions.mjs 用 /[^a-z0-9]/ 归一化，中文被剥空后所有 token 拿到
// 第一个词的 start，还照常打印 clean、退出码 0。这里用脚本级冒烟把这层守住。

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts", "align-captions-cjk.mjs");
const node = process.execPath;
const dir = mkdtempSync(join(tmpdir(), "align-captions-cjk-test-"));

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface CaptionLine {
	id: number;
	end: number;
	w: [string, number][];
}

function run(args: string[]): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(node, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		const guard = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`align-captions-cjk 未返回：${stdout}${stderr}`));
		}, 20_000);
		child.once("error", (error) => {
			clearTimeout(guard);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(guard);
			resolve({ code, stdout, stderr });
		});
	});
}

let seq = 0;
function writeJson(name: string, value: unknown): string {
	const file = join(dir, `${seq++}-${name}`);
	writeFileSync(file, JSON.stringify(value));
	return file;
}

function readCaptions(file: string): CaptionLine[] {
	return (JSON.parse(readFileSync(file, "utf8")) as { lines: CaptionLine[] }).lines;
}

const starts = (lines: CaptionLine[]): number[] => lines.flatMap((line) => line.w.map(([, t]) => t));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("align-captions-cjk", () => {
	it("中文稿对齐繁体+错字的 ASR：时间分散且单调，行尾接下一行首词", async () => {
		// ASR 输出故意用繁体与错字（whisper base 对中文的真实形态）：字幕文字仍取 display 层。
		const tokens = writeJson("tokens-zh.json", {
			lines: [
				{ id: 0, tokens: ["这一周", "我们", "做完了", "插件", "更新"] },
				{ id: 1, tokens: ["和", "终端", "重构", "新增了", "三个", "工具"] },
			],
		});
		const words = writeJson("words-zh.json", [
			{ text: "這一", start: 0.12, end: 0.46 },
			{ text: "週", start: 0.55, end: 0.72 },
			{ text: "我們", start: 0.72, end: 1.1 },
			{ text: "做", start: 1.23, end: 1.44 },
			{ text: "完了,", start: 1.44, end: 2.26 },
			{ text: "差", start: 2.33, end: 2.46 },
			{ text: "間", start: 2.46, end: 2.59 },
			{ text: "更", start: 2.64, end: 2.81 },
			{ text: "新", start: 2.87, end: 3.0 },
			{ text: "若", start: 3.0, end: 3.6 },
			{ text: "重", start: 3.6, end: 3.75 },
			{ text: "斷", start: 3.75, end: 4.2 },
			{ text: "新增", start: 4.4, end: 5.0 },
			{ text: "了", start: 5.0, end: 5.2 },
			{ text: "三個", start: 5.2, end: 5.6 },
			{ text: "工具", start: 5.6, end: 6.1 },
		]);
		const out = join(dir, `${seq++}-captions-zh.json`);

		const result = await run(["--tokens", tokens, "--words", words, "--out", out]);
		expect(result.code, result.stderr).toBe(0);

		const lines = readCaptions(out);
		expect(lines).toHaveLength(2);
		// 字幕文字必须是我们自己的稿子，不能是 ASR 的繁体/错字。
		expect(lines[0].w.map(([word]) => word)).toEqual(["这一周", "我们", "做完了", "插件", "更新"]);
		expect(lines[1].w.map(([word]) => word)).toEqual(["和", "终端", "重构", "新增了", "三个", "工具"]);

		// 回归守卫：时间不能全塌到同一个值（插件版本正是这样静默失败的）。
		const times = starts(lines);
		expect(new Set(times).size).toBeGreaterThanOrEqual(4);
		expect(times[0]).toBeLessThan(times.at(-1) as number);
		for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);

		// 命中的锚点时间必须等于 ASR 原始 start。
		expect(lines[0].w[1][1]).toBe(0.72); // 我们 ← 我們
		expect(lines[0].w[2][1]).toBe(1.23); // 做完了 ← 做
		expect(lines[0].w[4][1]).toBe(2.64); // 更新 ← 更

		// 行尾 == 下一行首词起点。
		expect(lines[0].end).toBe(lines[1].w[0][1]);
		expect(lines[1].end).toBeGreaterThan(times.at(-1) as number);
		expect(result.stderr).toContain("matched");
	});

	it("中英混排：拉丁术语按字符对齐，覆盖率 100%", async () => {
		const tokens = writeJson("tokens-mixed.json", {
			lines: [
				{ id: 0, tokens: ["新增", "MCP", "工具", "和", "PTY", "终端"] },
				{ id: 1, tokens: ["还有", "沙盒", "工作区"] },
			],
		});
		const seqWords: [string, number][] = [
			["新增", 0.5],
			["M", 0.12],
			["C", 0.12],
			["P", 0.12],
			["工", 0.2],
			["具", 0.2],
			["和", 0.2],
			["P", 0.12],
			["T", 0.12],
			["Y", 0.12],
			["终", 0.25],
			["端", 0.25],
			["还", 0.2],
			["有", 0.2],
			["沙", 0.3],
			["盒", 0.3],
			["工", 0.2],
			["作", 0.2],
			["区", 0.25],
		];
		let t = 0.2;
		const words = writeJson(
			"words-mixed.json",
			seqWords.map(([text, span]) => {
				const entry = { text, start: Number(t.toFixed(2)), end: Number((t + span).toFixed(2)) };
				t += span;
				return entry;
			}),
		);
		const out = join(dir, `${seq++}-captions-mixed.json`);

		const result = await run(["--tokens", tokens, "--words", words, "--out", out]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).toContain("(100%)");

		const lines = readCaptions(out);
		expect(lines[0].w.map(([word]) => word)).toEqual(["新增", "MCP", "工具", "和", "PTY", "终端"]);
		expect(lines[0].w[1][1]).toBe(0.7); // MCP 的 M
		expect(lines[0].w[4][1]).toBe(1.66); // PTY 的 P
		expect(lines[0].end).toBe(lines[1].w[0][1]);
	});

	it("覆盖率低于阈值时以 3 退出，而不是悄悄交出垃圾时间", async () => {
		const tokens = writeJson("tokens-low.json", { lines: [{ id: 0, tokens: ["完全不同的稿子内容"] }] });
		const words = writeJson("words-low.json", [
			{ text: "unrelated", start: 0, end: 0.5 },
			{ text: "audio", start: 0.5, end: 1 },
		]);
		const out = join(dir, `${seq++}-captions-low.json`);

		const result = await run(["--tokens", tokens, "--words", words, "--out", out, "--min-coverage", "0.9"]);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("coverage");
	});

	it("缺参数或空 words 以 2 退出", async () => {
		const words = writeJson("words-empty.json", []);
		const result = await run(["--words", words]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--tokens required");
	});
});
