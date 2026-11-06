import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobilePushAdapter, MobilePushState } from "../../web/src/mobile-runtime";

const service = "https://service.example/apps/pi";

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("ok")),
	);
	vi.stubGlobal("location", {
		href: "https://localhost/index.html?group=old",
		origin: "https://localhost",
		protocol: "https:",
		host: "localhost",
	});
	vi.stubGlobal("document", { baseURI: "https://localhost/index.html" });
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function mobile(pushAdapter?: MobilePushAdapter) {
	const runtime = await import("../../web/src/mobile-runtime");
	runtime.configureMobileRuntime({ serverUrl: `${service}/`, token: "native secret", pushAdapter });
	return runtime;
}

function pushAdapter(initial: Partial<MobilePushState> = {}) {
	const state: MobilePushState = { supported: true, permission: "granted", enabled: false, ...initial };
	const listeners = new Set<() => void>();
	const adapter: MobilePushAdapter = {
		getState: () => ({ ...state }),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		requestPermission: vi.fn(async () => state.permission),
		setEnabled: vi.fn(async (enabled) => {
			state.enabled = enabled;
			for (const listener of listeners) listener();
		}),
		setKinds: vi.fn(async () => {}),
	};
	return { adapter, state, listeners };
}

describe("mobile service URLs and authentication", () => {
	it("keeps the browser base, resource and WebSocket behavior without native configuration", async () => {
		vi.stubGlobal("document", { baseURI: "https://browser.example/pi/" });
		vi.stubGlobal("location", { href: "https://browser.example/pi/" });
		const { appBase, appUrl, appResourceUrl, appWsUrl } = await import("../../web/src/base-url");
		expect(appBase()).toBe("/pi/");
		expect(appUrl("/api/config")).toBe("/pi/api/config");
		expect(appResourceUrl("/themes/dark.css?v=1")).toBe("/pi/themes/dark.css?v=1");
		expect(appWsUrl()).toBe("wss://browser.example/pi/ws");
	});

	it("routes HTTP and WS to the remote subpath while preserving local bundle resources", async () => {
		await mobile();
		const { appBase, appUrl, appResourceUrl, appWsUrl } = await import("../../web/src/base-url");
		expect(appBase()).toBe("/");
		expect(appUrl("/api/config")).toBe(`${service}/api/config`);
		expect(`${appUrl("/api/files")}/child?name=a`).toBe(`${service}/api/files/child?name=a`);
		expect(appWsUrl()).toBe("wss://service.example/apps/pi/ws");
		const css = new URL(appResourceUrl("/themes/dark.css?v=3#palette"));
		expect(css.searchParams.get("v")).toBe("3");
		expect(css.searchParams.get("token")).toBe("native secret");
		expect(css.hash).toBe("#palette");
		expect(appResourceUrl("https://third.example/image.png")).toBe("https://third.example/image.png");
	});

	it("connects the independent canvas WebSocket to the authenticated remote endpoint", async () => {
		await mobile();
		const connect = vi.fn();
		class Socket {
			constructor(url: string) {
				connect(url);
			}
			close() {}
		}
		vi.stubGlobal("WebSocket", Socket);
		const { CanvasClient } = await import("../../web/src/components/canvas/canvas-client");
		const client = new CanvasClient();
		client.connect();
		expect(connect).toHaveBeenCalledWith("wss://service.example/apps/pi/ws?token=native+secret");
		client.dispose();
	});

	it("allows file transfers to the configured service instead of rejecting the native origin", async () => {
		const fetchService = vi.mocked(globalThis.fetch);
		await mobile();
		vi.stubGlobal("window", { location: globalThis.location });
		vi.doMock("../../web/src/use-chat", () => ({ getClientId: () => "client&injected=value" }));
		try {
			const { archiveAction } = await import("../../web/src/file-transfer");
			await archiveAction("extract", "/project/archive.zip", { destination: "/project/out", policy: "skip" });
			const [input, init] = fetchService.mock.calls[0]!;
			const url = new URL(String(input));
			expect(url.origin + url.pathname).toBe(`${service}/api/file-transfer/archive`);
			expect(url.searchParams.get("clientId")).toBe("client&injected=value");
			expect(url.searchParams.has("injected")).toBe(false);
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer native secret");
			expect(JSON.parse(String(init?.body))).toEqual({
				action: "extract",
				path: "/project/archive.zip",
				destination: "/project/out",
				policy: "skip",
			});
		} finally {
			vi.doUnmock("../../web/src/use-chat");
		}
	});

	it("never reads browser token storage and authenticates only exact service URLs", async () => {
		const storage = {
			getItem: vi.fn(() => {
				throw new Error("must not access credentials");
			}),
			setItem: vi.fn(),
		};
		vi.stubGlobal("localStorage", storage);
		await mobile();
		const { withToken, initAuthToken } = await import("../../web/src/auth-token");
		initAuthToken();
		const url = new URL(withToken(`${service}/ws?keep=1&token=stale#hash`));
		expect(url.searchParams.getAll("token")).toEqual(["native secret"]);
		expect(url.searchParams.get("keep")).toBe("1");
		expect(url.hash).toBe("#hash");
		for (const outsider of [
			"https://third.example/api",
			"https://service.example/apps/pi-other/api",
			"https://service.example/apps/api",
			"https://service.example.evil/apps/pi/api",
			"https://service.example/apps/pi/../private",
			"https://user@service.example/apps/pi/api",
			"https://localhost/api",
			"/api/file",
		])
			expect(withToken(outsider)).toBe(outsider);
		expect(withToken("wss://service.example/apps/pi/ws")).toContain("token=native+secret");
		expect(storage.getItem).not.toHaveBeenCalled();
		expect(storage.setItem).not.toHaveBeenCalled();
	});

	it("adds bearer auth to service fetches without leaking it to third parties or redirects", async () => {
		const fetchService = vi.mocked(globalThis.fetch);
		await mobile();
		await fetch(`${service}/api/upload`, { method: "POST", headers: { "X-Test": "kept" }, body: "content" });
		const [, init] = fetchService.mock.calls[0]!;
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer native secret");
		expect(headers.get("X-Test")).toBe("kept");
		expect(init).toMatchObject({ method: "POST", body: "content", credentials: "omit", redirect: "error" });
		for (const outsider of ["https://third.example/api", "https://service.example/apps/pi-other/api", "/api/local"]) {
			await fetch(outsider, { headers: { "X-Test": "outside" } });
			const [, outside] = fetchService.mock.calls.at(-1)!;
			expect(new Headers(outside?.headers).has("Authorization")).toBe(false);
			expect(outside?.redirect).toBeUndefined();
		}
	});

	it("preserves Request headers and uses the latest in-memory token without nesting wrappers", async () => {
		const fetchService = vi.mocked(globalThis.fetch);
		const runtime = await mobile();
		const wrapper = globalThis.fetch;
		runtime.configureMobileRuntime({ serverUrl: service, token: "replacement" });
		expect(globalThis.fetch).toBe(wrapper);
		await fetch(new Request(`${service}/api/config`, { headers: { "X-Request": "preserved" } }));
		expect(fetchService).toHaveBeenCalledOnce();
		const [, init] = fetchService.mock.calls[0]!;
		expect(new Headers(init?.headers).get("X-Request")).toBe("preserved");
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer replacement");
	});

	it("allows private HTTP services and rejects credentials, query, hash and non-HTTP bases", async () => {
		const runtime = await import("../../web/src/mobile-runtime");
		runtime.configureMobileRuntime({ serverUrl: "http://192.168.1.4:3000/pi/", token: "test" });
		const { appWsUrl } = await import("../../web/src/base-url");
		expect(appWsUrl()).toBe("ws://192.168.1.4:3000/pi/ws");
		for (const serverUrl of [
			"file:///local",
			"https://user@service.example",
			"https://service.example/?token=x",
			"https://service.example/#s=x",
		]) {
			expect(() => runtime.configureMobileRuntime({ serverUrl, token: "test" })).toThrow();
		}
		expect(() => runtime.configureMobileRuntime({ serverUrl: service, token: "bad\r\nheader" })).toThrow();
	});
});

describe("native device navigation", () => {
	it("delegates device opening to the native shell without remote HTML popups", async () => {
		const fetchService = vi.mocked(globalThis.fetch);
		const runtime = await mobile();
		const adapter = { openDevice: vi.fn(async () => {}), openDeviceCenter: vi.fn() };
		runtime.configureMobileRuntime({ serverUrl: service, token: "native secret", deviceAdapter: adapter });
		const open = vi.fn();
		vi.stubGlobal("window", { open });
		const { openDeviceAccess } = await import("../../web/src/device-access");
		await openDeviceAccess("laptop", "https://hub.example", false, false);
		expect(adapter.openDevice).toHaveBeenCalledWith("laptop", "https://hub.example");
		expect(open).not.toHaveBeenCalled();
		expect(fetchService).not.toHaveBeenCalled();
	});

	it("does not fall back to a remote popup when the shell has no device adapter", async () => {
		await mobile();
		const open = vi.fn();
		vi.stubGlobal("window", { open });
		const { openDeviceAccess } = await import("../../web/src/device-access");
		await expect(openDeviceAccess("laptop", "https://hub.example", true, false)).rejects.toThrow(
			"Native device access is unavailable",
		);
		expect(open).not.toHaveBeenCalled();
	});
});

describe("native notification adapter", () => {
	it("reflects server event subscriptions changed in the native settings panel", async () => {
		const { adapter, state } = pushAdapter({ enabled: true, kinds: ["question", "approval"] });
		await mobile(adapter);
		const notify = await import("../../web/src/notify");
		expect(notify.loadNotifySettings()).toMatchObject({
			enabled: true,
			events: { question: "on", approval: "on", done: "off", start: "off" },
		});
		state.kinds = ["done"];
		expect(notify.loadNotifySettings().events).toMatchObject({ done: "on", question: "off", approval: "off" });
	});
	it("keeps OS permission separate from subscription state and stops remote push on disable", async () => {
		const { adapter, state } = pushAdapter();
		await mobile(adapter);
		const notify = await import("../../web/src/notify");
		expect(notify.notificationPermission()).toBe("granted");
		expect(notify.loadNotifySettings().enabled).toBe(false);
		const listener = vi.fn();
		const unsubscribe = notify.subscribeNotificationState(listener);
		expect(await notify.setNotificationsEnabled(true)).toBe(true);
		expect(adapter.setEnabled).toHaveBeenCalledWith(true);
		expect(listener).toHaveBeenCalledOnce();
		expect(await notify.setNotificationsEnabled(false)).toBe(false);
		expect(adapter.setEnabled).toHaveBeenLastCalledWith(false);
		expect(state.permission).toBe("granted");
		unsubscribe();
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("does not subscribe after denied permission or report a failed registration as enabled", async () => {
		const { adapter, state } = pushAdapter({ permission: "denied" });
		await mobile(adapter);
		const notify = await import("../../web/src/notify");
		expect(await notify.setNotificationsEnabled(true)).toBe(false);
		expect(adapter.setEnabled).toHaveBeenCalledWith(false);
		state.permission = "granted";
		vi.mocked(adapter.setEnabled).mockRejectedValueOnce(new Error("registration failed"));
		await expect(notify.setNotificationsEnabled(true)).rejects.toThrow("registration failed");
		expect(notify.loadNotifySettings().enabled).toBe(false);
	});

	it("resolves per-event overrides and follows sound preferences for the native subscription", async () => {
		const { adapter } = pushAdapter();
		await mobile(adapter);
		vi.stubGlobal("localStorage", {
			getItem: () =>
				JSON.stringify({
					question: false,
					done: true,
					error: false,
					subagentDone: false,
					start: false,
					approval: false,
				}),
			setItem: vi.fn(),
		});
		const notify = await import("../../web/src/notify");
		await notify.syncMobileNotificationKinds({ enabled: false, events: { done: "off", question: "on" } });
		expect(adapter.setKinds).toHaveBeenCalledWith(["question"]);
	});

	it("never emits duplicate Browser Notifications or accesses the native service worker", async () => {
		const { adapter } = pushAdapter({ enabled: true });
		await mobile(adapter);
		const Notification = vi.fn();
		vi.stubGlobal("Notification", Notification);
		vi.stubGlobal("window", { Notification });
		const notify = await import("../../web/src/notify");
		await notify.notify("finished", "body", "done", "session");
		expect(Notification).not.toHaveBeenCalled();
	});

	it("does not fall back to Browser Notification when no native adapter is installed", async () => {
		await mobile();
		vi.stubGlobal("window", { Notification: {}, isSecureContext: true });
		const notify = await import("../../web/src/notify");
		expect(notify.notificationsSupported()).toBe(false);
		expect(notify.notifyBlockReason()).toBe("unsupported");
		expect(await notify.requestNotificationPermission()).toBe("denied");
		expect(await notify.setNotificationsEnabled(true)).toBe(false);
	});

	it("accepts only local notification deep links and removes credentials", async () => {
		await mobile();
		const target = new EventTarget();
		vi.stubGlobal("window", Object.assign(target, { location: globalThis.location }));
		vi.stubGlobal("navigator", {});
		const notify = await import("../../web/src/notify");
		const click = vi.fn();
		const unsubscribe = notify.subscribeNotificationClicks(click);
		const dispatch = (url: string) =>
			target.dispatchEvent(
				new CustomEvent("pi-web-ui:notification-click", {
					detail: { type: "pi-web-ui:notification-click", url },
				}),
			);
		dispatch(`${service}/#s=remote`);
		expect(click).not.toHaveBeenCalled();
		dispatch("https://localhost/?token=remove#s=session");
		expect(click).toHaveBeenCalledWith("https://localhost/#s=session");
		unsubscribe();
		dispatch("https://localhost/#s=second");
		expect(click).toHaveBeenCalledOnce();
	});
});

describe("mobile notification routing", () => {
	it("retains a cold-start target until consumed and emits a warm event", async () => {
		const runtime = await mobile();
		const browser = new EventTarget();
		vi.stubGlobal("window", browser);
		const listener = vi.fn();
		browser.addEventListener(runtime.MOBILE_NOTIFICATION_OPEN, listener);
		const target = {
			eventId: "event",
			instanceId: "service-instance",
			sessionId: "session",
			clientId: "desktop",
			conversationId: "conversation",
		};
		runtime.openMobileNotificationTarget(target);
		expect(listener).toHaveBeenCalledOnce();
		expect(runtime.hasPendingMobileNotificationTarget()).toBe(true);
		expect(runtime.consumeMobileNotificationTarget()).toEqual(target);
		expect(runtime.hasPendingMobileNotificationTarget()).toBe(false);
		expect(runtime.consumeMobileNotificationTarget()).toBeNull();
	});

	it("clears old pending targets and stops authenticating the old service after a device switch", async () => {
		const fetchService = vi.mocked(globalThis.fetch);
		const runtime = await mobile();
		runtime.openMobileNotificationTarget({ eventId: "old", instanceId: "old-instance", sessionId: "session" });
		runtime.configureMobileRuntime({ serverUrl: "https://next.example/pi", token: "next-secret" });
		expect(runtime.consumeMobileNotificationTarget()).toBeNull();
		await fetch(`${service}/api/config`);
		expect(new Headers(fetchService.mock.calls[0]![1]?.headers).has("Authorization")).toBe(false);
		await fetch("https://next.example/pi/api/config");
		expect(new Headers(fetchService.mock.calls[1]![1]?.headers).get("Authorization")).toBe("Bearer next-secret");
	});

	it("uses a read-only shared binding or existing local conversation without loading or taking over", async () => {
		const runtime = await mobile();
		const target = {
			eventId: "event",
			instanceId: "instance",
			sessionId: "session",
			clientId: "desktop",
			conversationId: "conversation",
		};
		expect(runtime.mobileNotificationRequest(target, "phone")).toEqual({
			type: "open_shared_conversation",
			owner: "desktop",
			id: "conversation",
			readOnly: true,
		});
		expect(runtime.mobileNotificationRequest(target, "desktop")).toEqual({
			type: "switch_conversation",
			id: "conversation",
		});
		expect(runtime.mobileNotificationRequest({ ...target, clientId: undefined }, "phone")).toBeNull();
	});
});

describe("native remote plugin policy", () => {
	it("does not load view, preload, action, file-handler, fence or widget client bundles", async () => {
		await mobile();
		const loader = await import("../../web/src/plugin-loader");
		const importer = vi.fn();
		await expect(
			loader.createScopedImporter(importer)("remote", `${service}/plugins/remote/client/entry.mjs`),
		).rejects.toThrow("Remote plugin clients");
		expect(importer).not.toHaveBeenCalled();
		const fence = await import("../../web/src/plugin-fence");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const plugin = {
			id: "remote",
			name: "Remote",
			hasClient: true,
			preload: true,
			renderers: ["diagram"],
			messageWidgets: ["custom"],
		};
		await loader.syncPluginViews([plugin], 1);
		expect(await loader.ensurePluginViewLoaded(plugin, 1)).toBe(false);
		expect(await loader.retryPluginViewLoad(plugin, 1)).toBe(false);
		expect(await loader.loadPluginBundleModule(plugin, 1)).toBeNull();
		const views = vi.fn();
		loader.subscribeLoadedPluginViews(views)();
		expect(views).toHaveBeenCalledWith([]);
		fence.syncFenceRenderers([plugin], 1);
		fence.syncMessageWidgets([plugin], 1);
		expect(fence.hasFenceRenderer("diagram")).toBe(false);
		expect(fence.hasMessageWidget("custom")).toBe(false);
		expect(await fence.renderFence("diagram", "code")).toBeNull();
		fence.widgetRegistry.set("custom", "remote");
		expect(await fence.loadMessageWidget("custom")).toBeNull();
		expect(error).not.toHaveBeenCalled();
	});
});
