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
		// 不钉死具体版本号（每次发版都要改）：这里只锁「是合法 semver 且不低于引入
		// qualityPreset 的那一版」；版本必须**递增**由 plugin-version-bump-guard 守。
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
		// 严禁在消息文本中存在 16px 大半径多层模糊文本阴影
		expect(styles).not.toContain("0 0 16px rgba(0, 0, 0");
		// 严禁在视频元素上声明强制双三次/高负荷渲染
		expect(styles).not.toContain("image-rendering: high-quality");
		// 抽屉面板必须采用硬件加速 translate3d
		expect(styles).toContain("translate3d");
		// 用户气泡与卡片容器阴影已移除
		expect(styles).toContain("box-shadow: none !important;");
		// 解除最小 40% 限制
		expect(styles).toContain("Math.max(0.0");
		// 输入框底部胶囊文字彻底提亮
		expect(styles).toContain(".composer-tools .chip-sub");
		// 工具与思考文字彻底提亮并注入1px紧致微边缘
		expect(styles).toContain(".toolcall-name");
		expect(styles).toContain(".thinking-label");
		// 折叠展开箭头与卡头复制按钮矢量锁边，折叠后浮层按钮 .panel-rail 适配透明
		expect(styles).toContain(".chead-toggle");
		expect(styles).toContain(".chead-copy");
		expect(styles).toContain(".panel-rail");
		expect(styles).toContain("drop-shadow(0 0 1px rgba(0, 0, 0, 0.95))");
		// 顶栏按钮（含沙盒、临时对话等）默认彻底裸幽灵化，绝不残留突兀高亮边框或圆环
		expect(styles).toContain(".topbar .sandbox-chip:not(:hover)");
		// 工具调用与思考卡彻底裸透无框无底板（方案 B：连成一体无空隙）
		expect(styles).toContain(
			".toolcall,\n.thinking {\n\tbackground: transparent !important;\n\tborder: none !important;\n\tborder-radius: 0 !important;\n\tmargin: 0 !important;",
		);
		// 助手消息正文容器具备单个气泡独立圆角与轻微毛玻璃背景（无边缘阴影），正文消息与工具/思考对齐留出边距
		expect(styles).toContain(
			".msg-assistant .msg-body {\n\tbackground: rgba(12, 18, 32, 0.38) !important;\n\tborder: 1px solid rgba(255, 255, 255, 0.05) !important;\n\tborder-radius: 16px !important;\n\tbox-shadow: none !important;\n\tbackdrop-filter: blur(2px) saturate(115%) !important;\n\t-webkit-backdrop-filter: blur(2px) saturate(115%) !important;\n\toverflow: hidden !important;\n}",
		);
		expect(styles).toContain(".msg-text {\n\tpadding: 6px 12px !important;\n\tborder-radius: 8px !important;\n}");
		// 输入框与快捷指令芯片均具备轻微毛玻璃模糊
		expect(styles).toContain(".inputbox {\n\tbackground: rgba(12, 14, 20, 0.48) !important;");
		expect(styles).toContain("backdrop-filter: blur(10px) saturate(130%) !important;");
		expect(styles).toContain(".quick-chip {\n\tbackground: rgba(14, 16, 24, 0.45) !important;");
		expect(styles).toContain("backdrop-filter: blur(8px) saturate(130%) !important;");
		// 严禁下拉胶囊按钮在 hover 时变形为 50% 椭圆，必须锁定保持 8px 圆角
		expect(styles).toContain("border-radius: 8px !important;");
		expect(styles).not.toContain(".composer-tools-left button:hover");
		// 支持亮色壁纸增强模式
		expect(styles).toContain("lightWallpaperMode");
	});

	it("黑曜冷月专属主题 CSS 去除了所有容器 box-shadow，顶栏底栏无多余大模糊，消息正文带方案 B 超轻微柔雾且工具调用彻底裸透无框", () => {
		const css = readThemeCss(resolve(process.cwd(), "themes/wallpaper-obsidian.css"));
		// 前提：`!important` 已随 CSS 分层重构从主题样式里整体删除（值一字未改）。
		// 旗标去掉后 `box-shadow: none;` / `backdrop-filter: none;` 这类声明在全文件里出现十几次，
		// 单条 toContain 会退化为「任意处出现过」 -> 改为按规则块断言，严格度不降。
		const blockOf = (selector: string): string => {
			const at = css.indexOf(`\n${selector} {`);
			expect(at, `主题 CSS 里没有规则：${selector}`).toBeGreaterThanOrEqual(0);
			return css.slice(at, css.indexOf("}", at));
		};
		// 用户气泡、输入框、卡片等容器均已设置为 box-shadow: none
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
		// 顶栏与底栏保持纯净无大模糊
		expect(css).toContain(".topbar {\n\tbackground: rgba");
		expect(blockOf(".topbar")).toContain("backdrop-filter: none;");
		expect(blockOf(".statusbar")).toContain("backdrop-filter: none;");
		// 单个气泡独立圆角与轻微毛玻璃背景（无边缘阴影），正文消息留出对齐边距
		expect(css).toContain(
			".msg-assistant .msg-body {\n\tbackground: rgba(12, 18, 32, 0.38);\n\tborder: 1px solid rgba(255, 255, 255, 0.05);\n\tborder-radius: 16px;\n\tbox-shadow: none;\n\tbackdrop-filter: blur(2px) saturate(115%);\n\t-webkit-backdrop-filter: blur(2px) saturate(115%);\n\toverflow: hidden;\n}",
		);
		expect(css).toContain(".msg-text {\n\tpadding: 6px 12px;\n\tborder-radius: 8px;\n}");
		// 输入框与快捷指令芯片均具备轻微毛玻璃模糊
		expect(css).toContain(".inputbox {\n\tbackground: rgba(12, 14, 20, 0.48);");
		expect(css).toContain("backdrop-filter: blur(10px) saturate(130%);");
		expect(css).toContain(".quick-chip {\n\tbackground: rgba(14, 16, 24, 0.45);");
		expect(css).toContain("backdrop-filter: blur(8px) saturate(130%);");
		// 工具调用与思考卡彻底移除硬边框并消除间隙连成一体
		expect(css).toContain(
			".toolcall,\n.thinking {\n\tbackground: transparent;\n\tborder: none;\n\tborder-radius: 0;\n\tmargin: 0;",
		);
		// 输入框底部胶囊文字提亮
		expect(css).toContain(".composer-tools .chip-sub");
		// 工具与思考文字提亮
		expect(css).toContain(".toolcall-name");
		expect(css).toContain(".thinking-label");
		// 折叠与复制图标 drop-shadow 矢量锁边，折叠后浮层按钮 .panel-rail 适配透明
		expect(css).toContain(".chead-toggle");
		expect(css).toContain(".chead-copy");
		expect(css).toContain(".panel-rail");
		expect(css).toContain("drop-shadow(0 0 1px rgba(0, 0, 0, 0.95))");
		// 顶栏按钮裸幽灵化，沙盒与临时会话在非 hover 时无突兀黄色圆圈高亮
		expect(css).toContain(".topbar .sandbox-chip:not(:hover)");
		// 严禁下拉胶囊在 hover 时变形为 50% 椭圆
		expect(css).toContain(".dropdown > button.chip:hover {\n\tborder-radius: 8px;\n}");
		expect(css).not.toContain(".composer-tools-left button:hover");
		// 发送按钮适配：冷白高光底 + 深黑高对比箭头图标
		expect(css).toContain(".inputbox .btn.send");
		expect(blockOf(".inputbox .btn.send"), "发送按钮箭头必须是深黑 #050507").toContain("color: #050507;");
		// 图标阴影唯一挂载在矢量笔画，span 容器保持 filter: none 杜绝双重嵌套浓黑阴影
		expect(css).toContain("span.bar-item-icon");
		expect(css).toContain("svg.bar-item-icon");
	});

	it("entry.mjs 提供清晰原生 QUALITY_PROFILES，优先加载打包 scene.pkg 杜绝降级模糊，抽屉包含亮色壁纸增强开关且清理了已删除的旧主题", () => {
		const entry = readFileSync(entryPath, "utf8");
		expect(entry).toContain("QUALITY_PROFILES");
		// 抽屉主题下拉菜单已移除 cyber, synthwave, aurora, amber 等已删除主题，包含 obsidian 与极简行文 flow
		expect(entry).not.toContain('value="cyber"');
		expect(entry).not.toContain('value="synthwave"');
		expect(entry).not.toContain('value="aurora"');
		expect(entry).not.toContain('value="amber"');
		expect(entry).toContain('value="obsidian"');
		expect(entry).toContain('value="flow"');
		// 严禁对纹理应用 0.75 降采样，保证原生 1:1 清晰
		expect(entry).not.toContain("videoTexScale: 0.75");
		// 优先拉取 scene.pkg
		expect(entry).toContain("shouldTryPkg");
		// 不再在 Scene 挂载中硬编码 msaa4
		expect(entry).not.toContain(`antiAliasing: "msaa4", // 开启高质量抗锯齿`);
		expect(entry).toContain("pi-we-quality-select");
		expect(entry).toContain("pi-we-aa-select");
		expect(entry).toContain("pi-we-lightmode-check");
		expect(entry).toContain('antiAliasing: "off"');
		// 深度加载优化守卫：Scene 并行流水线、缩略图懒加载、直显秒开
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
		// 深度服务端加载优化守卫：磁盘缓存落盘、ETag 协商缓存、强缓存头
		expect(index).toContain("cacheFile");
		expect(index).toContain("loadCache()");
		expect(index).toContain("persistCache()");
		expect(index).toContain('res.setHeader("ETag"');
		expect(index).toContain("304");
	});

	it("极简行文专属主题提供极致紧凑排版、正文零边框零背景色与微小紧致黑色阴影，保证 AI 回答如行云流水般流畅", () => {
		const flowCss = readThemeCss(resolve(process.cwd(), "themes/wallpaper-flow.css"));
		// 正文主体无背景、无边框、无阴影、无圆角（!important 已随 CSS 分层重构移除，值一字未改）
		expect(flowCss).toContain(
			".msg-assistant .msg-body {\n\tbackground: transparent;\n\tborder: none;\n\tborder-radius: 0;",
		);
		// 正文文本无额外内边距与边框
		expect(flowCss).toContain(".msg-text,\n.msg-assistant .msg-text {\n\tbackground: transparent;\n\tborder: none;");
		// 极致紧凑排版：段间距、行高、首尾段边距紧致
		expect(flowCss).toContain(".msg-body p {\n\tmargin: 0.36em 0;");
		expect(flowCss).toContain(".msg-body p:first-child {\n\tmargin-top: 0;\n}");
		// 紧致微雕微小黑色阴影
		expect(flowCss).toContain("text-shadow:\n\t\t0 0 1px rgba(0, 0, 0, 0.95),\n\t\t0 1px 1.5px rgba(0, 0, 0, 0.88);");
		// 工具与思考轻量行内代码胶囊融入行文，彻底隐藏原地展开内容
		expect(flowCss).toContain(".thinking {\n\tdisplay: inline-flex;");
		expect(flowCss).toContain(".toolcall-body,\n.thinking-body {\n\tdisplay: none;\n}");
		// 极简行文模式隐藏思考摘要与预览，只保留胶囊名称与状态，支持回合工具流集群与特殊产物徽标
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
