/**
 * 服务端同步子进程调用守卫（对应 `docs/agent-rules.md` §四「服务端禁同步子进程调用」）。
 *
 * 背景：`spawnSync` / `execSync` / `execFileSync` 在事件循环线程上 fork+exec，并**阻塞到
 * 子进程结束**。子进程若卡在 `exec()` 之前，主线程就永远停在 spawn 错误管道的 `read()` 上，
 * 定时器、socket、`/api/health` 全部停摆 —— 只能靠外部 watchdog 杀进程（2026-11-02 在
 * Termux/Android 上一天之内复现三次，见 `#830`）。异步 `spawn` / `execFile` 不会被拖到子进程
 * 结束，所以修复方向是「换异步」或「静态推导」，而不是加超时。
 *
 * 本测试锁两件事：
 *   1. `server/` 下不得**新增**同步子进程调用（存量登记在 ALLOWED 里）；
 *   2. ALLOWED 只许变短：某条已不再命中，说明迁移完成，必须删掉那一行。
 *
 * 扫描器会先抹掉注释与普通字符串（`patch-*.ts` 里那些作为**源码文本**保存的调用不是真实
 * 调用），模板字符串保留 —— 模板插值里可能是真实代码，宁可多报也不漏报。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const serverDir = join(root, "server");

const SYNC_APIS = /\b(spawnSync|execSync|execFileSync)\s*\(/g;

/**
 * 存量名单：file → 为什么它现在还没迁移。
 * 只许删除；新增即红（新代码请直接用异步 spawn 或静态推导）。
 */
const ALLOWED: Record<string, string> = {
	"server/plugin-facilities.ts": "插件设施开关的同步调用，迁移到异步 spawn 待办",
	"server/eval-tool.ts": "`taskkill` / `--version` 探测，工具调用路径，迁移待办",
	"server/plugin-assets.ts": "`tar` 解包整段阻塞事件循环，最该优先迁移的一个",
	"server/device-center/desktop-linux.ts": "`xrandr` / `xdpyinfo` 探测，LAN 客户端可触发",
	"server/device-center/desktop-native.ts": "`xcrun` 探测，仅 macOS",
	"server/patch-executable-lookup.ts": "模板字符串里的 SDK 源码文本，不是真实调用",
	// #830 把这条 `npm root -g` 换成静态推导；那个 PR 合并后删掉这一行（棘轮会点名提醒）
	"server/global-loader.ts": "#830 已改为静态推导，等合并后从名单移除",
};

/** 抹掉注释与普通字符串的内容（保留换行，行号不变）。 */
function blankCommentsAndStrings(src: string): string {
	const chars = [...src];
	const blankRange = (from: number, to: number) => {
		for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " ";
	};
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "/" && next === "/") {
			let j = i;
			while (j < src.length && src[j] !== "\n") j++;
			blankRange(i, j);
			i = j;
			continue;
		}
		if (c === "/" && next === "*") {
			let j = i + 2;
			while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
			blankRange(i, Math.min(j + 2, src.length));
			i = j + 2;
			continue;
		}
		if (c === '"' || c === "'") {
			const quote = c;
			let j = i + 1;
			while (j < src.length) {
				if (src[j] === "\\") {
					j += 2;
					continue;
				}
				if (src[j] === quote || src[j] === "\n") break;
				j++;
			}
			blankRange(i + 1, Math.max(i + 1, j));
			i = j + 1;
			continue;
		}
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
	blankCommentsAndStrings(source)
		.split("\n")
		.forEach((line, index) => {
			for (const m of line.matchAll(SYNC_APIS)) {
				hits.push({ file, line: index + 1, api: m[1] });
			}
		});
	return hits;
}

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(ts|mjs)$/.test(path) && !path.endsWith(".d.ts")) out.push(path);
	}
	return out;
}

const serverHits = walk(serverDir)
	.flatMap((path) => findSyncChildProcessCalls(readFileSync(path, "utf8"), relative(root, path)))
	.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

describe("服务端禁同步子进程调用", () => {
	it("扫描器本身可靠：注释与字符串里的调用不算，真实调用要抓到", () => {
		const sample = [
			'// spawnSync("a") 在注释里',
			'const help = "execSync(\\"npm root -g\\") 在普通字符串里";',
			"/*",
			"spawnSync('b') 在块注释里",
			"*/",
			'const out = execSync("npm root -g");',
		].join("\n");
		const hits = findSyncChildProcessCalls(sample);
		expect(hits.map((hit) => `${hit.line}:${hit.api}`)).toEqual(["6:execSync"]);
	});

	it("server/ 下没有名单外的同步子进程调用", () => {
		const offending = serverHits.filter((hit) => !(hit.file in ALLOWED));
		expect(
			offending.map((hit) => `${hit.file}:${hit.line} → ${hit.api}`),
			"新增同步子进程调用会让事件循环阻塞到子进程结束（见 docs/agent-rules.md §四）。改用异步 spawn/execFile，或把结果静态推导出来。",
		).toEqual([]);
	});

	it("存量名单只许变短：不再命中的条目必须删除", () => {
		const stale = Object.keys(ALLOWED).filter((file) => !serverHits.some((hit) => hit.file === file));
		expect(stale, "这些文件已不再有同步子进程调用，请从 ALLOWED 里删掉（名单是棘轮，只能缩）").toEqual([]);
	});
});
