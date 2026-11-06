import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web", "src", "styles.css"), "utf8");

describe("顶栏溢出菜单（issue #183）", () => {
	it("菜单项规则只命中直接子节点，不许后代选择器盖住搬进来的宿主控件", () => {
		const unscoped = [...CSS.matchAll(/\.plugin-topbar-menu\s+(?!>)\s*button\b/g)].map((m) => m[0]);
		expect(unscoped).toEqual([]);
		expect(CSS).toMatch(/\.plugin-topbar-menu\s*>\s*button\s*[,{]/);
	});

	it("GitHub 外链与菜单项按钮同一套外观（同一选择器组，不再自成一款）", () => {
		const group = CSS.match(
			/\.plugin-topbar-menu\s*>\s*button\s*,\s*\.plugin-topbar-menu\s*>\s*a\.plugin-topbar-menu-link\s*\{([^}]*)\}/s,
		);
		expect(group).toBeTruthy();
		expect(group![1]).toMatch(/display:\s*block/);
		expect(group![1]).toMatch(/text-decoration:\s*none/);
		const occurrences = [...CSS.matchAll(/\.plugin-topbar-menu\s*>\s*a\.plugin-topbar-menu-link/g)].length;
		expect(occurrences).toBe(2);
		expect(CSS).not.toMatch(/a\.plugin-topbar-menu-link[^{]*\{[^}]*display:\s*flex/s);
	});

	it("嵌套下拉打开时 portal 放行横向溢出（:has 门控 + overflow:visible）", () => {
		expect(CSS).toMatch(/\.plugin-topbar-menu\.portal\s*:\s*has\(\s*\.dd-menu\s*\)\s*\{[^}]*overflow\s*:\s*visible/s);
	});

	it("portal 里的 chip 在移动端断点与顶栏同高（portal 没有 .topbar 祖先）", () => {
		expect(CSS).toMatch(/\.plugin-topbar-menu\.portal\s+\.chip\s*\{[^}]*height/s);
	});

	it("菜单里的行与文字统一 12.5px（不再让 .tb-row 继承 body 的 14px）", () => {
		const menu = CSS.match(/\.plugin-topbar-menu\s*\{([^}]*)\}/s);
		expect(menu).toBeTruthy();
		expect(menu![1]).toMatch(/font-size:\s*12\.5px/);
		const rows = CSS.match(/\.plugin-topbar-menu\.portal\s+:is\(\.tb-row[^{]*\{([^}]*)\}/s);
		expect(rows).toBeTruthy();
		expect(rows![1]).toMatch(/font-size:\s*12\.5px/);
	});

	it("菜单里的图标格包着的 svg 也要填满方盒", () => {
		expect(CSS).toMatch(
			/\.plugin-topbar-menu\.portal\s+\.plugin-icon-glyph\s+svg\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/s,
		);
	});
});
