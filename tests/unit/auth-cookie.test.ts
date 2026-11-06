import { describe, expect, it } from "vitest";
import { buildPiWebTokenCookie, decodeCookieToken, isTlsRequest } from "../../server/auth-cookie.js";

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
