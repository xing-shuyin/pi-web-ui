/**
 * 死 i18n key 守卫（issue #472）：`web/src/i18n.tsx` 里 zh 字典的每个 key 都必须
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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { THINKING_VALUES } from "../../web/src/thinking-levels.js";
import { PROMPT_TOKENS } from "../../server/prompt-composer.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const I18N = join(ROOT, "web/src/i18n.tsx");

/** 不参与「引用」统计的路径：产物、依赖、语言包本体（是翻译不是引用）、一次性脚本。 */
const SKIP = [
	"/node_modules/",
	"/dist/",
	"/web/dist/",
	"/.git/",
	"/.worktrees/",
	"/.pi/",
	"/locales/",
	"/tests/scratch/",
	// 插件自带的大 bundle / 扩展产物：由各自的 src 生成，扫了也没意义
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
		// Exclude paths within this checkout, not a managed worktree's parent directory.
		const norm = `/${relative(ROOT, p).replace(/\\/g, "/")}`;
		if (SKIP.some((s) => norm.includes(s))) continue;
		if (e.isDirectory()) collectFiles(p, out);
		else if (/\.(tsx?|mjs|js|json)$/.test(e.name)) out.push(p);
	}
	return out;
}

/** 语料里出现过的 identifier / dotted identifier。 */
function collectWords(): Set<string> {
	const words = new Set<string>();
	const wordRe = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g;
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

/** zh 字典的全部顶层 key（普通写法 + 带引号的点号 key）。 */
function zhKeys(): string[] {
	const src = readFileSync(I18N, "utf8");
	const zhStart = src.indexOf("export const zh = {");
	const enStart = src.indexOf("export const en: Record<keyof typeof zh, string> = {");
	expect(zhStart, "找不到 zh 字典").toBeGreaterThan(-1);
	expect(enStart, "找不到 en 字典").toBeGreaterThan(zhStart);
	const keys: string[] = [];
	const re = /^\t(?:([A-Za-z_$][\w$]*)|"([^"]+)"):/gm;
	let m: RegExpExecArray | null;
	const block = src.slice(zhStart, enStart);
	while ((m = re.exec(block)) !== null) keys.push(m[1] ?? m[2]!);
	return keys;
}

/** 由代码模板拼接出来的 key（不在语料里以字面量出现，但确实在用）。 */
function dynamicKeys(): Set<string> {
	const out = new Set<string>();
	// `t(`thinking.${v}`)`，v ∈ THINKING_VALUES
	for (const v of THINKING_VALUES) out.add(`thinking.${v}`);
	// `tt(`promptTok_${tk}`)` / `tt(`promptTok_${tk}_desc`)`，tk ∈ PROMPT_TOKENS
	for (const tk of PROMPT_TOKENS) {
		out.add(`promptTok_${tk}`);
		out.add(`promptTok_${tk}_desc`);
	}
	return out;
}

describe("i18n 死 key 守卫", () => {
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
