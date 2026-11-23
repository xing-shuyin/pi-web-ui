import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkgDir = join(root, "packages", "keel");
const coreDir = join(root, "packages", "keel", "src");

/** P0 冻结的依赖清单：只许在 P1 里逐行划掉，新增一行就红。 */
const MOVES_IN_P1 = [
	"protocol",
	"session-turns",
	"session-projection",
	"conversation-rows",
	"queue-utils",
	"serialize",
	"versioned-doc",
	"path-boundary",
	"session-open",
	"transcript-prepare",
	"session-branch",
	"session-parser",
	"session-search",
	"session-scan",
	"session-list-scan",
	"i18n",
	"agent-formatters",
	"engine-capabilities",
	"tool-guards",
	"tool-approval",
	"approval-rules",
	"pending-question",
	"ask-user-question-tool",
	"subagents",
	"subagent-templates",
	"subagent-settle",
	"subagent-security-gate",
	"engine-service",
	"launch-origin",
	"orphan-manager",
];

/** P2 要反转成端口的四个：它们在 P1 之后仍允许被 import，直到端口落地。 */
const STAYS_BEHIND_PORTS = ["client-state", "settings-service", "terminals", "tool-manager"];

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

function appDepsOf(files: string[]): Set<string> {
	const deps = new Set<string>();
	for (const file of files) {
		for (const m of readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]+)"/g)) {
			const abs = resolve(dirname(file), m[1]).replace(/\.js$/, ".ts");
			const rel = relative(root, abs).split(sep).join("/");
			if (!rel.startsWith("server/")) continue;
			if (rel.startsWith("packages/keel/src/")) continue;
			deps.add(rel.replace(/^server\//, "").replace(/\.ts$/, ""));
		}
	}
	return deps;
}

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;

describe("keel · 包骨架", () => {
	it("包名与版本", () => {
		expect(pkg.name).toBe("@earendil-works/keel");
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.type).toBe("module");
		expect(pkg.engines).toEqual({ node: ">=22.19.0" });
	});

	it("包入口是 src/index.ts，且 exports 指向它", () => {
		const exportsField = pkg.exports as Record<string, { types: string; default: string }>;
		expect(exportsField["."].types).toBe("./src/index.ts");
		expect(exportsField["."].default).toBe("./src/index.ts");
		expect(walk(join(pkgDir, "src")).length).toBeGreaterThan(50);
	});

	it("内核里没有指向 app 的桥（P1 后只允许对老叶子的显式依赖）", () => {
		const files = walk(join(pkgDir, "src"));
		expect(files.filter((f) => readFileSync(f, "utf8").includes("server/core/"))).toEqual([]);
	});
});

describe("keel · 依赖清单冻结", () => {
	it("内核依赖的 app 模块都在清单里（新增耦合会红）", () => {
		const deps = appDepsOf(walk(coreDir));
		const known = new Set([...MOVES_IN_P1, ...STAYS_BEHIND_PORTS]);
		expect([...deps].filter((d) => !known.has(d))).toEqual([]);
	});

	it("清单里的 P1 模块确实还被引用（搬完就把它从表里删掉）", () => {
		const deps = appDepsOf(walk(coreDir));
		expect(MOVES_IN_P1.filter((d) => !deps.has(d))).toEqual([]);
	});

	it("内核不 import 宿主的 UI / 插件 / 面板实现", () => {
		const deps = appDepsOf(walk(coreDir));
		const forbidden = [...deps].filter((d) =>
			/^(plugins|web|desktop|browser|device-center|files-service|model-admin)$/.test(d),
		);
		expect(forbidden).toEqual([]);
	});
});
