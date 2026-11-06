import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notify, subscribeNotificationClicks } from "../../web/src/notify.js";

const CLICK = "pi-web-ui:notification-click";
const workerSource = readFileSync(new URL("../../web/public/sw.js", import.meta.url), "utf8");

function notificationPage(registration?: unknown) {
	const notifications: PageNotification[] = [];
	class PageNotification {
		static permission = "granted";
		onclick: (() => void) | null = null;
		close = vi.fn();
		constructor(
			readonly title: string,
			readonly options: NotificationOptions,
		) {
			notifications.push(this);
		}
	}
	const page = Object.assign(new EventTarget(), {
		Notification: PageNotification,
		location: new URL("http://localhost:8911/pi/?token=test-token&view=devices#s=foreground"),
		focus: vi.fn(),
	});
	const worker = Object.assign(new EventTarget(), { getRegistration: vi.fn(async () => registration) });
	vi.stubGlobal("window", page);
	vi.stubGlobal("location", page.location);
	vi.stubGlobal("navigator", { serviceWorker: worker });
	vi.stubGlobal("Notification", PageNotification);
	vi.stubGlobal("document", { hasFocus: () => false, visibilityState: "hidden", addEventListener: vi.fn() });
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => (key === "pi-web-notify" ? JSON.stringify({ enabled: true }) : null),
	});
	return { page, worker, notifications };
}

function windowClient(url: string) {
	return { url, postMessage: vi.fn(), focus: vi.fn().mockResolvedValue(undefined) };
}

function serviceWorker(clients: ReturnType<typeof windowClient>[] = [], scope = "http://localhost:8911/pi/") {
	const handlers = new Map<string, (event: unknown) => void>();
	const matchAll = vi.fn().mockResolvedValue(clients);
	const openWindow = vi.fn().mockResolvedValue(undefined);
	runInNewContext(workerSource, {
		URL,
		self: {
			registration: { scope },
			location: new URL(scope),
			clients: { matchAll, openWindow },
			addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
		},
	});
	const click = async (url?: string) => {
		let completed: Promise<unknown> | undefined;
		const close = vi.fn();
		handlers.get("notificationclick")!({
			notification: { data: url ? { url } : undefined, close },
			waitUntil: (promise: Promise<unknown>) => (completed = promise),
		});
		await completed;
		expect(close).toHaveBeenCalledOnce();
	};
	return { click, matchAll, openWindow };
}

afterEach(() => vi.unstubAllGlobals());

describe("notification session targets", () => {
	it("keeps a background session target while the user switches chats during delivery", async () => {
		const showNotification = vi.fn();
		const { page, worker } = notificationPage({ active: {}, showNotification });
		let resolveRegistration!: (registration: unknown) => void;
		worker.getRegistration.mockImplementationOnce(() => new Promise((resolve) => (resolveRegistration = resolve)));
		const pending = notify("Task complete", "Background task finished", "done", "background session");
		page.location.hash = "s=another-chat";
		resolveRegistration({ active: {}, showNotification });
		await pending;
		expect(showNotification).toHaveBeenCalledWith(
			"Task complete",
			expect.objectContaining({
				body: "Background task finished",
				data: { url: "http://localhost:8911/pi/#s=background%20session" },
			}),
		);
		expect(showNotification.mock.calls[0][1]).not.toHaveProperty("tag");
	});

	it("captures the foreground session when no explicit target is supplied", async () => {
		const showNotification = vi.fn();
		notificationPage({ active: {}, showNotification });
		await notify("Question", "Input needed", "question");
		expect(showNotification.mock.calls[0][1].data.url).toBe("http://localhost:8911/pi/#s=foreground");
	});

	it.each([false, true])(
		"routes plain notification clicks after a worker is absent/fails (%s)",
		async (workerFails) => {
			const { page, worker, notifications } = notificationPage();
			if (workerFails) worker.getRegistration.mockRejectedValueOnce(new Error("worker not ready"));
			const onClick = vi.fn();
			const unsubscribe = subscribeNotificationClicks(onClick);
			await notify("Task complete", "Finished", "done", "background");
			page.location.hash = "s=later-chat";
			notifications[0].onclick!();
			expect(notifications[0].close).toHaveBeenCalledOnce();
			expect(page.focus).toHaveBeenCalledOnce();
			expect(onClick).toHaveBeenCalledWith("http://localhost:8911/pi/#s=background");
			unsubscribe();
		},
	);

	it("accepts worker click messages, rejects invalid targets and removes listeners", () => {
		const { worker } = notificationPage();
		const onClick = vi.fn();
		const unsubscribe = subscribeNotificationClicks(onClick);
		const send = (url: string) => worker.dispatchEvent(new MessageEvent("message", { data: { type: CLICK, url } }));
		send("http://localhost:8911/pi/#s=background");
		send("https://other.example/pi/#s=background");
		send("invalid URL");
		expect(onClick).toHaveBeenCalledExactlyOnceWith("http://localhost:8911/pi/#s=background");
		unsubscribe();
		send("http://localhost:8911/pi/#s=later");
		expect(onClick).toHaveBeenCalledOnce();
	});
});

describe("service worker notification clicks", () => {
	it("focuses an existing window and forwards the target without reloading", async () => {
		const client = windowClient("http://localhost:8911/pi/#s=foreground");
		const { click, openWindow } = serviceWorker([client]);
		await click("http://localhost:8911/pi/#s=background");
		expect(client.postMessage).toHaveBeenCalledWith({ type: CLICK, url: "http://localhost:8911/pi/#s=background" });
		expect(client.focus).toHaveBeenCalledOnce();
		expect(openWindow).not.toHaveBeenCalled();
	});

	it("prefers the window already showing the target conversation", async () => {
		const other = windowClient("http://localhost:8911/pi/#s=other");
		const target = windowClient("http://localhost:8911/pi/#s=background");
		const { click } = serviceWorker([other, target]);
		await click(target.url);
		expect(target.focus).toHaveBeenCalledOnce();
		expect(other.focus).not.toHaveBeenCalled();
	});

	it("reopens the session deep link when no app window is open", async () => {
		const otherApp = windowClient("http://localhost:8911/another-app/");
		const otherOrigin = windowClient("http://localhost:8912/pi/");
		const { click, openWindow } = serviceWorker([otherApp, otherOrigin]);
		await click("http://localhost:8911/pi/#s=background");
		expect(openWindow).toHaveBeenCalledWith("http://localhost:8911/pi/#s=background");
		expect(otherApp.focus).not.toHaveBeenCalled();
		expect(otherOrigin.focus).not.toHaveBeenCalled();
	});

	it.each([undefined, "invalid URL", "https://other.example/pi/", "http://localhost:8911/another-app/"])(
		"opens the app root for an old or invalid target (%s)",
		async (url) => {
			const { click, openWindow } = serviceWorker();
			await click(url);
			expect(openWindow).toHaveBeenCalledWith("http://localhost:8911/pi/");
		},
	);

	it("forwards the session even when the browser refuses to focus the window", async () => {
		const client = windowClient("http://localhost:8911/#s=foreground");
		client.focus.mockRejectedValueOnce(new Error("focus refused"));
		const { click } = serviceWorker([client], "http://localhost:8911/");
		await click("http://localhost:8911/#s=background");
		expect(client.postMessage).toHaveBeenCalledWith({ type: CLICK, url: "http://localhost:8911/#s=background" });
	});
});
