/**
 * 死 i18n key 守卫（issue #472）：`web/src/i18n/messages/<module>/zh.json` 合并字典的每个 key 都必须
 * 在全仓（web/src / server / extensions / plugins / desktop / bin / scripts / tests）
 * 至少被引用一次 —— 否则就只是一份没人读的翻译，白白拖着 8 个语言包一起翻译与审阅。
 *
 * 判据：
 *   · key = zh 字典顶层条目，含 `"a.b"` 这种点号 key（如 `tpl.title`、`sound.done`）；
 *   · 「被引用」= 语料里出现同名字符串或 dot-identifier（`t("x")` / `tt("x")` /
 *     类型联合 `labelKey: "sound.done"` 都算）；
 *   · 模板拼接的动态 key 显式白名单：`thinking.<THINKING_VALUES>`；
 *     `promptTok_<PROMPT_TOKENS>` 与 `promptTok_<token>_desc`（见 SettingsModal 的 `tt(...)`）。
 *
 * 加了新 key 却提示「未被引用」时，先确认真的有人用；确实要用就正常接上，别往白名单里塞。
 */
import { describe, expect, it } from "vitest";
import { parsers } from "prettier/plugins/typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { THINKING_VALUES } from "../../web/src/thinking-levels.js";
import { PROMPT_TOKENS } from "../../server/prompt-composer.js";
import { readCatalog } from "../../scripts/lib/i18n-catalog.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const I18N = join(ROOT, "web/src/i18n.tsx");

const SKIP = [
	"/node_modules/",
	"/dist/",
	"/web/dist/",
	"/.git/",
	"/.worktrees/",
	"/.pi/",
	"/locales/",
	"/web/src/i18n/messages/", // 所有语言的模块源码都是文案本体，不能证明 key 被使用
	"/tests/scratch/",
	"/plugins/legado-web/client/",
	"/plugins/vscode-editor/client/",
	"/plugins/db-client/client/",
	"/plugins/mermaid/client/",
	"/plugins/run-trace/client/",
	"/plugins/wechat-ilink/client/",
	"/plugins/page-picker/extension/",
];

function collectFiles(dir: string, out: string[] = []): string[] {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		const norm = `/${relative(ROOT, p).replace(/\\/g, "/")}`;
		if (SKIP.some((s) => norm.includes(s))) continue;
		if (e.isDirectory()) collectFiles(p, out);
		else if (/\.(tsx?|mjs|js|json)$/.test(e.name)) out.push(p);
	}
	return out;
}

function collectWords(): Set<string> {
	const words = new Set<string>();
	const wordRe = /[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*/g;
	for (const f of collectFiles(ROOT)) {
		if (f === I18N) continue;
		try {
			if (statSync(f).size > 400_000) continue;
		} catch {
			continue;
		}
		const text = readFileSync(f, "utf8");
		let m: RegExpExecArray | null;
		wordRe.lastIndex = 0;
		while ((m = wordRe.exec(text)) !== null) words.add(m[0]);
	}
	return words;
}

/** 同一入口合并 core、Canvas 及未来模块；语言文件本身不参与引用计数。 */
function zhKeys(): string[] {
	return readCatalog({ repoRoot: ROOT, includeTranslations: false }).zh.order;
}

/** Canvas helper 的静态 suffix；只读实际 helper 参数及明确的模拟步骤表。 */
function canvasRuntimeKeys(source: string): Set<string> {
	const out = new Set<string>();
	const walk = (node: any, visit: (node: any) => void) => {
		if (!node || typeof node !== "object") return;
		if (typeof node.type === "string") visit(node);
		for (const [key, value] of Object.entries(node)) {
			if (["loc", "range", "comments", "tokens"].includes(key)) continue;
			if (Array.isArray(value)) for (const child of value) walk(child, visit);
			else if (value && typeof value === "object") walk(value, visit);
		}
	};
	const collect = (expression: any) =>
		walk(expression, (node) => {
			if (
				node.type === "Literal" &&
				typeof node.value === "string" &&
				/^(action|log|error)\.[\w.]+$/.test(node.value)
			) {
				out.add(`canvas.runtime.${node.value}`);
			}
		});
	walk(parsers.typescript.parse(source, {} as any), (node) => {
		if (node.type === "CallExpression" && node.callee?.name === "canvasRuntimeMessage") collect(node.arguments[0]);
		if (node.type === "NewExpression" && node.callee?.name === "CanvasRuntimeError") collect(node.arguments[1]);
		if (node.type === "MethodDefinition" && node.key?.name === "simulateNodeExecution") {
			walk(node.value, (statement) => {
				if (
					statement.type !== "VariableDeclarator" ||
					statement.id?.name !== "steps" ||
					statement.init?.type !== "ArrayExpression"
				)
					return;
				for (const step of statement.init.elements) if (step?.type === "ArrayExpression") collect(step.elements[1]);
			});
		}
	});
	return out;
}

function dynamicKeys(): Set<string> {
	const out = new Set<string>();
	for (const v of THINKING_VALUES) out.add(`thinking.${v}`);
	for (const tk of PROMPT_TOKENS) {
		out.add(`promptTok_${tk}`);
		out.add(`promptTok_${tk}_desc`);
	}
	for (const file of collectFiles(join(ROOT, "server/canvas"))) {
		if (!file.endsWith(".ts")) continue;
		const source = readFileSync(file, "utf8");
		if (!source.includes("canvasRuntimeMessage") && !source.includes("CanvasRuntimeError")) continue;
		for (const key of canvasRuntimeKeys(source)) out.add(key);
	}
	return out;
}

describe("i18n 死 key 守卫", () => {
	it("只识别 helper 的实际静态 suffix，不豁免整模块或注释里的死 key", () => {
		const keys = canvasRuntimeKeys(`
			// canvasRuntimeMessage("log.deadComment")
			const unrelated = "error.deadLiteral";
			canvasRuntimeMessage(failed ? "log.toolFailed" : "log.toolFinished");
			new CanvasRuntimeError(format("ignored"), "error.invalidGraph");
			class Simulator { simulateNodeExecution() {
				const steps = [["text", "action.simulateAnalyze"]];
				for (const [text, key] of steps) canvasRuntimeMessage(key);
			} }
		`);
		expect([...keys].sort()).toEqual([
			"canvas.runtime.action.simulateAnalyze",
			"canvas.runtime.error.invalidGraph",
			"canvas.runtime.log.toolFailed",
			"canvas.runtime.log.toolFinished",
		]);
	});
	it("模块语言源码不作为 key 引用（包括额外语言）", () => {
		for (const file of collectFiles(join(ROOT, "web/src/i18n"))) {
			expect(relative(ROOT, file).replace(/\\/g, "/")).not.toContain("i18n/messages/");
		}
	});

	it("zh 字典里没有「全仓零引用」的 key（issue #472）", { timeout: 60_000 }, () => {
		const keys = zhKeys();
		expect(keys.length).toBeGreaterThan(800);

		const words = collectWords();
		const dynamic = dynamicKeys();
		const dead = keys.filter((k) => !dynamic.has(k) && !words.has(k));

		expect(
			dead,
			`以下 key 全仓无人引用（要么接上 UI，要么删掉 —— 同时记得清 locales/*.json）：\n${dead.join("\n")}`,
		).toEqual([]);
	});
});
