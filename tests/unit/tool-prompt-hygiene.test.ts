import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

it("bash guidance routes interactive input through the merged terminal tool", () => {
	const prompts = readFileSync(join(ROOT, "server/tool-prompts.ts"), "utf8");
	expect(prompts).toContain("terminal(action='input'/'key')");
	expect(prompts).not.toMatch(/terminal_(?:input|key)/);
});

const BILINGUAL_ALLOW = new Set(["i18n.ts", "dsh-client.ts", "dsh-agent-service.ts"]);

const CJK_ALLOW = new Set([
	"slash-commands.ts",
	"subagent-templates.ts",
	"subagent-templates-hant.ts",
	"plugin-api-catalog.ts",
	"tool-manager.ts",
]);

const MAIN_DESC_CAP = 600;
const MAIN_DESC_EXEMPT = new Set(["patch-tool.ts"]);
const SNIPPET_CAP = 80;
const GUIDELINE_CAP = 200;
const DUP_MIN_LEN = 40;
const DUP_JACCARD = 0.85;
const SNIPPET_DESC_JACCARD = 0.7;

const CJK = /[\u4e00-\u9fff\u3040-\u30ff]/;

function serverFiles(): string[] {
	return readdirSync(join(ROOT, "server"))
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
		.map((f) => join(ROOT, "server", f));
}

function readStr(src: string, i: number): { text: string; end: number } | null {
	const q = src[i];
	if (q !== '"' && q !== "'" && q !== "`") return null;
	let j = i + 1;
	let out = "";
	while (j < src.length && src[j] !== q) {
		if (src[j] === "\\") {
			const n = src[j + 1];
			out += n === "n" ? "\n" : n === "t" ? "\t" : n;
			j += 2;
		} else out += src[j++];
	}
	if (src[j] !== q) return null;
	return { text: out, end: j + 1 };
}

function readConcat(src: string, i: number): { text: string; end: number } | null {
	let out = "";
	let j = i;
	let expectOperand = true;
	for (;;) {
		while (/\s/.test(src[j] ?? "")) j++;
		const c = src[j];
		if (c === "+") {
			j++;
			expectOperand = true;
			continue;
		}
		if (c === ")" || c === "," || c === ";" || c == null) break;
		if (!expectOperand) break;
		const s = readStr(src, j);
		if (!s) return null;
		out += s.text;
		j = s.end;
		expectOperand = false;
	}
	return { text: out, end: j };
}

describe("tool prompt hygiene（工具提示词纯英文精简）", () => {
	it("server 工具定义文件不再调用 bilingual()", () => {
		const offenders: string[] = [];
		for (const file of serverFiles()) {
			if (BILINGUAL_ALLOW.has(file.split(/[/\\]/).pop()!)) continue;
			const src = readFileSync(file, "utf8");
			const calls = src.match(/\bbilingual\s*\(/g);
			if (calls) offenders.push(`${file}: ${calls.length} 处`);
		}
		expect(offenders, `以下文件仍有 bilingual() 调用：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("server description/promptSnippet/promptGuidelines 值不含中文", () => {
		const offenders: string[] = [];
		for (const file of serverFiles()) {
			if (CJK_ALLOW.has(file.split(/[/\\]/).pop()!)) continue;
			const src = readFileSync(file, "utf8");
			for (const key of ["description", "promptSnippet", "promptGuidelines"]) {
				let idx = 0;
				while ((idx = src.indexOf(key + ":", idx)) !== -1) {
					const line = src.slice(0, idx).split("\n").length;
					idx += key.length + 1;
					let j = idx;
					while (/\s/.test(src[j])) j++;
					const r = readConcat(src, j);
					if (!r) continue;
					idx = r.end;
					if (CJK.test(r.text)) offenders.push(`${file}:${line} ${key} 含中文: ${r.text.slice(0, 60)}`);
				}
			}
		}
		expect(offenders, `以下工具提示词含中文：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("server 主 description 不超过长度上限", () => {
		const offenders: string[] = [];
		for (const file of serverFiles()) {
			if (MAIN_DESC_EXEMPT.has(file.split(/[/\\]/).pop()!)) continue;
			const src = readFileSync(file, "utf8");
			let idx = 0;
			while ((idx = src.indexOf("description:", idx)) !== -1) {
				const line = src.slice(0, idx).split("\n").length;
				idx += "description:".length;
				let j = idx;
				while (/\s/.test(src[j])) j++;
				const r = readConcat(src, j);
				if (!r) continue;
				if (r.text.length > MAIN_DESC_CAP) offenders.push(`${file}:${line} ${r.text.length}c`);
			}
		}
		expect(offenders, `以下 description 超过 ${MAIN_DESC_CAP}c：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("插件 *.mjs 的 description/promptSnippet 行不含中文", () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const f of readdirSync(dir)) {
				const p = join(dir, f);
				if (statSync(p).isDirectory()) {
					// 只查插件正文（提示词/工具描述）；test/tests 里是中文样本数据（B 站标题、简介），不是提示词
					if (f !== "node_modules" && f !== "test" && f !== "tests") walk(p);
					continue;
				}
				if (!f.endsWith(".mjs")) continue;
				const lines = readFileSync(p, "utf8").split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (!/^\s*(description|promptSnippet|promptGuidelines)\s*[:=]/.test(lines[i])) continue;
					const context = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 5)).join("\n");
					if (context.includes("registerCommand") || context.includes("descriptionEn")) continue;
					const m = lines[i].match(/(["'`])((?:\\.|(?!\1).)*)\1/);
					if (m && CJK.test(m[2])) offenders.push(`${p}:${i + 1} ${m[2].slice(0, 60)}`);
				}
			}
		};
		walk(join(ROOT, "plugins"));
		expect(offenders, `以下插件提示词行含中文：\n${offenders.join("\n")}`).toEqual([]);
	}, 20_000);
});

interface PromptEntry {
	line: number;
	field: "description" | "promptSnippet" | "guideline";
	text: string;
}

function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function wordSet(s: string): Set<string> {
	return new Set(
		normalize(s)
			.split(" ")
			.filter((w) => w.length > 3),
	);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	return inter / (a.size + b.size - inter || 1);
}

function arrayElements(src: string, open: number): { items: string[]; end: number } | null {
	let depth = 0;
	let start = open + 1;
	let inStr: string | null = null;
	const items: string[] = [];
	for (let j = open + 1; j < src.length; j++) {
		const c = src[j];
		if (inStr) {
			if (c === "\\") {
				j++;
				continue;
			}
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") {
			depth++;
			continue;
		}
		if (c === ")" || c === "}") {
			depth--;
			continue;
		}
		if (c === "]") {
			if (depth > 0) {
				depth--;
				continue;
			}
			items.push(src.slice(start, j));
			return { items, end: j + 1 };
		}
		if (c === "," && depth === 0) {
			items.push(src.slice(start, j));
			start = j + 1;
		}
	}
	return null;
}

function stringOnly(el: string): string | null {
	let out = "";
	let sawString = false;
	let j = 0;
	while (j < el.length) {
		const c = el[j];
		if (/\s/.test(c) || c === "+" || c === ",") {
			j++;
			continue;
		}
		const s = readStr(el, j);
		if (!s) return null;
		sawString = true;
		out += s.text;
		j = s.end;
	}
	return sawString ? out : null;
}

function scanPromptEntries(src: string): PromptEntry[] {
	const out: PromptEntry[] = [];
	for (const field of ["description", "promptSnippet"] as const) {
		let idx = 0;
		while ((idx = src.indexOf(`${field}:`, idx)) !== -1) {
			const line = src.slice(0, idx).split("\n").length;
			idx += field.length + 1;
			let j = idx;
			while (/\s/.test(src[j] ?? "")) j++;
			const r = readConcat(src, j);
			if (r && r.text.trim()) out.push({ line, field, text: r.text });
			idx = r ? Math.max(r.end, j + 1) : j + 1;
		}
	}
	let idx = 0;
	while ((idx = src.indexOf("promptGuidelines:", idx)) !== -1) {
		const line = src.slice(0, idx).split("\n").length;
		idx += "promptGuidelines:".length;
		let j = idx;
		while (/\s/.test(src[j] ?? "")) j++;
		if (src[j] === "[") {
			const arr = arrayElements(src, j);
			if (arr) {
				for (const el of arr.items) {
					const t = stringOnly(el);
					if (t && t.trim()) out.push({ line, field: "guideline", text: t });
				}
				idx = arr.end;
				continue;
			}
		}
		idx = j + 1;
	}
	return out;
}

function toolNamesIn(src: string): string[] {
	const out: string[] = [];
	const re = /\bname:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
	let m = re.exec(src);
	while (m !== null) {
		out.push(m[1]);
		m = re.exec(src);
	}
	return out;
}

function pluginPromptFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (statSync(p).isDirectory()) {
				if (f !== "node_modules" && f !== "vendor" && f !== "artifacts") walk(p);
				continue;
			}
			if (f.endsWith(".mjs")) out.push(p);
		}
	};
	walk(join(ROOT, "plugins"));
	return out;
}

function promptFiles(): string[] {
	return [...serverFiles(), ...pluginPromptFiles()];
}

describe("tool prompt hygiene（三处职责分离：description / snippet / guidelines）", () => {
	it(`promptSnippet ≤ ${SNIPPET_CAP}c 且不以工具名开头`, () => {
		const offenders: string[] = [];
		for (const file of promptFiles()) {
			const src = readFileSync(file, "utf8");
			const names = toolNamesIn(src);
			for (const e of scanPromptEntries(src)) {
				if (e.field !== "promptSnippet") continue;
				if (e.text.length > SNIPPET_CAP) offenders.push(`${file}:${e.line} ${e.text.length}c > ${SNIPPET_CAP}c`);
				const head = normalize(e.text);
				for (const n of names) {
					if (n.length < 4) continue;
					const link = normalize(n);
					if (head === link || head.startsWith(`${link} `)) {
						offenders.push(`${file}:${e.line} snippet 以工具名「${n}」开头: ${e.text.slice(0, 60)}`);
					}
				}
			}
		}
		expect(
			offenders,
			`snippet 违规（系统提示词列表已渲染 \`- name: …\`，不必再重复工具名）：\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("promptSnippet 不复述 description", () => {
		const offenders: string[] = [];
		for (const file of promptFiles()) {
			const src = readFileSync(file, "utf8");
			const entries = scanPromptEntries(src);
			const descs = entries.filter((e) => e.field === "description" && e.text.length > 60);
			for (const s of entries.filter((e) => e.field === "promptSnippet")) {
				const words = wordSet(s.text);
				if (words.size < 4) continue;
				for (const d of descs) {
					const v = jaccard(words, wordSet(d.text));
					if (v >= SNIPPET_DESC_JACCARD) {
						offenders.push(
							`${file}:${s.line} 与同文件 description 重合 ${(v * 100).toFixed(0)}%: ${s.text.slice(0, 60)}`,
						);
						break;
					}
				}
			}
		}
		expect(
			offenders,
			`以下 snippet 只是 description 的改写（同一条信息进上下文两次）：\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it(`promptGuidelines 单条 ≤ ${GUIDELINE_CAP}c 且不复述 description`, () => {
		const offenders: string[] = [];
		for (const file of promptFiles()) {
			const src = readFileSync(file, "utf8");
			const entries = scanPromptEntries(src);
			const descs = entries.filter((e) => e.field === "description" && e.text.length > 60);
			for (const g of entries.filter((e) => e.field === "guideline")) {
				if (g.text.length > GUIDELINE_CAP) offenders.push(`${file}:${g.line} ${g.text.length}c > ${GUIDELINE_CAP}c`);
				const norm = normalize(g.text);
				for (const d of descs) {
					const v = jaccard(wordSet(g.text), wordSet(d.text));
					if ((norm.length >= DUP_MIN_LEN && normalize(d.text).includes(norm)) || v >= DUP_JACCARD) {
						offenders.push(
							`${file}:${g.line} 复述 description（重合 ${(v * 100).toFixed(0)}%）: ${g.text.slice(0, 60)}`,
						);
						break;
					}
				}
			}
		}
		expect(
			offenders,
			`guidelines 只写「何时用/顺序/禁止/路由」，不复述 description：\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("同一文件内不出现同义重复的提示词串（子串 / 高度改写）", () => {
		const offenders: string[] = [];
		for (const file of promptFiles()) {
			const src = readFileSync(file, "utf8");
			const entries = scanPromptEntries(src).filter((e) => e.text.length >= DUP_MIN_LEN);
			for (let i = 0; i < entries.length; i++) {
				for (let k = i + 1; k < entries.length; k++) {
					const a = entries[i];
					const b = entries[k];
					const na = normalize(a.text);
					const nb = normalize(b.text);
					if (na === nb || na.includes(nb) || nb.includes(na)) {
						offenders.push(
							`${file}:${a.line}&${b.line} 子串重复: 「${a.text.slice(0, 45)}」/「${b.text.slice(0, 45)}」`,
						);
						continue;
					}
					const v = jaccard(wordSet(a.text), wordSet(b.text));
					if (v >= DUP_JACCARD) {
						offenders.push(`${file}:${a.line}&${b.line} 同义改写 ${(v * 100).toFixed(0)}%: 「${a.text.slice(0, 45)}」`);
					}
				}
			}
		}
		expect(offenders, `同一文件内同一条信息说了两遍（合并到唯一归属处）：\n${offenders.join("\n")}`).toEqual([]);
	});
});
