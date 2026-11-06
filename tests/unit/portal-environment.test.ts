import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { wrapperHtml } from "../../server/device-center/path-portal.js";
import { relayBase, resolveBase, withAppBase } from "../../web/src/base-url.js";
import { createMemoryStorage, installPortalEnvironment, restorePortalTheme } from "../../web/src/portal-environment.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function frame(path = "/device/dev/__relay/cap/index.html?token=auth", blocked = true) {
	const fetch = vi.fn().mockResolvedValue({ ok: true });
	const location = new URL(path, "http://hub:50001");
	const target = { location, document: { baseURI: location.href }, fetch, parent: { postMessage: vi.fn() } };
	for (const name of ["localStorage", "sessionStorage"]) {
		Object.defineProperty(target, name, {
			configurable: true,
			get: blocked
				? () => {
						throw new DOMException("Opaque origin", "SecurityError");
					}
				: () => storage[name],
		});
	}
	const storage: Record<string, ReturnType<typeof createMemoryStorage>> = {
		localStorage: createMemoryStorage(),
		sessionStorage: createMemoryStorage(),
	};
	return { target: target as unknown as Parameters<typeof installPortalEnvironment>[0], fetch, storage };
}

describe("opaque portal environment", () => {
	it.each(["/device-lan/dev/__relay/cap/", "/pi/device-lan/dev/__relay/cap/index.html"])(
		"boots a LAN device portal with safe storage and scoped fetch: %s",
		async (path) => {
			const { target, fetch } = frame(path);
			const base = path.replace(/index\.html$/, "");
			expect(relayBase(path)).toBe(base);
			expect(installPortalEnvironment(target)).toBe(true);
			target.localStorage.setItem("draft", "hello");
			expect(target.localStorage.getItem("draft")).toBe("hello");
			await target.fetch(base + "api/conversations", { credentials: "same-origin" });
			expect(fetch).toHaveBeenLastCalledWith(base + "api/conversations", { credentials: "omit" });
			expect(resolveBase(target.location.pathname)).toBe(base);
		},
	);
	it("implements the Storage API with string coercion and insertion order", () => {
		const storage = createMemoryStorage();
		expect(storage.length).toBe(0);
		expect(storage.getItem("missing")).toBeNull();
		expect(storage.key(0)).toBeNull();
		storage.setItem("a", "1");
		storage.setItem("b", "2");
		storage.setItem("a", "3");
		storage.setItem(42 as any, false as any);
		expect(storage.length).toBe(3);
		expect(storage.key(0)).toBe("a");
		expect(storage.key(1)).toBe("b");
		expect(storage.key(-1)).toBeNull();
		expect(storage.getItem("a")).toBe("3");
		expect(storage.getItem("42")).toBe("false");
		storage.removeItem("a");
		storage.removeItem("missing");
		expect(storage.key(0)).toBe("b");
		storage.clear();
		expect(storage.length).toBe(0);
	});

	it("replaces throwing getters before existing storage consumers run, with isolated stores", () => {
		const { target } = frame();
		expect(installPortalEnvironment(target)).toBe(true);
		target.localStorage.setItem("theme", "dark");
		expect(target.localStorage.getItem("theme")).toBe("dark");
		expect(target.sessionStorage.getItem("theme")).toBeNull();
		const another = frame();
		installPortalEnvironment(another.target);
		expect(another.target.localStorage.getItem("theme")).toBeNull();
		const fetch = target.fetch;
		expect(installPortalEnvironment(target)).toBe(false);
		expect(target.fetch).toBe(fetch);
	});

	it("preserves available storage and fetch in a normal relay document", () => {
		const { target, fetch, storage } = frame(undefined, false);
		expect(installPortalEnvironment(target)).toBe(false);
		expect(target.localStorage).toBe(storage.localStorage);
		expect(target.sessionStorage).toBe(storage.sessionStorage);
		expect(target.fetch).toBe(fetch);
	});

	it("preserves an accessible store when only the other getter is blocked", () => {
		const { target, storage } = frame();
		Object.defineProperty(target, "sessionStorage", { value: storage.sessionStorage });
		expect(installPortalEnvironment(target)).toBe(true);
		expect(target.sessionStorage).toBe(storage.sessionStorage);
		expect(target.localStorage.length).toBe(0);
	});

	it.each(["/", "/pi/", "/device/dev/", "/device/dev/__relay/", "/other/device/dev/__relay/cap/"])(
		"does not access blocked storage outside the exact relay route: %s",
		(path) => {
			const { target, fetch } = frame(path);
			expect(installPortalEnvironment(target)).toBe(false);
			expect(() => target.localStorage).toThrow("Opaque origin");
			expect(target.fetch).toBe(fetch);
		},
	);

	it("omits credentials only for this capability, preserving request options", async () => {
		const { target, fetch } = frame();
		installPortalEnvironment(target);
		const options = { method: "POST", body: "payload", credentials: "include" as const };
		await target.fetch("/device/dev/__relay/cap/api/save", options);
		expect(fetch).toHaveBeenLastCalledWith("/device/dev/__relay/cap/api/save", {
			...options,
			credentials: "omit",
		});
		expect(options.credentials).toBe("include");
		await target.fetch(new URL("./api/health?x=1", target.location.href));
		expect(fetch.mock.lastCall?.[1]).toEqual({ credentials: "omit" });
		const request = new Request("http://hub:50001/device/dev/__relay/cap/api/save", options);
		await target.fetch(request);
		expect(fetch).toHaveBeenLastCalledWith(request, { credentials: "omit" });
		for (const url of [
			"/api/health",
			"/device/dev/__relay/other/api/health",
			"/device/dev/__relay/cap-extra/api/health",
			"http://elsewhere/device/dev/__relay/cap/api/health",
		]) {
			await target.fetch(url, options);
			expect(fetch).toHaveBeenLastCalledWith(url, options);
		}
	});

	it("resolves relative fetch against document base metadata", async () => {
		const { target, fetch } = frame();
		Object.defineProperty(target.document, "baseURI", { value: "http://hub:50001/" });
		installPortalEnvironment(target);
		await target.fetch("api/health");
		expect(fetch).toHaveBeenLastCalledWith("api/health", undefined);
	});

	it("evaluates the environment before application imports in the entry point", () => {
		const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
		expect(main.match(/^import .*$/m)?.[0]).toContain('from "./portal-environment"');
	});
});

function portal(storage: Storage, scope = ["account", "dev"], capability = "cap") {
	const base = `/device/${scope[1]}/__relay/${capability}/`;
	const { target } = frame(`${base}index.html`);
	const listeners = new Set<(event: MessageEvent) => void>();
	let receiveWrapper: (event: Partial<MessageEvent>) => void;
	const sendToChild = (data: unknown, source = target.parent, origin = target.location.origin) => {
		for (const listener of listeners) listener({ data, source, origin } as MessageEvent);
	};
	const child = {
		postMessage: (data: unknown) => queueMicrotask(() => sendToChild(data)),
	};
	const sendToWrapper = (data: unknown, source: unknown = child, origin = "null") => {
		receiveWrapper({ data, source: source as MessageEventSource, origin });
	};
	Object.assign(target, {
		parent: { postMessage: (data: unknown) => queueMicrotask(() => sendToWrapper(data)) },
		addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
		removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
	});
	const iframe = { contentWindow: child, addEventListener: vi.fn(), src: "" };
	const { html } = wrapperHtml(base, "", undefined, "Device", JSON.stringify(scope));
	runInNewContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1], {
		document: { querySelector: () => iframe, getElementById: () => ({}) },
		addEventListener: (_type: string, listener: typeof receiveWrapper) => (receiveWrapper = listener),
		localStorage: storage,
		location: target.location,
		setTimeout: vi.fn(() => 1),
		clearTimeout: vi.fn(),
		URL,
	});
	installPortalEnvironment(target);
	return { target, sendToWrapper, sendToChild };
}

describe("remote theme persistence", () => {
	it("restores the theme after reopening with a new capability, isolated by account and device", async () => {
		const storage = createMemoryStorage();
		const first = portal(storage);
		await restorePortalTheme(first.target);
		first.target.localStorage.setItem("pi-theme", "nord");
		first.target.localStorage.setItem("pi-auth-token", "private-token");
		first.target.sessionStorage.setItem("pi-theme", "dracula");
		await Promise.resolve();
		expect(storage.length).toBe(1);
		expect(storage.getItem(storage.key(0)!)).toBe("nord");

		const reopened = portal(storage, undefined, "rotated-capability");
		await restorePortalTheme(reopened.target);
		expect(reopened.target.localStorage.getItem("pi-theme")).toBe("nord");
		expect(reopened.target.localStorage.getItem("pi-auth-token")).toBeNull();
		for (const scope of [
			["another-account", "dev"],
			["account", "another-device"],
		]) {
			const other = portal(storage, scope);
			await restorePortalTheme(other.target);
			expect(other.target.localStorage.getItem("pi-theme")).toBeNull();
		}
	});

	it("persists theme removal and clear without exposing other storage keys", async () => {
		const storage = createMemoryStorage();
		const { target } = portal(storage);
		await restorePortalTheme(target);
		for (const remove of [() => target.localStorage.removeItem("pi-theme"), () => target.localStorage.clear()]) {
			target.localStorage.setItem("pi-theme", "nord");
			await Promise.resolve();
			expect(storage.length).toBe(1);
			remove();
			await Promise.resolve();
			expect(storage.length).toBe(0);
			const reopened = portal(storage);
			await restorePortalTheme(reopened.target);
			expect(reopened.target.localStorage.getItem("pi-theme")).toBeNull();
		}
	});

	it("rejects forged wrapper messages, unrelated storage requests and invalid themes", async () => {
		const storage = createMemoryStorage();
		const first = portal(storage);
		first.target.localStorage.setItem("pi-theme", "nord");
		await Promise.resolve();
		storage.setItem("hub-secret", "secret");
		const reopened = portal(storage);
		const ready = restorePortalTheme(reopened.target);
		reopened.sendToChild({ type: "device-portal-theme", value: "dracula" }, {} as Window);
		reopened.sendToChild({ type: "device-portal-theme", value: "dracula" }, reopened.target.parent, "null");
		await ready;
		expect(reopened.target.localStorage.getItem("pi-theme")).toBe("nord");
		const write = { type: "device-portal-theme-write", value: "dracula" };
		reopened.sendToWrapper(write, {});
		reopened.sendToWrapper(write, undefined, reopened.target.location.origin);
		reopened.sendToWrapper({ ...write, value: "../../secret" });
		reopened.sendToWrapper({ type: "storage-write", key: "hub-secret", value: "stolen" });
		const another = portal(storage);
		await restorePortalTheme(another.target);
		expect(another.target.localStorage.getItem("pi-theme")).toBe("nord");
		expect(another.target.localStorage.getItem("hub-secret")).toBeNull();
		expect(storage.getItem("hub-secret")).toBe("secret");
		expect(storage.length).toBe(2);
	});

	it("continues startup when an older wrapper does not support theme persistence", async () => {
		vi.useFakeTimers();
		const { target } = frame();
		const listeners = new Set();
		Object.assign(target, {
			addEventListener: (_type: string, listener: unknown) => listeners.add(listener),
			removeEventListener: (_type: string, listener: unknown) => listeners.delete(listener),
		});
		installPortalEnvironment(target);
		const ready = restorePortalTheme(target);
		await vi.advanceTimersByTimeAsync(500);
		await ready;
		expect(listeners.size).toBe(0);
		expect(target.localStorage.getItem("pi-theme")).toBeNull();
	});
});

describe("relay base URLs", () => {
	it("keeps the capability root for index, nested paths, query and base metadata", () => {
		const path = "/device/dev/__relay/cap/";
		expect(relayBase(`${path}index.html`)).toBe(path);
		expect(resolveBase(`${path}nested/view`)).toBe(path);
		vi.stubGlobal("location", new URL(`http://hub:50001${path}?token=auth&base=/wrong/`));
		vi.stubGlobal("document", { baseURI: "http://hub:50001/wrong/" });
		expect(resolveBase()).toBe(path);
		const ws = new URL(withAppBase("/ws", resolveBase()), "http://hub:50001");
		expect(ws.href).toBe(`http://hub:50001${path}ws`);
	});

	it("retains document base behavior for regular deployments", () => {
		vi.stubGlobal("location", new URL("http://hub:50001/pi/"));
		vi.stubGlobal("document", { baseURI: "http://hub:50001/custom/index.html?x=1" });
		expect(resolveBase()).toBe("/custom/");
	});
});
