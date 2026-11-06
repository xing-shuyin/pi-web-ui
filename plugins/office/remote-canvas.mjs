import { randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

const SYNTHETIC_ORIGIN = "https://office-canvas.invalid";
const MiB = 1024 * 1024;
const DEFAULTS = Object.freeze({
	maxRequestBytes: 6 * MiB,
	maxResponseBytes: 16 * MiB,
	maxUploadBytes: 32 * MiB,
	maxTotalRequestBytes: 64 * MiB,
	maxSocketBytes: MiB,
	maxQueueBytes: 4 * MiB,
	maxQueueEvents: 256,
	maxSockets: 8,
	maxConcurrent: 32,
	requestTimeoutMs: 30_000,
	pollTimeoutMs: 20_000,
});
const bundleCache = new Map();

function fail(message) {
	throw new Error(`Office canvas: ${message}`);
}
function documentKey(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/u.test(value)) fail("invalid document key");
	const decoded = Buffer.from(value, "base64url");
	if (decoded.toString("base64url") !== value || decoded.includes(0)) fail("invalid document key");
	return value;
}
function loopbackOrigin(value) {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		fail("gateway must be a literal loopback HTTP origin");
	return url.origin;
}
function scopedPath(value, key, socket = false) {
	if (
		typeof value !== "string" ||
		value.length > 16_384 ||
		!value.startsWith("/") ||
		value.startsWith("//") ||
		/[\\\s#\u0000-\u001f\u007f]/u.test(value)
	)
		fail("invalid document path");
	const raw = value.split("?", 1)[0];
	const parts = raw.split("/").slice(1);
	for (const part of parts) {
		let decoded;
		try {
			decoded = decodeURIComponent(part);
		} catch {
			fail("invalid path encoding");
		}
		if (!decoded || decoded === "." || decoded === ".." || /[%/\\\u0000-\u001f\u007f]/u.test(decoded))
			fail("document path escape");
	}
	if (parts[0] !== "uf" || parts[1] !== key) fail("document scope mismatch");
	let tail = parts.slice(2);
	if (tail[0] === "worktrees") {
		if (tail.length === 1 && !socket) return value;
		if (!/^[A-Za-z0-9_-]{1,256}$/u.test(tail[1] || "")) fail("invalid worktree");
		tail = tail.slice(2);
		if (
			!socket &&
			(tail.length === 0 || (tail.length === 1 && ["ready", "reopen", "discard", "merge", "units"].includes(tail[0])))
		)
			return value;
	}
	if (!socket && tail.length === 0) return value;
	if (socket) {
		if (tail.join("/") !== "events" && tail.join("/") !== "universer-api/comb/connect") fail("socket route denied");
	} else if (
		!(tail.length === 1 && tail[0] === "units") &&
		!(
			tail[0] === "universer-api" &&
			["authz", "snapshot", "history", "comb", "user", "stream", "file", "exchange", "frontend"].includes(tail[1])
		)
	) {
		fail("document route denied");
	}
	return value;
}
function bytesFromBase64(value, max) {
	if (
		typeof value !== "string" ||
		value.length > Math.ceil(max / 3) * 4 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
	)
		fail("invalid or oversized base64 payload");
	const bytes = Buffer.from(value, "base64");
	if (bytes.length > max) fail("payload limit exceeded");
	return bytes;
}
function checkSignal(signal) {
	if (signal?.aborted) throw signal.reason || new Error("Office canvas disposed");
}
function boundedLimits(overrides = {}) {
	const result = { ...DEFAULTS };
	for (const [key, value] of Object.entries(overrides)) {
		if (!(key in DEFAULTS) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULTS[key])
			fail("invalid transport limit");
		result[key] = value;
	}
	return result;
}

/**
 * @typedef {{status:number,statusText:string,headers:Record<string,string>,body:string}} CanvasFetchResult
 * @typedef {{type:string,data?:string,binary?:boolean,code?:number,reason?:string}} CanvasSocketEvent
 * @typedef {{id?:number,op:string,path?:string,method?:string,headers?:Record<string,string>,body?:string,socketId?:string,data?:{type:string,data:string},code?:number,reason?:string}} CanvasMessage
 * @typedef {{signal?:AbortSignal}} CanvasRequestOptions
 * @typedef {((message:CanvasMessage & {op:'fetch'},options?:CanvasRequestOptions)=>Promise<CanvasFetchResult>) & ((message:CanvasMessage & {op:'ws-open'},options?:CanvasRequestOptions)=>Promise<{socketId:string}>) & ((message:CanvasMessage & {op:'ws-poll'},options?:CanvasRequestOptions)=>Promise<{events:CanvasSocketEvent[]}>) & ((message:CanvasMessage,options?:CanvasRequestOptions)=>Promise<any>)} CanvasRequest
 */
/**
 * A capability bound to ONE document and a pinned gateway. Dispose on token expiry.
 * @param {{gatewayOrigin:string,fileKey:string,fetchImpl?:typeof fetch,WebSocketImpl?:new (...args:any[])=>any,signal?:AbortSignal,limits?:Partial<typeof DEFAULTS> & {maxBodyBytes?:number}}} options
 * @returns {{request:CanvasRequest,dispose:()=>void}}
 */
export function createCanvasTransport({
	gatewayOrigin,
	fileKey,
	fetchImpl = globalThis.fetch,
	WebSocketImpl,
	signal,
	limits: overrides,
}) {
	const origin = loopbackOrigin(gatewayOrigin);
	const key = documentKey(fileKey);
	const normalizedLimits = overrides
		? { ...overrides, ...("maxBodyBytes" in overrides ? { maxRequestBytes: overrides.maxBodyBytes } : {}) }
		: undefined;
	if (normalizedLimits) delete normalizedLimits.maxBodyBytes;
	const limits = boundedLimits(normalizedLimits);
	const lifetime = new AbortController();
	const sockets = new Map();
	let concurrent = 0;
	let uploadedBytes = 0;
	let totalRequestBytes = 0;
	function dispose() {
		if (lifetime.signal.aborted) return;
		lifetime.abort(new Error("Office canvas disposed"));
		signal?.removeEventListener("abort", dispose);
		for (const entry of sockets.values()) {
			entry.wake?.();
			try {
				entry.ws.terminate?.();
			} catch {}
			try {
				entry.ws.close?.();
			} catch {}
		}
		sockets.clear();
	}
	signal?.addEventListener("abort", dispose, { once: true });
	if (signal?.aborted) dispose();
	function entryFor(id) {
		if (typeof id !== "string" || !sockets.has(id)) fail("unknown socket");
		return sockets.get(id);
	}
	function enqueue(entry, event) {
		if (lifetime.signal.aborted || entry.overflow) return;
		const size = Buffer.byteLength(JSON.stringify(event));
		if (
			size > Math.ceil(limits.maxSocketBytes / 3) * 4 + 1024 ||
			entry.bytes + size > limits.maxQueueBytes ||
			entry.queue.length >= limits.maxQueueEvents
		) {
			entry.overflow = true;
			entry.queue = [{ type: "close", code: 1009, reason: "Office canvas socket queue exceeded" }];
			entry.bytes = 128;
			entry.ws.terminate?.();
		} else {
			entry.queue.push(event);
			entry.bytes += size;
		}
		entry.wake?.();
	}
	async function fetchDocument(message, requestSignal) {
		const path = scopedPath(message.path, key);
		const method = message.method || "GET";
		if (path.split("?", 1)[0] === `/uf/${key}` && !["GET", "HEAD"].includes(method)) fail("document creation denied");
		if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) fail("HTTP method denied");
		const headers = new Headers();
		if (
			message.headers !== undefined &&
			(!message.headers || typeof message.headers !== "object" || Array.isArray(message.headers))
		)
			fail("invalid headers");
		for (const [name, value] of Object.entries(message.headers || {})) {
			if (
				!["accept", "content-type", "x-user-id", "range"].includes(name.toLowerCase()) ||
				typeof value !== "string" ||
				value.length > 4096 ||
				/[\r\n]/u.test(value)
			)
				fail("header denied");
			headers.set(name, value);
		}
		const body = message.body === undefined ? undefined : bytesFromBase64(message.body, limits.maxRequestBytes);
		if (body && ["GET", "HEAD"].includes(method)) fail("HTTP body denied");
		const bodyBytes = body?.byteLength || 0;
		const isUpload = /\/universer-api\/stream\/file\/upload(?:\?|$)/u.test(path);
		if (totalRequestBytes + bodyBytes > limits.maxTotalRequestBytes) fail("session request byte quota exceeded");
		if (isUpload && uploadedBytes + bodyBytes > limits.maxUploadBytes) fail("session upload byte quota exceeded");
		totalRequestBytes += bodyBytes;
		if (isUpload) uploadedBytes += bodyBytes;
		const response = await fetchImpl(origin + path, {
			method,
			headers,
			body,
			redirect: "error",
			credentials: "omit",
			signal: requestSignal,
		});
		checkSignal(requestSignal);
		if (response.status >= 300 && response.status < 400) fail("upstream redirect denied");
		const declared = Number(response.headers.get("content-length"));
		if (declared > limits.maxResponseBytes) {
			await response.body?.cancel();
			fail("response limit exceeded");
		}
		const chunks = [];
		let length = 0;
		if (response.body) {
			const reader = response.body.getReader();
			const abortRead = () => {
				void reader.cancel(requestSignal.reason).catch(() => {});
			};
			requestSignal.addEventListener("abort", abortRead, { once: true });
			try {
				while (true) {
					checkSignal(requestSignal);
					const { value, done } = await reader.read();
					if (done) break;
					length += value.byteLength;
					if (length > limits.maxResponseBytes) fail("response limit exceeded");
					chunks.push(Buffer.from(value));
				}
			} catch (error) {
				await reader.cancel().catch(() => {});
				throw error;
			} finally {
				requestSignal.removeEventListener("abort", abortRead);
				reader.releaseLock();
			}
		}
		checkSignal(requestSignal);
		let bytes = Buffer.concat(chunks, length);
		const contentType = response.headers.get("content-type") || "application/octet-stream";
		if (contentType.includes("json") && /\/file\/[^/]+\/sign-url(?:\?|$)/u.test(path)) {
			const payload = JSON.parse(bytes.toString("utf8"));
			if (typeof payload.url === "string") {
				const asset = new URL(payload.url, origin);
				if (asset.origin !== origin) fail("asset origin denied");
				scopedPath(asset.pathname + asset.search, key);
				payload.url = SYNTHETIC_ORIGIN + asset.pathname + asset.search;
			}
			bytes = Buffer.from(JSON.stringify(payload));
		}
		const safeHeaders = {};
		for (const name of ["content-type", "content-disposition", "content-range", "accept-ranges", "etag"]) {
			const value = response.headers.get(name);
			if (value) safeHeaders[name] = value;
		}
		return {
			status: response.status,
			statusText: response.statusText,
			headers: safeHeaders,
			body: bytes.toString("base64"),
		};
	}
	async function request(message, { signal: externalSignal } = {}) {
		checkSignal(lifetime.signal);
		checkSignal(externalSignal);
		if (!message || typeof message !== "object" || Array.isArray(message)) fail("invalid message");
		if (concurrent >= limits.maxConcurrent) fail("too many requests");
		concurrent++;
		const deadline = AbortSignal.timeout(limits.requestTimeoutMs);
		const requestSignal = AbortSignal.any([lifetime.signal, deadline, ...(externalSignal ? [externalSignal] : [])]);
		try {
			switch (message.op) {
				case "fetch":
					return await fetchDocument(message, requestSignal);
				case "ws-open": {
					const path = scopedPath(message.path, key, true);
					if (sockets.size >= limits.maxSockets) fail("socket limit exceeded");
					const id = randomBytes(18).toString("base64url");
					const SocketImpl = WebSocketImpl || (await import("ws")).WebSocket;
					checkSignal(requestSignal);
					if (sockets.size >= limits.maxSockets) fail("socket limit exceeded");
					const ws = new SocketImpl(origin.replace(/^http/u, "ws") + path, {
						maxPayload: limits.maxSocketBytes,
						followRedirects: false,
						handshakeTimeout: limits.requestTimeoutMs,
					});
					const entry = { ws, queue: [], bytes: 0, wake: null, polling: false, overflow: false };
					sockets.set(id, entry);
					ws.on("open", () => enqueue(entry, { type: "open" }));
					ws.on("message", (data, binary) => {
						const bytes = Buffer.from(data);
						if (bytes.length > limits.maxSocketBytes) {
							enqueue(entry, { type: "close", code: 1009, reason: "Frame too large" });
							ws.terminate();
							return;
						}
						enqueue(entry, {
							type: "message",
							binary: !!binary,
							data: binary ? bytes.toString("base64") : bytes.toString("utf8"),
						});
					});
					ws.on("error", () => enqueue(entry, { type: "error" }));
					ws.on("close", (code, reason) =>
						enqueue(entry, {
							type: "close",
							code,
							reason: Buffer.from(reason || "")
								.toString("utf8")
								.slice(0, 123),
						}),
					);
					return { socketId: id };
				}
				case "ws-send": {
					const entry = entryFor(message.socketId);
					const data = message.data;
					if (!data || !["text", "binary"].includes(data.type) || typeof data.data !== "string")
						fail("invalid socket data");
					const bytes =
						data.type === "binary" ? bytesFromBase64(data.data, limits.maxSocketBytes) : Buffer.from(data.data);
					if (bytes.length > limits.maxSocketBytes || entry.ws.bufferedAmount > limits.maxQueueBytes)
						fail("socket send limit exceeded");
					if (entry.ws.readyState !== 1) fail("socket not open");
					if (totalRequestBytes + bytes.byteLength > limits.maxTotalRequestBytes)
						fail("session request byte quota exceeded");
					totalRequestBytes += bytes.byteLength;
					await new Promise((done, reject) => {
						const abort = () => {
							requestSignal.removeEventListener("abort", abort);
							reject(requestSignal.reason);
						};
						requestSignal.addEventListener("abort", abort, { once: true });
						if (requestSignal.aborted) {
							abort();
							return;
						}
						try {
							entry.ws.send(bytes, { binary: data.type === "binary" }, (error) => {
								requestSignal.removeEventListener("abort", abort);
								if (error) reject(error);
								else done();
							});
						} catch (error) {
							requestSignal.removeEventListener("abort", abort);
							reject(error);
						}
					});
					return {};
				}
				case "ws-poll": {
					const entry = entryFor(message.socketId);
					if (entry.polling) fail("socket already polling");
					entry.polling = true;
					try {
						if (!entry.queue.length)
							await new Promise((done, reject) => {
								let timer;
								const finish = () => {
									clearTimeout(timer);
									requestSignal.removeEventListener("abort", abort);
									entry.wake = null;
									done();
								};
								const abort = () => {
									finish();
									reject(requestSignal.reason);
								};
								entry.wake = finish;
								timer = setTimeout(finish, limits.pollTimeoutMs);
								requestSignal.addEventListener("abort", abort, { once: true });
								if (requestSignal.aborted) abort();
							});
						checkSignal(requestSignal);
						const events = entry.queue.splice(0);
						entry.bytes = 0;
						if (events.some((event) => event.type === "close")) sockets.delete(message.socketId);
						return { events };
					} finally {
						entry.polling = false;
					}
				}
				case "ws-close": {
					const entry = entryFor(message.socketId);
					const code = message.code ?? 1000;
					const reason = message.reason ?? "";
					if (
						!(code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999)) ||
						typeof reason !== "string" ||
						Buffer.byteLength(reason) > 123
					)
						fail("invalid close frame");
					entry.ws.close(code, reason);
					return {};
				}
				default:
					fail("unknown transport operation");
			}
		} finally {
			concurrent--;
		}
	}
	return { request, dispose };
}

async function localFile(root, file) {
	const actual = await realpath(file);
	const rel = relative(root, actual);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail("bundle resource escaped viewer root");
	return actual;
}
async function viewerBundle(viewerRoot) {
	const root = await realpath(viewerRoot);
	const html = await readFile(resolve(root, "index.html"), "utf8");
	const entryName = html.match(/<script\b[^>]*\bsrc=["']([^"']+)["']/iu)?.[1];
	if (!entryName || !/^\/univer-viewer\/assets\/[A-Za-z0-9_.-]+\.js$/u.test(entryName))
		fail("unsupported viewer entry");
	const entry = await localFile(root, resolve(root, entryName.replace(/^\/univer-viewer\//u, "")));
	const stamp = await stat(entry);
	const cacheKey = `${root}:${stamp.size}:${stamp.mtimeMs}`;
	if (bundleCache.has(cacheKey)) return bundleCache.get(cacheKey);
	const pending = (async () => {
		const { build } = await import("esbuild");
		const result = await build({
			entryPoints: [entry],
			bundle: true,
			splitting: false,
			platform: "browser",
			format: "iife",
			target: "es2022",
			write: false,
			minify: true,
			legalComments: "none",
			logLevel: "silent",
			define: {
				"import.meta.url": JSON.stringify(`${SYNTHETIC_ORIGIN}/univer-viewer/assets/index.js`),
				"import.meta.resolve": "undefined",
				window: "globalThis.__officeCanvasWindow",
				location: "globalThis.__officeCanvasLocation",
			},
			plugins: [
				{
					name: "office-opaque-viewer",
					setup(builder) {
						builder.onLoad({ filter: /\.js$/ }, async (args) => {
							const file = await localFile(root, args.path);
							let source = await readFile(file, "utf8");
							if (source.includes("vite:preloadError")) {
								const before = source;
								source = source.replace(
									/if\(([A-Za-z_$][\w$]*)&&\1\.length>0\)(?=\{let [A-Za-z_$][\w$]*=document\.getElementsByTagName\([`"']link[`"']\))/u,
									"if(false)",
								);
								if (source === before) fail("unsupported viewer preload runtime");
							}
							source = source.replace(
								/\b(?:(?:window|globalThis|document)\.)?location\.(origin|href|search|pathname|protocol|host|hostname|port)\b/gu,
								"globalThis.__officeCanvasLocation.$1",
							);
							if (file === entry) {
								const ready = ".start().catch(e=>{";
								const index = source.lastIndexOf(ready);
								if (index < 0) fail("unsupported viewer application bootstrap");
								source =
									source.slice(0, index) +
									source
										.slice(index)
										.replace(
											ready,
											".start().then(()=>globalThis.__officeCanvasReady()).catch(e=>{globalThis.__officeCanvasError(e);",
										);
							}
							return { contents: source, loader: "js", resolveDir: dirname(file) };
						});
					},
				},
			],
		});
		const cssFiles = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/giu)].map(
			(match) => match[1],
		);
		let css = "";
		for (const name of cssFiles) {
			if (!/^\/univer-viewer\/assets\/[A-Za-z0-9_.-]+\.css$/u.test(name)) fail("unsupported stylesheet");
			css += (
				await readFile(await localFile(root, resolve(root, name.replace(/^\/univer-viewer\//u, ""))), "utf8")
			).replace(/\/\*[\s\S]*?\*\//gu, "");
		}
		const urls = [...css.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/giu)];
		for (const [full, url] of urls) {
			if (url.startsWith("data:") || url.startsWith("#")) continue;
			if (/^(?:[a-z]+:|\/\/)/iu.test(url)) {
				css = css.replaceAll(full, "url(data:,)");
				continue;
			}
			if (url.includes("?")) fail("unsupported stylesheet resource");
			const file = await localFile(
				root,
				url.startsWith("/univer-viewer/") ? resolve(root, url.slice(15)) : resolve(root, "assets", url),
			);
			const mime = { ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".svg": "image/svg+xml" }[
				extname(file)
			];
			if (!mime) fail("unsupported stylesheet asset");
			css = css.replaceAll(full, `url(data:${mime};base64,${(await readFile(file)).toString("base64")})`);
		}
		return { js: result.outputFiles[0].text, css };
	})();
	bundleCache.set(cacheKey, pending);
	if (bundleCache.size > 2) bundleCache.delete(bundleCache.keys().next().value);
	try {
		return await pending;
	} catch (error) {
		bundleCache.delete(cacheKey);
		throw error;
	}
}

/**
 * Fully self-contained opaque-origin viewer, with no gateway address or parent token.
 * @param {{viewerRoot:string,fileKey:string,unitId?:string,lang?:string,editable?:boolean}} options
 * @returns {Promise<{srcdoc:string,channel:string,sandbox:string}>}
 */
export async function buildRemoteCanvas({ viewerRoot, fileKey, unitId, lang = "en-US", editable = true }) {
	const key = documentKey(fileKey);
	if (unitId !== undefined && (typeof unitId !== "string" || !unitId || unitId.length > 256)) fail("invalid unit ID");
	if (typeof lang !== "string" || !/^[A-Za-z-]{2,16}$/u.test(lang)) fail("invalid language");
	await import("ws");
	const { js, css } = await viewerBundle(viewerRoot);
	const channel = randomBytes(24).toString("base64url");
	const nonce = randomBytes(24).toString("base64url");
	const query = new URLSearchParams({ file: key, lang, editable: String(editable), mode: "embedded", scope: "trunk" });
	if (unitId) query.set("unit", unitId);
	const config = {
		channel,
		origin: SYNTHETIC_ORIGIN,
		key,
		filePath: Buffer.from(key, "base64url").toString("utf8"),
		href: `${SYNTHETIC_ORIGIN}/canvas?${query}`,
		maxBody: DEFAULTS.maxRequestBytes,
	};
	const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
	const script = `(${canvasBootstrap.toString()})(${JSON.stringify(config)});\n${js}`.replace(
		/<\/script/giu,
		"<\\/script",
	);
	const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.replace(/<\/style/giu, "<\\/style")}</style></head><body><div id="app"></div><script nonce="${nonce}">${script}</script></body></html>`;
	return { srcdoc, channel, sandbox: "allow-scripts allow-downloads" };
}

// Serialized into srcdoc. Keep this function closed over config and browser globals only.
function canvasBootstrap(config) {
	const synthetic = new URL(config.href);
	globalThis.__officeCanvasLocation = synthetic;
	const windowMethods = new Map();
	globalThis.__officeCanvasWindow = new Proxy(window, {
		get(target, property) {
			if (property === "location") return synthetic;
			if (property === "window" || property === "self") return globalThis.__officeCanvasWindow;
			const value = Reflect.get(target, property, target);
			if (typeof value === "function" && /^[a-z]/u.test(String(property))) {
				if (!windowMethods.has(property)) windowMethods.set(property, value.bind(target));
				return windowMethods.get(property);
			}
			return value;
		},
		set(target, property, value) {
			if (property === "location") throw new Error("Navigation denied");
			return Reflect.set(target, property, value, target);
		},
	});
	Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
	for (const name of ["localStorage", "sessionStorage"]) {
		const values = new Map();
		let bytes = 0;
		const memory = {
			get length() {
				return values.size;
			},
			key(index) {
				return [...values.keys()][index] ?? null;
			},
			getItem(key) {
				return values.get(String(key)) ?? null;
			},
			setItem(key, value) {
				key = String(key);
				value = String(value);
				const next = bytes - (values.has(key) ? key.length + values.get(key).length : 0) + key.length + value.length;
				if (next > 4 * 1024 * 1024) throw new DOMException("Memory storage full", "QuotaExceededError");
				values.set(key, value);
				bytes = next;
			},
			removeItem(key) {
				key = String(key);
				if (values.has(key)) {
					bytes -= key.length + values.get(key).length;
					values.delete(key);
				}
			},
			clear() {
				values.clear();
				bytes = 0;
			},
		};
		Object.defineProperty(globalThis, name, { configurable: true, value: memory });
	}
	history.replaceState = (_state, _title, url) => {
		if (url !== undefined) {
			const next = new URL(url, synthetic);
			if (next.origin !== config.origin) throw new Error("History URL denied");
			synthetic.href = next.href;
		}
	};
	const requests = new Map();
	const sockets = new Set();
	const blobs = new Set();
	let port,
		sequence = 0,
		stopped = false,
		appReady = false,
		appError;
	let resolvePort;
	const connected = new Promise((resolve) => {
		resolvePort = resolve;
	});
	const encode = (bytes) => {
		let text = "";
		for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
		return btoa(text);
	};
	const decode = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
	function scoped(input) {
		const url = new URL(input, synthetic);
		if (
			![config.origin, config.origin.replace("https:", "wss:")].includes(url.origin) ||
			!(url.pathname === `/uf/${config.key}` || url.pathname.startsWith(`/uf/${config.key}/`)) ||
			url.username ||
			url.password ||
			url.hash
		)
			throw new Error("Office canvas URL denied");
		return url.pathname + url.search;
	}
	async function rpc(message, signal) {
		if (stopped || signal?.aborted) throw new DOMException("Aborted", "AbortError");
		if (requests.size >= 32) throw new Error("Office canvas request limit");
		await connected;
		if (stopped || signal?.aborted) throw new DOMException("Aborted", "AbortError");
		if (requests.size >= 32) throw new Error("Office canvas request limit");
		return new Promise((resolve, reject) => {
			const id = ++sequence;
			const cancel = () => {
				port.postMessage({ type: "office-canvas-cancel", id });
				finish(new DOMException("Aborted", "AbortError"));
			};
			const timer = setTimeout(() => {
				port.postMessage({ type: "office-canvas-cancel", id });
				finish(new Error("Office canvas request timed out"));
			}, 35_000);
			const finish = (error, result) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				requests.delete(id);
				if (error) reject(error);
				else resolve(result);
			};
			requests.set(id, finish);
			signal?.addEventListener("abort", cancel, { once: true });
			port.postMessage({ ...message, id });
		});
	}
	function connect(event) {
		if (
			event.source !== parent ||
			event.data?.type !== "office-canvas-connect" ||
			event.data.channel !== config.channel ||
			event.ports.length !== 1 ||
			port
		)
			return;
		port = event.ports[0];
		port.onmessage = (event) => {
			if (event.data?.type === "office-canvas-dispose") {
				stop();
				return;
			}
			const { id, result, error } = event.data || {};
			requests.get(id)?.(error ? new Error(error) : null, result);
		};
		port.start();
		resolvePort();
		if (appReady) port.postMessage({ type: "office-canvas-app-ready" });
		if (appError) port.postMessage({ type: "office-canvas-error", error: appError });
	}
	addEventListener("message", connect);
	globalThis.__officeCanvasReady = () => {
		const ready = () => {
			if (!document.querySelector("#app canvas")) return false;
			appReady = true;
			port?.postMessage({ type: "office-canvas-app-ready" });
			return true;
		};
		if (ready()) return;
		const observer = new MutationObserver(() => {
			if (ready()) observer.disconnect();
		});
		observer.observe(document.getElementById("app"), { childList: true, subtree: true });
		setTimeout(() => {
			observer.disconnect();
			if (!appReady && !stopped) globalThis.__officeCanvasError("Editor canvas did not finish loading");
		}, 30_000);
	};
	globalThis.__officeCanvasError = (error) => {
		appError = String(error).slice(0, 1000);
		port?.postMessage({ type: "office-canvas-error", error: appError });
	};
	addEventListener("error", (event) => {
		if (!appReady) globalThis.__officeCanvasError(event.message || "Viewer failed");
	});
	addEventListener("unhandledrejection", (event) => {
		if (!appReady) globalThis.__officeCanvasError(event.reason || "Viewer failed");
	});
	parent.postMessage({ type: "office-canvas-ready", channel: config.channel }, "*");
	globalThis.fetch = async (input, init = {}) => {
		const path = scoped(input instanceof Request ? input.url : String(input));
		const request = new Request(new URL(path, config.origin), {
			...(input instanceof Request
				? {
						method: input.method,
						headers: input.headers,
						body: ["GET", "HEAD"].includes(input.method) ? undefined : await input.arrayBuffer(),
						signal: input.signal,
					}
				: {}),
			...init,
			credentials: "omit",
		});
		const headers = {};
		for (const [name, value] of request.headers) {
			if (["accept", "content-type", "x-user-id", "range"].includes(name)) headers[name] = value;
		}
		const body = ["GET", "HEAD"].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer());
		if (body?.byteLength > config.maxBody) throw new Error("Office canvas request body exceeds 6 MiB");
		const result = await rpc(
			{ op: "fetch", path, method: request.method, headers, ...(body ? { body: encode(body) } : {}) },
			request.signal,
		);
		return new Response(
			[204, 205, 304].includes(result.status) || request.method === "HEAD" ? null : decode(result.body),
			{ status: result.status, statusText: result.statusText, headers: result.headers },
		);
	};
	class CanvasXHR extends EventTarget {
		readyState = 0;
		status = 0;
		statusText = "";
		response = null;
		responseText = "";
		responseType = "";
		responseURL = "";
		timeout = 0;
		withCredentials = false;
		upload = new EventTarget();
		constructor() {
			super();
			this.headers = new Headers();
			this.controller = new AbortController();
		}
		emit(type, event = new Event(type)) {
			this.dispatchEvent(event);
			this[`on${type}`]?.(event);
		}
		state(value) {
			this.readyState = value;
			this.emit("readystatechange");
		}
		open(method, url, async = true, username, password) {
			if (!async || username || password) throw new Error("XHR mode denied");
			this.method = method;
			this.url = String(url);
			scoped(this.url);
			this.state(1);
		}
		setRequestHeader(name, value) {
			this.headers.append(name, value);
		}
		getResponseHeader(name) {
			return this.responseHeaders?.get(name) ?? null;
		}
		getAllResponseHeaders() {
			return [...(this.responseHeaders || [])].map(([name, value]) => `${name}: ${value}\r\n`).join("");
		}
		overrideMimeType(value) {
			this.mimeType = value;
		}
		abort() {
			this.controller.abort();
			this.state(0);
		}
		send(body = null) {
			let timer;
			if (this.timeout > 0)
				timer = setTimeout(() => {
					this.timedOut = true;
					this.controller.abort();
				}, this.timeout);
			this.emit("loadstart");
			void (async () => {
				try {
					const response = await fetch(this.url, {
						method: this.method,
						headers: this.headers,
						body,
						signal: this.controller.signal,
					});
					this.status = response.status;
					this.statusText = response.statusText;
					this.responseURL = this.url;
					this.responseHeaders = response.headers;
					this.state(2);
					const bytes = await response.arrayBuffer();
					this.state(3);
					this.responseText = new TextDecoder().decode(bytes);
					this.response =
						this.responseType === "arraybuffer"
							? bytes
							: this.responseType === "blob"
								? new Blob([bytes], { type: this.mimeType || response.headers.get("content-type") || "" })
								: this.responseType === "json"
									? JSON.parse(this.responseText)
									: this.responseText;
					this.emit(
						"progress",
						new ProgressEvent("progress", {
							lengthComputable: true,
							loaded: bytes.byteLength,
							total: bytes.byteLength,
						}),
					);
					this.state(4);
					this.emit("load");
				} catch {
					this.status = 0;
					this.state(4);
					this.emit(this.timedOut ? "timeout" : this.controller.signal.aborted ? "abort" : "error");
				} finally {
					clearTimeout(timer);
					this.emit("loadend");
				}
			})();
		}
	}
	Object.assign(CanvasXHR, { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 });
	Object.assign(CanvasXHR.prototype, { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 });
	globalThis.XMLHttpRequest = CanvasXHR;
	class CanvasSocket extends EventTarget {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		CONNECTING = 0;
		OPEN = 1;
		CLOSING = 2;
		CLOSED = 3;
		readyState = 0;
		bufferedAmount = 0;
		binaryType = "blob";
		extensions = "";
		protocol = "";
		constructor(url, protocols) {
			super();
			if (protocols && (typeof protocols === "string" || protocols.length)) throw new Error("Socket protocols denied");
			this.url = String(url);
			this.path = scoped(this.url);
			this.tail = Promise.resolve();
			sockets.add(this);
			this.run();
		}
		emit(type, init = {}) {
			const event =
				type === "message"
					? new MessageEvent(type, init)
					: type === "close"
						? new CloseEvent(type, init)
						: new Event(type);
			this.dispatchEvent(event);
			this[`on${type}`]?.(event);
		}
		async run() {
			try {
				this.socketId = (await rpc({ op: "ws-open", path: this.path })).socketId;
				if (this.readyState === 2)
					await rpc({ op: "ws-close", socketId: this.socketId, code: this.closeCode, reason: this.closeReason });
				while (!stopped && this.readyState !== 3) {
					const { events } = await rpc({ op: "ws-poll", socketId: this.socketId });
					for (const event of events) {
						if (event.type === "open") {
							if (this.readyState === 0) {
								this.readyState = 1;
								this.emit("open");
							}
						} else if (event.type === "message") {
							const data = event.binary ? decode(event.data) : event.data;
							this.emit("message", {
								data: event.binary ? (this.binaryType === "arraybuffer" ? data.buffer : new Blob([data])) : data,
							});
						} else if (event.type === "error") this.emit("error");
						else if (event.type === "close") {
							this.readyState = 3;
							sockets.delete(this);
							this.emit("close", { code: event.code, reason: event.reason, wasClean: event.code === 1000 });
						}
					}
				}
			} catch {
				if (this.readyState !== 3) {
					this.readyState = 3;
					sockets.delete(this);
					this.emit("error");
					this.emit("close", { code: 1006, wasClean: false });
				}
			}
		}
		send(value) {
			if (this.readyState !== 1) throw new DOMException("Socket not open", "InvalidStateError");
			const size =
				typeof value === "string"
					? new TextEncoder().encode(value).length
					: value instanceof Blob
						? value.size
						: value.byteLength;
			if (!Number.isFinite(size) || size > 1024 * 1024 || this.bufferedAmount + size > 4 * 1024 * 1024)
				throw new Error("Socket send limit");
			this.bufferedAmount += size;
			this.tail = this.tail
				.then(async () => {
					const data =
						typeof value === "string"
							? { type: "text", data: value }
							: {
									type: "binary",
									data: encode(
										new Uint8Array(
											value instanceof Blob
												? await value.arrayBuffer()
												: ArrayBuffer.isView(value)
													? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
													: value,
										),
									),
								};
					await rpc({ op: "ws-send", socketId: this.socketId, data });
				})
				.catch(() => this.emit("error"))
				.finally(() => {
					this.bufferedAmount -= size;
				});
		}
		close(code = 1000, reason = "") {
			if (
				!(code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999)) ||
				new TextEncoder().encode(reason).length > 123
			)
				throw new DOMException("Invalid close", "InvalidAccessError");
			if (this.readyState >= 2) return;
			this.readyState = 2;
			this.closeCode = code;
			this.closeReason = reason;
			if (this.socketId)
				this.tail.then(() => rpc({ op: "ws-close", socketId: this.socketId, code, reason })).catch(() => {});
		}
	}
	globalThis.WebSocket = CanvasSocket;
	const nativeSet = Element.prototype.setAttribute;
	const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
	async function image(element, value) {
		try {
			const path = scoped(value);
			const response = await fetch(config.origin + path);
			if (!response.ok) throw new Error("Asset failed");
			const url = URL.createObjectURL(await response.blob());
			if (stopped) {
				URL.revokeObjectURL(url);
				return;
			}
			blobs.add(url);
			nativeSet.call(element, "src", url);
		} catch {
			nativeSet.call(element, "src", "data:,");
		}
	}
	Object.defineProperty(HTMLImageElement.prototype, "src", {
		...imageSrc,
		set(value) {
			if (/^(?:data:|blob:)/u.test(String(value))) imageSrc.set.call(this, value);
			else void image(this, String(value));
		},
	});
	Element.prototype.setAttribute = function (name, value) {
		if (this instanceof HTMLImageElement && name.toLowerCase() === "src" && !/^(?:data:|blob:)/u.test(String(value))) {
			void image(this, String(value));
			return;
		}
		return nativeSet.call(this, name, value);
	};
	function stop() {
		if (stopped) return;
		stopped = true;
		for (const finish of requests.values()) finish(new DOMException("Disposed", "AbortError"));
		for (const socket of sockets) socket.readyState = 3;
		sockets.clear();
		for (const url of blobs) URL.revokeObjectURL(url);
		blobs.clear();
		port?.close();
		removeEventListener("message", connect);
	}
	addEventListener("pagehide", stop, { once: true });
}
