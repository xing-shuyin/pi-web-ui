import { describe, expect, it } from "vitest";
import { AUTH_ERROR_PARAM, AUTH_LOGIN_PATH, loginFailureLocation, sanitizeNextPath } from "../../server/auth-login.js";

describe("auth-login: 登录表单契约", () => {
	it("登录端点与失败标记是固定常量", () => {
		expect(AUTH_LOGIN_PATH).toBe("/__pi/auth");
		expect(AUTH_ERROR_PARAM).toBe("auth_error");
	});
});

describe("sanitizeNextPath", () => {
	it("默认回跳根路径", () => {
		expect(sanitizeNextPath(undefined)).toBe("/");
		expect(sanitizeNextPath("")).toBe("/");
		expect(sanitizeNextPath(42)).toBe("/");
	});

	it("保留同源深链接与查询参数", () => {
		expect(sanitizeNextPath("/device/abc?tab=files")).toBe("/device/abc?tab=files");
		expect(sanitizeNextPath("/")).toBe("/");
	});

	it("拒绝协议相对与跨站地址（开放重定向）", () => {
		expect(sanitizeNextPath("//evil.com/x")).toBe("/");
		expect(sanitizeNextPath("https://evil.com/x")).toBe("/");
		expect(sanitizeNextPath("/\\evil.com")).toBe("/");
		expect(sanitizeNextPath("/a/../..//evil.com")).toBe("/");
	});

	it("剔除会泄露口令的查询参数", () => {
		expect(sanitizeNextPath("/chat?token=secret&x=1")).toBe("/chat?x=1");
		expect(sanitizeNextPath("/?token=secret")).toBe("/");
		expect(sanitizeNextPath("/?__tried_cached_token=1&auth_error=1")).toBe("/");
	});

	it("挡掉控制字符", () => {
		expect(sanitizeNextPath("/a\u0000b")).toBe("/");
		expect(sanitizeNextPath("/a\nb")).toBe("/");
	});
});

describe("loginFailureLocation", () => {
	it("回到原目标并带上失败标记", () => {
		expect(loginFailureLocation("/chat")).toBe("/chat?auth_error=1");
		expect(loginFailureLocation("/chat?x=1")).toBe("/chat?x=1&auth_error=1");
	});

	it("非法目标退回根路径", () => {
		expect(loginFailureLocation("//evil.com")).toBe("/?auth_error=1");
	});
});
