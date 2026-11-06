import { afterEach, describe, expect, it, vi } from "vitest";
import { mobileRequest, normalizeServerUrl, notificationTarget } from "../../mobile/src/connection.js";
import { loginHub, validateDeviceAccess } from "../../mobile/src/hub.js";

const hub = { serverUrl: "https://hub.example.test", token: "installation-session" };
const cap = "a".repeat(48);
afterEach(() => vi.unstubAllGlobals());

describe("mobile hub connection boundaries", () => {
	it("allows LAN HTTP and requires HTTPS for public connections", () => {
		expect(normalizeServerUrl(" http://192.168.1.5:8790/ ")).toBe("http://192.168.1.5:8790");
		expect(normalizeServerUrl("http://[fd00::5]:8790/")).toBe("http://[fd00::5]:8790");
		expect(normalizeServerUrl("https://hub.example.test/pi/")).toBe("https://hub.example.test/pi");
		for (const url of ["http://hub.example.test", "http://172.32.0.1", "http://192.169.1.1", "http://[2001:db8::1]"]) {
			expect(() => normalizeServerUrl(url)).toThrow("HTTPS");
		}
	});
	it("does not accept credentials or copied query-bearing links as server addresses", () => {
		for (const url of [
			"https://user:secret@hub.example.test",
			"https://hub.example.test/?token=secret",
			"https://hub.example.test/#s=task",
			"javascript:alert(1)",
		]) {
			expect(() => normalizeServerUrl(url)).toThrow();
		}
	});
	it("authenticates the chosen hub without allowing credential-forwarding redirects", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ configured: false })));
		await mobileRequest(hub, "/api/mobile-push/status", {}, fetcher);
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe("https://hub.example.test/api/mobile-push/status");
		expect(new Headers(init.headers).get("authorization")).toBe("Bearer installation-session");
		expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
		await expect(
			mobileRequest(hub, "https://another.example.test/api/mobile-push/status", {}, fetcher),
		).rejects.toThrow();
		await expect(mobileRequest(hub, "/api/mobile-push/../../setup", {}, fetcher)).rejects.toThrow();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("exchanges the account login for an installation session without returning the account password", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ token: "native-session", account: { id: "account" } })));
		vi.stubGlobal("fetch", fetcher);
		const connection = await loginHub(hub.serverUrl, " account ", "account-password");
		expect(connection).toEqual({ serverUrl: hub.serverUrl, token: "native-session" });
		expect(fetcher.mock.calls[0][0]).toBe(`${hub.serverUrl}/api/mobile-hub/login`);
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ username: "account", password: "account-password" });
		expect(new Headers(fetcher.mock.calls[0][1].headers).has("authorization")).toBe(false);
	});
	it("accepts a private capability only for the chosen device at the authenticated hub", () => {
		const access = {
			device: { id: "workstation", name: "Workstation" },
			serverUrl: `${hub.serverUrl}/device/workstation/__relay/${cap}`,
			token: "",
		};
		expect(validateDeviceAccess(hub, "workstation", access)).toEqual(access);
		for (const changed of [
			{ ...access, serverUrl: `https://other.example.test/device/workstation/__relay/${cap}` },
			{ ...access, serverUrl: `${hub.serverUrl}/device/other/__relay/${cap}` },
			{ ...access, serverUrl: `${access.serverUrl}?token=stolen` },
			{ ...access, token: "unexpected-server-secret" },
			{ ...access, device: { id: "other", name: "Other" } },
		])
			expect(() => validateDeviceAccess(hub, "workstation", changed)).toThrow();
	});
	it("routes structured notifications only within the bound hub instance", () => {
		const extras = {
			eventId: "event:1",
			instanceId: "hub:1",
			deviceId: "workstation",
			sessionId: "session-1",
			clientId: "owner",
			conversationId: "c1",
		};
		expect(notificationTarget(extras, "hub:1")).toEqual(extras);
		expect(notificationTarget(extras, "another-hub")).toBeNull();
		expect(notificationTarget({ ...extras, sessionId: "javascript:alert(1)" }, "hub:1")).toBeNull();
		expect(notificationTarget({ ...extras, url: "https://evil.example.test" }, "hub:1")).not.toHaveProperty("url");
	});
});
