import { randomBytes } from "node:crypto";
import { buildRemoteCanvas, createCanvasTransport } from "./remote-canvas.mjs";

export function registerRemoteCanvas(host, { prepare, viewerRoot, getOrigin, signal, touch, maxSessions = 16 }) {
	const sessions = new Map();
	let creating = 0;
	const ttl = 10 * 60_000;
	let invalidation = 0;
	const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
	function release(token) {
		const session = sessions.get(token);
		if (!session) return;
		sessions.delete(token);
		session.controller.abort();
		session.transport.dispose();
	}
	function sweep() {
		for (const [token, session] of sessions) if (Date.now() - session.touched > ttl) release(token);
	}
	const timer = setInterval(sweep, 60_000);
	timer.unref?.();
	function respond(handler) {
		return async (req, res) => {
			try {
				signal.throwIfAborted();
				res.setHeader?.("Cache-Control", "no-store");
				const value = await handler(req, res);
				if (!res.destroyed) res.json({ ok: true, ...value });
			} catch (error) {
				if (!res.destroyed) res.status(error.statusCode || 500).json({ ok: false, error: error.message });
			}
		};
	}
	host.route(
		"POST",
		"/canvas-create",
		respond(async (req, res) => {
			if (typeof req.body?.path !== "string" || !req.body.path.trim()) throw fail(400, "Document path required");
			sweep();
			if (sessions.size + creating >= maxSessions)
				throw fail(429, "Too many Office canvas sessions; close an existing viewer");
			creating++;
			const admittedGeneration = invalidation;
			try {
				const doc = await prepare(req.body.path);
				const build = () => buildRemoteCanvas({ viewerRoot, fileKey: doc.fileKey, unitId: doc.unitId });
				let canvas;
				try {
					canvas = await build();
				} catch (error) {
					if (error.code !== "ERR_MODULE_NOT_FOUND" || !/["'](?:esbuild|ws)["']/.test(String(error.message)))
						throw error;
					throw new Error(
						"Office canvas dependencies are missing. Install this plugin's declared dependencies (npm install in the Office plugin directory), then reload the plugin.",
					);
				}
				signal.throwIfAborted();
				if (req.aborted || res.destroyed) throw fail(499, "Office canvas request cancelled");
				if (admittedGeneration !== invalidation)
					throw fail(409, "Office document reloaded while preparing canvas; reopen it");
				if (sessions.size >= maxSessions) throw fail(429, "Too many Office canvas sessions");
				const token = randomBytes(32).toString("hex");
				const controller = new AbortController();
				const transport = createCanvasTransport({
					gatewayOrigin: getOrigin(),
					fileKey: doc.fileKey,
					signal: AbortSignal.any([signal, controller.signal]),
					limits: { maxRequestBytes: 6 * 1024 * 1024 },
				});
				sessions.set(token, { transport, controller, fileKey: doc.fileKey, touched: Date.now(), pending: 0 });
				touch();
				return { token, ...canvas };
			} finally {
				creating--;
			}
		}),
	);
	host.route(
		"POST",
		"/canvas-rpc",
		respond(async (req, res) => {
			const token = req.body?.token;
			if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw fail(403, "Invalid Office canvas session");
			const session = sessions.get(token);
			if (!session || Date.now() - session.touched > ttl) {
				release(token);
				throw fail(410, "Office canvas session expired; reopen the document");
			}
			if (session.pending >= 32) throw fail(429, "Too many pending Office canvas requests");
			session.touched = Date.now();
			touch();
			session.pending++;
			const cancelled = new AbortController();
			const abort = () => cancelled.abort();
			req.once?.("aborted", abort);
			res.once?.("close", abort);
			if (req.aborted || res.destroyed) abort();
			try {
				return { result: await session.transport.request(req.body?.message, { signal: cancelled.signal }) };
			} finally {
				session.pending--;
				req.removeListener?.("aborted", abort);
				res.removeListener?.("close", abort);
			}
		}),
	);
	host.route(
		"POST",
		"/canvas-close",
		respond(async (req) => {
			release(req.body?.token);
			return {};
		}),
	);
	const dispose = () => {
		clearInterval(timer);
		for (const token of sessions.keys()) release(token);
	};
	signal.addEventListener("abort", dispose, { once: true });
	return {
		dispose,
		closeDocument(fileKey) {
			invalidation++;
			for (const [token, session] of sessions) if (session.fileKey === fileKey) release(token);
		},
	};
}
