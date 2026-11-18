import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankNonCode } from "../helpers/code-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/**
 * 子进程只有两个出口（详见 docs/agent-rules.md §四）：
 * - `server/run-process.ts`：**有限命令**（等 close、收输出、超时杀树）；
 * - `server/spawn-child.ts`：**常驻 / 交互式**（raw 流由调用方接，收场走 `stop()`）。
 *
 * 这条守卫盯的是「直接 `spawn(...)` 又把 windowsHide / detached / stdio / 杀树各写一遍」——
 * 那是所有 Windows 特有 bug（弹黑窗、漏杀孙进程、孤儿占端口）的来源。
 */
const SPAWN_APIS = /(?<![\w.$])(spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/g;

/** 允许直接起子进程的文件，理由必须写清楚（这是封闭清单，不接受"新加一个"）。 */
const OUTLETS: Record<string, string> = {
	"server/run-process.ts": "出口一：有限命令",
	"server/spawn-child.ts": "出口二：常驻子进程",
	"server/process-utils.ts": "基座：killPidTree / 进程探测（run-process 依赖它，反向依赖成环）",
	"server/terminals.ts": "node-pty：不是 child_process API",
	"server/device-center/desktop-linux.ts":
		"xdotool 输入队列：异步 execFile + 自建回调队列（非阻塞），不属 spawn 三件套重复",
};

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(ts|mjs|js)$/.test(path) && !path.endsWith(".d.ts")) out.push(relative(root, path).replace(/\\/g, "/"));
	}
	return out;
}

const scanned = walk(join(root, "server")).sort();

const hits = scanned.flatMap((file) => {
	const code = blankNonCode(readFileSync(join(root, file), "utf8"));
	return [...code.matchAll(SPAWN_APIS)].map((m) => ({
		file,
		line: code.slice(0, m.index ?? 0).split("\n").length,
		api: m[1]!,
	}));
});

describe("子进程只走两个出口（server/）", () => {
	it("扫描器本身可靠：注释/字符串/模板里的调用不算，真实调用要抓到", () => {
		const sample = [
			'// spawn("x") 注释里不算',
			'const s = "spawn(\\"x\\")";',
			"const t = `spawn(y)`;",
			'const ok = /re/.exec("x");',
			'spawn("real", []);',
			"execFileSync('real', []);",
		].join("\n");
		const code = blankNonCode(sample);
		const found = [...code.matchAll(SPAWN_APIS)].map((m) => m[1]);
		expect(found).toEqual(["spawn", "execFileSync"]);
	});

	it("除两个出口与登记过的基座外，server/ 不直接起子进程", () => {
		const offending = hits
			.filter((hit) => !(hit.file in OUTLETS))
			.map((hit) => `${hit.file}:${hit.line} → ${hit.api}(…)`);
		expect(
			offending,
			"要起子进程请走 `runProcess`（有限命令）或 `spawnChild`（常驻/交互式）；确实不能用时把理由写进本守卫的 OUTLETS 并同步 docs/agent-rules.md §四。",
		).toEqual([]);
	});

	it("出口清单里的文件确实还在用（防止清单腐化成白名单）", () => {
		const stale = Object.keys(OUTLETS).filter((file) => !hits.some((hit) => hit.file === file));
		expect(stale, "这些文件已经不再直接起子进程了，请从 OUTLETS 删掉").toEqual([]);
	});
});
