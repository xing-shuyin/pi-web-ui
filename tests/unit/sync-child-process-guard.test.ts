/**
 * 服务端禁同步子进程调用守卫（对应 `docs/agent-rules.md` §四「服务端禁同步子进程调用」）。
 *
 * 背景：`spawnSync` / `execSync` / `execFileSync` 在事件循环线程上 fork+exec，并**阻塞到
 * 子进程结束**。子进程若卡在 `exec()` 之前，主线程就永远停在 spawn 错误管道的 `read()` 上，
 * 定时器、socket、`/api/health` 全部停摆 —— 只能靠外部 watchdog 杀进程（2026-11-02 在
 * Termux/Android 上一天之内复现三次，见 `#830`）。异步 `spawn` / `execFile` 不会被拖到子进程
 * 结束，所以修复方向是「换异步」或「静态推导」，而不是加超时。
 *
 * **扫描范围包含插件运行时**：`server/plugins.ts` 用 `import()` 把 `plugins/<id>/index.mjs`
 * 载进主进程，插件代码与服务器共用同一个事件循环，所以插件里的一次同步 spawn 同样能把
 * pi-web 冻住。`bin/`、`assets/`、`build.mjs` 这类**在自己进程里**跑的东西才排除。
 *
 * 本测试锁两件事：
 *   1. 范围里不得**新增**同步子进程调用（存量登记在 ALLOWED 里，按**次数**记账）；
 *   2. ALLOWED 只许变短：某条命中变少要下调次数，归零则整行删除。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const SYNC_APIS = /\b(spawnSync|execSync|execFileSync)\s*\(/g;

/**
 * 存量名单：file → { count, reason }。次数是**天花板**，只许下调或整行删除。
 * 新代码请直接用异步 spawn 或静态推导，不要往这里加。
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
	"server/plugin-facilities.ts": { count: 1, reason: "插件设施开关的同步调用，迁移到异步 spawn 待办" },
	"server/eval-tool.ts": { count: 2, reason: "`taskkill` / `--version` 探测，工具调用路径，迁移待办" },
	"server/plugin-assets.ts": { count: 1, reason: "`tar` 解包整段阻塞事件循环，最该优先迁移的一个" },
	"server/device-center/desktop-linux.ts": { count: 2, reason: "`xrandr` / `xdpyinfo` 探测，LAN 客户端可触发" },
	"server/device-center/desktop-native.ts": { count: 1, reason: "`xcrun` 探测，仅 macOS" },
	// 插件主进程代码：uv 探测在事件处理里被 await，同样能冻住事件循环
	"plugins/bili-scroll/lib/uvfetch.mjs": { count: 6, reason: "插件里探测 `uv` 版本，迁移到异步 spawn 待办" },
};

/**
 * 扫描范围内的排除项：这些文件在**自己的进程**里运行，不阻塞服务端事件循环。
 */
const OUT_OF_SCOPE = [
	/\/bin\//, // 插件命令行入口，独立进程
	/\/assets\//, // 随包资产（CLI 包装），不经服务端 import
	/\/build\.mjs$/, // 构建脚本
	/\/scripts?\//, // 工具脚本
	/\/web\//, // 前端代码，跑在浏览器里
];

const REGEX_PRECEDER_CHARS = "([{,;:=!&|?+-*%<>^~";
const REGEX_PRECEDER_WORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|instanceof|new|do|else|yield|await)$/;

/**
 * 把注释、字符串、模板文本、正则字面量的内容抹成空格（保留换行与代码骨架，行号不变）。
 *
 * 模板的 `${...}` 里是**真实代码**，会照常扫描；`\`\` ` 文本、`//`、`/* *\/`、`/re/`
 * 里的文本不会。宁可多报也不漏报 —— 漏报的守卫等于没有守卫。
 */
function blankNonCode(src: string): string {
	const chars = [...src];
	const n = chars.length;
	const blank = (from: number, to: number) => {
		for (let i = from; i < to && i < n; i++) if (chars[i] !== "\n") chars[i] = " ";
	};
	type Frame = { kind: "template" } | { kind: "expr"; depth: number };
	const stack: Frame[] = [];
	let i = 0;
	let prevSignificant = "";

	while (i < n) {
		const frame = stack[stack.length - 1];

		if (frame?.kind === "template") {
			const c = src[i];
			if (c === "\\") {
				blank(i, i + 2);
				i += 2;
				continue;
			}
			if (c === "`") {
				stack.pop();
				prevSignificant = "`";
				i++;
				continue;
			}
			if (c === "$" && src[i + 1] === "{") {
				stack.push({ kind: "expr", depth: 0 });
				blank(i, i + 2);
				i += 2;
				continue;
			}
			blank(i, i + 1);
			i++;
			continue;
		}

		const c = src[i];
		const next = src[i + 1];

		if (c === "/" && next === "/") {
			let j = i;
			while (j < n && src[j] !== "\n") j++;
			blank(i, j);
			i = j;
			continue;
		}

		if (c === "/" && next === "*") {
			let j = i + 2;
			while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
			blank(i, Math.min(j + 2, n));
			i = j + 2;
			continue;
		}

		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < n) {
				if (src[j] === "\\") {
					j += 2;
					continue;
				}
				if (src[j] === c || src[j] === "\n") break;
				j++;
			}
			blank(i + 1, Math.max(i + 1, j));
			i = j + 1;
			prevSignificant = c;
			continue;
		}

		if (c === "`") {
			stack.push({ kind: "template" });
			i++;
			continue;
		}

		if (c === "/") {
			const wordBefore = /[\w$]+$/.exec(chars.slice(Math.max(0, i - 32), i).join(""));
			const startsRegex =
				!prevSignificant ||
				REGEX_PRECEDER_CHARS.includes(prevSignificant) ||
				(!!wordBefore && REGEX_PRECEDER_WORDS.test(wordBefore[0]));
			if (startsRegex) {
				let j = i + 1;
				let inClass = false;
				while (j < n) {
					const ch = src[j];
					if (ch === "\\") {
						j += 2;
						continue;
					}
					if (ch === "\n") break;
					if (inClass) {
						if (ch === "]") inClass = false;
					} else if (ch === "[") inClass = true;
					else if (ch === "/") {
						j++;
						break;
					}
					j++;
				}
				blank(i + 1, Math.max(i + 1, j - 1));
				i = j;
				prevSignificant = "/";
				continue;
			}
		}

		if (frame?.kind === "expr") {
			if (c === "}") {
				if (frame.depth === 0) {
					stack.pop();
					blank(i, i + 1);
					i++;
					prevSignificant = "}";
					continue;
				}
				frame.depth--;
			} else if (c === "{") {
				frame.depth++;
			}
		}

		if (!/\s/.test(c)) prevSignificant = c;
		i++;
	}

	return chars.join("");
}

interface Hit {
	file: string;
	line: number;
	api: string;
}

/** 扫一段源码里的同步子进程调用（行号 1 起）。 */
function findSyncChildProcessCalls(source: string, file = "inline"): Hit[] {
	const hits: Hit[] = [];
	blankNonCode(source)
		.split("\n")
		.forEach((line, index) => {
			for (const m of line.matchAll(SYNC_APIS)) hits.push({ file, line: index + 1, api: m[1] });
		});
	return hits;
}

/** 收集扫描范围内的文件（server/ 全部 + 插件主进程代码）。 */
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

const scanned = [...walk(join(root, "server")), ...walk(join(root, "plugins"))].sort();
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
