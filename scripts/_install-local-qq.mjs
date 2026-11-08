// 一次性本地安装：把仓库里「未发布」的 plugins/qq 装进 dataDir（不走线上市场）
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

const SRC = "plugins/qq";
const DST = join(homedir(), ".pi-web", "plugins", "qq");
// 用户态 / 开发态文件：绝不从仓库拷过去（仓库里的 secrets.bin 是别的机器的旧密钥）
const EXCLUDE = new Set(["storage.json", "secrets.bin", ".pi-approved"]);
const EXCLUDE_PATH = /(^|[\\/])(\.git|node_modules)([\\/]|$)|\.tmp$/;

function walk(dir, base = dir, out = []) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, e.name);
		if (EXCLUDE_PATH.test(abs)) continue;
		const rel = relative(base, abs).split("\\").join("/");
		if (EXCLUDE.has(rel)) continue;
		if (e.isDirectory()) walk(abs, base, out);
		else out.push(rel);
	}
	return out;
}

const files = walk(SRC);
if (existsSync(DST)) {
	const bak = `${DST}.bak-${Date.now()}`;
	renameSync(DST, bak);
	console.log(`已备份旧目录 → ${bak}`);
}
for (const rel of files) {
	const to = join(DST, rel);
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(join(SRC, rel), to);
}
const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 12);
const rows = files.map((rel) => {
	const a = hash(join(SRC, rel));
	const b = existsSync(join(DST, rel)) ? hash(join(DST, rel)) : "";
	return { rel, ok: a === b, size: statSync(join(DST, rel)).size };
});
console.log(`复制文件数: ${files.length}，hash 全部一致: ${rows.every((r) => r.ok)}`);
for (const r of rows) console.log(`  ${r.ok ? "✓" : "✗"} ${r.rel} (${r.size}B)`);
const m = JSON.parse(readFileSync(join(DST, "manifest.json"), "utf8"));
console.log(
	"manifest:",
	JSON.stringify({
		id: m.id,
		name: m.name,
		version: m.version,
		alwaysOn: m.alwaysOn,
		apiVersion: m.apiVersion,
		permissions: m.permissions,
	}),
);
const copied = new Set(files);
console.log("=== 未复制的用户态文件（仓库里存在，但属于别的机器） ===");
for (const f of EXCLUDE) {
	const p = join(SRC, f);
	if (existsSync(p) && !copied.has(f)) console.log(`  ${f} (${statSync(p).size}B)`);
}
