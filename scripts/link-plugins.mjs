#!/usr/bin/env node

import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const repoPluginsDir = join(repoRoot, "plugins");
const catalogPath = join(repoPluginsDir, "catalog.json");

const dataDir = process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web");
const userPluginsDir = join(dataDir, "plugins");

const isWin = process.platform === "win32";

const args = process.argv.slice(2);
const isUnlink = args.includes("--unlink") || args.includes("-u");
const targetPluginId = args.find((a) => !a.startsWith("-"));

function getBuiltinPluginIds() {
	if (targetPluginId) return [targetPluginId];
	if (!existsSync(catalogPath)) return [];
	try {
		const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
		return Array.isArray(raw) ? raw.map((e) => e?.id).filter(Boolean) : [];
	} catch {
		return [];
	}
}

export function linkPlugin(id, { repoDir = repoPluginsDir, targetDir = userPluginsDir } = {}) {
	const src = join(repoDir, id);
	const dest = join(targetDir, id);
	const bak = join(targetDir, `${id}.bak`);

	if (!existsSync(src)) {
		console.warn(`[link-plugins] 源码目录不存在，跳过: ${src}`);
		return false;
	}

	mkdirSync(targetDir, { recursive: true });

	if (existsSync(dest)) {
		const stat = lstatSync(dest);
		if (stat.isSymbolicLink()) {
			console.log(`[link-plugins] ✓ ${id} 已经是软链接，无需操作`);
			return true;
		}
		if (existsSync(bak)) rmSync(bak, { recursive: true, force: true });
		renameSync(dest, bak);
		console.log(`[link-plugins] 旧目录已备份至 ${id}.bak`);
	}

	symlinkSync(src, dest, isWin ? "junction" : "dir");
	console.log(`[link-plugins] ✓ 成功链接: ${id} → ${src}`);
	return true;
}

export function unlinkPlugin(id, { repoDir = repoPluginsDir, targetDir = userPluginsDir } = {}) {
	const src = join(repoDir, id);
	const dest = join(targetDir, id);
	const bak = join(targetDir, `${id}.bak`);

	if (!existsSync(dest)) {
		console.log(`[link-plugins] 目录不存在，跳过: ${dest}`);
		return true;
	}

	const stat = lstatSync(dest);
	if (!stat.isSymbolicLink()) {
		console.log(`[link-plugins] ${id} 是普通目录，不是软链接，无需解除`);
		return true;
	}

	rmSync(dest, { force: true });

	if (existsSync(bak)) {
		renameSync(bak, dest);
		console.log(`[link-plugins] ✓ 已恢复备份目录: ${id}`);
	} else if (existsSync(src)) {
		cpSync(src, dest, { recursive: true });
		console.log(`[link-plugins] ✓ 已从源码复制独立副本: ${id}`);
	} else {
		console.log(`[link-plugins] ✓ 已移除软链接: ${id}`);
	}
	return true;
}

export function cleanBrokenSymlinks({ targetDir = userPluginsDir } = {}) {
	if (!existsSync(targetDir)) return [];
	const removed = [];
	try {
		for (const name of readdirSync(targetDir)) {
			const p = join(targetDir, name);
			try {
				const st = lstatSync(p);
				if (st.isSymbolicLink() && !existsSync(p)) {
					rmSync(p, { force: true });
					console.log(`[link-plugins] 自动清理失效软链接: ${name}`);
					removed.push(name);
				}
			} catch {}
		}
	} catch {}
	return removed;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	cleanBrokenSymlinks();
	const ids = getBuiltinPluginIds();
	if (ids.length === 0) {
		console.log("[link-plugins] 未找到内置插件，退出。");
		process.exit(0);
	}

	console.log(`[link-plugins] ${isUnlink ? "解除链接" : "建立软链接"}目标目录: ${userPluginsDir}`);
	for (const id of ids) {
		if (isUnlink) {
			unlinkPlugin(id);
		} else {
			linkPlugin(id);
		}
	}
	console.log(
		`[link-plugins] 完成！${isUnlink ? "已恢复为独立副本" : "现在修改 plugins/ 源码将实时生效，无需手动复制"}`,
	);
}
