import { describe, expect, it } from "vitest";
import { isPrivateHost } from "../../plugins/legado-web/net.mjs";

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
});
