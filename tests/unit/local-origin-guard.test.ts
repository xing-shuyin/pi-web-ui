import { describe, expect, it } from "vitest";
import { allowsLocalWriteOrigin } from "../../server/device-center/local.js";

/**
 * 设备中心写接口的同源守卫。
 *
 * 真实回归：dev 下 Vite 代理把 Host 改写成后端地址，Origin 仍是 :5173，
 * 于是「一句话建 Bot / 确认草案 / 删除 Bot」全部 403 LOCAL_ONLY，但 GET 正常——
 * 界面看起来能用，一写就静默失败。
 * 例外必须只给运维显式声明的 origin（PI_WEB_ALLOW_ORIGINS），不能放宽同源判定本身。
 */
describe("allowsLocalWriteOrigin", () => {
	const declared = new Set(["http://localhost:5173"]);

	it("同源请求照常放行", () => {
		expect(allowsLocalWriteOrigin("http://127.0.0.1:8788", "127.0.0.1:8788", new Set())).toBe(true);
	});

	it("dev 代理：声明的 origin 放行（Host 已被改写）", () => {
		expect(allowsLocalWriteOrigin("http://localhost:5173", "127.0.0.1:8788", declared)).toBe(true);
	});

	it("未声明的跨源请求拒绝", () => {
		expect(allowsLocalWriteOrigin("http://evil.example", "127.0.0.1:8788", declared)).toBe(false);
		expect(allowsLocalWriteOrigin("http://localhost:5174", "127.0.0.1:8788", declared)).toBe(false);
	});

	it("缺失 / 非法 / 非 http(s) 的 Origin 拒绝", () => {
		expect(allowsLocalWriteOrigin(undefined, "127.0.0.1:8788", declared)).toBe(false);
		expect(allowsLocalWriteOrigin("not a url", "127.0.0.1:8788", declared)).toBe(false);
		expect(allowsLocalWriteOrigin("file:///etc/passwd", "127.0.0.1:8788", declared)).toBe(false);
	});
});
