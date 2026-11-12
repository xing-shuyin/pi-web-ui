import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 客户端模块由宿主按 /plugins/<id>/client/* 静态下发：相对 import 指错文件时，
// 只有打开插件视图才会炸（表现为「插件视图加载失败」），所以在这里静态兜住。
const CLIENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "client");

function listModules(dir, sub = "") {
	const out = [];
	for (const ent of readdirSync(join(dir, sub), { withFileTypes: true })) {
		const rel = sub ? `${sub}/${ent.name}` : ent.name;
		if (ent.isDirectory()) {
			if (ent.name === "node_modules" || ent.name === "vendor") continue;
			out.push(...listModules(dir, rel));
		} else if (ent.isFile() && ent.name.endsWith(".mjs")) {
			out.push(rel);
		}
	}
	return out;
}

const SPECIFIER =
	/(?:^|[^.\w])import\s+(?:[^'"]*?\sfrom\s*)?["'](\.[^"']+)["']|export\s+[^'"]*?\sfrom\s*["'](\.[^"']+)["']/g;

test("客户端模块：所有相对 import 都指向真实存在的文件", () => {
	const problems = [];
	for (const rel of listModules(CLIENT_DIR)) {
		const file = join(CLIENT_DIR, rel);
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(SPECIFIER)) {
			const spec = m[1] || m[2];
			if (!spec) continue;
			const clean = spec.split("?")[0];
			const target = resolve(dirname(file), clean);
			if (!existsSync(target)) problems.push(`${rel} → ${spec}`);
		}
	}
	assert.deepEqual(problems, [], "客户端相对 import 指向了不存在的文件");
});

test("客户端模块：不越过 client/ 目录 import 服务端代码", () => {
	const problems = [];
	for (const rel of listModules(CLIENT_DIR)) {
		const file = join(CLIENT_DIR, rel);
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(SPECIFIER)) {
			const spec = m[1] || m[2];
			if (!spec) continue;
			const target = resolve(dirname(file), spec.split("?")[0]);
			if (!target.startsWith(CLIENT_DIR)) problems.push(`${rel} → ${spec}`);
		}
	}
	assert.deepEqual(problems, [], "浏览器只能拿 client/ 里的文件，不能引用服务端模块");
});
