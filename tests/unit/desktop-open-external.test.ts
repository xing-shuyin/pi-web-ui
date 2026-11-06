import { describe, expect, it } from "vitest";
import { hubBrowserOrigin, isAllowedExternalUrl } from "../../desktop/external-url.js";

describe("Hub browser destinations", () => {
	it("normalizes origins while rejecting credentials and non-web protocols", () => {
		expect(hubBrowserOrigin("http://198.51.100.10:50001/")).toBe("http://198.51.100.10:50001");
		expect(hubBrowserOrigin("https://hub.example.com/pair")).toBe("https://hub.example.com");
		for (const url of [
			null,
			"",
			"file:///test",
			"javascript:alert(1)",
			"https://user:secret@example.com",
			"https://hub.example.com\n",
		])
			expect(hubBrowserOrigin(url)).toBeNull();
		expect(hubBrowserOrigin("https://hub.example.com.evil.test")).not.toBe(hubBrowserOrigin("https://hub.example.com"));
	});
});

describe("isAllowedExternalUrl", () => {
	it("放行 http/https（含大写 scheme）", () => {
		expect(isAllowedExternalUrl("http://example.com/a")).toBe(true);
		expect(isAllowedExternalUrl("https://example.com/a?b=1#x")).toBe(true);
		expect(isAllowedExternalUrl("HTTP://EXAMPLE.COM/")).toBe(true);
		expect(isAllowedExternalUrl("  https://example.com/  ")).toBe(true);
	});

	it("放行 Markdown 已当外链的 mailto/tel", () => {
		expect(isAllowedExternalUrl("mailto:a@b.com")).toBe(true);
		expect(isAllowedExternalUrl("tel:+18001234567")).toBe(true);
	});

	it("拦截危险 scheme", () => {
		expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
		expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
		expect(isAllowedExternalUrl("data:text/html,<h1>x</h1>")).toBe(false);
		expect(isAllowedExternalUrl("ftp://example.com/a")).toBe(false);
		expect(isAllowedExternalUrl("myapp://open?x=1")).toBe(false);
	});

	it("空串与非法串一律拦截", () => {
		expect(isAllowedExternalUrl("")).toBe(false);
		expect(isAllowedExternalUrl("   ")).toBe(false);
		expect(isAllowedExternalUrl("not a url")).toBe(false);
	});
});
