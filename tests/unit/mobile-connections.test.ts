import { afterEach, describe, expect, it, vi } from "vitest";
import {
	authenticateConnection,
	notificationDestination,
	restoreConnection,
	restorePendingTarget,
	savePendingTarget,
} from "../../mobile/src/connections.js";

const direct = { mode: "direct" as const, serverUrl: "https://device.example.test/pi", token: "device-access-token" };
const hub = { mode: "hub" as const, serverUrl: "https://hub.example.test", token: "native-account-session" };
const target = {
	eventId: "event:1",
	instanceId: "server:1",
	clientId: "owner",
	sessionId: "session-1",
	conversationId: "c1",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe("mobile connection modes", () => {
	it("connects directly with a device bearer without logging in to a hub", async () => {
		const fetcher = vi.fn().mockResolvedValue(reply({ instanceId: "server:1", configured: false }));
		vi.stubGlobal("fetch", fetcher);
		expect(await authenticateConnection({ ...direct, serverUrl: `${direct.serverUrl}/` }, "installation-id")).toEqual(
			direct,
		);
		expect(fetcher).toHaveBeenCalledOnce();
		const [url, options] = fetcher.mock.calls[0];
		expect(url).toBe(`${direct.serverUrl}/api/mobile-push/status?deviceId=installation-id`);
		expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${direct.token}`);
		expect(options).toMatchObject({ credentials: "omit", redirect: "error" });
		expect(options.method ?? "GET").toBe("GET");
	});
	it("keeps account login separate from direct access credentials", async () => {
		const fetcher = vi.fn().mockResolvedValue(reply({ token: hub.token, account: { id: "account" } }));
		vi.stubGlobal("fetch", fetcher);
		expect(
			await authenticateConnection(
				{ mode: "hub", serverUrl: hub.serverUrl, username: " user ", password: "account-credential" },
				"installation-id",
			),
		).toEqual(hub);
		expect(fetcher).toHaveBeenCalledOnce();
		const [url, options] = fetcher.mock.calls[0];
		expect(url).toBe(`${hub.serverUrl}/api/mobile-hub/login`);
		expect(JSON.parse(options.body)).toEqual({ username: "user", password: "account-credential" });
		expect(new Headers(options.headers).has("authorization")).toBe(false);
	});
	it.each(["", " ", "unsafe\nvalue", "unsafe value", "a".repeat(4097)])(
		"rejects an invalid direct credential before sending it",
		async (token) => {
			const fetcher = vi.fn();
			vi.stubGlobal("fetch", fetcher);
			await expect(authenticateConnection({ ...direct, token }, "installation-id")).rejects.toThrow("访问令牌");
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
	it("rejects public HTTP before sending a direct credential", async () => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		await expect(
			authenticateConnection({ ...direct, serverUrl: "http://device.example.test" }, "installation-id"),
		).rejects.toThrow("HTTPS");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("reports device authentication errors without asking for a hub account", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({}, 401)));
		await expect(authenticateConnection(direct, "installation-id")).rejects.toThrow("检查令牌");
	});
	it.each([null, { ok: true }])("does not treat an arbitrary JSON service as a compatible device", async (body) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(body)));
		await expect(authenticateConnection(direct, "installation-id")).rejects.toThrow("不兼容");
	});
	it("restores the selected connection mode and migrates existing hub credentials", () => {
		expect(restoreConnection(direct)).toEqual(direct);
		expect(restoreConnection(hub)).toEqual(hub);
		expect(restoreConnection({ serverUrl: hub.serverUrl, token: hub.token })).toEqual(hub);
		expect(() => restoreConnection({ ...direct, mode: "other" })).toThrow("连接方式");
	});
});

describe("notification routing across connection modes", () => {
	it("opens direct-device notifications in the current workspace and hub notifications at their source device", () => {
		expect(notificationDestination("direct", target)).toBe("conversation");
		expect(notificationDestination("hub", { ...target, deviceId: "workstation" })).toBe("device");
		expect(notificationDestination("hub", target)).toBe("settings");
		expect(notificationDestination("direct", { ...target, deviceId: "workstation" })).toBe("settings");
	});
	it("restores a direct notification only for the exact device connection and instance", () => {
		const saved = savePendingTarget(direct, target);
		expect(saved).not.toContain(direct.token);
		expect(restorePendingTarget(saved, direct, target.instanceId)).toEqual(target);
		expect(
			restorePendingTarget(saved, { ...direct, serverUrl: "https://another.example.test" }, target.instanceId),
		).toBeNull();
		expect(restorePendingTarget(saved, direct, "another-instance")).toBeNull();
		expect(restorePendingTarget(saved, { ...direct, mode: "hub" }, target.instanceId)).toBeNull();
	});
	it("preserves hub routing on reload and accepts the previous hub-only format", () => {
		const fromDevice = { ...target, deviceId: "workstation" };
		expect(restorePendingTarget(savePendingTarget(hub, fromDevice), hub, target.instanceId)).toEqual(fromDevice);
		expect(
			restorePendingTarget(JSON.stringify({ hubUrl: hub.serverUrl, target: fromDevice }), hub, target.instanceId),
		).toEqual(fromDevice);
		expect(restorePendingTarget(savePendingTarget(hub, target), hub, target.instanceId)).toBeNull();
	});
	it("drops hub device routes and malformed pending data while connected directly", () => {
		expect(
			restorePendingTarget(
				savePendingTarget(direct, { ...target, deviceId: "workstation" }),
				direct,
				target.instanceId,
			),
		).toBeNull();
		expect(
			restorePendingTarget(savePendingTarget(direct, { ...target, deviceId: "../invalid" }), direct, target.instanceId),
		).toBeNull();
		for (const value of [
			null,
			"null",
			"[]",
			"invalid",
			JSON.stringify({ mode: "direct", serverUrl: direct.serverUrl, target: { ...target, sessionId: "../other" } }),
		]) {
			expect(restorePendingTarget(value, direct, target.instanceId)).toBeNull();
		}
	});
});
