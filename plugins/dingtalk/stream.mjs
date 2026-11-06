import { dingJson } from "./media.mjs";

export class DingTalkStream {
	constructor({ config, onMessage, onState, log }) {
		this.config = config;
		this.onMessage = onMessage;
		this.onState = onState;
		this.log = log;
		this.closed = false;
	}
	async connect() {
		const cfg = this.config();
		if (!cfg.appKey || !cfg.appSecret) throw new Error("钉钉 Stream 需要 AppKey / AppSecret");
		const gateway = await dingJson("https://api.dingtalk.com/v1.0/gateway/connections/open", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				clientId: cfg.appKey,
				clientSecret: cfg.appSecret,
				subscriptions: [{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }],
				ua: "pi-web-ui-dingtalk",
			}),
		});
		if (this.closed) return;
		const url = new URL(gateway.endpoint);
		if (url.protocol !== "wss:" || !gateway.ticket) throw new Error("钉钉 Stream 返回无效网关");
		url.searchParams.set("ticket", gateway.ticket);
		const socket = new WebSocket(url);
		this.socket = socket;
		socket.addEventListener("open", () => {
			if (!this.closed) this.onState(true);
		});
		socket.addEventListener("message", (event) => {
			void this.receive(socket, event.data);
		});
		socket.addEventListener("error", () => {
			this.log("钉钉 Stream WebSocket 连接错误");
			socket.close();
		});
		socket.addEventListener("close", () => {
			if (this.closed || this.socket !== socket) return;
			this.onState(false);
			this.retry();
		});
	}
	retry() {
		if (this.closed || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.connect().catch((error) => {
				this.log(error.message);
				this.retry();
			});
		}, 5000);
		this.timer.unref?.();
	}
	async receive(socket, raw) {
		try {
			const message = JSON.parse(String(raw));
			const headers = message.headers || {};
			if (message.type === "SYSTEM" && headers.topic === "ping") {
				socket.send(
					JSON.stringify({
						code: 200,
						headers: { messageId: headers.messageId, contentType: "application/json" },
						message: "OK",
						data: message.data,
					}),
				);
				return;
			}
			if (message.type === "SYSTEM" && headers.topic === "disconnect") {
				socket.close();
				return;
			}
			if (message.type !== "CALLBACK" || headers.topic !== "/v1.0/im/bot/messages/get") return;
			const event = typeof message.data === "string" ? JSON.parse(message.data) : message.data;
			socket.send(
				JSON.stringify({
					code: 200,
					headers: { messageId: headers.messageId, contentType: "application/json" },
					message: "OK",
					data: "{}",
				}),
			);
			if (!this.closed) await this.onMessage(event);
		} catch (error) {
			this.log(`钉钉 Stream 消息处理失败：${error.message}`);
		}
	}
	close() {
		this.closed = true;
		clearTimeout(this.timer);
		this.socket?.close();
	}
}
