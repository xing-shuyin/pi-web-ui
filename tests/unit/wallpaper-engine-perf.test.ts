import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readThemeCss } from "../../server/themes.js";

describe("wallpaper-engine 性能优化与画质分级守卫测试", () => {
	const manifestPath = resolve(process.cwd(), "plugins/wallpaper-engine/manifest.json");
	const entryPath = resolve(process.cwd(), "plugins/wallpaper-engine/client/entry.mjs");
	const stylesPath = resolve(process.cwd(), "plugins/wallpaper-engine/client/styles.mjs");
	const indexPath = resolve(process.cwd(), "plugins/wallpaper-engine/index.mjs");

	it("manifest.json 版本递增且提供 qualityPreset、antiAliasing 与 lightWallpaperMode 设置", () => {
		const raw = readFileSync(manifestPath, "utf8");
		const manifest = JSON.parse(raw);
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		const atLeast = (value: string, floor: string) => {
			const [a, b, c] = value.split(".").map(Number);
			const [x, y, z] = floor.split(".").map(Number);
			return a !== x ? a > x : b !== y ? b > y : c >= z;
		};
		expect(atLeast(manifest.version, "0.3.68")).toBe(true);

		const keys = manifest.settings.map((s: { key: string }) => s.key);
		expect(keys).toContain("qualityPreset");
		expect(keys).toContain("antiAliasing");
		expect(keys).toContain("lightWallpaperMode");

		const themeSetting = manifest.settings.find((s: { key: string }) => s.key === "wallpaperTheme");
		expect(themeSetting.default).toBe("obsidian");
		expect(themeSetting.options.some((o: { value: string }) => o.value === "flow")).toBe(true);

		const qSetting = manifest.settings.find((s: { key: string }) => s.key === "qualityPreset");
		expect(qSetting.default).toBe("high");

		const aaSetting = manifest.settings.find((s: { key: string }) => s.key === "antiAliasing");
		expect(aaSetting.default).toBe("off");

		const fpsSetting = manifest.settings.find((s: { key: string }) => s.key === "fpsLimit");
		expect(fpsSetting.default).toBe("0");

		const opacitySetting = manifest.settings.find((s: { key: string }) => s.key === "glassOpacity");
		expect(opacitySetting.default).toBe(40);

		const lightSetting = manifest.settings.find((s: { key: string }) => s.key === "lightWallpaperMode");
		expect(lightSetting.default).toBe(false);
	});

	it("styles.mjs 移除所有容器阴影，输入框胶囊、工具与思考文字全量提亮，折叠与复制图标采用 drop-shadow 矢量锁边，顶栏按钮裸幽灵化，消息带方案 B 超轻微柔雾且工具调用彻底裸透无框", () => {
		const styles = readFileSync(stylesPath, "utf8");
		expect(styles).not.toContain("0 0 16px rgba(0, 0, 0");
		expect(styles).not.toContain("image-rendering: high-quality");
		expect(styles).toContain("translate3d");
		expect(styles).toContain("box-shadow: none !important;");
		expect(styles).toContain("Math.max(0.0");
		expect(styles).toContain(".composer-tools .chip-sub");
		expect(styles).toContain(".toolcall-name");
		expect(styles).toContain(".thinking-label");
		expect(styles).toContain(".chead-toggle");
		expect(styles).toContain(".chead-copy");
		expect(styles).toContain(".panel-rail");
		expect(styles).toContain("drop-shadow(0 0 1px rgba(0, 0, 0, 0.95))");
		expect(styles).toContain(".topbar .sandbox-chip:not(:hover)");
		expect(styles).toContain(
			".toolcall,\n.thinking {\n\tbackground: transparent !important;\n\tborder: none !important;\n\tborder-radius: 0 !important;\n\tmargin: 0 !important;",
		);
		expect(styles).toContain(
			".msg-assistant .msg-body {\n\tbackground: rgba(12, 18, 32, 0.38) !important;\n\tborder: 1px solid rgba(255, 255, 255, 0.05) !important;\n\tborder-radius: 16px !important;\n\tbox-shadow: none !important;\n\tbackdrop-filter: blur(2px) saturate(115%) !important;\n\t-webkit-backdrop-filter: blur(2px) saturate(115%) !important;\n\toverflow: hidden !important;\n}",
		);
		expect(styles).toContain(".msg-text {\n\tpadding: 6px 12px !important;\n\tborder-radius: 8px !important;\n}");
		expect(styles).toContain(".inputbox {\n\tbackground: rgba(12, 14, 20, 0.48) !important;");
		expect(styles).toContain("backdrop-filter: blur(10px) saturate(130%) !important;");
		expect(styles).toContain(".quick-chip {\n\tbackground: rgba(14, 16, 24, 0.45) !important;");
		expect(styles).toContain("backdrop-filter: blur(8px) saturate(130%) !important;");
		expect(styles).toContain("border-radius: 8px !important;");
		expect(styles).not.toContain(".composer-tools-left button:hover");
		expect(styles).toContain("lightWallpaperMode");
	});

	it("胶囊不带 backdrop-filter：壁纸是每帧在变的画面，逐颗回读+卷积是最贵的用法（issue #858）", () => {
		const styles = readFileSync(stylesPath, "utf8");
		const at = styles.indexOf(".toolcall,\n.thinking {");
		expect(at, "styles.mjs 里没有胶囊规则").toBeGreaterThanOrEqual(0);
		const capsule = styles.slice(at, styles.indexOf("}", at));
		expect(capsule).toContain("backdrop-filter: none !important;");
		expect(styles).not.toContain("blur(12px) saturate(140%)");

		const offenders: string[] = [];
		for (const [, selector, body] of styles.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
			if (!/\.(toolcall|thinking)\b/.test(selector)) continue;
			if (/backdrop-filter:\s*blur/.test(body)) offenders.push(selector.trim());
		}
		expect(offenders, "胶囊不得重新引入 backdrop-filter 模糊").toEqual([]);
	});

	it("黑曜冷月专属主题 CSS 去除了所有容器 box-shadow，顶栏底栏无多余大模糊，消息正文带方案 B 超轻微柔雾且工具调用彻底裸透无框", () => {
		const css = readThemeCss(resolve(process.cwd(), "themes/wallpaper-obsidian.css"));
		const blockOf = (selector: string): string => {
			const at = css.indexOf(`\n${selector} {`);
			expect(at, `主题 CSS 里没有规则：${selector}`).toBeGreaterThanOrEqual(0);
			return css.slice(at, css.indexOf("}", at));
		};
		for (const sel of [
			".topbar",
			".statusbar",
			".msg",
			".msg-assistant .msg-body",
			".inputbox",
			".quick-chip",
			".card",
		]) {
			expect(blockOf(sel), `${sel} 必须无阴影`).toContain("box-shadow: none;");
		}
		expect(css).toContain(".topbar {\n\tbackground: rgba");
		expect(blockOf(".topbar")).toContain("backdrop-filter: none;");
		expect(blockOf(".statusbar")).toContain("backdrop-filter: none;");
		expect(css).toContain(
			".msg-assistant .msg-body {\n\tbackground: rgba(12, 18, 32, 0.38);\n\tborder: 1px solid rgba(255, 255, 255, 0.05);\n\tborder-radius: 16px;\n\tbox-shadow: none;\n\tbackdrop-filter: blur(2px) saturate(115%);\n\t-webkit-backdrop-filter: blur(2px) saturate(115%);\n\toverflow: hidden;\n}",
		);
		expect(css).toContain(".msg-text {\n\tpadding: 6px 12px;\n\tborder-radius: 8px;\n}");
		expect(css).toContain(".inputbox {\n\tbackground: rgba(12, 14, 20, 0.48);");
		expect(css).toContain("backdrop-filter: blur(10px) saturate(130%);");
		expect(css).toContain(".quick-chip {\n\tbackground: rgba(14, 16, 24, 0.45);");
		expect(css).toContain("backdrop-filter: blur(8px) saturate(130%);");
		expect(css).toContain(
			".toolcall,\n.thinking {\n\tbackground: transparent;\n\tborder: none;\n\tborder-radius: 0;\n\tmargin: 0;",
		);
		expect(css).toContain(".composer-tools .chip-sub");
		expect(css).toContain(".toolcall-name");
		expect(css).toContain(".thinking-label");
		expect(css).toContain(".chead-toggle");
		expect(css).toContain(".chead-copy");
		expect(css).toContain(".panel-rail");
		expect(css).toContain("drop-shadow(0 0 1px rgba(0, 0, 0, 0.95))");
		expect(css).toContain(".topbar .sandbox-chip:not(:hover)");
		expect(css).toContain(".dropdown > button.chip:hover {\n\tborder-radius: 8px;\n}");
		expect(css).not.toContain(".composer-tools-left button:hover");
		expect(css).toContain(".inputbox .btn.send");
		expect(blockOf(".inputbox .btn.send"), "发送按钮箭头必须是深黑 #050507").toContain("color: #050507;");
		expect(css).toContain("span.bar-item-icon");
		expect(css).toContain("svg.bar-item-icon");
	});

	it("entry.mjs 提供清晰原生 QUALITY_PROFILES，优先加载打包 scene.pkg 杜绝降级模糊，抽屉包含亮色壁纸增强开关且清理了已删除的旧主题", () => {
		const entry = readFileSync(entryPath, "utf8");
		expect(entry).toContain("QUALITY_PROFILES");
		expect(entry).not.toContain('value="cyber"');
		expect(entry).not.toContain('value="synthwave"');
		expect(entry).not.toContain('value="aurora"');
		expect(entry).not.toContain('value="amber"');
		expect(entry).toContain('value="obsidian"');
		expect(entry).toContain('value="flow"');
		expect(entry).not.toContain("videoTexScale: 0.75");
		expect(entry).toContain("shouldTryPkg");
		expect(entry).not.toContain(`antiAliasing: "msaa4", // 开启高质量抗锯齿`);
		expect(entry).toContain("pi-we-quality-select");
		expect(entry).toContain("pi-we-aa-select");
		expect(entry).toContain("pi-we-lightmode-check");
		expect(entry).toContain('antiAliasing: "off"');
		expect(entry).toContain("Promise.all([");
		expect(entry).toContain('loading="lazy"');
		expect(entry).toContain('decoding="async"');
		expect(entry).toContain("json.activeWallpaper");
	});

	it("index.mjs 支持 qualityPreset、antiAliasing 与 lightWallpaperMode 状态持久化，且下发 hasPkg 标识与 Map 索引加速", () => {
		const index = readFileSync(indexPath, "utf8");
		expect(index).toContain("qualityPreset");
		expect(index).toContain("antiAliasing");
		expect(index).toContain("lightWallpaperMode");
		expect(index).toContain("cachedWallpaperMap");
		expect(index).toContain("hasPkg: Boolean(w.pkgPath)");
		expect(index).toContain("cacheFile");
		expect(index).toContain("loadCache()");
		expect(index).toContain("persistCache()");
		expect(index).toContain('res.setHeader("ETag"');
		expect(index).toContain("304");
	});

	it("极简行文专属主题提供极致紧凑排版、正文零边框零背景色与微小紧致黑色阴影，保证 AI 回答如行云流水般流畅", () => {
		const flowCss = readThemeCss(resolve(process.cwd(), "themes/wallpaper-flow.css"));
		expect(flowCss).toContain(
			".msg-assistant .msg-body {\n\tbackground: transparent;\n\tborder: none;\n\tborder-radius: 0;",
		);
		expect(flowCss).toContain(".msg-text,\n.msg-assistant .msg-text {\n\tbackground: transparent;\n\tborder: none;");
		expect(flowCss).toContain(".msg-body p {\n\tmargin: 0.36em 0;");
		expect(flowCss).toContain(".msg-body p:first-child {\n\tmargin-top: 0;\n}");
		expect(flowCss).toContain("text-shadow:\n\t\t0 0 1px rgba(0, 0, 0, 0.95),\n\t\t0 1px 1.5px rgba(0, 0, 0, 0.88);");
		expect(flowCss).toContain(".thinking {\n\tdisplay: inline-flex;");
		expect(flowCss).toContain(".toolcall-body,\n.thinking-body {\n\tdisplay: none;\n}");
		expect(flowCss).toContain(".thinking .thinking-summary-text");
		expect(flowCss).toContain(".thinking-status");
		expect(flowCss).toContain(".thinking-name");
		expect(flowCss).toContain(".flow-turn");
		expect(flowCss).toContain(".toolcall-out-badge");
		expect(flowCss).toContain(".toolcall-images");

		const styles = readFileSync(stylesPath, "utf8");
		expect(styles).toContain("WALLPAPER_THEMES");
		expect(styles).toContain("flow:");
		expect(styles).toContain("isFlowTheme");
		expect(styles).toContain("字级输入流系统");
		expect(styles).toContain(".turn-tools-trail");
		expect(styles).toContain(".thinking-status");
		expect(styles).toContain(".thinking .thinking-summary-text");
		expect(styles).toContain(".toolcall-out-badge");
		expect(styles).toContain(".toolcall-images");
		expect(styles).toContain("pi-we-inspector-backdrop");
		expect(styles).toContain("pi-we-inspector-dialog");

		const entry = readFileSync(entryPath, "utf8");
		expect(entry).toContain("createToolInspector");
		expect(entry).toContain("setupToolInspectorClickListener");
		expect(entry).toContain("toolcall-payload-output");
		expect(entry).toContain("pi-we-inspector-images");
	});

	it("index.mjs 静态资源服务对 SVG 注入 CSP sandbox 防范跨站", () => {
		const indexSrc = readFileSync(indexPath, "utf8");
		expect(indexSrc).toContain('headers["Content-Security-Policy"] = "sandbox"');
		expect(indexSrc).toContain('headers["X-Content-Type-Options"] = "nosniff"');
	});
});
