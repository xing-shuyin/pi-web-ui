import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hiddenConsoleArgs, wrapForHiddenConsole } from "../../server/hide-console-windows.js";
import { blankNonCode } from "../helpers/code-scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * 桌面壳（Electron 主进程 / `ELECTRON_RUN_AS_NODE` 起的 server 与插件作业）里没有控制台窗口。
 * Windows 上从这种进程 spawn 控制台程序（git / tar / npm / powershell / tasklist …）时，若不带
 * `windowsHide: true`，系统会为子进程新建一个控制台 —— 用户看到的就是「装插件时弹一下黑窗」。
 *
 * 两层守：
 * 1. **进程级开关**（`server/hide-console-windows.ts`，CLI 侧是生成件 `bin/lib/hide-console-windows.mjs`）
 *    在进程入口 import 一次，覆盖全部调用点，含宿主内 `import()` 加载的插件代码。
 * 2. **热路径逐点显式**：插件安装/更新链路上的每次 spawn 自己写死 `windowsHide`，双保险。
 */
const SPAWN_APIS = /(?<![\w.$])(spawn|spawnSync|execFile|execFileSync|exec|fork)\s*\(/g;

/** 必须装上进程级开关的三个进程根：CLI（插件作业/服务安装）、server（服务本体 + 宿主内插件）、
 *  桌面壳（Electron 主进程：taskkill / 更新器 / 浏览器宿主）。 */
const ENTRY_INSTALLS: Array<{ file: string; specifier: string }> = [
	{ file: "bin/pi-web-ui.mjs", specifier: "./lib/hide-console-windows.mjs" },
	{ file: "server/index.ts", specifier: "./hide-console-windows.js" },
	{ file: "desktop/main.ts", specifier: "../server/hide-console-windows.js" },
];

/** 热路径：桌面端触发插件安装/更新/校验的整条链 + CLI 全部子命令（服务安装、frp、hub 都在这里）。
 *  `server/plugin*.ts` 与 `bin/*.mjs` 全量纳入，新文件自动被覆盖。 */
function guardedFiles(): string[] {
	const plugins = readdirSync(join(root, "server"))
		.filter((name) => /^plugin.*\.ts$/.test(name))
		.map((name) => `server/${name}`);
	const listDir = (dir: string) =>
		readdirSync(join(root, dir))
			.filter((name) => name.endsWith(".mjs"))
			.map((name) => `${dir}/${name}`);
	return ["server/plugins.ts", ...plugins, ...listDir("bin"), ...listDir("bin/lib")].sort();
}

interface SpawnCall {
	line: number;
	api: string;
	text: string;
}

function findSpawnCalls(source: string): SpawnCall[] {
	const code = blankNonCode(source);
	const calls: SpawnCall[] = [];
	for (const m of code.matchAll(SPAWN_APIS)) {
		const start = (m.index ?? 0) + m[0].length;
		let depth = 1;
		let i = start;
		while (i < code.length && depth > 0) {
			const c = code[i];
			if (c === "(") depth++;
			else if (c === ")") depth--;
			i++;
		}
		calls.push({
			line: code.slice(0, m.index ?? 0).split("\n").length,
			api: m[1]!,
			text: code.slice(start, i - 1),
		});
	}
	return calls;
}

function firstImportLine(source: string): string {
	// blankNonCode 保留字符下标，所以能在「只看到代码结构」的文本里定位行首 import，再回原文取真实文字。
	const code = blankNonCode(source);
	const m = /^[ \t]*import\b.*$/m.exec(code);
	if (!m) return "";
	const end = code.indexOf("\n", m.index);
	return source.slice(m.index, end === -1 ? source.length : end).trim();
}

describe("Windows 下子进程不弹控制台", () => {
	it("扫描器本身可靠：注释/字符串/正则里的调用不算，真实调用要抓到且能判断 windowsHide", () => {
		const cases: Array<[string, string, number, boolean]> = [
			["裸 spawn 无选项", 'spawn("git", ["clone"]);', 1, false],
			["带 windowsHide", 'spawn("git", ["clone"], { windowsHide: true });', 1, true],
			["对象唯一选项", "spawnSync(cmd, { shell: true, windowsHide: true });", 1, true],
			["正则的 .exec(", "const m = /x/.exec(line);", 0, false],
			["行注释", '// spawn("git") 会被忽略', 0, false],
			["字符串内容", 'const s = "spawn(\\"git\\")";', 0, false],
			["模板文本内容", "const s = `spawn(git)`;", 0, false],
			["嵌套括号里带 windowsHide", 'spawnSync(bin, args, { env: { a: "b" }, windowsHide: true });', 1, true],
		];
		const problems: string[] = [];
		for (const [name, source, count, hidden] of cases) {
			const found = findSpawnCalls(source);
			if (found.length !== count) {
				problems.push(`${name}：期望 ${count} 次调用，实际 ${found.length}`);
				continue;
			}
			if (count > 0 && found[0]!.text.includes("windowsHide") !== hidden)
				problems.push(`${name}：windowsHide 判定不符（实际 ${found[0]!.text.includes("windowsHide")}）`);
		}
		expect(problems).toEqual([]);
	});

	it("热路径文件里每次子进程调用都显式 windowsHide", () => {
		const offending = guardedFiles().flatMap((file) => {
			const source = read(file);
			return findSpawnCalls(source)
				.filter((call) => !call.text.includes("windowsHide"))
				.map((call) => `${file}:${call.line} → ${call.api}(…)`);
		});
		expect(
			offending,
			"没有 windowsHide 的子进程在 Windows 桌面版会新建一个控制台窗口（git/tar/npm 黑窗闪一下）。给 options 补 windowsHide: true。",
		).toEqual([]);
	});

	it("两个进程入口的第一条 import 就是进程级开关", () => {
		const problems = ENTRY_INSTALLS.map(({ file, specifier }) => {
			const first = firstImportLine(read(file));
			return first === `import "${specifier}";`
				? null
				: `${file} 的第一条 import 是 ${first || "(没有)"}，应为 import "${specifier}"; —— 开关必须在这两个进程里最先装上`;
		}).filter((x): x is string => x !== null);
		expect(problems).toEqual([]);
	});

	it("CLI 用的是生成件，而不是自己另写一套包装", () => {
		const source = read("bin/pi-web-ui.mjs");
		expect(source).toContain('import "./lib/hide-console-windows.mjs";');
		expect(source).not.toContain('Symbol.for("pi-web-ui.hide-console-windows")');
	});

	// 生成件的逐字节同源比对在 tests/unit/bin-mirror.test.ts（镜像件清单在那里统一登记）。

	describe("hiddenConsoleArgs：把调用参数补成隐藏控制台", () => {
		it("(cmd, options) 形状注入默认值", () => {
			expect(hiddenConsoleArgs("spawnSync", ["git", { cwd: "/x" }])[1]).toEqual({ windowsHide: true, cwd: "/x" });
		});

		it("(cmd, args, options) 形状注入默认值", () => {
			expect(hiddenConsoleArgs("spawn", ["git", ["clone"], { cwd: "/x" }])[2]).toEqual({
				windowsHide: true,
				cwd: "/x",
			});
		});

		it("调用点显式传的 windowsHide 优先（逃生口）", () => {
			expect(hiddenConsoleArgs("spawn", ["x", ["a"], { windowsHide: false }])[2]).toEqual({ windowsHide: false });
		});

		it("没有 options 时补一个；options 位置是回调时插在前面", () => {
			expect(hiddenConsoleArgs("spawn", ["git"])[1]).toEqual({ windowsHide: true });
			expect(hiddenConsoleArgs("exec", ["ls", () => {}])[1]).toEqual({ windowsHide: true });
			expect(hiddenConsoleArgs("execFile", ["git", ["a"], () => {}])[2]).toEqual({ windowsHide: true });
		});

		it("exec/execSync 的第二参本来就是 options，不按 args 数组判", () => {
			expect(hiddenConsoleArgs("execSync", ["git status", { timeout: 1000 }])[1]).toEqual({
				windowsHide: true,
				timeout: 1000,
			});
		});
	});

	describe("wrapForHiddenConsole：包装后行为不变，只多一个默认项", () => {
		it("spawn 包装后透传参数并注入 windowsHide", () => {
			const seen: unknown[][] = [];
			const fake = (...args: unknown[]): unknown => {
				seen.push(args);
				return "ok";
			};
			const wrapped = wrapForHiddenConsole("spawn", fake);
			expect(wrapped("git", ["clone"], { cwd: "/x" })).toBe("ok");
			expect(seen[0]).toEqual(["git", ["clone"], { windowsHide: true, cwd: "/x" }]);
		});

		it("保留 promisify.custom：promisify(execFile) 仍拿到带默认项的版本", async () => {
			const seen: unknown[][] = [];
			const fake = Object.assign((...args: unknown[]): unknown => void args, {
				[promisify.custom]: (...args: unknown[]): Promise<unknown> => {
					seen.push(args);
					return Promise.resolve({});
				},
			});
			const wrapped = wrapForHiddenConsole("execFile", fake);
			expect(typeof wrapped[promisify.custom]).toBe("function");
			const run = promisify(wrapped) as (...args: unknown[]) => Promise<unknown>;
			await run("git", ["a"], { cwd: "/x" });
			expect(seen[0]?.[2]).toEqual({ windowsHide: true, cwd: "/x" });
		});
	});
});
