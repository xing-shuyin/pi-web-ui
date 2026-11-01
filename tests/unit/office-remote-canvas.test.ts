// @vitest-environment jsdom
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvasTransport, buildRemoteCanvas } from "../../plugins/office/remote-canvas.mjs";
import { attachCanvasBroker } from "../../plugins/office/client/canvas-broker.mjs";

const key = Buffer.from("C:/workspace/book.univer").toString("base64url");
const base = `/uf/${key}`;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
function transport(options: Record<string, unknown> = {}) {
	const value = createCanvasTransport({ gatewayOrigin: "http://127.0.0.1:9421", fileKey: key, ...options });
	cleanups.push(value.dispose);
	return value;
}
class Socket extends EventEmitter {
	static instances: Socket[] = [];
	readyState = 1;
	bufferedAmount = 0;
	url: string;
	options: unknown;
	send = vi.fn((_data, _options, done) => done());
	close = vi.fn(() => {
		this.readyState = 3;
	});
	terminate = vi.fn(() => {
		this.readyState = 3;
	});
	constructor(url: string, options: unknown) {
		super();
		this.url = url;
		this.options = options;
		Socket.instances.push(this);
	}
}
const response = (bytes: string, headers: Record<string, string> = {}) => new Response(bytes, { headers });

describe("document-scoped Office canvas server transport", () => {
	it.each([
		"http://localhost:9421",
		"https://127.0.0.1:9421",
		"http://127.0.0.1.evil.test",
		"http://127.0.0.1:9421/private",
		"http://user:secret@127.0.0.1:9421",
		"http://192.168.1.1:9421",
	])("rejects unpinned gateway %s", (gatewayOrigin) => {
		expect(() => transport({ gatewayOrigin })).toThrow();
	});
	it.each([
		`/uf/another/units`,
		`${base}/../other/units`,
		`${base}/%2e%2e/units`,
		`${base}/%252e%252e/units`,
		`${base}/universer-api/%2fother`,
		`${base}//units`,
		`${base}/universer-api/hi\\there`,
		`//evil.test${base}/units`,
		`${base}/universer-api/a#bad`,
		`${base}/optimize`,
		`${base}/universer-api/%zz`,
	])("rejects scope/path escape %s before fetching", async (path) => {
		const fetchImpl = vi.fn();
		const session = transport({ fetchImpl });
		await expect(session.request({ op: "fetch", path })).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("forwards only allowed headers and bytes to its literal origin without credentials or redirects", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			response("hello", { "content-type": "text/plain", "set-cookie": "secret", location: "http://private" }),
		);
		const session = transport({ fetchImpl });
		const result = await session.request({
			op: "fetch",
			path: `${base}/universer-api/snapshot/1`,
			method: "POST",
			headers: { "content-type": "application/json", "x-user-id": "editor" },
			body: Buffer.from("{}").toString("base64"),
		});
		expect(fetchImpl.mock.calls[0][0]).toBe(`http://127.0.0.1:9421${base}/universer-api/snapshot/1`);
		expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "error", credentials: "omit", method: "POST" });
		expect(Buffer.from(result.body, "base64").toString()).toBe("hello");
		expect(result.headers).toEqual({ "content-type": "text/plain" });
		await expect(
			session.request({ op: "fetch", path: `${base}/units`, headers: { authorization: "secret" } }),
		).rejects.toThrow("header denied");
		await expect(session.request({ op: "fetch", path: base, method: "POST" })).rejects.toThrow("creation denied");
	});
	it("rewrites document asset signed URLs to the synthetic origin and rejects foreign signed URLs", async () => {
		const fetchImpl = vi.fn(async () =>
			response(JSON.stringify({ url: `http://127.0.0.1:9421${base}/universer-api/file/image/content` }), {
				"content-type": "application/json",
			}),
		);
		const session = transport({ fetchImpl });
		const message = { op: "fetch", path: `${base}/universer-api/file/image/sign-url` };
		const result = await session.request(message);
		expect(JSON.parse(Buffer.from(result.body, "base64").toString()).url).toBe(
			`https://office-canvas.invalid${base}/universer-api/file/image/content`,
		);
		fetchImpl.mockImplementation(async () =>
			response('{"url":"http://evil.test/file"}', { "content-type": "application/json" }),
		);
		await expect(session.request(message)).rejects.toThrow("asset origin denied");
	});
	it("enforces request and streamed response bounds and refuses redirects", async () => {
		const fetchImpl = vi.fn(async () => response("12345"));
		const session = transport({ fetchImpl, limits: { maxRequestBytes: 4, maxResponseBytes: 4 } });
		await expect(
			session.request({
				op: "fetch",
				path: `${base}/universer-api/snapshot/1`,
				method: "POST",
				body: Buffer.from("12345").toString("base64"),
			}),
		).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
		await expect(session.request({ op: "fetch", path: `${base}/units` })).rejects.toThrow("response limit");
		fetchImpl.mockImplementation(async () => new Response(null, { status: 302 }));
		await expect(session.request({ op: "fetch", path: `${base}/units` })).rejects.toThrow("redirect denied");
	});
	it("cancels a stalled upstream response reader when the caller aborts", async () => {
		const cancelled = vi.fn();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("partial"));
			},
			cancel: cancelled,
		});
		const session = transport({ fetchImpl: async () => new Response(stream) });
		const controller = new AbortController();
		const pending = session.request({ op: "fetch", path: `${base}/units` }, { signal: controller.signal });
		await Promise.resolve();
		await Promise.resolve();
		controller.abort(new Error("caller left"));
		await expect(pending).rejects.toThrow("caller left");
		expect(cancelled).toHaveBeenCalled();
	});
	it("charges cumulative upload and request quotas before dispatch, including failed upstream requests", async () => {
		const fetchImpl = vi.fn(async () => response("ok"));
		const session = transport({ fetchImpl, limits: { maxUploadBytes: 6, maxTotalRequestBytes: 10 } });
		const upload = {
			op: "fetch",
			path: `${base}/universer-api/stream/file/upload?size=4`,
			method: "POST",
			body: Buffer.from("1234").toString("base64"),
		};
		await session.request(upload);
		await expect(session.request(upload)).rejects.toThrow("upload byte quota");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		fetchImpl.mockImplementation(async () => {
			throw new Error("upstream failed after commit");
		});
		await expect(session.request({ ...upload, path: `${base}/universer-api/snapshot/1` })).rejects.toThrow(
			"upstream failed",
		);
		await expect(session.request({ ...upload, path: `${base}/universer-api/snapshot/1` })).rejects.toThrow(
			"request byte quota",
		);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
	it("rejects malformed base64 and limits that raise the security ceiling", async () => {
		expect(() => transport({ limits: { maxRequestBytes: 7 * 1024 * 1024 } })).toThrow();
		await expect(
			transport().request({ op: "fetch", path: `${base}/universer-api/snapshot/1`, method: "POST", body: "!!!" }),
		).rejects.toThrow();
	});
	it("brokers socket text and binary frames using bounded long polling", async () => {
		const session = transport({ WebSocketImpl: Socket });
		const { socketId } = await session.request({
			op: "ws-open",
			path: `${base}/universer-api/comb/connect?unitID=one`,
		});
		const socket = Socket.instances.at(-1)!;
		expect(socket.url).toContain(`ws://127.0.0.1:9421${base}/`);
		expect(socket.options).toMatchObject({ followRedirects: false, maxPayload: 1024 * 1024 });
		const poll = session.request({ op: "ws-poll", socketId });
		socket.emit("open");
		expect(await poll).toEqual({ events: [{ type: "open" }] });
		socket.emit("message", Buffer.from([1, 2, 3]), true);
		socket.emit("message", Buffer.from("text"), false);
		expect(await session.request({ op: "ws-poll", socketId })).toEqual({
			events: [
				{ type: "message", binary: true, data: "AQID" },
				{ type: "message", binary: false, data: "text" },
			],
		});
		await session.request({ op: "ws-send", socketId, data: { type: "binary", data: "AQID" } });
		expect(socket.send.mock.calls[0][0]).toEqual(Buffer.from([1, 2, 3]));
		await expect(session.request({ op: "ws-open", path: `${base}/universer-api/snapshot` })).rejects.toThrow(
			"socket route denied",
		);
	});
	it("terminates overflowing queues and releases socket slots after close delivery", async () => {
		const session = transport({ WebSocketImpl: Socket, limits: { maxSockets: 1, maxQueueEvents: 1 } });
		const { socketId } = await session.request({ op: "ws-open", path: `${base}/events` });
		await expect(session.request({ op: "ws-open", path: `${base}/events` })).rejects.toThrow("socket limit");
		const socket = Socket.instances.at(-1)!;
		socket.emit("open");
		socket.emit("message", Buffer.from("two"), false);
		expect(socket.terminate).toHaveBeenCalled();
		expect((await session.request({ op: "ws-poll", socketId })).events[0]).toMatchObject({ type: "close", code: 1009 });
		await expect(session.request({ op: "ws-open", path: `${base}/events` })).resolves.toHaveProperty("socketId");
	});
	it("cancels polls, rejects duplicate polls and disposes all sockets", async () => {
		const lifetime = new AbortController();
		const session = transport({ WebSocketImpl: Socket, signal: lifetime.signal });
		const { socketId } = await session.request({ op: "ws-open", path: `${base}/events` });
		const abort = new AbortController();
		const poll = session.request({ op: "ws-poll", socketId }, { signal: abort.signal });
		await expect(session.request({ op: "ws-poll", socketId })).rejects.toThrow("already polling");
		abort.abort(new Error("cancelled"));
		await expect(poll).rejects.toThrow("cancelled");
		const disposedPoll = session.request({ op: "ws-poll", socketId });
		lifetime.abort();
		await expect(disposedPoll).rejects.toThrow("disposed");
		expect(Socket.instances.at(-1)!.terminate).toHaveBeenCalled();
		await expect(session.request({ op: "ws-poll", socketId })).rejects.toThrow("disposed");
	});
});

class Port {
	onmessage: ((event: { data: any }) => unknown) | null = null;
	messages: any[] = [];
	closed = false;
	postMessage(message: unknown) {
		this.messages.push(message);
	}
	start() {}
	close() {
		this.closed = true;
	}
	async receive(data: unknown) {
		await this.onmessage?.({ data });
	}
}
class Channel {
	static instances: Channel[] = [];
	port1 = new Port();
	port2 = new Port();
	constructor() {
		Channel.instances.push(this);
	}
}
function setupBroker(
	request: ReturnType<typeof vi.fn<(...args: any[]) => Promise<any>>> = vi.fn(async () => ({ status: 200 })),
) {
	vi.stubGlobal("MessageChannel", Channel);
	const iframe = document.createElement("iframe");
	document.body.append(iframe);
	const post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
	const onReady = vi.fn(),
		onError = vi.fn(),
		signal = new AbortController();
	const dispose = attachCanvasBroker({
		iframe,
		channel: "capability",
		request,
		onReady,
		onError,
		signal: signal.signal,
	});
	cleanups.push(() => {
		dispose();
		iframe.remove();
	});
	const ready = (overrides: Record<string, unknown> = {}) =>
		window.dispatchEvent(
			new MessageEvent("message", {
				source: iframe.contentWindow,
				origin: "null",
				data: { type: "office-canvas-ready", channel: "capability" },
				...overrides,
			}),
		);
	return { iframe, post, onReady, onError, request, ready, dispose, signal };
}
describe("opaque iframe parent broker", () => {
	it("requires matching source, null origin and channel; waits for app readiness", async () => {
		const broker = setupBroker();
		broker.ready({ origin: "https://parent.test" });
		broker.ready({ source: window });
		broker.ready({ data: { type: "office-canvas-ready", channel: "wrong" } });
		expect(broker.post).not.toHaveBeenCalled();
		broker.ready();
		expect(broker.post).toHaveBeenCalledWith({ type: "office-canvas-connect", channel: "capability" }, "*", [
			Channel.instances.at(-1)!.port2,
		]);
		expect(broker.onReady).not.toHaveBeenCalled();
		const port = Channel.instances.at(-1)!.port1;
		await port.receive({ type: "office-canvas-app-ready" });
		await port.receive({ type: "office-canvas-app-ready" });
		expect(broker.onReady).toHaveBeenCalledTimes(1);
		await port.receive({ type: "office-canvas-error", error: "failed" });
		expect(broker.onError.mock.calls[0][0].message).toBe("failed");
	});
	it("routes RPCs and cancels in-flight requests on re-handshake/disposal", async () => {
		let pendingSignal: AbortSignal | undefined;
		const request = vi.fn(async (_message, options) => {
			pendingSignal = options.signal;
			return { bytes: 2 };
		});
		const broker = setupBroker(request);
		broker.ready();
		const old = Channel.instances.at(-1)!.port1;
		await old.receive({ id: 1, op: "fetch", path: `${base}/units` });
		expect(old.messages).toContainEqual({ id: 1, result: { bytes: 2 } });
		request.mockImplementation((_message, options) => {
			pendingSignal = options.signal;
			return new Promise(() => {});
		});
		void old.receive({ id: 2, op: "ws-poll", socketId: "socket" });
		broker.ready();
		expect(pendingSignal!.aborted).toBe(true);
		expect(old.closed).toBe(true);
		const port = Channel.instances.at(-1)!.port1;
		void port.receive({ id: 3, op: "fetch" });
		await port.receive({ type: "office-canvas-cancel", id: 3 });
		expect(pendingSignal!.aborted).toBe(true);
		broker.signal.abort();
		expect(port.closed).toBe(true);
	});
	it("disposes even if detached-port postMessage throws", () => {
		const broker = setupBroker();
		broker.ready();
		const port = Channel.instances.at(-1)!.port1;
		vi.spyOn(port, "postMessage").mockImplementation(() => {
			throw new Error("detached");
		});
		expect(broker.dispose).not.toThrow();
		expect(port.closed).toBe(true);
	});
});

/**
 * 跑一次真正的 esbuild 打包，并把「只在 jsdom 下暴露」的坑挡在用例内。
 *
 * 两个已知的脆弱点（满负载下才现形，且现场容易误判成并发争用）：
 *  1. jsdom 的 `Uint8Array` 与 Node 的 `TextEncoder`/`Buffer` 不同 realm —— esbuild 的
 *     JS 协议层会做 `instanceof` 判断，必须临时换成 Node 的实现。旧实现用
 *     `vi.stubGlobal` 把整个文件的作用域都改了；这里只在一对 build 前后换，避免任何
 *     后续用例/同 worker 的其它路径读到 Node 的构造器。
 *  2. esbuild 首次 `build()` 需要拉起子进程（进程内单例）。在 4 worker 并发 + 其它用例
 *     同时 spawn server/PTY 的机器上，偶发 `spawn EAGAIN` / `EPERM` / `service was
 *     stopped` 这类**瞬态**启动失败。这类失败与打包结果无关，重试一次即可；真失败
 *     （例如插件规则不再匹配）第二次照样抛，并把 root 下的文件清单一起带出来便于定位。
 */
const TRANSIENT_BUNDLE_FAILURE = /spawn|EAGAIN|EPERM|EBUSY|EMFILE|ENFILE|service was stopped|socket hang up/i;

async function bundleInNodeRealm<T>(build: () => Promise<T>): Promise<T> {
	const nodeUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor;
	const restore = () => vi.stubGlobal("Uint8Array", nodeUint8Array);
	restore();
	try {
		try {
			return await build();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!TRANSIENT_BUNDLE_FAILURE.test(message)) throw error;
			// 瞬态启动失败：立刻重试一次（esbuild service 已在上一轮拉起，第二次不会再 spawn）
			return await build();
		}
	} finally {
		vi.unstubAllGlobals();
	}
}

describe("self-contained canvas bundling", () => {
	it("bundles dynamic imports, inline CSS and synthetic location without exposing parent credentials", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "office-canvas-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		await mkdir(resolve(root, "assets"));
		await writeFile(
			resolve(root, "index.html"),
			'<script type="module" src="/univer-viewer/assets/index.js"></script><link rel="stylesheet" href="/univer-viewer/assets/main.css">',
		);
		await writeFile(resolve(root, "assets/main.css"), "body{color:red}");
		await writeFile(resolve(root, "assets/lazy.js"), "export const value='LAZY_INCLUDED'");
		await writeFile(
			resolve(root, "assets/preload.js"),
			'export function other(t){if(t&&t.length>0){globalThis.kept=t.length}};export function preload(e,t){if(t&&t.length>0){let links=document.getElementsByTagName(`link`);globalThis.leakedPreloadLinks=links}return e()};globalThis.preloadError="vite:preloadError";',
		);
		await writeFile(
			resolve(root, "assets/index.js"),
			'import {other,preload} from "./preload.js";other([1]);globalThis.originTest=location.origin;globalThis.computedOrigin=window["loc"+"ation"]["ori"+"gin"];const app={start:async()=>{globalThis.lazy=await preload(()=>import("./lazy.js"),["assets/lazy.js"])}};app.start().catch(e=>{console.error(e)});',
		);
		const first = await bundleInNodeRealm(() => buildRemoteCanvas({ viewerRoot: root, fileKey: key, unitId: "unit1" }));
		const second = await bundleInNodeRealm(() => buildRemoteCanvas({ viewerRoot: root, fileKey: key }));
		expect(first.sandbox).toBe("allow-scripts allow-downloads");
		expect(first.srcdoc).toContain("LAZY_INCLUDED");
		expect(first.srcdoc).toContain("body{color:red}");
		expect(first.srcdoc).toContain("connect-src 'none'");
		expect(first.srcdoc).toContain("__officeCanvasLocation");
		expect(first.srcdoc).not.toContain("allow-same-origin");
		expect(first.srcdoc).not.toMatch(/\bimport\(/u);
		expect(first.srcdoc).not.toContain("127.0.0.1");
		expect(second.channel).not.toBe(first.channel);
		expect(first.srcdoc).toContain(`file=${key}`);
		expect(first.srcdoc).toContain("scope=trunk");
		expect(first.srcdoc).not.toContain("leakedPreloadLinks");
		expect(first.srcdoc).toContain("__officeCanvasWindow");
		expect(first.srcdoc).toContain("class CanvasXHR");
		expect(first.srcdoc).toContain('"indexedDB"');
	}, 30_000);
});
