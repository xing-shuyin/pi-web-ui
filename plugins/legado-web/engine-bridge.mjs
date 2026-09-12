/**
 * 规则引擎桥（主进程侧）—— 起一个 engine-host.mjs worker，把诊断任务丢过去等结果。
 *
 * 生命周期：lazy 起 worker；任务超时/worker 崩溃 → 终止并重建（下次调用自动恢复）；
 * 插件反激活时 dispose。
 */

import { Worker } from "node:worker_threads";

const DEFAULT_JOB_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 30_000;

export function createEngineBridge({ log = () => {}, jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS } = {}) {
	let worker = null;
	let ready = null;
	let seq = 0;
	const pending = new Map();

	const spawn = () => {
		const w = new Worker(new URL("./engine-host.mjs", import.meta.url));
		worker = w;
		ready = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("规则引擎 worker 启动超时")), READY_TIMEOUT_MS);
			w.on("message", (msg) => {
				if (msg?.ready) {
					clearTimeout(timer);
					resolve();
				}
			});
			w.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
		w.on("message", (msg) => {
			if (!msg || msg.ready || msg.id === undefined) return;
			const entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			clearTimeout(entry.timer);
			if (msg.ok) entry.resolve(msg.result);
			else entry.reject(new Error(String(msg.error ?? "规则引擎执行失败")));
		});
		const crash = (why) => {
			log(`规则引擎 worker 退出：${why}`);
			for (const [, entry] of pending) {
				clearTimeout(entry.timer);
				entry.reject(new Error(`规则引擎 worker 退出：${why}`));
			}
			pending.clear();
			if (worker === w) {
				worker = null;
				ready = null;
			}
		};
		w.on("exit", (code) => crash(`exit ${code}`));
		w.on("error", (err) => crash(err?.message ?? String(err)));
		return w;
	};

	return {
		/** 在引擎 worker 里跑一个任务（{kind:'probe'|'check', …}）。 */
		async run(job) {
			const w = worker ?? spawn();
			await ready;
			const id = ++seq;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					// 超时：任务可能还卡在同步桥里，杀掉 worker 免得留着脏状态
					try {
						w.terminate();
					} catch {
						/* ignore */
					}
					if (worker === w) {
						worker = null;
						ready = null;
					}
					reject(new Error(`规则引擎任务超时（${jobTimeoutMs / 1000}s）`));
				}, jobTimeoutMs);
				pending.set(id, { resolve, reject, timer });
				w.postMessage({ id, job });
			});
		},
		dispose() {
			try {
				worker?.terminate();
			} catch {
				/* ignore */
			}
			worker = null;
			ready = null;
		},
	};
}
