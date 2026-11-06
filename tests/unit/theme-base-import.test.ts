import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readThemeCss } from "../../server/themes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FLOW_CSS = join(ROOT, "themes", "flow.css");
const FLOW_LIGHT_CSS = join(ROOT, "themes", "flow-light.css");
const FLOW_BASE_CSS = join(ROOT, "themes", "bases", "flow-base.css");
const ZHUPI_CSS = join(ROOT, "themes", "zhupi.css");
const ZHUPI_DARK_CSS = join(ROOT, "themes", "zhupi-dark.css");
const ZHUPI_BASE_CSS = join(ROOT, "themes", "bases", "zhupi-base.css");
const ZHUJIAN_CSS = join(ROOT, "themes", "zhujian.css");
const ZHUJIAN_DARK_CSS = join(ROOT, "themes", "zhujian-dark.css");
const ZHUJIAN_BASE_CSS = join(ROOT, "themes", "bases", "zhujian-base.css");
const OBSIDIAN_CSS = join(ROOT, "themes", "wallpaper-obsidian.css");
const OBSIDIAN_BASE_CSS = join(ROOT, "themes", "bases", "obsidian-base.css");

describe("主题基底解耦与 @import 服务端内联体系", () => {
	it("themes/bases/flow-base.css 存在且作为公共形态基底", () => {
		expect(existsSync(FLOW_BASE_CSS)).toBe(true);
		const baseContent = readFileSync(FLOW_BASE_CSS, "utf8");
		expect(baseContent).toContain(".msg-assistant .msg-body");
		expect(baseContent).toContain(".flow-turn");
		expect(baseContent).toContain("--flow-inline-stream: 1");
		expect(baseContent).toContain(".toolcall");
		expect(baseContent).toContain(".thinking");
	});

	it("flow.css 与 flow-light.css 仅作为纯调色板 + 引入公共基底，体积精简 80% 以上", () => {
		const flowRaw = readFileSync(FLOW_CSS, "utf8");
		const lightRaw = readFileSync(FLOW_LIGHT_CSS, "utf8");

		expect(flowRaw.split("\n").length).toBeLessThan(250);
		expect(lightRaw.split("\n").length).toBeLessThan(250);

		expect(flowRaw).toMatch(/@import\s+["']\.\/bases\/flow-base\.css["']/);
		expect(lightRaw).toMatch(/@import\s+["']\.\/bases\/flow-base\.css["']/);
	});

	it("readThemeCss 能完整内联展开 @import，为客户端生成单文件高性能样式表", () => {
		const inlinedFlow = readThemeCss(FLOW_CSS);
		const inlinedLight = readThemeCss(FLOW_LIGHT_CSS);

		expect(inlinedFlow).not.toContain('@import "./bases/flow-base.css"');
		expect(inlinedFlow).toContain(".msg-assistant .msg-body");
		expect(inlinedFlow).toContain(".thinking");

		expect(inlinedLight).not.toContain('@import "./bases/flow-base.css"');
		expect(inlinedLight).toContain(".msg-assistant .msg-body");
		expect(inlinedLight).toContain(".thinking");
	});

	it("readThemeCss 返回的整份样式表被 @layer theme { } 包裹（且只包最外层一次）", () => {
		for (const file of [FLOW_CSS, FLOW_LIGHT_CSS, ZHUPI_CSS, ZHUJIAN_CSS, OBSIDIAN_CSS]) {
			const css = readThemeCss(file);
			expect(css.trimStart().startsWith("@layer theme {"), `${file} 未以 @layer theme { 开头`).toBe(true);
			expect(css.trimEnd().endsWith("}"), `${file} 未正确闭合 @layer theme`).toBe(true);
			expect(css.match(/@layer\s+theme\s*\{/g)?.length ?? 0, `${file} 出现了多层 @layer theme 嵌套`).toBe(1);
			const body = css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
			expect(body).toContain(".msg-assistant .msg-body");
		}

		const baseOnly = readThemeCss(FLOW_BASE_CSS, new Set<string>(), 1);
		expect(baseOnly).not.toContain("@layer theme {");
		expect(baseOnly).toContain(".msg-assistant .msg-body");
	});

	it("flow-base.css 中主操作实底按钮与角标统一走语义变量，杜绝写死黑底黑字或白底白字", () => {
		const baseContent = readFileSync(FLOW_BASE_CSS, "utf8");
		expect(baseContent).toMatch(/\.inputbox \.btn\.send \{[^}]*background:\s*var\(--accent\)/);
		expect(baseContent).toMatch(/color:\s*var\(--accent-contrast, #fff\)/);

		expect(baseContent).toContain(".topbar .bar-item-badge:not(.bg-task-badge)");
	});

	it("朱批与朱笺古风主题成功解耦公共基底，消除数千行重复代码", () => {
		expect(existsSync(ZHUPI_BASE_CSS)).toBe(true);
		expect(existsSync(ZHUJIAN_BASE_CSS)).toBe(true);

		const zhupiBase = readFileSync(ZHUPI_BASE_CSS, "utf8");
		const zhujianBase = readFileSync(ZHUJIAN_BASE_CSS, "utf8");

		expect(zhupiBase).toContain(".msg-user .msg-body");
		expect(zhupiBase).toContain(".toolcall .toolcall-spacer");
		expect(zhujianBase).toContain(".toolcall .toolcall-spacer");

		const inlinedZhupi = readThemeCss(ZHUPI_CSS);
		const inlinedZhupiDark = readThemeCss(ZHUPI_DARK_CSS);
		expect(inlinedZhupi).toContain(".toolcall .toolcall-spacer");
		expect(inlinedZhupiDark).toContain(".toolcall .toolcall-spacer");

		const inlinedZhujian = readThemeCss(ZHUJIAN_CSS);
		const inlinedZhujianDark = readThemeCss(ZHUJIAN_DARK_CSS);
		expect(inlinedZhujian).toContain(".toolcall .toolcall-spacer");
		expect(inlinedZhujianDark).toContain(".toolcall .toolcall-spacer");
	});

	it("黑曜冷月壁纸主题成功解耦公共基底 obsidian-base.css", () => {
		expect(existsSync(OBSIDIAN_BASE_CSS)).toBe(true);
		const obsidianRaw = readFileSync(OBSIDIAN_CSS, "utf8");
		expect(obsidianRaw.split("\n").length).toBeLessThan(100);
		expect(obsidianRaw).toMatch(/@import\s+["']\.\/bases\/obsidian-base\.css["']/);

		const inlinedObs = readThemeCss(OBSIDIAN_CSS);
		expect(inlinedObs).toContain(".msg-assistant .msg-body");
		expect(inlinedObs).toMatch(/box-shadow:\s*none/);
	});
});
