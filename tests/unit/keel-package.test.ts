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
 * - `PENDING_PORT`：被搬进来的老叶子的首跳宿主依赖（端口反转在 P2/P4 销账）；
 * - `PORTS`：P2 要反转成端口的宿主模块。
 * 除这两桶以外的任何 `server/*` 依赖都会红——这是「新增耦合」的唯一门禁。
 *
 * **P2 已落地：两桶都空，内核引宿主模块 = 0。** 设置面靠 `SettingsStorePort`（存储）与
 * `SettingsFramePort`（设置帧/预设/审批规则）两个端口反转；`client-state` 的纯数据/纯函数
 * 已搬进 `settings-schema` / `settings-normalize` / `ui-layout` / `projects-schema`。
 * 这条棘轮保留：谁再往 keel 里 import 一个 `server/*`，下面第一个用例就红。
 */
/** 已清零：approval-default-rules / plugins / quick-ask-context 都改成 keel 内的单源或窄类型。 */
const PENDING_PORT: string[] = [];

/** P2 端口反转清单：client-state / settings-service 已销账，清单清空。 */
const PORTS: string[] = [];

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
	const known = new Set([...PENDING_PORT, ...PORTS]);

	it("内核依赖的 app 模块都在清单里（新增耦合会红）", () => {
		expect([...deps].filter((d) => !known.has(d))).toEqual([]);
	});

	it("PENDING_PORT 不再被引用时要把行删掉（棘轮只往一个方向转）", () => {
		expect(PENDING_PORT.filter((d) => !deps.has(d))).toEqual([]);
	});

	it("P2 完成：三桶全空 —— 内核不再依赖任何宿主模块", () => {
		expect(PORTS).toEqual([]);
		expect(PENDING_PORT).toEqual([]);
		expect([...deps]).toEqual([]);
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
