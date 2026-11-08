import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8");

function getMobile768Blocks(css: string): string {
	const regex = /@media\s*\([^)]*max-width:\s*768px[^)]*\)\s*\{/g;
	let match: RegExpExecArray | null;
	const blocks: string[] = [];

	while ((match = regex.exec(css)) !== null) {
		let depth = 1;
		let i = match.index + match[0].length;
		const start = i;
		while (i < css.length && depth > 0) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}") depth--;
			i++;
		}
		blocks.push(css.slice(start, i - 1));
	}
	return blocks.join("\n\n");
}

const MOBILE_CSS = getMobile768Blocks(CSS);

/**
 * 读某个选择器块里的 z-index 数值。允许两种单源写法：
 * - 字面值（如 `.modal-backdrop` 的 300）；
 * - 令牌 `var(--z-notice)`——回查 `styles.css` 里的令牌声明取值。
 * 叠栈区间的层级禁止写死数字（守卫：`tests/unit/overlay-stack.test.ts`）。
 */
function blockZIndex(selector: string): number {
	const block = CSS.match(new RegExp(`\\.${selector}\\s*\\{[^}]*z-index:\\s*([^;}]+)`));
	expect(block, `${selector} 缺少 z-index 声明`).not.toBeNull();

	const raw = block![1].trim();
	if (!raw.startsWith("var(")) return Number(raw);

	const token = raw.slice("var(".length, raw.indexOf(")")).trim();
	const declared = CSS.match(new RegExp(`${token}:\\s*([0-9]+);`));
	expect(declared, `${selector} 引用的令牌 ${token} 未在 styles.css 中定义`).not.toBeNull();
	return Number(declared![1]);
}

describe("手机端通知与横幅宽度规则（≤768px 满宽防过窄）", () => {
	it(".notice-text 具有断行和防溢出声明", () => {
		expect(CSS).toMatch(/\.notice-text\s*\{[^}]*overflow-wrap:\s*anywhere/);
		expect(CSS).toMatch(/\.notice-text\s*\{[^}]*word-break:\s*break-word/);
	});

	it("@media (max-width: 768px) 中 .notices 设置为拉伸满宽（两边留边距）", () => {
		expect(MOBILE_CSS).not.toBe("");

		expect(MOBILE_CSS).toMatch(/\.notices\s*\{[^}]*left:\s*10px/);
		expect(MOBILE_CSS).toMatch(/\.notices\s*\{[^}]*right:\s*10px/);
		expect(MOBILE_CSS).toMatch(/\.notices\s*\{[^}]*align-items:\s*stretch/);

		expect(MOBILE_CSS).toMatch(/\.notice\s*\{[^}]*width:\s*100%/);
	});

	it("@media (max-width: 768px) 中 .banner-container 与 .banner-card 撑满可用宽度", () => {
		expect(MOBILE_CSS).not.toBe("");

		expect(MOBILE_CSS).toMatch(/\.banner-container\s*\{[^}]*left:\s*10px/);
		expect(MOBILE_CSS).toMatch(/\.banner-container\s*\{[^}]*right:\s*10px/);
		expect(MOBILE_CSS).toMatch(/\.banner-card\s*\{[^}]*width:\s*100%/);
	});
});

describe("通知与横幅层级规则（高于遮罩与弹窗）", () => {
	it(".notices 的 z-index 处于顶层，高于一切弹窗与遮罩（如 .modal-backdrop 300）", () => {
		const noticeZ = blockZIndex("notices");
		const modalBackdropZ = blockZIndex("modal-backdrop");

		expect(noticeZ).toBeGreaterThan(modalBackdropZ);
		expect(noticeZ).toBeGreaterThan(100000);
	});

	it(".banner-container 的 z-index 处于顶层，高于遮罩与弹窗", () => {
		const bannerZ = blockZIndex("banner-container");
		expect(bannerZ).toBeGreaterThan(100000);
	});
});
