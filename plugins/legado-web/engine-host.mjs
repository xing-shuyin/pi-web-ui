/**
 * 规则引擎 worker —— 在独立线程里跑内嵌前端的书源规则引擎（server/engine.mjs）。
 *
 * 为什么放 worker：① 诊断一次书源要发好几个请求（几秒到几十秒），不能卡住主进程的
 * WS/HTTP；② 书源 JS 规则里的同步 HTTP（java.ajax…）需要 Atomics.wait 阻塞线程，
 * 只能在 worker 里做（见 sync-bridge.mjs）。
 *
 * 注入：
 *   - 异步 transport → net.mjs（绕 CORS/GBK/cookie jar，与 UI 走的 /proxy 同一份实现）
 *   - 同步 transport → sync-bridge（同步 worker + 共享内存）
 *   - localStorage 内存垫片（JS 规则的 java.cache / infoMap 需要）
 */

import { parentPort } from "node:worker_threads";
import { proxyFetch, describeFetchError } from "./net.mjs";
import { createSyncHttp } from "./sync-bridge.mjs";

// ---- localStorage 垫片（仅在 worker 内生效，进程内共享、退出即丢） ----------
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
