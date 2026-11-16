#!/usr/bin/env node
/**
 * 硬编码文案清点器（I18N 去硬编码的度量基线）。
 *
 * 扫描 web/src 下除 i18n/messages 之外的 .ts/.tsx，收集「含中日韩文字的字符串字面量」，
 * 默认输出统计；--write 重写 tests/fixtures/i18n-hardcoded-allowlist.json；
 * --json 打印明细（供人工核对）。守卫测试 tests/unit/i18n-hardcoded-guard.test.ts 复用同一实现。
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWLIST_PATH = "tests/fixtures/i18n-hardcoded-allowlist.json";
const SCAN_ROOT = "web/src";
const SKIP_DIRS = new Set(["i18n/messages", "node_modules", "dist"]);
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 单行内的 "..." / '...' / `...`；跨行模板在这里按行切分，宁可少报也不误报。
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;

function walk(base, out = []) {
	for (const name of readdirSync(base)) {
		const full = join(base, name);
		const rel = relative(base, full).replaceAll("\\", "/");
		if (SKIP_DIRS.has(rel) || SKIP_DIRS.has(name)) continue;
		const stat = statSync(full);
		if (stat.isDirectory()) walk(full, out);
		else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
	}
	return out;
}

/** 文案是否已由词典提供（`t("...")` 的实参不是界面文案，不参与统计）。 */
function isTranslationKeyCall(line) {
	return /\b(?:t|useT|tr)\(\s*$/.test(line.slice(0, line.search(LITERAL) === -1 ? 0 : 0));
}

export function collectLiterals(rootDir) {
	const base = join(rootDir, SCAN_ROOT);
	const byFile = new Map();
	for (const file of walk(base)) {
		const rel = relative(rootDir, file).replaceAll("\\", "/");
		const lines = readFileSync(file, "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue; // 纯注释行不算界面文案
			for (const match of line.matchAll(LITERAL)) {
				const text = match[2];
				if (!CJK.test(text)) continue;
				if (isTranslationKeyCall(line)) continue;
				const key = `${rel}\u0000${text}`;
				const existing = byFile.get(key);
				if (existing) existing.count += 1;
				else byFile.set(key, { file: rel, text, count: 1, line: i + 1 });
			}
		}
	}
	return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file) || a.text.localeCompare(b.text));
}

export function diffAgainstAllowlist(found, allow = []) {
	const foundKey = new Map(found.map((entry) => [`${entry.file}\u0000${entry.text}`, entry]));
	const allowKey = new Map(
		allow
			.filter((entry) => entry && typeof entry.file === "string")
			.map((entry) => [`${entry.file}\u0000${entry.text}`, entry]),
	);
	const added = [];
	for (const [key, entry] of foundKey) {
		const allowed = allowKey.get(key);
		if (!allowed) added.push({ file: entry.file, text: entry.text, count: entry.count, line: entry.line });
		else if (entry.count > allowed.count)
			added.push({ file: entry.file, text: entry.text, count: entry.count, was: allowed.count, line: entry.line });
	}
	const stale = [];
	for (const [key, entry] of allowKey) {
		const current = foundKey.get(key);
		if (!current) stale.push({ file: entry.file, text: entry.text, count: entry.count, was: entry.count, now: 0 });
		else if (current.count < entry.count) {
			stale.push({ file: entry.file, text: entry.text, count: entry.count, was: entry.count, now: current.count });
		}
	}
	return { added, stale };
}

function main() {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const argv = process.argv.slice(2);
	const found = collectLiterals(root);
	if (argv.includes("--json")) {
		console.log(JSON.stringify(found, null, 1));
		return;
	}
	const allowPath = join(root, ALLOWLIST_PATH);
	const allow = JSON.parse(readFileSync(allowPath, "utf8"));
	if (argv.includes("--write")) {
		const previous = new Map((allow.entries ?? []).map((entry) => [`${entry.file}\u0000${entry.text}`, entry.reason]));
		const entries = found.map((entry) => ({
			file: entry.file,
			text: entry.text,
			count: entry.count,
			reason:
				previous.get(`${entry.file}\u0000${entry.text}`) ??
				(/\/(?:mcp|skill)-catalog\.ts$/.test(entry.file) ? "data" : "pending"),
		}));
		writeFileSync(allowPath, `${JSON.stringify({ note: allow.note ?? "", entries }, null, "\t")}\n`, "utf8");
		console.log(
			`已写入 ${ALLOWLIST_PATH}：${entries.length} 条，覆盖 ${new Set(entries.map((e) => e.file)).size} 个文件`,
		);
		return;
	}
	const { added, stale } = diffAgainstAllowlist(found, allow.entries);
	const files = new Set(found.map((entry) => entry.file));
	console.log(`硬编码文案：${found.length} 条，分布在 ${files.size} 个文件`);
	if (added.length)
		console.log(
			`新增 ${added.length} 条（未登记）：\n${added
				.slice(0, 20)
				.map((e) => `  ${e.file}:${e.line ?? "?"} ${e.text}`)
				.join("\n")}`,
		);
	if (stale.length)
		console.log(
			`陈旧 ${stale.length} 条（名单里多余）：\n${stale
				.slice(0, 20)
				.map((e) => `  ${e.file} ${e.text}`)
				.join("\n")}`,
		);
	if (!added.length && !stale.length) console.log("✓ 与 allowlist 完全一致");
	process.exitCode = added.length || stale.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
