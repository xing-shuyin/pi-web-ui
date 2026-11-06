import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STYLES_CSS = join(ROOT, "web", "src", "styles.css");
const THEMES_DIR = join(ROOT, "themes");
const FLOW_BASE_CSS = join(THEMES_DIR, "bases", "flow-base.css");
const CORE_DOC = join(ROOT, "docs", "architecture-core.md");

const MAX_BASE_IMPORTANT = 1;

function readText(path: string): string {
	return readFileSync(path, "utf8");
}

function countImportant(css: string): number {
	return css.split("!important").length - 1;
}

function listCssFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".css")) out.push(full);
		}
	};
	walk(dir);
	return out.sort();
}

describe("CSS 分层契约（@layer guard, base, theme）", () => {
	it("styles.css 声明三层顺序：@layer guard, base, theme;", () => {
		const css = readText(STYLES_CSS);
		const order = css.match(/@layer\s+guard\s*,\s*base\s*,\s*theme\s*;/);
		expect(
			order,
			"web/src/styles.css 必须显式声明层序 `@layer guard, base, theme;`（顺序即优先级：普通声明 theme > base > guard）",
		).not.toBeNull();
		expect(css.indexOf(order![0])).toBeLessThan(css.indexOf("@layer base {"));
	});

	it("styles.css 把基线样式包进 @layer base { ... }", () => {
		const css = readText(STYLES_CSS);
		expect(css, "web/src/styles.css 必须含 `@layer base {`（整份基线样式都在 base 层里）").toContain("@layer base {");
	});

	it("例外规则所在的 @layer guard { ... }（若存在）必须排在 @layer base { 之后", () => {
		const css = readText(STYLES_CSS);
		const guardAt = css.indexOf("@layer guard {");
		const baseAt = css.indexOf("@layer base {");
		if (guardAt === -1) return;
		expect(
			guardAt,
			"@layer guard { 必须写在 @layer base { 之后：同文件内按文本顺序阅读时它才是「例外收口」而不是主体",
		).toBeGreaterThan(baseAt);
		const guardBody = css.slice(guardAt);
		expect(guardBody, "@layer guard 内的 !important 是唯一合法用法（用来压内联样式）").toContain("!important");
	});

	it(`styles.css 的 !important 数量 ≤ ${MAX_BASE_IMPORTANT}`, () => {
		const count = countImportant(readText(STYLES_CSS));
		expect(
			count,
			`web/src/styles.css 现有 ${count} 处 !important，上限 ${MAX_BASE_IMPORTANT}（唯一活口：mermaid 运行时内联 style）。` +
				"新增 !important 前先想：同层内用复合类提权；盖主题/三方库普通声明用文件末尾无层覆盖区；" +
				"只有运行时内联 style（如 mermaid d3 .style()）才配写，并写明原因、收进 @layer guard。",
		).toBeLessThanOrEqual(MAX_BASE_IMPORTANT);
	});

	it("themes/**/*.css 里 !important 必须为 0（主题只靠 theme 层胜出）", () => {
		const files = listCssFiles(THEMES_DIR);
		expect(files.length, "themes/ 下应当存在主题样式文件").toBeGreaterThan(0);

		const offenders: string[] = [];
		let total = 0;
		for (const file of files) {
			const count = countImportant(readText(file));
			if (count > 0) offenders.push(`${relative(ROOT, file).split("\\").join("/")} (${count})`);
			total += count;
		}
		expect(
			total,
			"Theme CSS must not use !important — the `@layer theme` wrapper (server/themes.ts) already outranks `@layer base`, " +
				`so !important here only restarts the arms race. Offenders: ${offenders.join(", ") || "(none)"}`,
		).toBe(0);
	});

	it("themes/bases/flow-base.css 不再用 #root 提权重（分层后靠层序而非 ID 权重）", () => {
		const css = readText(FLOW_BASE_CSS);
		expect(
			/#root\s+\.flow-turn/.test(css),
			"themes/bases/flow-base.css 已不需要 `#root .flow-turn` 这类 ID 加权选择器（它属于 theme 层，天然压过 base）",
		).toBe(false);
	});

	it("docs/architecture-core.md 写明分层契约", () => {
		const doc = readText(CORE_DOC);
		expect(doc).toContain("@layer");
		for (const keyword of ["guard", "base", "theme", "!important"]) {
			expect(doc, `docs/architecture-core.md 的分层说明缺少关键字 \`${keyword}\``).toContain(keyword);
		}
		expect(doc).toMatch(/@layer guard, base, theme;/);
	});
});
