import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TOKEN_COOKIE_MAX_AGE_SECONDS,
	buildPiWebTokenCookie,
	clearPiWebTokenCookies,
	decodeCookieToken,
	isTlsRequest,
} from "../../server/auth-cookie.js";
import { clearAuthToken, withToken } from "../../web/src/auth-token.js";

describe("isTlsRequest", () => {
	it("明文 HTTP 默认不加 Secure", () => {
		expect(isTlsRequest({ socket: {}, headers: {} })).toBe(false);
		expect(isTlsRequest({ headers: {} })).toBe(false);
	});

	it("直连 TLS（socket.encrypted）判为 TLS", () => {
		expect(isTlsRequest({ socket: { encrypted: true }, headers: {} })).toBe(true);
	});

	it("express req.secure 判为 TLS", () => {
		expect(isTlsRequest({ secure: true, headers: {} })).toBe(true);
	});

	it("x-forwarded-proto=https 判为 TLS（大小写/空格容忍）", () => {
		expect(isTlsRequest({ headers: { "x-forwarded-proto": "https" } })).toBe(true);
		expect(isTlsRequest({ headers: { "x-forwarded-proto": " HTTPS " } })).toBe(true);
		expect(isTlsRequest({ headers: { "x-forwarded-proto": "https, http" } })).toBe(true);
		expect(isTlsRequest({ headers: { "x-forwarded-proto": ["https"] } })).toBe(true);
	});

	it("x-forwarded-proto=http 判为明文", () => {
		expect(isTlsRequest({ headers: { "x-forwarded-proto": "http" } })).toBe(false);
		expect(isTlsRequest({ headers: { "x-forwarded-proto": "http, https" } })).toBe(false);
	});

	it("RFC 7239 Forwarded: proto=https 判为 TLS", () => {
		expect(isTlsRequest({ headers: { forwarded: "for=1.2.3.4;proto=https;host=x" } })).toBe(true);
		expect(isTlsRequest({ headers: { forwarded: "for=1.2.3.4;proto=http;host=x" } })).toBe(false);
	});
});

describe("buildPiWebTokenCookie", () => {
	it("明文不带 Secure（保持 loopback 可用）", () => {
		expect(buildPiWebTokenCookie("abc", 31536000, false)).toBe(
			"pi_web_token=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000",
		);
	});

	it("有效期常量是单源（所有签发点共用，7 天配合滑动续期）", () => {
		expect(TOKEN_COOKIE_MAX_AGE_SECONDS).toBe(7 * 24 * 60 * 60);
		expect(buildPiWebTokenCookie("abc", TOKEN_COOKIE_MAX_AGE_SECONDS, false)).toContain(
			`Max-Age=${TOKEN_COOKIE_MAX_AGE_SECONDS}`,
		);
	});

	it("clearPiWebTokenCookies 同时清除明文与 Secure 两路", () => {
		const [plain, sec] = clearPiWebTokenCookies();
		expect(plain).toBe("pi_web_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
		expect(sec).toBe("pi_web_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
	});

	it("TLS 写入带 Secure", () => {
		const v = buildPiWebTokenCookie("abc", 31536000, true);
		expect(v).toContain("; Secure");
		expect(v.startsWith("pi_web_token=abc;")).toBe(true);
	});

	it("清除 cookie 两路都跟 Secure 走", () => {
		expect(buildPiWebTokenCookie("", 0, false)).toBe("pi_web_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
		expect(buildPiWebTokenCookie("", 0, true)).toContain("; Secure");
	});
});

describe("decodeCookieToken", () => {
	it("普通口令解码后不变", () => {
		expect(decodeCookieToken("s3cret-token-xyz")).toBe("s3cret-token-xyz");
	});

	it("把 %3D 解回 =", () => {
		expect(decodeCookieToken("00mJYc4g8rnJVJOxqBlaSiGrszirmeVQCmGnrmw8i8s%3D")).toBe(
			"00mJYc4g8rnJVJOxqBlaSiGrszirmeVQCmGnrmw8i8s=",
		);
	});

	it("小写十六进制与非 ASCII 同样解回明文", () => {
		expect(decodeCookieToken("a%3db")).toBe("a=b");
		expect(decodeCookieToken("%2B%2F%E4%B8%AD")).toBe("+/中");
		expect(decodeCookieToken("a%20b")).toBe("a b");
	});

	it("明文里的 % 解不开时原样返回（不招 URIError）", () => {
		expect(decodeCookieToken("100%done")).toBe("100%done");
		expect(decodeCookieToken("a%zz")).toBe("a%zz");
	});

	it("空串保持空串", () => {
		expect(decodeCookieToken("")).toBe("");
	});
});

// 登出清理落在 `web/src/auth-token.ts`：它是「口令怎么持久化」的同一处事实源（读写同模块），
// 所以与 cookie 生命周期放在一个文件里守（服务端 cookie + 客户端持久化副本是一对）。
describe("clearAuthToken（登出清理，web/src/auth-token.ts）", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubBrowser(href: string, stored?: string) {
		const store = new Map<string, string>(stored ? [["pi-web-ui:token", stored]] : []);
		const removeItem = vi.fn((key: string) => store.delete(key));
		const replaceState = vi.fn((_state: unknown, _title: string, url: string) => url);
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem,
		});
		vi.stubGlobal("window", { location: { href }, history: { replaceState } });
		return { store, removeItem, replaceState };
	}

	it("同时清 localStorage 与地址栏 ?token=（只清一个，withToken 下一跳就把会话建回来）", () => {
		const { removeItem, replaceState } = stubBrowser("http://127.0.0.1:8787/?token=abc&lang=zh", "abc");
		expect(withToken("/api/health")).toBe("/api/health?token=abc");
		clearAuthToken();
		expect(removeItem).toHaveBeenCalledWith("pi-web-ui:token");
		expect(withToken("/api/health")).toBe("/api/health");
		expect(replaceState).toHaveBeenCalledTimes(1);
		const cleaned = new URL(String(replaceState.mock.calls[0]?.[2]));
		expect(cleaned.searchParams.has("token")).toBe(false);
		expect(cleaned.searchParams.get("lang")).toBe("zh");
	});

	it("地址栏本来没有 token 时不碰历史记录", () => {
		const { replaceState } = stubBrowser("http://127.0.0.1:8787/", "abc");
		clearAuthToken();
		expect(replaceState).not.toHaveBeenCalled();
		expect(withToken("/api/health")).toBe("/api/health");
	});
});
