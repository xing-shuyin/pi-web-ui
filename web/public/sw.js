const BUILD_ID = "__BUILD_ID__";
const STATIC_CACHE = BUILD_ID.startsWith("__") ? "pi-web-ui-static-dev" : `pi-web-ui-static-${BUILD_ID}`;
const SHELL_CACHE = "pi-web-ui-shell-v1";

const SCOPE = new URL("./", self.registration.scope).pathname;

function appPath(pathname) {
	if (SCOPE === "/") return pathname;
	if (pathname.startsWith(SCOPE)) return "/" + pathname.slice(SCOPE.length);
	return null;
}

self.addEventListener("install", (event) => {
	self.skipWaiting();
	event.waitUntil(caches.open(SHELL_CACHE));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== SHELL_CACHE).map((k) => caches.delete(k))),
			)
			.then(() => self.clients.claim()),
	);
});

function isCachable(request) {
	const method = request.method;
	if (method !== "GET") return false;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return false;

	const path = appPath(url.pathname);
	if (
		path === null ||
		path.startsWith("/ws") ||
		path.startsWith("/api") ||
		path.startsWith("/themes") ||
		path.startsWith("/plugins")
	) {
		return false;
	}
	return true;
}

function assetContentOk(requestUrl, response) {
	const ct = (response.headers.get("content-type") || "").toLowerCase();
	const path = requestUrl.pathname.toLowerCase();
	if (path.endsWith(".js")) return ct.includes("javascript");
	if (path.endsWith(".css")) return ct.includes("css");
	if (path.endsWith(".svg")) return ct.includes("svg");
	if (path.endsWith(".webmanifest")) return ct.includes("json");
	return true;
}

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (!isCachable(request)) {
		return;
	}

	const requestUrl = new URL(request.url);

	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const copy = response.clone();
					caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
					return response;
				})
				.catch(() => caches.match(request).then((cached) => cached || caches.match(SCOPE) || Response.error())),
		);
		return;
	}

	const path = appPath(requestUrl.pathname);
	const isStatic =
		path !== null &&
		(path.startsWith("/assets/") ||
			path.startsWith("/icons/") ||
			path === "/favicon.svg" ||
			path === "/icon.ico" ||
			path === "/manifest.webmanifest");

	if (isStatic) {
		event.respondWith(
			caches.match(request).then((cached) => {
				if (cached) return cached;
				return fetch(request)
					.then((response) => {
						if (response && response.ok && assetContentOk(requestUrl, response)) {
							const copy = response.clone();
							caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
						}
						return response;
					})
					.catch(() => caches.match(request).then((fallback) => fallback || Response.error()));
			}),
		);
	}
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const fallback = new URL(SCOPE, self.location.origin).href;
	let target = fallback;
	try {
		const url = new URL(event.notification.data?.url || fallback);
		if (url.origin === self.location.origin && appPath(url.pathname) !== null) target = url.href;
	} catch {}

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clients) => {
				const inScope = clients.filter((client) => {
					const url = new URL(client.url);
					return url.origin === self.location.origin && appPath(url.pathname) !== null;
				});
				const match = inScope.find((client) => client.url === target) || inScope[0];
				if (match) {
					match.postMessage({ type: "pi-web-ui:notification-click", url: target });
					return match.focus ? match.focus().catch(() => match) : match;
				}
				return self.clients.openWindow(target);
			})
			.catch(() => undefined),
	);
});
