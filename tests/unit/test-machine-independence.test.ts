import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * 测试不能绑死某一台机器。
 *
 * 事故形态（本次）：多个用例在 win32 上写死 `E:/tmp`（当年开发机把临时目录挪到了 E 盘），
 * 换任何一台机器就是 `ENOENT: mkdtemp 'E:\tmp\...'` —— 18 条用例整批红，看着像代码坏了。
 * 同类还有：把 Chrome 默认路径写成 `C:/Program Files/...`（换个安装位置就找不到）。
 *
 * 规则（不是「尽量」，是「必须」）：
 * - **临时目录**：`os.tmpdir()` 派生（单源 `tests/helpers/tmp.ts` 的 `makeTestTmpDir()`）。
 * - **仓库内文件**：从模块位置派生（`fileURLToPath(new URL("../..", import.meta.url))`），
 *   这样它与 cwd 无关；不要写相对路径给真实 I/O（相对路径按 `process.cwd()` 解析，跑在哪都一样坏）。
 * - **外部可执行文件**：走发现逻辑（`tests/lib/chrome.mjs` 的 `CHROME_PATH`），不要写死安装路径。
 * - **假数据字符串**（prompt 里演示的 `C:/Users/x/...`、期望输出的 `D:/data/...`）不算路径，豁免。
 */
const RULES: { name: string; re: RegExp; hint: string }[] = [
	{
		name: "临时目录写死盘符",
		re: /\bmkdtemp(?:Sync)?\(\s*["'`][A-Za-z]:[/\\]/,
		hint: "用 tests/helpers/tmp.ts 的 makeTestTmpDir()（os.tmpdir() 派生）",
	},
	{
		name: "临时根写死盘符（三元选盘）",
		re: /\?\s*["'`][A-Za-z]:[/\\](?:tmp|temp)\b/i,
		hint: "临时根直接用 os.tmpdir()，不要按平台挑固定盘符",
	},
	{
		name: "浏览器/外部程序写死安装路径（作默认值）",
		re: /\?\?\s*["'`][A-Za-z]:[/\\]Program Files/i,
		hint: "用 tests/lib/chrome.mjs 的 CHROME_PATH 发现逻辑",
	},
];

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(ts|mjs|cjs)$/.test(name)) out.push(path);
	}
	return out;
}

describe("测试的机器无关性", () => {
	it("不写死盘符 / 安装路径（临时目录与外部程序必须发现式获取）", () => {
		const violations: string[] = [];
		for (const file of walk(join(repoRoot, "tests"))) {
			const rel = relative(repoRoot, file).split("\\").join("/");
			if (rel === "tests/helpers/tmp.ts") continue; // 文档里的反例
			if (rel.startsWith("tests/scratch/")) continue; // 一次性调试区（用完即删）
			// 注意：**不能**用 blankNonCode——它会把字符串内容抹成空格，正好把这里的证据抹掉。
			// 三条规则都锚定在"真实路径用法"上（mkdtemp 的实参 / 选盘的三元 / ?? 默认值），
			// 所以假数据里的 C:/Users/x 这类演示路径不会误伤。
			const code = readFileSync(file, "utf8");
			for (const rule of RULES) {
				if (rule.re.test(code)) violations.push(`${rel}: ${rule.name} → ${rule.hint}`);
			}
		}
		expect(violations, "测试不得绑死某一台机器：\n").toEqual([]);
	});
});
