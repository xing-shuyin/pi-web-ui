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
			} catch {}
			worker = null;
		},
	};
}
