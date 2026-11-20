/**
 * 文件落位守卫（细则见 `docs/agent-rules.md` §八「文件落位与临时产物」）。
 *
 * 判据四条：
 *   1. **根目录登记制**：根级条目（`readdirSync`，含被 gitignore 的运行时目录）必须命中白名单。
 *      这一条必须直接扫文件系统 —— 只查 git 会漏掉 `debug.log` 这类"已被忽略、但确实堆在根目录"的东西。
 *   2. **已入库的产物**：`git ls-files` 里不许出现日志 / 备份 / 一次性对比页 / 安装包（防 `git add -f`）。
 *   3. **忽略覆盖**：临时与构建落点必须被 `.gitignore` 命中，否则它们会顺手被提交。
 *   4. **文档锚点**：规则正文还在，且三语文件都在（文档被改名/搬走时守卫要响）。
 *
 * 只看「根级」：子目录各有一级归属（`docs/`、`scripts/`、`server/`…），逐目录白名单会把正常演进
 * 卡成改白名单游戏，反而催生绕过。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * 根级白名单（登记制）。两类：
 *   - 仓库级配置 / 顶层说明：入库。
 *   - 运行时与产物的固定落点：不入库，但允许住在根目录（名字稳定，新增先想清楚）。
 * 其它任何东西——`debug.log`、`.tmp-*`、`fake-dir`、`preview-*.html`、一次性脚本——都不许出现在这里。
 */
const ROOT_ALLOWLIST = new Set([
	// —— 一级目录（代码归属）
	"assets",
	"bin",
	"browser",
	"deploy",
	"desktop",
	"dev",
	"docs",
	"extensions",
	"launcher",
	"locales",
	"mobile",
	"native",
	"packages",
	"pipelines",
	"plugin-registry",
	"plugin-sdk",
	"plugins",
	"scripts",
	"server",
	"tests",
	"themes",
	"web",
	// —— 工具链 / 依赖（不入库）
	".git",
	".github",
	".vscode",
	"node_modules",
	// —— 运行时数据与产物落点（不入库）
	".pi",
	".pi-web",
	".pi-wechat-media",
	".pi-qq-media",
	".tmp-test-data",
	".worktrees",
	".safe-exec",
	".scratch",
	".theme-audit",
	".artifacts",
	"artifacts",
	"dist",
	"release",
	"durable",
	// —— 仓库根文件
	".dockerignore",
	".gitattributes",
	".gitignore",
	".oxlintrc.json",
	".prettierignore",
	".prettierrc.json",
	"AGENTS.en.md",
	"AGENTS.md",
	"AGENTS.zh-TW.md",
	"CHANGELOG.md",
	"Dockerfile",
	"LICENSE",
	"README.md",
	"README.zh-CN.md",
	"README.zh-TW.md",
	"docker-compose.yml",
	"package-lock.json",
	"package.json",
	"tsconfig.extensions.json",
	"tsconfig.server.json",
	"tsconfig.tests.json",
	"vitest.config.ts",
	"vitest.integration.config.ts",
]);

/** 不许入库的产物形态（`git add -f` 也拦下）。 */
/**
 * 不许入库的产物形态（`git add -f` 也拦下）。
 * `rootOnly` 的几条只管仓库根：`dev/` 这类目录本来就住着开发用预览页，不是一次性草稿。
 */
const FORBIDDEN_TRACKED: { pattern: RegExp; hint: string; rootOnly?: boolean }[] = [
	{ pattern: /^\.tmp-/, hint: "临时草稿 → .scratch/", rootOnly: true },
	{ pattern: /^debug\.[^/]+$/, hint: "调试输出 → .scratch/ 或 .safe-exec/", rootOnly: true },
	{ pattern: /\.log$/, hint: "日志 → .safe-exec/（命令）或 .scratch/（临时）", rootOnly: true },
	{ pattern: /\.bak$/, hint: "备份文件不要入库", rootOnly: true },
	{ pattern: /^preview-[^/]*\.html$/, hint: "一次性对比页 → .scratch/ 或 docs/proposals/", rootOnly: true },
	{ pattern: /\.(apk|msi)$/, hint: "安装包是构建产物 → release/ 或 dist/" },
];

/** 必须在 `.gitignore` 里被覆盖的落点。 */
const MUST_BE_IGNORED = [
	".scratch/",
	"artifacts/",
	".safe-exec/",
	"release/",
	"dist/",
	"web/dist/",
	".tmp-test-data/",
	"tests/scratch/",
];

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 << 20 });
}

function rootEntries(): string[] {
	return readdirSync(ROOT, { withFileTypes: true }).map((entry) => entry.name);
}

describe("文件落位守卫", () => {
	it("根目录只住登记过的条目（根目录不是草稿纸）", () => {
		const offenders = rootEntries().filter((entry) => !ROOT_ALLOWLIST.has(entry));
		expect(
			offenders,
			`仓库根出现了未登记的条目：${offenders.join(", ")}\n` +
				"按 docs/agent-rules.md §八 归位：临时草稿 → .scratch/，脚本 → scripts/（并在 package.json 给入口），" +
				"文档 → docs/，构建产物 → dist/ 或 release/。确属仓库级配置或固定落点，才加进 ROOT_ALLOWLIST。",
		).toEqual([]);
	});

	it("没有产物形态的文件被提交进库", () => {
		const tracked = git(["ls-files", "-z", "--", "."])
			.split("\0")
			.filter(Boolean)
			.map((file) => file.replace(/\\/g, "/"));
		const hits = tracked.flatMap((file) =>
			FORBIDDEN_TRACKED.filter(({ pattern, rootOnly }) => (!rootOnly || !file.includes("/")) && pattern.test(file)).map(
				({ hint }) => `${file} → ${hint}`,
			),
		);
		expect(hits, `以下产物不该入库：\n${hits.join("\n")}`).toEqual([]);
	});

	it("临时与构建落点都被 .gitignore 覆盖", () => {
		const lines = readFileSync(join(ROOT, ".gitignore"), "utf8")
			.split("\n")
			.map((line) => line.trim());
		const missing = MUST_BE_IGNORED.filter(
			(entry) => !lines.some((line) => line === entry || line === `/${entry}` || line === entry.replace(/\/$/, "")),
		);
		expect(missing, `以下落点没被 .gitignore 覆盖，临时产物会顺手被提交：${missing.join(", ")}`).toEqual([]);
	});

	it("规则正文与三语文档都在位", () => {
		const rules = readFileSync(join(ROOT, "docs/agent-rules.md"), "utf8");
		expect(rules).toContain("## 八、文件落位与临时产物");
		expect(rules).toContain("根目录白名单制");
		expect(rules).toContain("repo-hygiene.test.ts");
		expect(existsSync(join(ROOT, "docs/agent-rules.en.md"))).toBe(true);
		expect(existsSync(join(ROOT, "docs/agent-rules.zh-TW.md"))).toBe(true);
		// AGENTS.md 只做索引：必须有指向该章节的映射行
		const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
		expect(agents).toContain("agent-rules.md#八文件落位与临时产物");
	});
});
