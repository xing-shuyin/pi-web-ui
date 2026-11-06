import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.env.PI_WEB_PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

const MEDIA_PATH = process.env.WS_MEDIA_PATH;

const clientId = randomUUID();
const ws = new WebSocket(WS_URL);
let step = 0;

function log(...a) {
	console.log(`[ws-session ${step}]`, ...a);
}

ws.on("open", () => {
	log("open, sending hello");
	ws.send(JSON.stringify({ type: "hello", clientId }));
});

ws.on("message", async (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, serverVersion:", m.serverVersion);
		ws.send(JSON.stringify({ type: "list_files", path: undefined }));
	} else if (m.type === "files") {
		log("files root:", m.path, "entries:", m.entries.length);
		if (MEDIA_PATH) {
			const r = await fetch(
				`${BASE}/api/file?clientId=${encodeURIComponent(clientId)}&path=${encodeURIComponent(MEDIA_PATH)}`,
			);
			log("media fetch:", r.status, r.headers.get("content-type"));
		} else {
			log("WS_MEDIA_PATH 未设置，跳过媒体下载探测");
		}
		ws.close();
		process.exit(0);
	} else if (m.type === "snapshot") {
		if (m.state?.cwd) log("snapshot cwd:", m.state.cwd);
	} else if (m.type === "notice") {
		log("notice:", m.text);
	}
});

ws.on("error", (e) => {
	log("ws error:", e.message);
	process.exit(1);
});

setTimeout(() => {
	log("TIMEOUT");
	process.exit(1);
}, 8000);
