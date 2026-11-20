import { describe, expect, it } from "vitest";
import {
	buildLangCookie,
	readLangCookie,
	renderUnauthorizedHtml,
	resolvePageLang,
} from "../../server/unauthorized-page.js";

describe("unauthorized-page: 401 页面渲染与自愈", () => {
	it("渲染基础口令验证页面，包含 localStorage 自愈脚本与表单", () => {
		const html = renderUnauthorizedHtml({ isLoopback: false, isStaleCookie: false, port: 8787 });
		expect(html).toContain("需要访问口令");
		expect(html).toContain("pi-web-ui:token");
		expect(html).toContain("__tried_cached_token");
		expect(html).toContain('id="token-input"');
		expect(html).toContain('id="auth-form"');
	});

	it("表单走原生 POST，带账号域与 current-password，浏览器才会提示保存密码", () => {
		const html = renderUnauthorizedHtml({ isLoopback: false, isStaleCookie: false, port: 8787 });
		expect(html).toContain('method="post" action="/__pi/auth"');
		expect(html).toContain('name="username"');
		expect(html).toContain('autocomplete="username"');
		expect(html).toContain('name="token"');
		expect(html).toContain('autocomplete="current-password"');
		expect(html).not.toContain('autocomplete="off"');
		// 禁止回到 JS preventDefault + ?token= 跳转的提交方式：那样密码管理器永远不弹保存提示
		expect(html).not.toContain("e.preventDefault()");
	});

	it("回跳目标写进隐藏域并做属性转义", () => {
		const html = renderUnauthorizedHtml({
			isLoopback: false,
			isStaleCookie: false,
			port: 8787,
			nextPath: '/device/a"&b?tab=x',
		});
		expect(html).toContain('name="next"');
		expect(html).toContain("/device/a&quot;&amp;b?tab=x");
	});

	it("口令错误时展示错误提示", () => {
		const ok = renderUnauthorizedHtml({ isLoopback: false, isStaleCookie: false, port: 8787 });
		expect(ok).not.toContain("口令不正确");
		const bad = renderUnauthorizedHtml({ isLoopback: false, isStaleCookie: false, port: 8787, authFailed: true });
		expect(bad).toContain("口令不正确");
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

describe("口令页本地化与语言切换（issue #955）", () => {
	it("默认简体中文，<html lang> 跟着走", () => {
		const html = renderUnauthorizedHtml({ isLoopback: false, isStaleCookie: false, port: 8787 });
		expect(html).toContain('<html lang="zh-CN">');
		expect(html).toContain("需要访问口令");
	});

	it("lang=en 时整页英文，且 <html lang> 同步", () => {
		const html = renderUnauthorizedHtml({ isLoopback: false, isStaleCookie: false, port: 8787, lang: "en" });
		expect(html).toContain('<html lang="en">');
		expect(html).toContain("Access token required");
		expect(html).toContain("Open workspace");
		expect(html).toContain("Access token");
		// 中文正文不该残留（select 里的语言名是原生名，不算正文）
		expect(html).not.toContain("进入工作区");
		expect(html).not.toContain("请输入口令或从终端复制");
	});

	it("错误态与口令失效态也本地化", () => {
		const en = renderUnauthorizedHtml({
			isLoopback: false,
			isStaleCookie: true,
			port: 8787,
			lang: "en",
			authFailed: true,
		});
		expect(en).toContain("Access token expired");
		expect(en).toContain("Server token changed");
		expect(en).toContain("Incorrect token");
	});

	it("语言切换器是原生 GET 表单（无 JS 也能用），且标出当前语言", () => {
		const html = renderUnauthorizedHtml({
			isLoopback: false,
			isStaleCookie: false,
			port: 8787,
			lang: "de",
			langs: [
				{ code: "zh", nativeName: "简体中文" },
				{ code: "en", nativeName: "English" },
				{ code: "de", nativeName: "Deutsch" },
			],
		});
		expect(html).toContain('method="get"');
		expect(html).toContain('name="lang"');
		expect(html).toContain('<option value="de" selected>Deutsch</option>');
		// 未安装语言包时回落到英文正文
		expect(html).toContain("Access token required");
	});

	it("resolvePageLang：显式 ?lang= > cookie > Accept-Language > zh", () => {
		const available = ["zh", "en", "de"];
		expect(resolvePageLang({ query: "de", cookie: "en", acceptLanguage: "fr", available })).toEqual({
			lang: "de",
			explicit: true,
		});
		expect(resolvePageLang({ cookie: "de", acceptLanguage: "zh-CN", available })).toEqual({
			lang: "de",
			explicit: false,
		});
		expect(resolvePageLang({ cookie: "nope", acceptLanguage: "de-DE,de;q=0.9", available })).toEqual({
			lang: "de",
			explicit: false,
		});
		expect(resolvePageLang({ acceptLanguage: "fr-FR", available })).toEqual({ lang: "zh", explicit: false });
		// 未安装的语言包不进 available：显式请求也降级
		expect(resolvePageLang({ query: "ja", available: ["zh", "en"] })).toEqual({ lang: "zh", explicit: false });
		// 任意字符串不能影响渲染
		expect(resolvePageLang({ query: "<script>", available }).lang).toBe("zh");
	});

	it("语言 cookie 读写往返", () => {
		expect(buildLangCookie("zh-Hant")).toBe("pi_web_lang=zh-Hant; Path=/; Max-Age=31536000; SameSite=Lax");
		expect(readLangCookie("a=1; pi_web_lang=de; b=2")).toBe("de");
		expect(readLangCookie("pi_web_lang=zh-Hant")).toBe("zh-Hant");
		expect(readLangCookie("pi_web_token=x")).toBeNull();
		expect(readLangCookie(null)).toBeNull();
	});
});
