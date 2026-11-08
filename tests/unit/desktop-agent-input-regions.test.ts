import fs from "node:fs";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync("browser/renderer/browser.css", "utf8");
const webCss = fs.readFileSync("web/src/styles.css", "utf8");
const host = fs.readFileSync("desktop/browser-host.ts", "utf8");

function ruleBody(selector: string, source = css): string {
	const start = source.indexOf(`${selector} {`);
	if (start < 0) return "";
	const end = source.indexOf("}", start);
	return source.slice(start, end + 1);
}

describe("桌面窗口拖拽区与 Agent 可见性（启动点不动的回归守卫）", () => {
	it("启动占位层不得声明 app-region: drag", () => {
		const boot = ruleBody(".pb-boot");
		expect(boot).not.toBe("");
		expect(boot).not.toMatch(/app-region:\s*drag/);
	});

	it("整窗级别的拖拽区只允许出现在 40px 浏览器窗格条上", () => {
		const dragRules = [...css.matchAll(/([^\n{}]+)\{[^}]*app-region:\s*drag/g)].map((m) => m[1].trim());
		// .pb-tab-row 是全仓唯一的窗口级拖拽区（高度 40px）；其余拖拽区在 web 侧顶栏里
		expect(dragRules).toEqual([".pb-tab-row"]);
	});

	it("Agent 视图的可见性不得以首帧就绪（agentReady）作为门槛", () => {
		const line = host.split("\n").find((l) => l.includes("this.agent.setVisible("));
		expect(line).toBeTruthy();
		expect(line).not.toContain("agentReady");
		// 只有确定为错误态时才隐藏 Agent 视图，让 shell 的错误卡露出切换出口
		expect(line).toContain("agentError === undefined");
	});

	it("Agent 顶栏拖窗区不依赖 .tb-spacer 的盒子（窄分栏手机视图里 spacer 没有盒子）", () => {
		// 手机视图的媒体查询把 spacer 收成 display: contents ⇒ 没有盒子也就没有拖拽区，
		// 分栏变窄后整个 Agent 头部会拖不动窗口，所以 topbar-flow 自身必须顶住拖拽。
		expect(webCss).toMatch(/\.topbar-flow \.tb-spacer\s*\{[^}]*display:\s*contents/);
		const flow = ruleBody("body.is-desktop .topbar-flow", webCss);
		expect(flow).not.toBe("");
		expect(flow).toMatch(/-webkit-app-region:\s*drag/);
		// 交互条目仍需逐条 no-drag，否则点击会被拖拽吞掉
		expect(webCss).toMatch(/\.topbar \.topbar-flow > \*:not\(\.tb-spacer\)[\s\S]{0,200}?-webkit-app-region:\s*no-drag/);
	});
});
