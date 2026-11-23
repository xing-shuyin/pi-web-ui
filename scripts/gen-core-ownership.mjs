#!/usr/bin/env node
/**
 * 扫描老树 god object（`server/agent-service.ts` 的 `ClientSession`），把每个可变字段按命名归类到新树的域，
 * 产出 `server/core/OWNERSHIP.md`：新树的「状态所有权表」底稿，交给人工裁定 `?` 项。
 *
 * 用法：`node scripts/gen-core-ownership.mjs`（写文件）· `--check`（只校验现有文件是否过期）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "server", "agent-service.ts");
const TARGET = join(root, "server", "core", "OWNERSHIP.md");

/** 顺序即优先级：先匹配到的域赢。 */
const RULES = [
	["app", /^on[A-Z]|webUi|^version$|isQuiesced|resetFlights|listExternalRunning/i],
	["subagents", /subagent|handoff|spawnBudget|settle/i],
	["terminals", /terminal|nativeCli|tui/i],
	["plugins", /plugin|mcp|extension|bgServers|bgTask/i],
	["goals", /goal|plan|delegate|wizard/i],
	["bots", /^bot[A-Z]|^bot$/],
	["interactions", /approv|question|pageCall|phoneCall|consult|askUser/i],
	["settings", /setting|model|provider|preset|locale|lang|permission/i],
	["tools", /tool|lazy|promptOverride|codemode/i],
	["snapshots", /emit|snapshot|delta|uiMessage|messageCache|sink|stats/i],
	[
		"turns",
		/queue|deliver|gate|turn|retry|stall|kickoff|watchdog|interrupt|jobs?\b|scheduler|^bg$|slash|pendingBotChat|pendingNotices|pageSeq|phoneSeq|snapRev|widgetsTimer|memoryQuotas|lastRunningSig|lastSkillCatalogDigest|contextMessageWeights|pendingCliManagers/i,
	],
	["workspace", /cwd|root|sandbox|worktree|project|claim|watcher|git|watchPath|watchTimer|hasStreamingElsewhere/i],
	["history", /session|transcript|compaction|loadTiming|title|listed|history/i],
	["turns", /queue|deliver|gate|turn|retry|stall|kickoff|watchdog|interrupt/i],
	["files", /^files?[A-Z]|^files?$/],
	["conversations", /conv|activeId|dispose/i],
	["history", /session|transcript|compaction|loadTiming|title|listed|history/i],
];

function maskNonCode(text) {
	const out = text.split("");
	let i = 0;
	const blank = (from, to) => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "/" && next === "/") {
			const end = text.indexOf("\n", i);
			const stop = end === -1 ? text.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			const stop = end === -1 ? text.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			let k = i + 1;
			while (k < text.length) {
				if (text[k] === "\\") {
					k += 2;
					continue;
				}
				if (text[k] === quote) {
					k++;
					break;
				}
				k++;
			}
			blank(i + 1, k - 1);
			i = k;
			continue;
		}
		i++;
	}
	return out.join("");
}

function matchBracket(mask, from) {
	const open = mask[from];
	const close = open === "{" ? "}" : open === "(" ? ")" : "]";
	let depth = 0;
	for (let i = from; i < mask.length; i++) {
		if (mask[i] === open) depth++;
		else if (mask[i] === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

const source = readFileSync(SOURCE, "utf8");
const mask = maskNonCode(source);
const classAt = mask.search(/\bclass\s+ClientSession\b/);
if (classAt === -1) throw new Error("找不到 class ClientSession");
const bodyStart = mask.indexOf("{", classAt);
const bodyEnd = matchBracket(mask, bodyStart);
const classBody = source.slice(bodyStart + 1, bodyEnd);
const classMask = mask.slice(bodyStart + 1, bodyEnd);

const methods = [];
for (let i = 0; i < classMask.length; i++) {
	if (classMask[i] !== "\n") continue;
	const rest = classMask.slice(i + 1);
	const m =
		/^\t(?:public |private |protected |static |async |get |set |readonly |override )*([A-Za-z_#][\w]*)\s*(?:<[^>(]*>)?\s*\(/.exec(
			rest,
		);
	if (m && !/^\t(\/\/|\*)/.test(rest)) methods.push({ name: m[1], start: i + 1 + m[0].length });
}
for (let k = 0; k < methods.length; k++)
	methods[k].end = k + 1 < methods.length ? methods[k + 1].start : classBody.length;

const fields = new Map();
const decl =
	/^\t(?!\t)((?:private|protected|public|readonly|override|declare|#)\s+)*([A-Za-z_$][\w$]*)\s*[?!]?\s*(?::[^=;\n]+?)?\s*=(?!=)/gm;
for (let m = decl.exec(classMask); m; m = decl.exec(classMask)) {
	const name = m[2];
	if (name === "constructor" || name === "static") continue;
	if (!fields.has(name)) fields.set(name, 0);
}
for (const field of fields.keys()) {
	const pattern = new RegExp(`this\\.${field.replace(/\$/g, "\\$")}\\b`, "g");
	let count = 0;
	for (const method of methods) {
		const body = classBody.slice(method.start, method.end);
		if (pattern.test(body)) count++;
		pattern.lastIndex = 0;
	}
	fields.set(field, count);
}

function domainOf(field) {
	for (const [domain, re] of RULES) if (re.test(field)) return domain;
	return "?";
}

const rows = [...fields.entries()]
	.map(([field, touches]) => ({ field, touches, domain: domainOf(field) }))
	.sort((a, b) => b.touches - a.touches || a.field.localeCompare(b.field));

const byDomain = new Map();
for (const row of rows) {
	if (!byDomain.has(row.domain)) byDomain.set(row.domain, []);
	byDomain.get(row.domain).push(row);
}

const lines = [
	"# 新树状态所有权表（自动生成，勿手改）",
	"",
	`由 \`node scripts/gen-core-ownership.mjs\` 从 \`server/agent-service.ts\` 的 \`ClientSession\` 扫描得到：共 ${rows.length} 个可变字段。`,
	"每个字段必须恰好一个所有者；`?` 是待裁定的争议项，只在 W1 内收敛，不许长期停留。",
	"",
	"| 域 | 字段数 | 字段（占用方法数） |",
	"| --- | --- | --- |",
];

for (const [domain, list] of [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length)) {
	const cells = list
		.slice(0, 40)
		.map((r) => `${r.field}(${r.touches})`)
		.join(" · ");
	const more = list.length > 40 ? ` … +${list.length - 40}` : "";
	lines.push(`| ${domain} | ${list.length} | ${cells}${more} |`);
}

const unknown = byDomain.get("?") ?? [];
lines.push("", `待裁定（\`?\`）：${unknown.length} 个 —— ${unknown.map((r) => r.field).join(" · ") || "无"}`, "");

const prettier = await import("prettier");
const content = await prettier.format(lines.join("\n"), {
	...(await prettier.resolveConfig(TARGET)),
	parser: "markdown",
});
if (process.argv.includes("--check")) {
	const current = readFileSync(TARGET, "utf8");
	if (current !== content) {
		console.error("✗ server/core/OWNERSHIP.md 已过期，请运行 node scripts/gen-core-ownership.mjs");
		process.exit(1);
	}
	console.log("✓ OWNERSHIP.md 与源码一致");
} else {
	writeFileSync(TARGET, content);
	console.log(`✓ 写入 ${TARGET}（${rows.length} 字段 / ${byDomain.size} 域）`);
}
