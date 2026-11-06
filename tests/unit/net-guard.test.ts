import { describe, expect, it } from "vitest";
import { isBlockedHost, resolveAndValidateUrl, safeFetch, validateFetchUrl } from "../../server/net-guard.js";
import { fetchText } from "../../server/preset-share.js";

describe("server/net-guard (#602)", () => {
	it("blocks long-form IPv4-mapped, IPv4-translated, IPv4-compatible, and NAT64 private/loopback IPv6", () => {
		expect(isBlockedHost("[::ffff:127.0.0.1]")).toBe(true);
		expect(isBlockedHost("[::ffff:7f00:1]")).toBe(true);
		expect(isBlockedHost("[::ffff:0:127.0.0.1]")).toBe(true);
		expect(isBlockedHost("[::ffff:0:7f00:1]")).toBe(true);
		expect(isBlockedHost("[0:0:0:0:0:ffff:7f00:1]")).toBe(true);
		expect(isBlockedHost("[0:0:0:0:0:ffff:a9fe:a9fe]")).toBe(true);
		expect(isBlockedHost("[64:ff9b::169.254.169.254]")).toBe(true);
		expect(isBlockedHost("[64:ff9b::a9fe:a9fe]")).toBe(true);
		expect(isBlockedHost("100.64.0.1")).toBe(true);

		expect(isBlockedHost("[::ffff:8.8.8.8]")).toBe(false);
		expect(isBlockedHost("[2606:4700:4700::1111]")).toBe(false);
		expect(validateFetchUrl("http://[0:0:0:0:0:ffff:127.0.0.1]/x").ok).toBe(false);
	});

	it("blocks DNS rebinding when a public hostname resolves to loopback or cloud metadata IPs", async () => {
		const rebindLoopback = await resolveAndValidateUrl("https://rebind.example.com/preset.json", {
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		});
		expect(rebindLoopback).toEqual({ ok: false, reason: "host" });

		const rebindMetadata = await resolveAndValidateUrl("https://rebind.example.com/preset.json", {
			lookup: async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "169.254.169.254", family: 4 },
			],
		});
		expect(rebindMetadata).toEqual({ ok: false, reason: "host" });

		const rebindIpv6 = await resolveAndValidateUrl("https://rebind.example.com/preset.json", {
			lookup: async () => [{ address: "::ffff:10.0.0.1", family: 6 }],
		});
		expect(rebindIpv6).toEqual({ ok: false, reason: "host" });

		const publicOk = await resolveAndValidateUrl("https://example.com/preset.json", {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
		});
		expect(publicOk.ok).toBe(true);
	});

	it("validates every redirect hop and blocks 302 redirects to internal/metadata endpoints", async () => {
		await expect(
			safeFetch(
				"https://public.example.com/start",
				{},
				{
					lookup: async () => [{ address: "93.184.216.34", family: 4 }],
					fetcher: async () =>
						new Response(null, {
							status: 302,
							headers: { location: "http://169.254.169.254/latest/meta-data/" },
						}),
				},
			),
		).rejects.toThrow(/Blocked private or internal host/);

		const res = await fetchText("https://public.example.com/preset.json", {
			fetcher: async () => ({
				ok: false,
				status: 302,
				headers: {
					get: (name: string) => (name.toLowerCase() === "location" ? "http://127.0.0.1:8787/api/health" : null),
				},
				text: async () => "",
			}),
		});
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.errorKey).toBe("presets.url.host");
		}
	});
});
