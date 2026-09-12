/**
 * 同步桥 —— 把异步 fetch 变成阻塞调用（只能在 worker 线程里用：主线程 Atomics.wait 会卡死事件循环）。
 *
 * 用途：书源 JS 规则里的 `java.ajax / java.connect / java.get / java.post` 是**同步**语义
 * （浏览器实现是同步 XHR），规则引擎在 Node 里跑时需要等价能力。
 *
 * 实现：一个常驻 worker（sync-worker.mjs）+ 每调用一块 SharedArrayBuffer，
 * 主调线程 Atomics.wait 阻塞等待结果。
 */

import { Worker } from "node:worker_threads";

const SAB_BYTES = 16 * 1024 * 1024;

/** @param {{timeoutMs?: number}} [opts] */
export function createSyncHttp(opts = {}) {
	const timeoutMs = Number(opts.timeoutMs ?? 25_000);
	let worker = null;

	const ensure = () => {
		if (worker) return worker;
		worker = new Worker(new URL("./sync-worker.mjs", import.meta.url));
		worker.on("error", () => {
			worker = null;
		});
		worker.on("exit", () => {
			worker = null;
		});
		return worker;
	};

	return {
		/** 阻塞抓取。成功返回 { status, url, body }，失败抛错（消息即原因）。 */
		call(req) {
			const sab = new SharedArrayBuffer(SAB_BYTES);
			const view = new Int32Array(sab);
			ensure().postMessage({ sab, req });
			const r = Atomics.wait(view, 1, 0, timeoutMs);
			if (r === "timed-out") throw new Error(`同步请求超时（${timeoutMs}ms）：${req?.url ?? ""}`);
			const len = Atomics.load(view, 0);
			const text = Buffer.from(new Uint8Array(sab, 8, len)).toString("utf8");
			const res = JSON.parse(text);
			if (res.error) throw new Error(res.error);
			return res;
		},
		dispose() {
			try {
				worker?.terminate();
			} catch {
				/* ignore */
			}
			worker = null;
		},
	};
}
