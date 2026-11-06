import * as S from "./store.mjs";
import { apiBase as getSharedApiBase } from "@pi-web-ui/plugin-sdk/client";

export function resolveApiBase(importMetaUrl) {
	try {
		const base = getSharedApiBase("notes");
		if (base) return base;
	} catch {}
	const base = String(importMetaUrl);
	const idx = base.indexOf("/plugins/");
	const root = idx >= 0 ? base.slice(0, idx) : base.replace(/\/[^/]*$/, "");
	return `${root}/plugins-api/notes`;
}

async function readJson(res) {
	const text = await res.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`bad response (${res.status})`);
	}
}

export function createDataClient(opts = {}) {
	const apiBase = opts.apiBase ?? resolveApiBase(opts.importMetaUrl ?? import.meta.url);
	const onFired = typeof opts.onFired === "function" ? opts.onFired : () => {};
	let store = S.emptyStore();
	let nextMap = {};
	let status = "connecting";
	let lastError = "";
	const listeners = new Set();
	const ackQueue = new Set();

	function snapshot() {
		return { store, next: nextMap, status, error: lastError, now: Date.now() };
	}

	function emit() {
		for (const fn of [...listeners]) {
			try {
				fn(snapshot());
			} catch (err) {
				console.error("[notes] listener failed:", err);
			}
		}
	}

	function apply(payload, { quiet = false } = {}) {
		if (payload?.store) store = S.normalizeStore(payload.store);
		if (payload?.next && typeof payload.next === "object") nextMap = payload.next;
		if (status !== "online") status = "online";
		lastError = "";
		if (!quiet) emit();
	}

	function ackLocal(ids) {
		const n = S.ackPending(store, ids);
		if (n > 0) emit();
		for (const id of ids) ackQueue.add(id);
	}

	async function call(path, init) {
		const res = await fetch(`${apiBase}${path}`, {
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			...init,
		});
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status}`);
			err.status = res.status;
			throw err;
		}
		return readJson(res);
	}

	function takeUnseen() {
		const seenKey = "notes:seen";
		let seen = [];
		try {
			seen = JSON.parse(localStorage.getItem(seenKey) ?? "[]");
		} catch {
			seen = [];
		}
		const seenSet = new Set(Array.isArray(seen) ? seen : []);
		const fresh = store.meta.pending.filter((p) => !seenSet.has(p.id));
		if (!fresh.length) return [];
		for (const p of fresh) seenSet.add(p.id);
		const keep = [...seenSet].slice(-500);
		try {
			localStorage.setItem(seenKey, JSON.stringify(keep));
		} catch {}
		return fresh;
	}

	async function flushAcks() {
		if (!ackQueue.size) return;
		const ids = [...ackQueue];
		ackQueue.clear();
		try {
			const data = await call("/op", { method: "POST", body: JSON.stringify({ op: "reminder.ack", ids }) });
			if (data?.store) {
				store = S.normalizeStore(data.store);
				nextMap = data.next ?? nextMap;
				emit();
			}
		} catch {
			for (const id of ids) ackQueue.add(id);
		}
	}

	let disposed = false;

	async function pollLoop() {
		let delay = 2000;
		for (;;) {
			if (disposed) return;
			const rev = store.meta.rev;
			try {
				const data = await call(`/wait?rev=${rev}&client=${encodeURIComponent(clientKey())}`, { method: "GET" });
				if (data?.store) apply(data);
				delay = 2000;
				if (typeof data?.retryAfterMs === "number" && data.retryAfterMs > 0) {
					await sleep(Math.min(data.retryAfterMs, 10_000));
				}
				const fresh = takeUnseen();
				if (fresh.length) {
					ackLocal(fresh.map((p) => p.id));
					onFired(fresh, snapshot());
				}
				await flushAcks();
			} catch (err) {
				if (disposed) return;
				if (typeof err?.status === "number") {
					lastError = err.message;
					emit();
					await sleep(Math.max(delay, 3000));
					continue;
				}
				status = "offline";
				lastError = err instanceof Error ? err.message : String(err);
				emit();
				await sleep(delay);
				delay = Math.min(15000, Math.round(delay * 1.7));
			}
		}
	}

	function sleep(ms) {
		return new Promise((r) => setTimeout(r, ms));
	}

	const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	function clientKey() {
		return key;
	}

	return {
		subscribe(fn) {
			listeners.add(fn);
			fn(snapshot());
			return () => listeners.delete(fn);
		},
		getState: snapshot,
		nextAt(rem) {
			const iso = nextMap?.[rem?.id];
			if (iso) {
				const t = new Date(iso).getTime();
				if (!Number.isNaN(t)) return t;
			}
			return rem?.enabled ? (nextScheduleSafe(rem.schedule) ?? null) : null;
		},
		async op(payload) {
			try {
				const data = await call("/op", { method: "POST", body: JSON.stringify(payload) });
				if (data?.store) apply(data, { quiet: true });
				emit();
				return data?.result ?? { ok: data?.ok !== false, error: data?.error };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				status = "offline";
				lastError = msg;
				emit();
				return { ok: false, error: msg };
			}
		},
		async download(format) {
			try {
				const res = await fetch(`${apiBase}/export?format=${format}`, { credentials: "same-origin" });
				if (!res.ok) {
					const err = new Error(`HTTP ${res.status}`);
					err.status = res.status;
					throw err;
				}
				const text = await res.text();
				const stamp = S.nowStamp().replace(/[:T]/g, "-");
				download(`${format === "md" ? "notes" : "notes-backup"}-${stamp}.${format}`, text);
				return { ok: true };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},
		async refresh() {
			try {
				const data = await call("/store", { method: "GET" });
				apply(data);
			} catch {}
		},
		start() {
			void pollLoop();
		},
		stop() {
			disposed = true;
		},
	};
}

function nextScheduleSafe(schedule) {
	try {
		return S.reminderFireAt({ enabled: true, schedule }, Date.now());
	} catch {
		return null;
	}
}

export function download(filename, text) {
	const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
