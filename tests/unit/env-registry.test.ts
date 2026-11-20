import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_SPECS, envDocOf, envNamesOfScope } from "../../server/env-registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 扫描范围：仓库自己的源码（不含 tests/ —— 那里只是在用变量，不是在定义配置面）。 */
const SCAN_ROOTS = [
	"server",
	"web/src",
	"desktop",
	"bin",
	"scripts",
	"browser",
	"mobile/src",
	"mobile/scripts",
	"extensions",
	"plugins",
];
/** 生成物/依赖目录不参与（web/dist 的压缩产物、plugins/*\/node_modules 会把名字带进来）。 */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "artifacts", ".git", "coverage"]);
/** 清单自身不是「读取点」——它当然会写出每个名字（含 docOnly 的说明）。 */
const SKIP_FILES = new Set(["server/env-registry.ts"]);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

/**
 * 四种真实读法，缺一个就会漏：
 * - `process.env.PI_WEB_PORT`（绝大多数）
 * - `env.PI_WEB_MANAGED`（注入式 `env` 参数，测试可直接塞假体）
 * - `env["PI_WEB_MANAGED"]` / `process.env[KEY_ENV]`（常量持名）
 * - `const X_ENV = "PI_WEB_RESTART_CHILD"`（名字只以字符串字面量出现）
 */
const PATTERNS = [
	/\b(?:process\s*\.\s*env|env)\s*\.\s*(PI_[A-Z0-9_]+)/g,
	/\b(?:process\s*\.\s*env|env)\s*\[\s*["'`](PI_[A-Z0-9_]+)["'`]\s*\]/g,
	/["'`](PI_[A-Z0-9_]+)["'`]/g,
];

type Hit = { name: string; at: string };

function collectEnvHits(): Hit[] {
	const hits: Hit[] = [];
	const walk = (dir: string): void => {
		let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(abs);
				continue;
			}
			if (!SOURCE_EXT.test(entry.name)) continue;
			const rel = relative(ROOT, abs).replace(/\\/g, "/");
			if (SKIP_FILES.has(rel)) continue;
			const lines = readFileSync(abs, "utf8").split("\n");
			for (const [index, line] of lines.entries()) {
				for (const pattern of PATTERNS) {
					pattern.lastIndex = 0;
					for (const match of line.matchAll(pattern)) {
						const name = match[1];
						// 模板前缀（`__PI_WEB_ATTACH_${token}`）不是完整变量名。
						if (!/^PI_[A-Z0-9_]+$/.test(name) || name.endsWith("_")) continue;
						hits.push({ name, at: `${rel}:${index + 1}` });
					}
				}
			}
		}
	};
	for (const dir of SCAN_ROOTS) walk(join(ROOT, dir));
	return hits;
}

function documentedNames(file: string): Set<string> {
	const text = readFileSync(join(ROOT, file), "utf8");
	return new Set([...text.matchAll(/`(PI_[A-Z0-9_]+)`/g)].map((match) => match[1]));
}

function mentions(text: string, name: string): boolean {
	return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
}

const hits = collectEnvHits();
const scanned = new Map<string, string[]>();
for (const { name, at } of hits) {
	const list = scanned.get(name) ?? [];
	if (!list.includes(at)) list.push(at);
	scanned.set(name, list);
}

describe("环境变量单源清单", () => {
	it("清单本身没有重复项", () => {
		const seen = new Map<string, number>();
		for (const spec of ENV_SPECS) seen.set(spec.name, (seen.get(spec.name) ?? 0) + 1);
		const dupes = [...seen].filter(([, count]) => count > 1).map(([name]) => name);
		expect(dupes, `server/env-registry.ts 里重复登记：${dupes.join(", ")}`).toEqual([]);
	});

	it("代码里读到的每个 PI_* 都已在清单登记", () => {
		const known = new Set(ENV_SPECS.map((spec) => spec.name));
		const missing = [...scanned]
			.filter(([name]) => !known.has(name))
			.map(([name, at]) => `${name}  ← ${at.slice(0, 3).join(", ")}`);
		expect(
			missing,
			"这些环境变量在代码里被读取但没进 server/env-registry.ts：新增变量必须归入 public/internal/plugin/build/test 之一；\n" +
				"若 public，同时补 docs/env-vars.md 三语表格。\n" +
				missing.join("\n"),
		).toEqual([]);
	});

	it("public 变量都能在文档里查到", () => {
		const cache = new Map<string, string>();
		const undocumented: string[] = [];
		for (const spec of envNamesOfScope("public").map((name) => ENV_SPECS.find((s) => s.name === name)!)) {
			const doc = envDocOf(spec);
			if (!cache.has(doc)) cache.set(doc, readFileSync(join(ROOT, doc), "utf8"));
			if (!mentions(cache.get(doc)!, spec.name)) undocumented.push(`${spec.name}  ← 缺 ${doc}`);
		}
		expect(
			undocumented,
			"public 变量是用户要调的开关，必须写进文档（没写就等于猜）：\n" + undocumented.join("\n"),
		).toEqual([]);
	});

	it("env-vars 三种语言的变量名集合一致", () => {
		const zh = documentedNames("docs/env-vars.md");
		const variants = ["docs/env-vars.en.md", "docs/env-vars.zh-TW.md"];
		const drift: string[] = [];
		for (const file of variants) {
			const other = documentedNames(file);
			for (const name of zh) if (!other.has(name)) drift.push(`${file} 缺少 ${name}`);
			for (const name of other) if (!zh.has(name)) drift.push(`docs/env-vars.md 缺少 ${name}（${file} 有）`);
		}
		expect(drift, `环境变量表已漂移，三种语言必须同名：\n${drift.join("\n")}`).toEqual([]);
	});

	it("deprecated 变量不出现在主表中（不宣传待删开关）", () => {
		const text = readFileSync(join(ROOT, "docs/env-vars.md"), "utf8");
		const advertised = envNamesOfScope("deprecated").filter((name) => documentedNames("docs/env-vars.md").has(name));
		expect(advertised, `这些变量标了 deprecated，不该再出现在 docs/env-vars.md：${advertised.join(", ")}`).toEqual([]);
		expect(text.length).toBeGreaterThan(0);
	});

	it("docOnly 变量必须确实不在代码里（文档承诺 ≠ 已实现）", () => {
		const docOnly = ENV_SPECS.filter((spec) => spec.docOnly).map((spec) => spec.name);
		const implemented = docOnly.filter((name) => scanned.has(name));
		expect(
			implemented,
			"这些变量已标 docOnly（文档写了、代码没有），但现在代码里出现了读取点：请实现完整后摘掉 docOnly，或撤销文档承诺。\n" +
				implemented.map((name) => `${name}  ← ${(scanned.get(name) ?? []).slice(0, 3).join(", ")}`).join("\n"),
		).toEqual([]);
	});
});
