import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankNonCode } from "../helpers/code-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const SYNC_APIS = /\b(spawnSync|execSync|execFileSync)\s*\(/g;

// 已清零：server/ 与 plugins/ 不再有同步子进程调用（全部走 run-process / git-run / 异步 execFile）。
// 新增违规直接红，不允许再往这里登记 —— 异步化或静态推导都能解决，见 docs/agent-rules.md §四。
const ALLOWED: Record<string, { count: number; reason: string }> = {};

const OUT_OF_SCOPE = [/\/bin\//, /\/assets\//, /\/build\.mjs$/, /\/scripts?\//, /\/web\//];

interface Hit {
	file: string;
	line: number;
	api: string;
}

function findSyncChildProcessCalls(source: string, file = "inline"): Hit[] {
	const hits: Hit[] = [];
	blankNonCode(source)
		.split("\n")
		.forEach((line, index) => {
			for (const m of line.matchAll(SYNC_APIS)) hits.push({ file, line: index + 1, api: m[1] });
		});
	return hits;
}

function walk(dir: string, out: string[] = []): string[] {
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(ts|mjs|js)$/.test(path) && !path.endsWith(".d.ts")) {
			const rel = relative(root, path).replace(/\\/g, "/");
			if (!OUT_OF_SCOPE.some((re) => re.test(rel))) out.push(rel);
		}
	}
	return out;
}

const scanned = [
	...walk(join(root, "server")),
	...walk(join(root, "plugins")),
	// 扩展跑在 pi 宿主主进程里（与 server 共用事件循环），同一套禁令
	...walk(join(root, "extensions")),
].sort();
const hits = scanned
	.flatMap((file) => findSyncChildProcessCalls(readFileSync(join(root, file), "utf8"), file))
	.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

function countsByFile(list: Hit[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const hit of list) counts[hit.file] = (counts[hit.file] ?? 0) + 1;
	return counts;
}

describe("服务端禁同步子进程调用", () => {
	it("扫描器本身可靠：注释/字符串/模板文本/正则里的调用不算，真实调用要抓到", () => {
		const cases: Array<[string, string]> = [
			['// spawnSync("a") 在行注释里', 'const a = 1; // spawnSync("a")'],
			["块注释", "/*\nspawnSync('b')\n*/\nconst c = 2;"],
			["普通字符串", 'const d = "execSync(\\"x\\")";'],
			["模板文本里的撇号，其后跟真实调用", 'const e = `it\'s fine`; execSync("x");'],
			["模板文本里的 //，其后跟真实调用", 'const f = `https://x`; execSync("y");'],
			["正则字面量里的 //，其后跟真实调用", 'const g = /\\/\\//; execSync("z");'],
			["模板插值里是真实代码，要抓到", 'const h = `${execSync("npm root -g")}`;'],
		];
		const problems: string[] = [];
		for (const [name, source] of cases) {
			const found = findSyncChildProcessCalls(source);
			const expected = name.startsWith("模板插值") ? 1 : name.includes("真实调用") ? 1 : 0;
			if (found.length !== expected) problems.push(`${name}：期望 ${expected}，实际 ${found.length}`);
		}
		expect(problems).toEqual([]);
	});

	it("范围内没有名单外的同步子进程调用", () => {
		const offending = hits.filter((hit) => !(hit.file in ALLOWED));
		expect(
			offending.map((hit) => `${hit.file}:${hit.line} → ${hit.api}`),
			"新增同步子进程调用会让事件循环阻塞到子进程结束（见 docs/agent-rules.md §四）。改用异步 spawn/execFile，或把结果静态推导出来。",
		).toEqual([]);
	});

	it("存量名单只许变短：次数超出即红，命中变少要下调，归零要删行", () => {
		const counts = countsByFile(hits);
		const problems: string[] = [];
		for (const [file, entry] of Object.entries(ALLOWED)) {
			const actual = counts[file] ?? 0;
			if (actual > entry.count) problems.push(`${file}：新增到 ${actual} 次（上限 ${entry.count}）`);
			if (actual === 0) problems.push(`${file}：已无同步调用，请删掉这一行`);
			else if (actual < entry.count) problems.push(`${file}：只剩 ${actual} 次，请把上限从 ${entry.count} 下调`);
		}
		expect(problems).toEqual([]);
	});
});
