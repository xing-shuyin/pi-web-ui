export function attachCanvasBroker({ iframe, channel, request, signal, onReady, onError }) {
	if (!iframe || typeof channel !== "string" || !channel || typeof request !== "function")
		throw new Error("Invalid Office canvas broker configuration");
	const lifetime = new AbortController();
	const active = new Map();
	let port,
		disposed = false,
		ready = false;
	function disconnect() {
		for (const controller of active.values()) controller.abort();
		active.clear();
		if (port) {
			try {
				port.postMessage({ type: "office-canvas-dispose" });
			} catch {}
			try {
				port.close();
			} catch {}
			port = undefined;
		}
		ready = false;
	}
	function dispose() {
		if (disposed) return;
		disposed = true;
		lifetime.abort();
		disconnect();
		window.removeEventListener("message", handshake);
		signal?.removeEventListener("abort", dispose);
	}
	function handshake(event) {
		if (
			disposed ||
			event.source !== iframe.contentWindow ||
			event.origin !== "null" ||
			event.data?.type !== "office-canvas-ready" ||
			event.data.channel !== channel
		)
			return;
		disconnect();
		const pair = new MessageChannel();
		const current = pair.port1;
		port = current;
		current.onmessage = async (event) => {
			if (disposed || port !== current || !event.data || typeof event.data !== "object") return;
			const message = event.data;
			if (message.type === "office-canvas-app-ready") {
				if (!ready) {
					ready = true;
					onReady?.();
				}
				return;
			}
			if (message.type === "office-canvas-error") {
				onError?.(new Error(String(message.error || "Office viewer failed").slice(0, 1000)));
				return;
			}
			if (message.type === "office-canvas-cancel") {
				active.get(message.id)?.abort();
				return;
			}
			const id = message.id;
			if (!Number.isSafeInteger(id) || id < 1 || active.has(id)) return;
			if (active.size >= 32) {
				current.postMessage({ id, error: "Office canvas request limit exceeded" });
				return;
			}
			if (!["fetch", "ws-open", "ws-send", "ws-poll", "ws-close"].includes(message.op)) {
				current.postMessage({ id, error: "Office canvas operation denied" });
				return;
			}
			const controller = new AbortController();
			active.set(id, controller);
			const requestSignal = AbortSignal.any([lifetime.signal, controller.signal]);
			try {
				const result = await request(message, { signal: requestSignal });
				if (!requestSignal.aborted && port === current) current.postMessage({ id, result });
			} catch (error) {
				if (!requestSignal.aborted && port === current)
					current.postMessage({ id, error: String(error?.message || "Office canvas request failed").slice(0, 1000) });
			} finally {
				if (active.get(id) === controller) active.delete(id);
			}
		};
		current.start();
		try {
			iframe.contentWindow.postMessage({ type: "office-canvas-connect", channel }, "*", [pair.port2]);
		} catch (error) {
			pair.port2.close();
			disconnect();
			onError?.(error);
		}
	}
	window.addEventListener("message", handshake);
	signal?.addEventListener("abort", dispose, { once: true });
	if (signal?.aborted) dispose();
	return dispose;
}
