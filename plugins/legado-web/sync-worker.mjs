import { parentPort } from "node:worker_threads";
import { proxyFetch, describeFetchError } from "./net.mjs";

const MAX_BYTES = 16 * 1024 * 1024;

parentPort.on("message", async ({ sab, req }) => {
	const view = new Int32Array(sab);
	const done = (payload) => {
		const bytes = Buffer.from(JSON.stringify(payload), "utf8");
		if (bytes.length + 8 > sab.byteLength) {
			const tooBig = Buffer.from(
				JSON.stringify({ error: `响应过大（${bytes.length} 字节），同步请求桥不支持` }),
				"utf8",
			);
			new Uint8Array(sab, 8, tooBig.length).set(tooBig);
			Atomics.store(view, 0, tooBig.length);
		} else {
			new Uint8Array(sab, 8, bytes.length).set(bytes);
			Atomics.store(view, 0, bytes.length);
		}
		Atomics.store(view, 1, 1);
		Atomics.notify(view, 1);
	};
	try {
		const res = await proxyFetch(req);
		done({ status: res.status, url: res.url, body: res.body });
	} catch (err) {
		done({ error: describeFetchError(err) });
	}
});

export { MAX_BYTES };
