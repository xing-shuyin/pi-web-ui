/**
 * 同步抓取 worker —— 给书源 JS 规则里的 `java.ajax/connect/get/post`（同步语义）当后端。
 *
 * 协议：主线程（同步桥）建一块 SharedArrayBuffer，postMessage({ sab, req }) 后
 * Atomics.wait 阻塞自己；本 worker 做完异步 fetch 把结果写进共享内存并 Atomics.notify。
 *   Int32Array 视图： [0]=结果字节长度  [1]=完成标志
 *   结果数据：从字节偏移 8 开始（保持 Int32 对齐）
 */

import { parentPort } from "node:worker_threads";
import { proxyFetch, describeFetchError } from "./net.mjs";

const MAX_BYTES = 16 * 1024 * 1024; // 单次响应上限（超了报错，避免共享内存开得更大）

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

// 共享内存上限声明（供同步桥读取，避免两边写死不一致）
export { MAX_BYTES };
