import { describe, expect, it } from "vitest";
import { decodeBytes, encodeText, isPrivateHost } from "../../plugins/legado-web/net.mjs";

describe("legado-web net SSRF guard", () => {
	it("blocks private, loopback, link-local and CGNAT hosts", () => {
		expect(isPrivateHost("localhost")).toBe(true);
		expect(isPrivateHost("sub.localhost")).toBe(true);
		expect(isPrivateHost("127.0.0.1")).toBe(true);
		expect(isPrivateHost("10.0.0.1")).toBe(true);
		expect(isPrivateHost("172.16.0.1")).toBe(true);
		expect(isPrivateHost("172.31.255.255")).toBe(true);
		expect(isPrivateHost("192.168.1.1")).toBe(true);
		expect(isPrivateHost("169.254.169.254")).toBe(true);
		expect(isPrivateHost("100.64.0.1")).toBe(true);
		expect(isPrivateHost("::1")).toBe(true);
	});

	it("does not block 198.18.0.0/15 (Clash / TUN fake-ip) or public internet IPs", () => {
		expect(isPrivateHost("198.18.0.1")).toBe(false);
		expect(isPrivateHost("198.18.1.74")).toBe(false);
		expect(isPrivateHost("198.19.255.254")).toBe(false);

		expect(isPrivateHost("8.8.8.8")).toBe(false);
		expect(isPrivateHost("1.1.1.1")).toBe(false);
	});

	describe("decodeBytes utf-8/gbk fallback", () => {
		it("keeps valid utf-8 that legitimately contains U+FFFD (e.g. 1331.json合集)", () => {
			const src = '{"comment":"【请勿删除】' + "\uFFFD" + "占位符" + "\uFFFD" + '","name":"墨辰"}';
			const buf = Buffer.from(src, "utf8");
			expect(buf.toString("utf8").includes("\uFFFD")).toBe(true);
			const out = decodeBytes(buf, "utf-8");
			expect(out).toBe(src);
			expect(() => JSON.parse(out)).not.toThrow();
		});

		it("still falls back to gbk for real gbk bytes", () => {
			const buf = encodeText("中文测试", "gbk");
			expect(decodeBytes(buf, "utf-8")).toBe("中文测试");
		});
	});
});
