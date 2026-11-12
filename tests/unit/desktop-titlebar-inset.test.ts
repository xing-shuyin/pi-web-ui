import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 桌面壳（macOS）的红黄绿按钮由 Electron 原生绘制、浮在 WebView 上不占布局。
// 顶栏靠 padding-left 让位，贴顶的 fixed 浮层必须靠 --desktop-titlebar-h 往下让，
// 否则窄分栏（自动进手机布局）时左栏项目列表头正好压在关闭按钮上。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CSS = readFileSync(join(ROOT, "web/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBodies(css: string, selector: string): string[] {
	const out: string[] = [];
	let from = 0;
	for (;;) {
		const idx = css.indexOf(selector, from);
		if (idx < 0) return out;
		from = idx + selector.length;
		const open = css.indexOf("{", idx);
		const close = css.indexOf("}", open);
		if (open < 0 || close < 0) return out;
		out.push(css.slice(open + 1, close));
	}
}

describe("桌面壳标题栏让位（macOS 红黄绿按钮）", () => {
	it("令牌默认 0，只有 macOS 桌面壳非全屏时才是标题栏高度", () => {
		expect(CSS).toMatch(/--desktop-titlebar-h:\s*0px/);
		const mac = ruleBodies(CSS, "body.is-desktop-mac:not(.is-desktop-fullscreen) {")[0] ?? "";
		expect(mac).toMatch(/--desktop-titlebar-h:\s*\d+px/);
		// 全屏没有按钮，靠 :not() 排除；顶栏的横向让位规则必须保留
		expect(CSS).toMatch(/body\.is-desktop-mac:not\(\.is-desktop-fullscreen\) \.topbar\s*\{[^}]*padding-left/);
	});

	it("贴顶抽屉（左栏 / 终端）都让出了该高度", () => {
		// 同一个选择器出现两次：桌面宽屏是 display: contents，手机/窄分栏才是 fixed 抽屉
		const drawer = ruleBodies(CSS, ".panel-drawer {").find((b) => /position:\s*fixed/.test(b));
		expect(drawer).toBeTruthy();
		expect(drawer!).toMatch(/padding-top:\s*var\(--desktop-titlebar-h/);

		const termCommands = ruleBodies(CSS, ".term-commands {").find((b) => /position:\s*fixed/.test(b)) ?? "";
		expect(termCommands).toMatch(/top:\s*calc\([\s\S]*?--desktop-titlebar-h/);
	});

	it("抽屉的拖窗带只在 .open 时存在（关着的抽屉飘在视口外，拖拽矩形会把别处吃掉）", () => {
		// `-webkit-app-region` 的矩形不跟视口裁剪：抽屉靠 translateX(±105%) 关起来，
		// 无条件给拖拽带时，右抽屉（文件列表）关着的那份会落在窗格条上方的标签位置，
		// 表现为「能在标签上拖窗口、但标签点不动」。
		const dragRules = [...CSS.matchAll(/([^\n{}]+)\{[^}]*app-region:\s*drag/g)].map((m) => m[1].trim());
		const drawerDragRules = dragRules.filter((sel) => sel.includes(".panel-drawer"));
		expect(drawerDragRules.length).toBeGreaterThan(0);
		for (const sel of drawerDragRules) expect(sel).toContain(".open");
	});
});
