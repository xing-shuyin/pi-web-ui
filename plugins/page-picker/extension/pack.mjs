/**
 * 打分发用的 zip：`release/page-picker-extension-<版本>.zip`。
 *
 * 目的：让**没有 Node 的人**也能装 —— 下载 zip、解压、在 chrome://extensions 里
 * 「加载已解压的扩展程序」，不需要 clone 仓库、不需要构建。
 *
 * 三个硬要求（都有检查，宁可失败也不要出一个装不上的包）：
 * 1. zip 根目录直接就是 `manifest.json`（否则 Chrome 加载不了）；
 * 2. 只装运行时需要的东西（`src/` 不给，免得用户对着 TypeScript 源码困惑）；
 * 3. 写完自己读一遍校验条目与 CRC —— 「包是坏的」这种事不该等到用户手里才发现。
 *
 * 用法：node plugins/page-picker/extension/pack.mjs   （或 npm run pack:extension）
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip, readZip } from "./zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const outDir = join(repoRoot, "release");

/** 必须存在的文件（缺一个就是没构建 / 构建残缺）。 */
const REQUIRED = ["manifest.json", "options.html"];

function collect(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collect(full, out);
		else out.push(full);
	}
	return out;
}

function main() {
	// dist/ 不在就明确报错（而不是打出一个只有 manifest 的空壳包）
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

	const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
	const version = manifest.version ?? "0.0.0";

	const entries = [...entryFiles, ...distFiles]
		.map((full) => ({
			// zip 内一律用 / 分隔（Windows 的 \ 会让解压器建出奇怪的文件名）
			name: relative(here, full).split("\\").join("/"),
			data: new Uint8Array(readFileSync(full)),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	const zip = buildZip(entries);

	// 自校验：读回来 → 条目一致 + manifest 在根目录（解压器不会告诉我们这些）
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

	mkdirSync(outDir, { recursive: true });
	const versioned = join(outDir, `page-picker-extension-${version}.zip`);
	writeFileSync(versioned, zip);
	// 无版本号别名：README 里用它做**永远指向最新**的下载链接
	//（GitHub 的 /releases/latest/download/<name> 要求文件名固定），代价只是多 64KB
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
