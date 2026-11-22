import { describe, expect, it } from "vitest";
import { isLoopbackAddress } from "../../server/server-config.js";
import { setupGate } from "../../server/setup-gate.js";

describe("isLoopbackAddress", () => {
	it("IPv4 / IPv6 回环地址放行", () => {
		expect(isLoopbackAddress("127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("127.0.1.1")).toBe(true);
		expect(isLoopbackAddress("::1")).toBe(true);
		expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackAddress("::ffff:127.0.1.5")).toBe(true);
	});

	it("非回环地址拒绝", () => {
		expect(isLoopbackAddress("")).toBe(false);
		expect(isLoopbackAddress(undefined)).toBe(false);
		expect(isLoopbackAddress("192.168.1.10")).toBe(false);
		expect(isLoopbackAddress("10.0.0.1")).toBe(false);
		expect(isLoopbackAddress("8.8.8.8")).toBe(false);
		expect(isLoopbackAddress("::2")).toBe(false);
	});
});

describe("setupGate", () => {
	function runGate(req: { remoteAddress?: string; headers?: Record<string, string | string[] | undefined> }): {
		status?: number;
		message?: string;
		passed: boolean;
	} {
		let status: number | undefined;
		let message: string | undefined;
		let passed = false;

		const fakeRes = {
			status(c: number) {
				status = c;
				return {
					end(m: string) {
						message = m;
					},
				};
			},
		};

		setupGate(
			{
				socket: { remoteAddress: req.remoteAddress },
				headers: req.headers ?? {},
			},
			fakeRes,
			() => {
				passed = true;
			},
		);

		return { status, message, passed };
	}

	it("本地正常访问放行", () => {
		const res = runGate({
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost:8787" },
		});
		expect(res.passed).toBe(true);
		expect(res.status).toBeUndefined();
	});

	it("本地带有效回环 Origin 放行", () => {
		const res = runGate({
			remoteAddress: "127.0.0.1",
			headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
		});
		expect(res.passed).toBe(true);
	});

	it("非回环 IP 直接 403", () => {
		const res = runGate({
			remoteAddress: "192.168.1.50",
			headers: { host: "localhost:8787" },
		});
		expect(res.passed).toBe(false);
		expect(res.status).toBe(403);
		expect(res.message).toContain("only available from localhost");
	});

	it("带反代头（X-Forwarded-For / X-Real-IP）即便来自 127.0.0.1 也 403 阻断", () => {
		const resXff = runGate({
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost:8787", "x-forwarded-for": "203.0.113.1" },
		});
		expect(resXff.passed).toBe(false);
		expect(resXff.status).toBe(403);
		expect(resXff.message).toContain("reverse proxy");

		const resXri = runGate({
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost:8787", "x-real-ip": "203.0.113.1" },
		});
		expect(resXri.passed).toBe(false);
		expect(resXri.status).toBe(403);
		expect(resXri.message).toContain("reverse proxy");
	});

	it("DNS Rebinding（Host 为非回环域名）阻断", () => {
		const res = runGate({
			remoteAddress: "127.0.0.1",
			headers: { host: "rebind.attacker.com:8787" },
		});
		expect(res.passed).toBe(false);
		expect(res.status).toBe(403);
		expect(res.message).toContain("Host header must be localhost");
	});

	it("跨站 CSRF（Origin 为恶意站）阻断", () => {
		const res = runGate({
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost:8787", origin: "https://evil.com" },
		});
		expect(res.passed).toBe(false);
		expect(res.status).toBe(403);
		expect(res.message).toContain("cross-origin setup request rejected");
	});

	it("Sec-Fetch-Site: cross-site 非 navigate 请求阻断", () => {
		const res = runGate({
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost:8787", "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" },
		});
		expect(res.passed).toBe(false);
		expect(res.status).toBe(403);
		expect(res.message).toContain("cross-site request to setup rejected");
	});

	it("Sec-Fetch-Site: cross-site 顶层导航放行", () => {
		const res = runGate({
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost:8787", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
		});
		expect(res.passed).toBe(true);
	});
});
