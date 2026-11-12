import type { ClipboardMode } from "./desktop-clipboard-protocol.js";
export interface ClipboardSocket {
	readyState: number;
	bufferedAmount: number;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: (() => void) | null;
	onerror: (() => void) | null;
	send(data: string): void;
	close(): void;
}
/** Self-contained so the trusted standalone portal and React use exactly the same bridge. */
export function clipboardBrowserBridge(options: {
	open: () => ClipboardSocket;
	id: () => string;
	post: (data: object) => void;
	state: (status: string) => void;
}) {
	let local: ClipboardSocket | undefined,
		channel = "",
		mode: ClipboardMode = "off",
		remoteReady = false,
		localReady = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pendingLocal: object | undefined;
	const post = (payload: object) => options.post({ type: "desktop-clipboard", channel, payload });
	const stop = () => {
		if (channel) post({ type: "bridge-stop" });
		channel = "";
		mode = "off";
		remoteReady = localReady = false;
		pendingLocal = undefined;
		clearTimeout(timer);
		if (local) {
			local.onmessage = local.onerror = local.onclose = null;
			local.close();
			local = undefined;
		}
	};
	const fail = (code: string) => {
		stop();
		options.state(code);
	};
	return {
		receive(data: unknown) {
			if (!data || typeof data !== "object") return;
			const envelope = data as { type?: string; channel?: string; payload?: Record<string, unknown> };
			if (envelope.type !== "desktop-clipboard" || !channel || envelope.channel !== channel) return;
			const packet = envelope.payload;
			if (!packet || typeof packet !== "object") return;
			if (packet.type === "clipboard-error") {
				fail(String(packet.code));
				return;
			}
			if (packet.type === "clipboard-stopped") {
				fail("clipboard-stopped");
				return;
			}
			if (packet.type === "clipboard-ready") {
				remoteReady = true;
				clearTimeout(timer);
				if (localReady) options.state("clipboard-ready");
				if (pendingLocal) {
					post(pendingLocal);
					pendingLocal = undefined;
				}
				return;
			}
			if (
				!remoteReady ||
				!localReady ||
				local?.readyState !== 1 ||
				!["offer", "chunk", "commit", "ack"].includes(String(packet.type))
			)
				return;
			if ((packet.type === "ack" && mode === "receive") || (packet.type !== "ack" && mode === "send"))
				return fail("clipboard-direction");
			const text = JSON.stringify(packet);
			if (text.length > 49152 || local.bufferedAmount > 98304) return fail("clipboard-size");
			local.send(text);
		},
		set(next: ClipboardMode) {
			stop();
			if (next === "off") {
				options.state("clipboard-off");
				return;
			}
			mode = next;
			channel = options.id();
			options.state("clipboard-connecting");
			let current: ClipboardSocket;
			try {
				current = options.open();
			} catch {
				fail("clipboard-unavailable");
				return;
			}
			local = current;
			timer = setTimeout(() => fail("clipboard-timeout"), 15000);
			current.onmessage = (event) => {
				if (current !== local || typeof event.data !== "string" || event.data.length > 49152) return;
				try {
					const packet = JSON.parse(event.data);
					if (packet.type === "clipboard-error") return fail(String(packet.code));
					if (packet.type === "clipboard-capabilities") {
						current.send(JSON.stringify({ type: "start", read: mode !== "receive", write: mode !== "send" }));
						return;
					}
					if (packet.type === "clipboard-ready") {
						localReady = true;
						post({ type: "bridge-start", mode });
						return;
					}
					if (["offer", "chunk", "commit", "ack"].includes(packet.type)) {
						if (remoteReady) post(packet);
						else if (!pendingLocal) pendingLocal = packet;
						else fail("clipboard-protocol");
					}
				} catch {
					fail("clipboard-protocol");
				}
			};
			current.onclose = current.onerror = () => {
				if (current === local) fail("clipboard-unavailable");
			};
		},
		close: stop,
	};
}
