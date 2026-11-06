import { parentPort } from "node:worker_threads";
import { proxyFetch, describeFetchError } from "./net.mjs";
import { createSyncHttp } from "./sync-bridge.mjs";

if (typeof globalThis.localStorage === "undefined") {
	const mem = new Map();
	globalThis.localStorage = {
		getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
		setItem: (k, v) => void mem.set(String(k), String(v)),
		removeItem: (k) => void mem.delete(String(k)),
		clear: () => mem.clear(),
		key: (i) => [...mem.keys()][i] ?? null,
		get length() {
			return mem.size;
		},
	};
}

const engine = await import(new URL("./server/engine.mjs", import.meta.url).href);

engine.setProxyTransport(async (target, opts = {}) => {
	const res = await proxyFetch({
		url: target,
		method: opts.method,
		headers: opts.headers,
		body: opts.body,
		charset: opts.charset,
	});
	return { url: res.url, body: res.body, headers: res.headers, status: res.status };
});

const syncHttp = createSyncHttp();
engine.setSyncTransport((target, method, headers, body) => {
	const res = syncHttp.call({ url: target, method, headers, body });
	if (res.status < 200 || res.status >= 300) throw new Error(`ajax ${res.status} ${target}`);
	return res.body;
});

parentPort.on("message", async ({ id, job }) => {
	try {
		const result = await engine.runJob(job);
		parentPort.postMessage({ id, ok: true, result });
	} catch (err) {
		parentPort.postMessage({ id, ok: false, error: describeFetchError(err) || String(err?.stack ?? err) });
	}
});

parentPort.postMessage({ ready: true });
