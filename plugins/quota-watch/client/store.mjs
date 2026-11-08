/**
 * 额度快照的**唯一来源**（客户端侧）。
 *
 * 为什么要有它：底栏文本与浮层各拉一次 `/summary` 是「点了刷新，状态栏数额不变」的根因 ——
 * 两个视图各持一个时间戳，谁也不知道对方刚刷新过。这里把「一次请求」变成「一份数据 + 一组订阅者」：
 * 谁刷新都只发一次请求，刷新完同时通知底栏与浮层（以及将来任何别的视图）。
 *
 * 节奏也归这里：
 * - 闲着（没人挂着浮层）：`idleMs`（60 秒）一次，多数命中服务端缓存，几乎不出网；
 * - 浮层开着（`hold()` 的持有者 > 0）：`activeMs`（15 秒）一次，界面上的「几秒前」才跟得上；
 * - 页面不可见时不发请求，回到可见 / 窗口聚焦时补一次。
 */

/**
 * @param {{
 *   apiBase: string,
 *   idleMs?: number,
 *   activeMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} opts
 */
export function createSummaryStore({ apiBase, idleMs = 60_000, activeMs = 15_000, fetchImpl }) {
	const doFetch = fetchImpl ?? ((...args) => fetch(...args));
	/** @type {any} */
	let data = null;
	/** @type {Promise<any> | null} */
	let inflight = null;
	/** @type {ReturnType<typeof setTimeout> | null} */
	let timer = null;
	let holders = 0;
	let disposed = false;
	/** @type {Set<(payload: any) => void>} */
	const listeners = new Set();

	const url = (force) => `${apiBase}/summary${force ? "?force=1" : ""}`;

	function emit() {
		for (const fn of [...listeners]) {
			try {
				fn(data);
			} catch {
				/* 一个订阅者画崩了不该带走其它视图 */
			}
		}
	}

	async function apply(force) {
		const res = await doFetch(url(force), { credentials: "same-origin" });
		const payload = await res.json();
		if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${res.status}`);
		data = payload;
		emit();
		return payload;
	}

	/**
	 * 拿一份快照。同一时刻只允许一个请求在飞：浮层点刷新和底栏轮询撞在一起时，
	 * 后来者直接复用前者的结果（这也是「两边同时变」的原因）。
	 * @param {boolean} force
	 */
	function refresh(force = false) {
		if (disposed) return Promise.resolve(data);
		if (inflight) return inflight;
		inflight = apply(force).finally(() => {
			inflight = null;
		});
		return inflight;
	}

	/**
	 * 订阅快照。已有数据时立刻同步一次（浮层挂载即画，不用等下一轮）。
	 * @param {(payload: any) => void} fn
	 */
	function subscribe(fn) {
		listeners.add(fn);
		if (data) {
			try {
				fn(data);
			} catch {
				/* ignore */
			}
		}
		return () => listeners.delete(fn);
	}

	function intervalMs() {
		return holders > 0 ? activeMs : idleMs;
	}

	function schedule() {
		if (disposed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			if (disposed) return;
			if (typeof document !== "undefined" && document.visibilityState === "hidden") {
				schedule();
				return;
			}
			void refresh(false)
				.catch(() => {
					/* 网络抖动：保留上一份，等下一轮 */
				})
				.finally(schedule);
		}, intervalMs());
		// 让 setTimeout 不拽住进程 / 不阻塞退出（Node 端只有测试会用到）
		if (timer && typeof timer === "object" && typeof timer.unref === "function") timer.unref();
	}

	/**
	 * 挂一个「有人在看」的持有者（浮层挂载）。持有期间轮询加速，并且立刻取一次。
	 * @returns {() => void} 卸载时调用
	 */
	function hold() {
		holders += 1;
		schedule();
		void refresh(false).catch(() => {});
		let released = false;
		return () => {
			if (released) return;
			released = true;
			holders = Math.max(0, holders - 1);
			schedule();
		};
	}

	function start() {
		if (disposed || timer) return;
		schedule();
		void refresh(false).catch(() => {});
	}

	function stop() {
		disposed = true;
		if (timer) clearTimeout(timer);
		timer = null;
		listeners.clear();
	}

	return { refresh, subscribe, hold, start, stop, get: () => data, intervalMs };
}
