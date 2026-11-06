import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readThemeCss } from "../../server/themes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STYLES_PATH = join(ROOT, "web", "src", "styles.css");
const SPINNER_PATH = join(ROOT, "web", "src", "components", "HalfRingSpinner.tsx");
const THINKING_PATH = join(ROOT, "web", "src", "components", "ThinkingBlock.tsx");
const TOOLCALL_PATH = join(ROOT, "web", "src", "components", "ToolCallBlock.tsx");
const LEFT_PANEL_PATH = join(ROOT, "web", "src", "components", "LeftPanel.tsx");
const THEME_FLOW_PATH = join(ROOT, "themes", "flow.css");
const THEME_WALLPAPER_FLOW_PATH = join(ROOT, "themes", "wallpaper-flow.css");
const WP_ENGINE_STYLES_PATH = join(ROOT, "plugins", "wallpaper-engine", "client", "styles.mjs");

describe("半圆环转动等待指示器 (HalfRingSpinner)", () => {
	it("HalfRingSpinner 组件输出标准 180° 半圆弧 SVG 并设置默认 1em 宽高防溢出", () => {
		const src = readFileSync(SPINNER_PATH, "utf8");
		expect(src).toContain("M 12 2 A 10 10 0 0 1 12 22");
		expect(src).toContain('strokeLinecap="round"');
		expect(src).toContain("half-ring-spin");
		expect(src).toContain("width={width}");
		expect(src).toContain("height={height}");
		expect(src).toMatch(/width\s*=\s*"1em"/);
		expect(src).toMatch(/height\s*=\s*"1em"/);
	});

	it("styles.css 包含 .half-ring-spin 旋转动画与保底 1em 宽高规则", () => {
		const css = readFileSync(STYLES_PATH, "utf8");
		expect(css).toMatch(/\.half-ring-spin\s*\{[^}]*animation:\s*spin/);
		expect(css).toMatch(/\.half-ring-spin\s*\{[^}]*width:\s*1em/);
		expect(css).toMatch(/\.half-ring-spin\s*\{[^}]*height:\s*1em/);
	});

	it("styles.css 中 .project-icon 与 .session-icon 具备固定宽高限制防膨胀", () => {
		const css = readFileSync(STYLES_PATH, "utf8");
		expect(css).toMatch(/\.project-icon\s*\{[^}]*width:\s*14px/);
		expect(css).toMatch(/\.project-icon\s*\{[^}]*height:\s*14px/);
		expect(css).toMatch(/\.session-icon\s*\{[^}]*width:\s*14px/);
		expect(css).toMatch(/\.session-icon\s*\{[^}]*height:\s*14px/);
	});

	it("底栏 working-spin 与工作区 transition-spinner 均为半圆环转动结构", () => {
		const css = readFileSync(STYLES_PATH, "utf8");
		expect(css).toMatch(
			/\.working-spin\s*\{[^}]*border:\s*2px solid transparent[^}]*border-top-color:[^}]*border-right-color:/,
		);
		expect(css).toMatch(
			/\.workspace-transition-spinner\s*\{[^}]*border:\s*2px solid transparent[^}]*border-top-color:[^}]*border-right-color:/,
		);
	});

	it("ThinkingBlock 与 ToolCallBlock 运行等待均接入 HalfRingSpinner", () => {
		const thinkingSrc = readFileSync(THINKING_PATH, "utf8");
		expect(thinkingSrc).toContain("HalfRingSpinner");
		expect(thinkingSrc).not.toContain("FiLoader");

		const toolcallSrc = readFileSync(TOOLCALL_PATH, "utf8");
		expect(toolcallSrc).toContain("HalfRingSpinner");
		expect(toolcallSrc).not.toContain("FiLoader");
		expect(toolcallSrc).not.toContain("waitingModel ? <FiClock />");
		expect(toolcallSrc).toContain("running || waitingModel ? <HalfRingSpinner />");
	});

	it("LeftPanel 切换加载接入 HalfRingSpinner", () => {
		const leftPanelSrc = readFileSync(LEFT_PANEL_PATH, "utf8");
		expect(leftPanelSrc).toContain("HalfRingSpinner");
		expect(leftPanelSrc).not.toContain("FiLoader");
	});

	it("极简行文 (flow / wallpaper-flow) 与壁纸插件主题动画引用有效关键帧且支持旋转", () => {
		const flowCss = readThemeCss(THEME_FLOW_PATH);
		expect(flowCss).not.toContain("conv-spin");
		expect(flowCss).toContain("animation: spin 0.85s linear infinite");

		const wpFlowCss = readThemeCss(THEME_WALLPAPER_FLOW_PATH);
		expect(wpFlowCss).not.toContain("conv-spin");
		expect(wpFlowCss).toContain("animation: spin 0.85s linear infinite");

		const wpEngineStyles = readFileSync(WP_ENGINE_STYLES_PATH, "utf8");
		expect(wpEngineStyles).not.toContain("conv-spin");
		expect(wpEngineStyles).toContain("animation: spin 0.85s linear infinite");
	});
});
