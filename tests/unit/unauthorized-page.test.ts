import { describe, expect, it } from "vitest";
import { renderUnauthorizedHtml } from "../../server/unauthorized-page.js";

describe("unauthorized-page: 401 页面渲染与自愈", () => {
	it("渲染基础口令验证页面，包含 localStorage 自愈脚本与表单", () => {
		const html = renderUnauthorizedHtml({ isLoopback: false, isStaleCookie: false, port: 8787 });
		expect(html).toContain("需要访问口令");
		expect(html).toContain("pi-web-ui:token");
		expect(html).toContain("__tried_cached_token");
		expect(html).toContain('id="token-input"');
		expect(html).toContain('id="auth-form"');
	});

	it("本机回环访问展示前往 /setup 的快捷入口", () => {
		const html = renderUnauthorizedHtml({ isLoopback: true, isStaleCookie: false, port: 8787 });
		expect(html).toContain('href="/setup"');
		expect(html).toContain("打开本机配置中心 (/setup)");
	});

	it("非本机访问隐藏 /setup 入口，保护本地管理通道", () => {
		const html = renderUnauthorizedHtml({ isLoopback: false, isStaleCookie: false, port: 8787 });
		expect(html).not.toContain('href="/setup"');
	});

	it("口令变更导致的凭证失效展示口令已变更警告", () => {
		const html = renderUnauthorizedHtml({ isLoopback: true, isStaleCookie: true, port: 8787 });
		expect(html).toContain("访问口令已失效");
		expect(html).toContain("服务端口令已变更");
	});
});
