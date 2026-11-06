#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diffWorktreeVsBase, renderI18nSection, resolveBase } from "./i18n-diff.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(root, "CHANGELOG.md");

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

function extractSection(src, version) {
	const ver = version.replace(/^v/, "");
	const lines = src.split("\n");
	const start = lines.findIndex((l) => l.startsWith(`## [${ver}]`));
	if (start === -1) fail(`CHANGELOG.md 里找不到 ## [${ver}] 小节，先按发布流程第 2 步写好 CHANGELOG`);
	let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
	if (end === -1) end = lines.length;
	return {
		header: lines[start],
		body: lines
			.slice(start + 1, end)
			.join("\n")
			.replace(/\n+$/, ""),
	};
}

function replaceI18n(body, i18nLines) {
	const lines = body.split("\n");
	const idx = lines.findIndex((l) => l.trim() === "### i18n");
	const block = ["### i18n", "", ...i18nLines];
	if (idx === -1) return [...lines, "", ...block].join("\n");
	let end = lines.findIndex((l, i) => i > idx && l.startsWith("### "));
	if (end === -1) end = lines.length;
	return [...lines.slice(0, idx), ...block, ...lines.slice(end)].join("\n");
}

function hasDelta(d) {
	return (
		d.frontend.added.length > 0 ||
		d.frontend.removed.length > 0 ||
		d.frontend.changedZh.length > 0 ||
		d.frontend.changedEn.length > 0 ||
		d.server.added.length > 0 ||
		d.server.removed.length > 0 ||
		d.server.changed.length > 0
	);
}

const AUTO_START = "<!-- auto-i18n:start -->";
const AUTO_END = "<!-- auto-i18n:end -->";
const UNRELEASED_PLACEHOLDER = "暂无未发布内容。";

function refreshUnreleased(changelog, i18nLines, delta) {
	const lines = changelog.split("\n");
	const start = lines.findIndex((l) => l.startsWith("## [Unreleased]"));
	if (start === -1) fail("CHANGELOG.md 里找不到 ## [Unreleased] 小节");
	let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
	if (end === -1) end = lines.length;
	const body = lines.slice(start + 1, end);
	let manual = body.filter((l) => l.trim() !== UNRELEASED_PLACEHOLDER);
	const s = manual.findIndex((l) => l.trim() === AUTO_START);
	const e = manual.findIndex((l) => l.trim() === AUTO_END);
	if (s !== -1 && e !== -1 && e > s) manual = [...manual.slice(0, s), ...manual.slice(e + 1)];
	while (manual.length > 0 && manual[0].trim() === "") manual.shift();
	while (manual.length > 0 && manual[manual.length - 1].trim() === "") manual.pop();
	let newBody;
	if (delta) {
		newBody = ["", ...manual, "", AUTO_START, "### i18n", "", ...i18nLines, AUTO_END, ""];
		if (manual.length === 0) newBody = ["", AUTO_START, "### i18n", "", ...i18nLines, AUTO_END, ""];
	} else {
		newBody = manual.length === 0 ? ["", UNRELEASED_PLACEHOLDER, ""] : ["", ...manual, ""];
	}
	return [...lines.slice(0, start + 1), ...newBody, ...lines.slice(end)].join("\n");
}

function main() {
	const argv = process.argv.slice(2).filter((a) => a !== "--");
	const getOpt = (name) => {
		const i = argv.indexOf(name);
		return i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
	};
	const pos = argv.filter((a) => !a.startsWith("--"));
	if (argv.includes("-h") || argv.includes("--help") || (pos.length === 0 && !argv.includes("--unreleased"))) {
		console.log(
			"用法：node scripts/release-notes.mjs <版本号> [--base <tag>] [--out 文件] [--write-changelog] [--create]\n" +
				"      node scripts/release-notes.mjs --unreleased [--base <tag>]（刷新 ## [Unreleased] 的自动 i18n 块）",
		);
		return;
	}
	if (argv.includes("--unreleased")) {
		const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
		const base = resolveBase(getOpt("--base"), pkgVersion);
		const diff = diffWorktreeVsBase(base);
		const delta = hasDelta(diff);
		const updated = refreshUnreleased(readFileSync(CHANGELOG, "utf8"), renderI18nSection(diff), delta);
		writeFileSync(CHANGELOG, updated);
		console.log(`✓ ## [Unreleased] 的 ### i18n 已刷新（base ${base}，${delta ? "有增量" : "无增量"}）`);
		return;
	}
	const version = pos[0].replace(/^v/, "");
	const base = resolveBase(getOpt("--base"));
	const diff = diffWorktreeVsBase(base);
	const i18nLines = renderI18nSection(diff);

	const changelog = readFileSync(CHANGELOG, "utf8");
	const { body } = extractSection(changelog, version);
	const notes = `${replaceI18n(body, i18nLines)}\n\n<!-- release-notes: i18n 小节由 scripts/release-notes.mjs 按 ${base}...工作区现场生成 -->\n`;

	if (argv.includes("--write-changelog")) {
		const patched = changelog.replace(body, () => replaceI18n(body, i18nLines));
		writeFileSync(CHANGELOG, patched);
		console.log(`✓ CHANGELOG.md ## [${version}] 的 ### i18n 已同步（base ${base}）`);
	}

	const out = getOpt("--out");
	if (out) {
		writeFileSync(out, notes);
		console.log(`✓ Release 说明已写入 ${out}`);
	} else if (!argv.includes("--create")) {
		process.stdout.write(notes);
	}

	if (argv.includes("--create")) {
		const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
		const file = join(dir, "notes.md");
		writeFileSync(file, notes);
		execFileSync("gh", ["release", "create", `v${version}`, "--title", `v${version}`, "--notes-file", file], {
			cwd: root,
			stdio: "inherit",
		});
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
