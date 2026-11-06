import { appWsUrl } from "../../base-url";
import { withToken } from "../../auth-token";
import { PROTOCOL_VERSION } from "../../protocol-version";
import type { ClientMessage, ServerMessage } from "../../types";
import { randomUuid } from "../../uuid";

type CanvasMessageListener = (msg: ServerMessage) => void;

export class CanvasClient {
	constructor(private readonly options: { loadGraphOnConnect?: boolean } = {}) {}
	private ws: WebSocket | null = null;
	private readonly clientId = `canvas:${randomUuid().slice(0, 8)}`;
	private readonly listeners = new Set<CanvasMessageListener>();
	private readonly connectionListeners = new Set<(connected: boolean) => void>();
	subscribeConnection(fn: (connected: boolean) => void): () => void {
		this.connectionListeners.add(fn);
		return () => {
			this.connectionListeners.delete(fn);
		};
	}
	private notifyConnection(connected: boolean) {
		for (const listener of this.connectionListeners) listener(connected);
	}
	private disposed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private currentGraphId = CanvasClient.readLastGraphId();
	onLoadRequest?: (request: Extract<ClientMessage, { type: "canvas_load" }>) => void;

	private static lastGraphKey(): string {
		return "pi-web-ui.canvas.lastGraphId";
	}

	static readLastGraphId(): string {
		try {
			const saved = localStorage.getItem(CanvasClient.lastGraphKey());
			if (saved && /^[A-Za-z0-9._-]{1,64}$/.test(saved)) return saved;
		} catch {}
		return "default";
	}

	setCurrentGraphId(id: string): void {
		if (typeof id === "string" && id) {
			this.currentGraphId = id;
			try {
				localStorage.setItem(CanvasClient.lastGraphKey(), id);
			} catch {}
		}
	}

	connect(): void {
		if (this.disposed || this.ws) return;
		try {
			const ws = new WebSocket(withToken(appWsUrl()));
			this.ws = ws;

			ws.onopen = () => {
				if (this.ws !== ws) return;
				this.notifyConnection(true);
				this.send({
					type: "hello",
					clientId: this.clientId,
					protocolVersion: PROTOCOL_VERSION,
				});
				this.send({ type: "canvas_list" });
				this.send({ type: "canvas_cards" });
				if (this.options.loadGraphOnConnect !== false) {
					const request = { type: "canvas_load" as const, id: this.currentGraphId, requestId: randomUuid() };
					this.onLoadRequest?.(request);
					this.send(request);
				}
			};

			ws.onmessage = (ev) => {
				if (this.ws !== ws) return;
				try {
					const msg = JSON.parse(ev.data as string) as ServerMessage;
					for (const l of this.listeners) {
						l(msg);
					}
				} catch {}
			};

			ws.onclose = () => {
				if (this.ws !== ws) return;
				this.ws = null;
				if (!this.disposed) this.notifyConnection(false);
				if (!this.disposed && !this.reconnectTimer) {
					this.reconnectTimer = setTimeout(() => {
						this.reconnectTimer = null;
						this.connect();
					}, 2000);
				}
			};
		} catch {}
	}

	send(msg: ClientMessage): boolean {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
			return true;
		}
		return false;
	}

	subscribe(fn: CanvasMessageListener): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	dispose(): void {
		this.disposed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.listeners.clear();
		this.connectionListeners.clear();
	}
}
