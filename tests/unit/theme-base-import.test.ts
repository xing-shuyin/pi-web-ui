import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readThemeCss } from "../../server/themes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FLOW_ZURICH_CSS = join(ROOT, "themes", "flow-zurich.css");
const FLOW_BASE_CSS = join(ROOT, "themes", "bases", "flow-base.css");

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

	it("flow-zurich.css 仅作为纯调色板 + 引入公共基底，体积精简 80% 以上", () => {
		const zurichRaw = readFileSync(FLOW_ZURICH_CSS, "utf8");
		expect(zurichRaw.split("\n").length).toBeLessThan(250);
		expect(zurichRaw).toMatch(/@import\s+["']\.\/bases\/flow-base\.css["']/);
	});

	it("readThemeCss 能完整内联展开 @import，为客户端生成单文件高性能样式表", () => {
		const inlined = readThemeCss(FLOW_ZURICH_CSS);
		expect(inlined).not.toContain('@import "./bases/flow-base.css"');
		expect(inlined).toContain(".msg-assistant .msg-body");
		expect(inlined).toContain(".thinking");
	});

	it("readThemeCss 返回的整份样式表被 @layer theme { } 包裹（且只包最外层一次）", () => {
		const css = readThemeCss(FLOW_ZURICH_CSS);
		expect(css.trimStart().startsWith("@layer theme {")).toBe(true);
		expect(css.trimEnd().endsWith("}")).toBe(true);
		expect(css.match(/@layer\s+theme\s*\{/g)?.length ?? 0).toBe(1);
		const body = css.slice(css.indexOf("{") + 1, css.lastIndexOf("}"));
		expect(body).toContain(".msg-assistant .msg-body");

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
});
