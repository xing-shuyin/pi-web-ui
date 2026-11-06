import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.env.PI_WEB_PORT ?? 8787);
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;

const clientId = randomUUID();
const CWD = process.env.WS_CWD ?? process.cwd();
const READ_PATH = process.env.WS_READ;
const MEDIA_PATH = process.env.WS_MEDIA;

const ws = new WebSocket(WS_URL);
let step = 0;

function log(...a) {
	console.log(`[live ${step}]`, ...a);
}

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", clientId })));

ws.on("message", async (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, serverVersion:", m.serverVersion);
		ws.send(JSON.stringify({ type: "set_cwd", path: CWD }));
	} else if (m.type === "notice" && step === 0) {
		log("set_cwd notice:", m.text);
		step = 1;
		ws.send(JSON.stringify({ type: "read_file", path: READ_PATH ?? "" }));
	} else if (m.type === "file_content" && step === 1) {
		log("file_content:", JSON.stringify({ name: m.name, truncated: m.truncated, binary: m.binary, lines: m.lines }));
		step = 2;
		if (MEDIA_PATH) {
			const url = `/api/file?clientId=${encodeURIComponent(clientId)}&path=${encodeURIComponent(MEDIA_PATH)}`;
			const r = await fetch(`${BASE}${url}`);
			log("media url:", url);
			log("media fetch:", r.status, r.headers.get("content-type"));
			const buf = Buffer.from(await r.arrayBuffer());
			log("bytes:", buf.length, "magic:", buf.subarray(0, 4).toString("hex"));
		} else {
			log("WS_MEDIA 未设置，跳过媒体下载探测");
		}
		ws.close();
		process.exit(0);
	} else if (m.type === "snapshot") {
		if (m.state?.cwd) log("snapshot cwd:", m.state.cwd);
	}
});

ws.on("error", (e) => {
	log("ws error:", e.message);
	process.exit(1);
});

setTimeout(() => {
	log("TIMEOUT");
	process.exit(2);
}, 10000);
