import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDir = join(repoRoot, "release");

async function main() {
	const files = readdirSync(releaseDir);
	const exeFile = files.find((f) => f.endsWith(".exe") && !f.endsWith(".blockmap"));
	if (!exeFile) {
		console.warn("[refresh-metadata] 未在 release/ 目录下找到 .exe 文件，跳过刷新");
		return;
	}

	const exePath = join(releaseDir, exeFile);
	const exeBuf = readFileSync(exePath);
	const newSha512 = createHash("sha512").update(exeBuf).digest("base64");
	const newSize = exeBuf.length;

	console.log(`[refresh-metadata] 目标文件: ${exeFile}`);
	console.log(`[refresh-metadata] 新 SHA-512: ${newSha512}`);
	console.log(`[refresh-metadata] 新文件大小: ${newSize} bytes`);

	const blockmapFile = `${exeFile}.blockmap`;
	const blockmapPath = join(releaseDir, blockmapFile);
	try {
		const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");
		await buildBlockMap(exePath, "gzip", blockmapPath);
		console.log(`[refresh-metadata] 已重新生成 blockmap: ${blockmapFile}`);
	} catch (err) {
		console.warn(`[refresh-metadata] 无法使用 app-builder-lib 生成 blockmap (${err.message})，跳过 blockmap 刷新`);
	}

	const latestYmlPath = join(releaseDir, "latest.yml");
	try {
		let content = readFileSync(latestYmlPath, "utf-8");
		content = content.replace(/(sha512:\s*)[^\r\n]+/g, `$1${newSha512}`);
		content = content.replace(/(size:\s*)\d+/g, `$1${newSize}`);
		writeFileSync(latestYmlPath, content, "utf-8");
		console.log(`[refresh-metadata] 已更新 latest.yml 中的哈希与尺寸`);
	} catch (err) {
		console.warn(`[refresh-metadata] 未找到 latest.yml 或更新失败: ${err.message}`);
	}
}

main().catch((err) => {
	console.error("[refresh-metadata] 失败:", err);
	process.exit(1);
});
