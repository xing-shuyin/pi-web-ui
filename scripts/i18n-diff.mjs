#!/usr/bin/env node
/**
 * i18n-diff.mjs — 发布时统计「翻译增量」：相对某个 base tag，文案源头新增/变更了哪些 key。
 *
 * 只看两处源头（语言包的翻译缺口不在这里管，运行时缺 key 会回落英文）：
 *   1. 前端 web/src/i18n.tsx 的 zh / en 内联文案（key 增删、中文/英文改字）；
 *   2. 服务端 server/**.ts 里 pick(lang, zh, en, key) / getServerBlock(lang, key, …) 的 key 增删、
 *      pick 内联中英文源头改字（getServerBlock 传的是标识符而非内联数组，只跟踪 key 增删）。
 *
 * bilingual(en, zh) 无 key，无法归因，不跟踪。
 *
 * 用法：
 *   node scripts/i18n-diff.mjs [--base v0.70.0]            # 人看：控制台表格
 *   node scripts/i18n-diff.mjs --base v0.70.0 --markdown   # CHANGELOG ### i18n / Release 说明片段
 *   node scripts/i18n-diff.mjs --base v0.70.0 --json       # 机器消费
 *   node scripts/i18n-diff.mjs --check-packs               # CI 门禁：locales/*.json key 与 zh 源头对照，缺/多余即 exit 1
 *   node scripts/i18n-diff.mjs --prune                     # 只列死 key（zh 源头已无的 key），不删除（删前需译者确认）
 *   npm run i18n:diff -- --base v0.70.0 --markdown
 *
 * --base 缺省时自动取「上一个 tag」（HEAD 正好落在最新 tag 上则再往前一个）。
 * 对比的是 base..工作区（含未提交修改），发版时工作区即发版内容。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const I18N_FILE = "web/src/i18n.tsx";
const SERVER_DIR = "server";

/* ------------------------------------------------------------------ */
/* git                                                                  */
/* ------------------------------------------------------------------ */

function git(args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** 取不到返回 null（base 之前不存在该文件时视为全部新增）。 */
function gitShow(ref, p) {
	try {
		return execFileSync("git", ["show", `${ref}:${p}`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return null;
	}
}

/** 简单 semver（x.y.z）比较：a<b 返回 <0，a>b 返回 >0。 */
function cmpVersion(a, b) {
	const pa = String(a)
		.split(".")
		.map((n) => parseInt(n, 10) || 0);
	const pb = String(b)
		.split(".")
		.map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** 缺省 base：最新的 tag；HEAD 正好是最新 tag（发版打完 tag 后跑）则取上一个。
 *
 * `atOrBelowVersion`（`--unreleased` 专用）：取版本号 ≤ 该值的最后一个 tag。
 * 发版流程是「升版本 → 写 CHANGELOG → 自检 → 提交 → 打 tag」，跑 `npm run changelog:i18n`
 * 时 HEAD 往往正好停在**上一个版本的 tag** 上，而上面那条「HEAD 在 tag 上就往前
 * 一个」会把已经发布过的那个版本的文案增量重复算进未发布小节（实测：v0.75.0
 * 的 tag 上跑，它拿 v0.74.0 当 base，结果把 0.75.0 的 key 又列了一遍）。
 */
export function resolveBase(explicit, atOrBelowVersion) {
	if (explicit) return explicit;
	const tags = git(["tag", "--sort=-v:refname"])
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	if (tags.length === 0) throw new Error("仓库里没有 tag，请显式传 --base <tag>");
	if (atOrBelowVersion) {
		const target = String(atOrBelowVersion).replace(/^v/, "");
		const found = tags.find((t) => cmpVersion(t.replace(/^v/, ""), target) <= 0);
		if (found) return found;
	}
	let head = null;
	try {
		head = git(["describe", "--tags", "--exact-match", "HEAD"]);
	} catch {
		// 不在 tag 上：base 就是最新 tag
	}
	if (head === tags[0] && tags.length > 1) return tags[1];
	return tags[0];
}

/* ------------------------------------------------------------------ */
/* 通用扫描器：跳过注释 / 字符串（含模板字符串 ${} 嵌套）               */
/* ------------------------------------------------------------------ */

/** 从字符串字面量开头跳到结尾之后（处理转义与 `…${…}…` 嵌套）。 */
function skipString(src, i) {
	const q = src[i];
	const n = src.length;
	i++;
	while (i < n) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (q === "`" && c === "$" && src[i + 1] === "{") {
			i += 2;
			let d = 1;
			while (i < n && d > 0) {
				const c2 = src[i];
				if (c2 === "\\") {
					i += 2;
					continue;
				}
				if (c2 === '"' || c2 === "'" || c2 === "`") {
					i = skipString(src, i);
					continue;
				}
				if (c2 === "/" && src[i + 1] === "/") {
					const j = src.indexOf("\n", i);
					i = j === -1 ? n : j;
					continue;
				}
				if (c2 === "/" && src[i + 1] === "*") {
					const j = src.indexOf("*/", i + 2);
					i = j === -1 ? n : j + 2;
					continue;
				}
				if (c2 === "{") d++;
				else if (c2 === "}") d--;
				i++;
			}
			continue;
		}
		if (c === q) return i + 1;
		i++;
	}
	return n;
}

/** '/' 是否为正则字面量起点（而非除法）：看上一个有效 token。
 * 启发式：标识符/数字/字符串/)/] 之后是除法；} 之后按块结尾处理为正则；
 * return/typeof 等关键字之后是正则。if(x)/re/ 这类罕见写法会误判为除法，接受。 */
const REGEX_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

function isRegexStart(src, i) {
	let k = i - 1;
	while (k >= 0) {
		if (/\s/.test(src[k])) {
			k--;
			continue;
		}
		if (src[k] === "/" && src[k - 1] === "*") {
			const j = src.lastIndexOf("/*", k - 2);
			if (j === -1) return true;
			k = j - 1;
			continue;
		}
		break;
	}
	if (k < 0) return true;
	const c = src[k];
	if (c === ")" || c === "]") return false;
	if (c === "}") return true;
	if (/[0-9]/.test(c)) return false;
	if (c === '"' || c === "'" || c === "`") return false;
	if (/[A-Za-z_$]/.test(c)) {
		let w = "";
		while (k >= 0 && /[\w$]/.test(src[k])) {
			w = src[k] + w;
			k--;
		}
		if (w === "this" || w === "true" || w === "false" || w === "null" || w === "undefined" || w === "super")
			return false;
		return REGEX_KEYWORDS.has(w);
	}
	return true;
}

/** 从正则起始 '/' 跳到 flags 之后（处理转义与 [...] 字符类）。 */
function skipRegex(src, i) {
	const n = src.length;
	i++;
	let inClass = false;
	while (i < n) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			i++;
			while (i < n && /[a-z]/.test(src[i])) i++;
			return i;
		} else if (c === "\n") return i;
		i++;
	}
	return n;
}

/** 从 '{' 起提花括号块内部文本（字符串/注释/正则感知）。 */
function extractBraceInner(src, openIdx) {
	const n = src.length;
	let i = openIdx;
	let depth = 0;
	while (i < n) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") {
			const j = src.indexOf("\n", i);
			i = j === -1 ? n : j;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const j = src.indexOf("*/", i + 2);
			i = j === -1 ? n : j + 2;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			i = skipString(src, i);
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return src.slice(openIdx + 1, i);
		}
		i++;
	}
	throw new Error("花括号不配对");
}

/* ------------------------------------------------------------------ */
/* 前端：解析 zh / en 对象（key 有序，value 为解码后的字符串）          */
/* ------------------------------------------------------------------ */

function parseQuoted(src, i) {
	const q = src[i];
	const n = src.length;
	let out = "";
	let j = i + 1;
	while (j < n) {
		const c = src[j];
		if (c === "\\") {
			const e = src[j + 1];
			if (e === "n") out += "\n";
			else if (e === "t") out += "\t";
			else if (e === "r") out += "\r";
			else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
				out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
				j += 6;
				continue;
			} else out += e ?? "";
			j += 2;
			continue;
		}
		if (c === q) return { value: out, end: j + 1 };
		out += c;
		j++;
	}
	throw new Error("字符串未闭合");
}

/** 读到 depth-0 的逗号或结尾（兜底：非字面量 value，当前文件里实际走不到）。 */
function parseRawValue(block, i) {
	const n = block.length;
	let j = i;
	let depth = 0;
	while (j < n) {
		const c = block[j];
		if (c === '"' || c === "'" || c === "`") {
			j = skipString(block, j);
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) break;
		j++;
	}
	return { value: block.slice(i, j).trim(), end: j };
}

function parseEntries(block) {
	const entries = [];
	let i = 0;
	const n = block.length;
	const skipWS = () => {
		while (i < n) {
			if (/\s/.test(block[i])) {
				i++;
				continue;
			}
			if (block[i] === "/" && block[i + 1] === "/") {
				const j = block.indexOf("\n", i);
				i = j === -1 ? n : j;
				continue;
			}
			if (block[i] === "/" && block[i + 1] === "*") {
				const j = block.indexOf("*/", i + 2);
				i = j === -1 ? n : j + 2;
				continue;
			}
			break;
		}
	};
	while (true) {
		skipWS();
		if (i >= n) break;
		let key;
		if (block[i] === '"' || block[i] === "'") {
			const r = parseQuoted(block, i);
			key = r.value;
			i = r.end;
		} else {
			const m = /^[A-Za-z_$][\w$]*/.exec(block.slice(i));
			if (!m) throw new Error(`解析 key 失败（offset ${i}）：${JSON.stringify(block.slice(i, i + 40))}`);
			key = m[0];
			i += m[0].length;
		}
		skipWS();
		if (block[i] !== ":") throw new Error(`key ${key} 后面不是冒号`);
		i++;
		skipWS();
		let value;
		if (block[i] === '"' || block[i] === "'") {
			const r = parseQuoted(block, i);
			value = r.value;
			i = r.end;
		} else if (block[i] === "`") {
			const e = skipString(block, i);
			value = block.slice(i + 1, e - 1);
			i = e;
		} else {
			const r = parseRawValue(block, i);
			value = r.value;
			i = r.end;
		}
		// 字符串续行：长文案在 i18n.tsx 里写成 "..." +\n\t"..."（如 filesHelp）。
		// diff 只关心解码后的完整值，这里把后续 + "..." 段拼进来；否则 + 会被误当下一个 key。
		for (;;) {
			skipWS();
			if (block[i] !== "+") break;
			i++;
			skipWS();
			if (block[i] === '"' || block[i] === "'") {
				const r = parseQuoted(block, i);
				value += r.value;
				i = r.end;
			} else if (block[i] === "`") {
				const e = skipString(block, i);
				value += block.slice(i + 1, e - 1);
				i = e;
			} else {
				throw new Error(`+ 后面不是字符串（offset ${i}）`);
			}
		}
		skipWS();
		if (block[i] === ",") i++;
		entries.push({ key, value });
	}
	return entries;
}

/** 返回 { zh: {order, map}, en: {order, map} }。 */
export function parseLocaleMaps(fileSrc) {
	const out = {};
	for (const name of ["zh", "en"]) {
		const marker = name === "zh" ? "export const zh =" : "const en";
		const idx = fileSrc.indexOf(marker);
		if (idx === -1) throw new Error(`找不到 ${marker}`);
		const open = fileSrc.indexOf("{", idx);
		const entries = parseEntries(extractBraceInner(fileSrc, open));
		const map = new Map();
		const order = [];
		for (const e of entries) {
			if (!map.has(e.key)) order.push(e.key);
			map.set(e.key, e.value);
		}
		out[name] = { order, map };
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* 服务端：提取 pick / getServerBlock 的 key 与内联中英文源头           */
/* ------------------------------------------------------------------ */

const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();

function parseKeyLiteral(raw) {
	if (raw == null) return null;
	const m = /^(['"])([\s\S]*)\1$/.exec(raw.trim());
	return m ? m[2] : null;
}

/** 从 '(' 起切顶层参数（字符串/注释/括号感知），返回 {args, end}。 */
function splitArgs(src, openIdx) {
	const args = [];
	const n = src.length;
	let i = openIdx + 1;
	let depth = 1;
	let cur = "";
	while (i < n && depth > 0) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			const e = skipString(src, i);
			cur += src.slice(i, e);
			i = e;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const j = src.indexOf("\n", i);
			const e = j === -1 ? n : j;
			cur += src.slice(i, e);
			i = e;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const j = src.indexOf("*/", i + 2);
			const e = j === -1 ? n : j + 2;
			cur += src.slice(i, e);
			i = e;
			continue;
		}
		if (c === "/" && src[i + 1] !== "/" && src[i + 1] !== "*" && isRegexStart(src, i)) {
			const e = skipRegex(src, i);
			cur += src.slice(i, e);
			i = e;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (c === ")" && depth === 1) {
				args.push(cur);
				i++;
				break;
			}
			depth--;
		} else if (c === "," && depth === 1) {
			args.push(cur);
			cur = "";
			i++;
			continue;
		}
		cur += c;
		i++;
	}
	return { args: args.map((a) => a.trim()), end: i };
}

const isIdentStart = (c) => /[A-Za-z_$]/.test(c ?? "");
const isIdentChar = (c) => /[\w$]/.test(c ?? "");

/** 扫描模板字符串：每个 ${…} 表达式递归 scanRange；返回模板结束之后的位置。 */
function scanTemplate(src, i, end, file, found) {
	const n = Math.min(end, src.length);
	i++; // 跳过开头的 `
	while (i < n) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "$" && src[i + 1] === "{") {
			let d = 1;
			let j = i + 2;
			const s = j;
			while (j < n && d > 0) {
				const c2 = src[j];
				if (c2 === "\\") {
					j += 2;
					continue;
				}
				if (c2 === '"' || c2 === "'") {
					j = skipString(src, j);
					continue;
				}
				if (c2 === "`") {
					j = scanTemplate(src, j, n, file, found);
					continue;
				}
				if (c2 === "/" && src[j + 1] === "/") {
					const k = src.indexOf("\n", j);
					j = k === -1 ? n : k;
					continue;
				}
				if (c2 === "/" && src[j + 1] === "*") {
					const k = src.indexOf("*/", j + 2);
					j = k === -1 ? n : k + 2;
					continue;
				}
				if (c2 === "/" && src[j + 1] !== "/" && src[j + 1] !== "*" && isRegexStart(src, j)) {
					j = skipRegex(src, j);
					continue;
				}
				if (c2 === "{") d++;
				else if (c2 === "}") d--;
				j++;
			}
			scanRange(src, s, j - 1, file, found);
			i = j;
			continue;
		}
		if (c === "`") return i + 1;
		i++;
	}
	return n;
}

/** 扫描一段代码区间，收集 pick/getServerBlock 的 key（注释/字符串/正则感知）。 */
function scanRange(src, start, end, file, found) {
	const n = Math.min(end, src.length);
	let i = start;
	while (i < n) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") {
			const j = src.indexOf("\n", i);
			i = j === -1 ? n : j;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const j = src.indexOf("*/", i + 2);
			i = j === -1 ? n : j + 2;
			continue;
		}
		if (c === "/" && src[i + 1] !== "/" && src[i + 1] !== "*" && isRegexStart(src, i)) {
			i = skipRegex(src, i);
			continue;
		}
		if (c === '"' || c === "'") {
			i = skipString(src, i);
			continue;
		}
		if (c === "`") {
			i = scanTemplate(src, i, n, file, found);
			continue;
		}
		if (isIdentStart(c)) {
			let j = i + 1;
			while (j < n && isIdentChar(src[j])) j++;
			const ident = src.slice(i, j);
			if (ident === "pick" || ident === "getServerBlock") {
				// 排除自身定义 `function pick(` / `function getServerBlock(`
				let k = i - 1;
				while (k >= 0 && /\s/.test(src[k])) k--;
				let w = "";
				while (k >= 0 && isIdentChar(src[k])) {
					w = src[k] + w;
					k--;
				}
				let p = j;
				while (p < n && /\s/.test(src[p])) p++;
				if (w !== "function" && src[p] === "(") {
					const { args, end: callEnd } = splitArgs(src, p);
					if (ident === "pick") {
						const key = parseKeyLiteral(args[3]);
						if (key && !found.has(key)) found.set(key, { zh: norm(args[1]), en: norm(args[2]), file });
					} else {
						const key = parseKeyLiteral(args[1]);
						if (key && !found.has(key)) found.set(key, { zh: "", en: "", file });
					}
					i = callEnd;
					continue;
				}
			}
			i = j;
			continue;
		}
		i++;
	}
}

/** 返回 Map<key, {zh, en, file}>；zh/en 为归一化后的源头原文（getServerBlock 传标识符则记 ""）。 */
export function extractServerKeys(src, file) {
	const found = new Map();
	scanRange(src, 0, src.length, file, found);
	return found;
}

function listServerFilesRecursive(rel = SERVER_DIR) {
	const out = [];
	for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
		if (e.isDirectory()) out.push(...listServerFilesRecursive(`${rel}/${e.name}`));
		else if (e.name.endsWith(".ts")) out.push(`${rel}/${e.name}`);
	}
	return out;
}

function collectServerKeys(getContent, files) {
	const all = new Map(); // key -> {zh, en, file}
	const dupes = [];
	for (const f of files) {
		const src = getContent(f);
		if (src == null) continue;
		for (const [key, v] of extractServerKeys(src, f)) {
			if (all.has(key)) dupes.push(key);
			else all.set(key, v);
		}
	}
	return { all, dupes };
}

/* ------------------------------------------------------------------ */
/* 语言包：locales/*.json 与 zh 源头的 key 对照（CI 门禁 --check-packs） */
/* ------------------------------------------------------------------ */

/** 返回每个包的 {code, version, missing[], extra[]}（missing 按 zh 顺序，extra 即死 key）。 */
export function checkPacks() {
	const zhKeys = parseLocaleMaps(readFileSync(join(root, I18N_FILE), "utf8")).zh.order;
	const zhSet = new Set(zhKeys);
	const out = [];
	for (const f of readdirSync(join(root, "locales"))
		.filter((f) => f.endsWith(".json"))
		.sort()) {
		const p = JSON.parse(readFileSync(join(root, "locales", f), "utf8"));
		const keys = Object.keys(p.strings ?? {});
		const packSet = new Set(keys);
		out.push({
			code: p.code ?? f,
			version: p.version ?? "unknown",
			missing: zhKeys.filter((k) => !packSet.has(k)),
			extra: keys.filter((k) => !zhSet.has(k)),
		});
	}
	return out;
}

function checkPacksMain() {
	const rows = checkPacks();
	let bad = 0;
	for (const r of rows) {
		const ok = r.missing.length === 0 && r.extra.length === 0;
		if (!ok) bad++;
		console.log(`${ok ? "OK  " : "FAIL"} ${r.code}（v${r.version}）：缺 ${r.missing.length}，多余 ${r.extra.length}`);
		if (r.missing.length > 0) console.log(`  缺：${r.missing.join("、")}`);
		if (r.extra.length > 0) console.log(`  多余（死 key）：${r.extra.join("、")}`);
	}
	if (bad > 0) {
		console.error(`语言包 ${bad}/${rows.length} 个与 zh 源头不一致：缺 key 按 zh 顺序补入，死 key 经译者确认后删除。`);
		process.exit(1);
	}
	console.log(`${rows.length} 个语言包 key 与 zh 一一对应。`);
}

/** 只列死 key，不删除。 */
function pruneMain() {
	for (const r of checkPacks()) {
		if (r.extra.length === 0) console.log(`${r.code}：无死 key`);
		else console.log(`${r.code} 死 key（${r.extra.length}）：${r.extra.join("、")}`);
	}
}

/* ------------------------------------------------------------------ */
/* diff                                                                 */
/* ------------------------------------------------------------------ */

function diffKeyMaps(oldMap, newOrder, newMap) {
	const added = [];
	const changed = [];
	const newSet = new Set(newOrder);
	for (const key of newOrder) {
		if (!oldMap.has(key)) added.push(key);
		else if (oldMap.get(key) !== newMap.get(key)) changed.push({ key, old: oldMap.get(key), new: newMap.get(key) });
	}
	const removed = [...oldMap.keys()].filter((k) => !newSet.has(k));
	return { added, removed, changed };
}

export function diffWorktreeVsBase(base) {
	// 前端
	const newSrc = readFileSync(join(root, I18N_FILE), "utf8");
	const oldSrc = gitShow(base, I18N_FILE);
	const newMaps = parseLocaleMaps(newSrc);
	const oldMaps = oldSrc
		? parseLocaleMaps(oldSrc)
		: { zh: { order: [], map: new Map() }, en: { order: [], map: new Map() } };
	const zhDiff = diffKeyMaps(oldMaps.zh.map, newMaps.zh.order, newMaps.zh.map);
	const enDiff = diffKeyMaps(oldMaps.en.map, newMaps.en.order, newMaps.en.map);

	// 服务端
	let baseFiles = [];
	try {
		baseFiles = git(["ls-tree", "-r", "--name-only", base, "--", SERVER_DIR])
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.endsWith(".ts"));
	} catch {
		baseFiles = [];
	}
	const curFiles = listServerFilesRecursive().sort();
	const files = [...new Set([...curFiles, ...baseFiles])].sort();
	const curCol = collectServerKeys((f) => {
		try {
			return readFileSync(join(root, f), "utf8");
		} catch {
			return null;
		}
	}, files);
	const baseCol = collectServerKeys((f) => gitShow(base, f), files);
	const server = { added: [], removed: [], changed: [] };
	for (const [key, v] of curCol.all) {
		const o = baseCol.all.get(key);
		if (!o) server.added.push({ key, file: v.file });
		else if (o.zh !== v.zh || o.en !== v.en) server.changed.push({ key, file: v.file });
	}
	for (const [key, v] of baseCol.all) {
		if (!curCol.all.has(key)) server.removed.push({ key, file: v.file });
	}
	return {
		base,
		frontend: { added: zhDiff.added, removed: zhDiff.removed, changedZh: zhDiff.changed, changedEn: enDiff.changed },
		server,
		dupes: curCol.dupes,
	};
}

/* ------------------------------------------------------------------ */
/* 输出                                                                 */
/* ------------------------------------------------------------------ */

const trunc = (s, len = 70) => {
	const one = (s ?? "").replace(/\s+/g, " ").trim();
	return one.length > len ? `${one.slice(0, len)}…` : one;
};

const backtickList = (keys) => keys.map((k) => `\`${k}\``).join("、");

export function renderI18nSection(d) {
	const lines = [];
	const f = d.frontend;
	if (f.added.length > 0) lines.push(`- 前端新增 key（${f.added.length}）：${backtickList(f.added)}`);
	if (f.removed.length > 0) lines.push(`- 前端删除 key（${f.removed.length}）：${backtickList(f.removed)}`);
	if (f.changedZh.length > 0)
		lines.push(`- 前端中文变更（${f.changedZh.length}）：${backtickList(f.changedZh.map((c) => c.key))}`);
	if (f.changedEn.length > 0)
		lines.push(`- 前端英文变更（${f.changedEn.length}）：${backtickList(f.changedEn.map((c) => c.key))}`);
	if (d.server.added.length > 0)
		lines.push(`- 服务端新增 key（${d.server.added.length}）：${d.server.added.map((a) => `\`${a.key}\``).join("、")}`);
	if (d.server.changed.length > 0)
		lines.push(
			`- 服务端文案变更（${d.server.changed.length}）：${d.server.changed.map((a) => `\`${a.key}\``).join("、")}`,
		);
	if (d.server.removed.length > 0)
		lines.push(
			`- 服务端删除 key（${d.server.removed.length}）：${d.server.removed.map((a) => `\`${a.key}\``).join("、")}`,
		);
	if (lines.length === 0) lines.push(`- 本版无文案增量（相对 ${d.base}，已核查）。`);
	return lines;
}

function printHuman(d) {
	console.log(`i18n 增量：${d.base}...工作区`);
	const f = d.frontend;
	console.log(`【前端 ${I18N_FILE}】`);
	console.log(`  新增 key（${f.added.length}）：${f.added.join(", ") || "—"}`);
	console.log(`  删除 key（${f.removed.length}）：${f.removed.join(", ") || "—"}`);
	console.log(`  中文变更（${f.changedZh.length}）：`);
	for (const c of f.changedZh) console.log(`    · ${c.key}：${trunc(c.old)} → ${trunc(c.new)}`);
	console.log(`  英文变更（${f.changedEn.length}）：`);
	for (const c of f.changedEn) console.log(`    · ${c.key}：${trunc(c.old)} → ${trunc(c.new)}`);
	console.log(`【服务端 ${SERVER_DIR}/ pick/getServerBlock】`);
	console.log(
		`  新增 key（${d.server.added.length}）：${d.server.added.map((a) => `${a.key}（${a.file}）`).join(", ") || "—"}`,
	);
	console.log(
		`  文案变更（${d.server.changed.length}）：${d.server.changed.map((a) => `${a.key}（${a.file}）`).join(", ") || "—"}`,
	);
	console.log(
		`  删除 key（${d.server.removed.length}）：${d.server.removed.map((a) => `${a.key}（${a.file}）`).join(", ") || "—"}`,
	);
	if (d.dupes.length > 0) console.log(`⚠ 重复 key（${d.dupes.length}）：${d.dupes.join(", ")}`);
}

function main() {
	const argv = process.argv.slice(2);
	const getOpt = (name) => {
		const i = argv.indexOf(name);
		return i !== -1 ? (argv[i + 1] ?? null) : null;
	};
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log("用法：node scripts/i18n-diff.mjs [--base <tag>] [--markdown|--json] [--check-packs] [--prune]");
		return;
	}
	if (argv.includes("--check-packs")) {
		checkPacksMain();
		return;
	}
	if (argv.includes("--prune")) {
		pruneMain();
		return;
	}
	const base = resolveBase(getOpt("--base"));
	const d = diffWorktreeVsBase(base);
	if (argv.includes("--json")) console.log(JSON.stringify(d, null, 2));
	else if (argv.includes("--markdown")) console.log(renderI18nSection(d).join("\n"));
	else printHuman(d);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
