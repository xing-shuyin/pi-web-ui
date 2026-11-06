import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip, readZip } from "./zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const outDir = join(repoRoot, "release");

const REQUIRED = ["manifest.json", "options.html"];

const REQUIRED_LOCALES = ["_locales/en/messages.json", "_locales/zh_CN/messages.json"];

const REQUIRED_DIST = ["background.js", "picker.js", "bind.js", "bridge.js", "options.js"];

function collect(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collect(full, out);
		else out.push(full);
	}
	return out;
}

function main() {
	let distFiles = [];
	try {
		distFiles = collect(join(here, "dist")).filter((f) => !f.endsWith(".map"));
	} catch {
		console.error("✗ 缺 dist/ —— 先跑 npm run build:extension");
		process.exit(1);
	}
	const entryFiles = REQUIRED.map((n) => join(here, n));
	const missing = REQUIRED.filter((n) => !entryFiles.some((f) => f.endsWith(n)));
	if (missing.length > 0) {
		console.error(`✗ 缺文件：${missing.join(", ")}`);
		process.exit(1);
	}
	if (distFiles.length === 0) {
		console.error("✗ dist/ 是空的 —— 先跑 npm run build:extension");
		process.exit(1);
	}
	const missingDist = REQUIRED_DIST.filter(
		(name) => !distFiles.some((f) => f.endsWith(join("dist", name)) || f.endsWith(`dist/${name}`)),
	);
	if (missingDist.length > 0) {
		console.error(`✗ dist/ 里缺 ${missingDist.join(", ")} —— 先跑 npm run build:extension`);
		process.exit(1);
	}

	let localeFiles = [];
	try {
		localeFiles = collect(join(here, "_locales")).filter((f) => f.endsWith(".json"));
	} catch {
		console.error("✗ 缺 _locales/ —— 扩展多语言文件缺失");
		process.exit(1);
	}
	const missingLocales = REQUIRED_LOCALES.filter(
		(name) => !localeFiles.some((f) => relative(here, f).split("\\").join("/") === name),
	);
	if (missingLocales.length > 0) {
		console.error(`✗ _locales/ 里缺 ${missingLocales.join(", ")}`);
		process.exit(1);
	}

	const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
	const version = manifest.version ?? "0.0.0";

	const entries = [...entryFiles, ...distFiles, ...localeFiles]
		.map((full) => ({
			name: relative(here, full).split("\\").join("/"),
			data: new Uint8Array(readFileSync(full)),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	const zip = buildZip(entries);

	const info = readZip(zip);
	const names = info.entries.map((e) => e.name);
	if (names.length !== entries.length) {
		console.error(`✗ 自校验失败：写入 ${entries.length} 个条目，读回 ${names.length} 个`);
		process.exit(1);
	}
	if (!names.includes("manifest.json")) {
		console.error("✗ 自校验失败：manifest.json 不在 zip 根目录，Chrome 会拒绝加载");
		process.exit(1);
	}
	if (!names.includes("_locales/en/messages.json") || !names.includes("_locales/zh_CN/messages.json")) {
		console.error("✗ 自校验失败：_locales 语言包缺失，Chrome 会拒绝加载扩展");
		process.exit(1);
	}

	mkdirSync(outDir, { recursive: true });
	const versioned = join(outDir, `page-picker-extension-${version}.zip`);
	writeFileSync(versioned, zip);
	const alias = join(outDir, "page-picker-extension.zip");
	writeFileSync(alias, zip);

	const kb = (zip.length / 1024).toFixed(1);
	const rel = (f) => relative(repoRoot, f).split("\\").join("/");
	console.log(`✓ ${rel(versioned)}  (${entries.length} 个文件, ${kb} KB)`);
	console.log(`  ${rel(alias)}  （同内容，稳定链接用）`);
	for (const e of info.entries) console.log(`    ${e.name}  (${e.size} B)`);
	console.log("  解压后把整个目录用「加载已解压的扩展程序」装进 Chrome");
}

main();
