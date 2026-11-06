import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.env.PI_WEB_PORT ?? 8787);
const WS_URL = `ws://localhost:${PORT}/ws`;

const clientId = randomUUID();
const ws = new WebSocket(WS_URL);

const TEXT_SMALL = Buffer.from("你好，这是一个小文本文件。\nsecond line\n").toString("base64");
const TEXT_BIG = Buffer.from("x".repeat(30 * 1024)).toString("base64");
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0xfe]).toString("base64");

let step = 0;
const results = { refSmall: false, refBig: false, bin: false, uploads: false };
let uploadDir = null;
const timer = setTimeout(() => {
	console.error("TIMEOUT — missing:", JSON.stringify(results));
	process.exit(1);
}, 60000);

const RUN = randomUUID().slice(0, 8);
const SMALL = `small-${RUN}.txt`;
const BIG = `big-${RUN}.txt`;
const BIN = `bin-${RUN}.dat`;

function log(...a) {
	console.log(`[file-upload ${step}]`, ...a);
}

ws.on("open", () => {
	log("open, sending hello");
	ws.send(JSON.stringify({ type: "hello", clientId }));
});

ws.on("message", async (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, sending prompt with 3 uploaded files");
		step = 1;
		ws.send(
			JSON.stringify({
				type: "prompt",
				text: "看看这些文件",
				attachments: [
					{ path: "", fileData: TEXT_SMALL, name: SMALL, size: 0 },
					{ path: "", fileData: TEXT_BIG, name: BIG, size: 0 },
					{ path: "", fileData: BINARY, name: BIN, size: 0 },
				],
			}),
		);
		const poll = setInterval(() => {
			try {
				ws.send(JSON.stringify({ type: "get_state" }));
			} catch {}
		}, 700);
		ws.on("close", () => clearInterval(poll));
	} else if (m.type === "snapshot") {
		for (const msg of m.state?.messages ?? []) {
			if (msg.customType !== "file") continue;
			const name = msg.details?.name;
			if (name === SMALL && msg.details?.mode === "reference" && !results.refSmall) {
				const text = (msg.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
				if (text.includes("path=") && !text.includes("你好") && !text.includes("second line")) {
					results.refSmall = true;
					if (typeof msg.details.path === "string") {
						uploadDir = msg.details.path.replace(/[\\/][^\\/]+$/, "");
					}
					log("OK: small text referenced (content not injected):", name, msg.details.path, msg.details.size);
				}
			}
			if (name === BIG && msg.details?.mode === "reference" && !results.refBig) {
				results.refBig = true;
				log("OK: 30KB text referenced:", name, msg.details.path, msg.details.size);
			}
			if (name === BIN && msg.details?.mode === "reference" && !results.bin) {
				results.bin = true;
				log("OK: binary referenced:", name, msg.details.path, msg.details.size);
			}
		}
	} else if (m.type === "notice") {
		log("notice:", m.level, m.text);
	}

	if (results.refSmall && results.refBig && results.bin) {
		clearTimeout(timer);
		log("PASS — checking uploads dir on disk");
		const { readdirSync } = await import("node:fs");
		try {
			const files = uploadDir ? readdirSync(uploadDir) : [];
			if (files.length >= 3) {
				results.uploads = true;
				log("OK: uploads persisted:", uploadDir, "->", files.join(", "));
			}
		} catch {}
		log(results.uploads ? "PASS (all)" : "WARN: could not verify uploads dir");
		ws.send(JSON.stringify({ type: "abort" }));
		ws.close();
		process.exit(results.uploads ? 0 : 1);
	}
});

ws.on("error", (e) => {
	console.error("ws error:", e.message);
	process.exit(1);
});
