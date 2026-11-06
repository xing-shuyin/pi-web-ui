import { relayBase } from "./base-url";

export function createMemoryStorage(onChange?: (key: string, value: string | null) => void): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		clear() {
			const keys = [...entries.keys()];
			entries.clear();
			for (const key of keys) onChange?.(key, null);
		},
		getItem(key) {
			return entries.get(String(key)) ?? null;
		},
		key(index) {
			return [...entries.keys()][Number(index) >>> 0] ?? null;
		},
		removeItem(key) {
			key = String(key);
			if (entries.delete(key)) onChange?.(key, null);
		},
		setItem(key, value) {
			key = String(key);
			value = String(value);
			entries.set(key, value);
			onChange?.(key, value);
		},
	};
}

export function installPortalEnvironment(target: Window): boolean {
	const base = relayBase(target.location.pathname);
	if (!base) return false;
	let opaque = false;
	for (const name of ["localStorage", "sessionStorage"] as const) {
		try {
			void target[name];
		} catch {
			opaque = true;
			Object.defineProperty(target, name, {
				configurable: true,
				enumerable: true,
				value: createMemoryStorage(
					name === "localStorage"
						? (key, value) => {
								if (key === "pi-theme") {
									target.parent.postMessage({ type: "device-portal-theme-write", value }, target.location.origin);
								}
							}
						: undefined,
				),
			});
		}
	}
	if (!opaque) return false;

	const originalFetch = target.fetch;
	target.fetch = (input, init) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(href, target.document.baseURI || target.location.href);
		if (url.origin === target.location.origin && url.pathname.startsWith(base)) {
			return originalFetch.call(target, input, { ...init, credentials: "omit" });
		}
		return originalFetch.call(target, input, init);
	};
	return true;
}

export function restorePortalTheme(target: Window, timeoutMs = 500): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			target.removeEventListener("message", receive);
			resolve();
		};
		const receive = (event: MessageEvent) => {
			if (
				event.source !== target.parent ||
				event.origin !== target.location.origin ||
				event.data?.type !== "device-portal-theme"
			) {
				return;
			}
			const value = event.data.value;
			if (value === null) target.localStorage.removeItem("pi-theme");
			else if (typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value)) {
				target.localStorage.setItem("pi-theme", value);
			}
			finish();
		};
		const timer = setTimeout(finish, timeoutMs);
		target.addEventListener("message", receive);
		target.parent.postMessage({ type: "device-portal-theme-read" }, target.location.origin);
	});
}

export const opaquePortalEnvironment = typeof window !== "undefined" && installPortalEnvironment(window);
