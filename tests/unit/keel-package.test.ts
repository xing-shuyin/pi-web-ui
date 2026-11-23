import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isShim, walkTypeScript } from "../helpers/guard-roots.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkgDir = join(root, "packages", "keel");
const coreDir = join(root, "packages", "keel", "src");
const serverDir = join(root, "server");

/**
 * P1 之后 keel 仍允许 import 的 app 模块。两桶都**只许变短**：
 * - `PENDING_PORT`：这是被搬进来的老叶子的首跳宿主依赖（端口反转在 P2/P4 销账）；
 * - `PORTS`：P2 要反转成端口的四个宿主模块。
 * 除这三桶以外的任何 `server/*` 依赖都会红——这是「新增耦合」的唯一门禁。
 */
const PENDING_PORT = [
	"approval-default-rules",
	"plugins",
	"quick-ask-context",
];

/** P2 的端口反转清单：反完一个就删一行（ 已销账：终端叶子改成注入工厂）。 */
const PORTS = ["client-state", "settings-service", "tool-manager"];

/** 本轮还没搬、下一轮单独搬的模块（搬完必须把这一行删掉，否则棘轮测试红）。 */
const PENDING_MOVE: string[] = [];

/** 宿主实现只许 type-only 引用（运行时拿到插件实例 = keel 又绑回了面板与生态）。 */
const TYPE_ONLY_HOST = new Set(["plugins"]);

function appDepsOf(files: string[]): Set<string> {
	const deps = new Set<string>();
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		// 静态 import 与动态 `import("…")` 类型引用都要算：漏掉后者会让 examples 里的耦合隐形。
		for (const m of source.matchAll(/(?:from\s*|import\s*\(\s*)"(\.[^"]+)"/g)) {
			const abs = resolve(dirname(file), m[1]).replace(/\.js$/, ".ts");
			const rel = relative(root, abs).split(sep).join("/");
			if (!rel.startsWith("server/")) continue;
			deps.add(rel.replace(/^server\//, "").replace(/\.ts$/, ""));
		}
	}
	return deps;
}

/** 非 type-only 的 import 说明符（跨行 import 也算一个整体）。 */
function valueImportsOf(source: string): string[] {
	const out: string[] = [];
	for (const m of source.matchAll(/(^|\n)\s*import\s+(?!type\b)[^;]*?from\s*"(\.[^"]+)"/g)) out.push(m[2]);
	return out;
}

const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
const coreFiles = walkTypeScript(coreDir);

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
		expect(coreFiles.length).toBeGreaterThan(50);
	});

	it("内核里没有指向 app 的桥（P1 后只允许对老叶子的显式依赖）", () => {
		expect(coreFiles.filter((f) => readFileSync(f, "utf8").includes("server/core/"))).toEqual([]);
	});

	it("运行时依赖在包里声明过（换机器装包不会缺 dep）", () => {
		const deps = (pkg.dependencies ?? {}) as Record<string, string>;
		const used = new Set<string>();
		for (const file of coreFiles) {
			for (const m of readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*\(\s*)"([^."'\s][^"']*)"/g)) {
				const spec = m[1];
				if (spec.startsWith("node:")) continue;
				used.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
			}
		}
		const missing = [...used].filter((name) => name !== "@earendil-works/pi-coding-agent" && !(name in deps));
		expect(missing, `packages/keel/package.json 缺 dependencies：${missing.join(", ")}`).toEqual([]);
	});
});

describe("keel · 依赖清单（只许变短）", () => {
	const deps = appDepsOf(coreFiles);
	const known = new Set([...PENDING_PORT, ...PORTS, ...PENDING_MOVE]);

	it("内核依赖的 app 模块都在清单里（新增耦合会红）", () => {
		expect([...deps].filter((d) => !known.has(d))).toEqual([]);
	});

	it("PENDING_MOVE 里的模块还没进 keel（搬完就把行删掉）", () => {
		const moved = PENDING_MOVE.filter((m) => existsSync(join(coreDir, `${m}.ts`)));
		expect(moved, `这些已经搬进来了，从 PENDING_MOVE 删掉：${moved.join(", ")}`).toEqual([]);
	});

	it("PENDING_PORT 不再被引用时要把行删掉（棘轮只往一个方向转）", () => {
		expect(PENDING_PORT.filter((d) => !deps.has(d))).toEqual([]);
	});

	it("四个端口候选在 P2 落地前仍被引用", () => {
		expect(PORTS.filter((d) => !deps.has(d))).toEqual([]);
	});

	it("宿主实现只许 type-only 引用", () => {
		const offenders: string[] = [];
		for (const file of coreFiles) {
			for (const spec of valueImportsOf(readFileSync(file, "utf8"))) {
				const base = spec.replace(/^.*server\//, "").replace(/\.js$/, "");
				if (TYPE_ONLY_HOST.has(base)) offenders.push(`${relative(root, file)} → ${spec}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("keel · 搬家完成度", () => {
	it("keel/src 里的老叶子在老位置只剩 re-export shim（禁并存两套实现）", () => {
		const offenders: string[] = [];
		for (const file of coreFiles) {
			const rel = relative(coreDir, file);
			// 包入口与宿主入口同名但不是同一个东西（`src/index.ts` 是导出面，不是搬进来的叶子）。
			if (rel === "index.ts") continue;
			const legacy = join(serverDir, rel);
			if (!existsSync(legacy)) continue;
			if (!isShim(readFileSync(legacy, "utf8"))) offenders.push(`server/${rel.split(sep).join("/")}`);
		}
		expect(offenders, `这些模块在 keel 与 server 里各有一份实现：\n${offenders.join("\n")}`).toEqual([]);
	});

	it("清单里仍是宿主能力的模块不许被搬进 keel（否则端口无处可注）", () => {
		const stray = [...PENDING_PORT, ...PORTS].filter((m) => existsSync(join(coreDir, `${m}.ts`)));
		expect(stray).toEqual([]);
	});
});
