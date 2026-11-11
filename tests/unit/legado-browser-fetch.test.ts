import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromeCandidates, findChrome, isChallengePage } from "../../plugins/legado-web/net.mjs";
import { mergeCookieIntoHeader, parseCookieString } from "../../plugins/legado-web/app/src/core/cookies";

describe("legado 真浏览器抓取：盾页识别", () => {
	it("Cloudflare Just a moment 页（403）判为盾页", () => {
		expect(isChallengePage(403, "<title>Just a moment...</title>challenges.cloudflare.com")).toBe(true);
	});
	it("网关 challenge_required（403）判为盾页", () => {
		expect(isChallengePage(403, '{"challenge_url":"/__gatekeeper_challenge/start","error":"challenge_required"}')).toBe(
			true,
		);
	});
	it("人人书云 CDN 拦截页（403）判为盾页", () => {
		expect(isChallengePage(403, "<div>403 Forbidden - 人人书云CDN</div>")).toBe(true);
	});
	it("普通 nginx 403（无盾特征）不判为盾页", () => {
		expect(isChallengePage(403, "<center><h1>403 Forbidden</h1></center><hr><center>nginx</center>")).toBe(false);
	});
	it("正常页面（200）不判为盾页", () => {
		expect(isChallengePage(200, "<html><body>第一章 正文内容</body></html>")).toBe(false);
	});
	it("非 403/503 状态码不判为盾页", () => {
		expect(isChallengePage(500, "Just a moment")).toBe(false);
	});
});

describe("legado Cookie 导入", () => {
	it("解析 document.cookie 串", () => {
		expect(parseCookieString("a=1; b=hello world; c=; noeq; $x=1")).toEqual({ a: "1", b: "hello world", c: "" });
	});
	it("空 header 直接生成 Cookie 字段", () => {
		const { header, count } = mergeCookieIntoHeader(undefined, "cf_clearance=abc; session=xyz");
		expect(count).toBe(2);
		expect(JSON.parse(header)).toEqual({ Cookie: "cf_clearance=abc; session=xyz" });
	});
	it("保留原有 UA 等字段，同名 Cookie key 用新的覆盖", () => {
		const { header, count } = mergeCookieIntoHeader(
			JSON.stringify({ "User-Agent": "Mozilla/5.0", Cookie: "old=1; keep=2" }),
			"old=9; fresh=3",
		);
		expect(count).toBe(2);
		expect(JSON.parse(header)).toEqual({ "User-Agent": "Mozilla/5.0", Cookie: "old=9; keep=2; fresh=3" });
	});
	it("空 Cookie 串抛错", () => {
		expect(() => mergeCookieIntoHeader(undefined, "  ;  ")).toThrow(/没解析出 Cookie/);
	});
	it("原 header 非法 JSON 抛错", () => {
		expect(() => mergeCookieIntoHeader("{oops", "a=1")).toThrow(/不是合法 JSON/);
	});
});

describe("legado Chrome 探测", () => {
	it("环境变量优先（LEGADO_CHROME_PATH）", () => {
		const { paths } = chromeCandidates("win32", { LEGADO_CHROME_PATH: "D:/chrome/chrome.exe" } as never);
		expect(paths[0]).toBe("D:/chrome/chrome.exe");
	});
	it("win32 覆盖 ProgramFiles 三处基准目录", () => {
		const { paths } = chromeCandidates("win32", {
			ProgramFiles: "C:/Program Files",
			"ProgramFiles(x86)": "C:/Program Files (x86)",
			LOCALAPPDATA: "C:/Users/u/AppData/Local",
		} as never);
		expect(paths).toContain(join("C:/Program Files", "Google/Chrome/Application/chrome.exe"));
		expect(paths).toContain(join("C:/Program Files", "Microsoft/Edge/Application/msedge.exe"));
		expect(paths).toContain(join("C:/Users/u/AppData/Local", "Google/Chrome/Application/chrome.exe"));
	});
	it("darwin 给出 .app 包内可执行文件", () => {
		const { paths } = chromeCandidates("darwin", {});
		expect(paths[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	});
	it("linux 给出 which 候选名", () => {
		const { whichNames } = chromeCandidates("linux", {});
		expect(whichNames).toContain("google-chrome");
		expect(whichNames).toContain("chromium");
	});
	it("findChrome 缓存结果（同一次进程只探测一次）", async () => {
		const a = await findChrome();
		const b = await findChrome();
		expect(a).toBe(b);
		expect(typeof a.found).toBe("boolean");
	});
});
