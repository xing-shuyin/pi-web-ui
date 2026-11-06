import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	status: { permission: "granted", registrationId: "registration123", enabled: true },
	listeners: new Map<string, (event: any) => void>(),
	disable: vi.fn(async () => {}),
}));
vi.mock("../../mobile/node_modules/@capacitor/core/dist/index.cjs.js", () => ({
	Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
}));
vi.mock("../../mobile/native/push/src/index.ts", () => ({
	PiPush: {
		getStatus: async () => ({ ...sdk.status }),
		enable: async () => ({ ...sdk.status }),
		disable: sdk.disable,
		getPendingNotification: async () => null,
		addListener: async (name: string, listener: (event: any) => void) => {
			sdk.listeners.set(name, listener);
			return { remove: async () => sdk.listeners.delete(name) };
		},
	},
}));
import { PushController } from "../../mobile/src/push-controller.js";

const connection = { serverUrl: "https://hub.example.test", token: "native-session" };
const installation = "11111111-1111-4111-8111-111111111111";
let storage: Map<string, string>;
let requests: { url: string; init: RequestInit }[];
let deviceEnabled: boolean;
let offlineDelete: boolean;
beforeEach(() => {
	sdk.listeners.clear();
	sdk.disable.mockClear();
	sdk.status = { permission: "granted", registrationId: "registration123", enabled: true };
	storage = new Map();
	requests = [];
	deviceEnabled = false;
	offlineDelete = false;
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init: RequestInit = {}) => {
			requests.push({ url: String(input), init });
			if (init.method === "DELETE" && offlineDelete) throw new Error("offline");
			return new Response(
				JSON.stringify(
					String(input).includes("/status")
						? {
								configured: true,
								instanceId: "hub-1",
								device: deviceEnabled ? { enabled: true, kinds: ["question", "approval"] } : null,
							}
						: { ok: true },
				),
				{ headers: { "Content-Type": "application/json" } },
			);
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("mobile native push subscription", () => {
	it("retains event preferences while notifications are disabled", async () => {
		const first = new PushController(connection, installation, vi.fn(), vi.fn());
		await first.setKinds(["approval"]);
		const restored = new PushController(connection, installation, vi.fn(), vi.fn());
		expect(restored.getDetails().kinds).toEqual(["approval"]);
		expect(requests).toEqual([]);
	});
	it("deduplicates clicks per source device while retaining identical event IDs on different devices", async () => {
		const opened = vi.fn();
		const controller = new PushController(connection, installation, opened, vi.fn());
		await controller.initialize();
		const tap = sdk.listeners.get("notificationOpened")!;
		const extras = { eventId: "event-1", instanceId: "hub-1", sessionId: "session-1" };
		tap({ extras: { ...extras, deviceId: "device-a" } });
		tap({ extras: { ...extras, deviceId: "device-b" } });
		tap({ extras: { ...extras, deviceId: "device-b" } });
		tap({ extras: { ...extras, deviceId: "device-a", instanceId: "foreign-hub" } });
		expect(opened).toHaveBeenCalledTimes(2);
		expect(opened.mock.calls[0][0].deviceId).toBe("device-a");
		expect(opened.mock.calls[1][0].deviceId).toBe("device-b");
		await controller.dispose();
	});
	it("stops the native SDK and keeps an unsubscribe intent when the hub is unreachable", async () => {
		deviceEnabled = true;
		const controller = new PushController(connection, installation, vi.fn(), vi.fn());
		await controller.initialize();
		offlineDelete = true;
		await controller.setEnabled(false);
		expect(sdk.disable).toHaveBeenCalledOnce();
		expect(controller.getDetails()).toMatchObject({ enabled: false, pendingDisable: true });
		const restored = new PushController(connection, installation, vi.fn(), vi.fn());
		expect(restored.getDetails().pendingDisable).toBe(true);
		await controller.dispose();
	});
	it("does not register remote push after the OS denies notification permission", async () => {
		sdk.status = { ...sdk.status, permission: "denied", enabled: false };
		const controller = new PushController(connection, installation, vi.fn(), vi.fn());
		await expect(controller.setEnabled(true)).rejects.toThrow("系统设置");
		expect(requests.some((request) => request.init.method === "POST")).toBe(false);
		expect(controller.getState().enabled).toBe(false);
	});
	it("upserts a rotated registration ID without changing the installation identity", async () => {
		deviceEnabled = true;
		const controller = new PushController(connection, installation, vi.fn(), vi.fn());
		await controller.initialize();
		sdk.listeners.get("registration")!({ registrationId: "rotatedRegistration456" });
		await vi.waitFor(() => {
			const bodies = requests
				.filter((request) => request.init.method === "POST")
				.map((request) => JSON.parse(String(request.init.body)));
			expect(bodies).toContainEqual(
				expect.objectContaining({ deviceId: installation, registrationId: "rotatedRegistration456" }),
			);
		});
		await controller.dispose();
	});
});
