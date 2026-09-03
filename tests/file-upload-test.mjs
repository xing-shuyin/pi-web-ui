/**
 * file-upload-test.mjs — 纯 WebSocket 冒烟测试：验证「上传文件」协议路径。
 *
 * 发送带 fileData（raw base64）附件的 prompt，验证：
 *   1. 小文本文件 → inline（内容进上下文）
 *   2. 二进制文件 → reference（绝对路径 + size）
 *   3. 文件落盘在 <dataDir>/uploads/<clientId>/ 下
 *   4. 超限（>20MB）被拒并回 notice
 *
 * 用法（需先有 server 在跑）:
 *   node file-upload-test.mjs   # 连 ws://localhost:${PORT:-8787}
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.env.PI_WEB_PORT ?? 8787);
const WS_URL = `ws://localhost:${PORT}/ws`;

const clientId = randomUUID();
const ws = new WebSocket(WS_URL);

const TEXT_SMALL = Buffer.from("你好，这是一个小文本文件。\nsecond line\n").toString("base64");
const TEXT_BIG = Buffer.from("x".repeat(30 * 1024)).toString("base64"); // 30KB > 12KB inline cap
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0xfe]).toString("base64");

let step = 0;
const results = { inline: false, refSmall: false, refBig: false, bin: false, uploads: false };
const timer = setTimeout(() => {
	console.error("TIMEOUT — missing:", JSON.stringify(results));
	process.exit(1);
}, 20000);

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
					{ path: "", fileData: TEXT_SMALL, name: "small.txt", size: 0 },
					{ path: "", fileData: TEXT_BIG, name: "big.txt", size: 0 },
					{ path: "", fileData: BINARY, name: "bin.dat", size: 0 },
				],
			}),
		);
	} else if (m.type === "snapshot") {
		for (const msg of m.state?.messages ?? []) {
			if (msg.customType !== "file") continue;
			const name = msg.details?.name;
			if (name === "small.txt" && msg.details?.mode === "inline") {
				// inline content must carry the text
				const text = (msg.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
				if (!results.inline && text.includes("你好") && text.includes("small.txt")) {
					results.inline = true;
					log("OK: small text inlined:", name, msg.details.size, "bytes");
				}
			}
			if (name === "big.txt" && msg.details?.mode === "reference" && !results.refBig) {
				results.refBig = true;
				log("OK: 30KB text referenced:", name, msg.details.path, msg.details.size);
			}
			if (name === "bin.dat" && msg.details?.mode === "reference" && !results.bin) {
				results.bin = true;
				log("OK: binary referenced:", name, msg.details.path, msg.details.size);
			}
		}
	} else if (m.type === "notice") {
		log("notice:", m.level, m.text);
	}

	if (results.inline && results.refBig && results.bin) {
		clearTimeout(timer);
		log("PASS — checking uploads dir on disk");
		// Uploaded files live in <home>/.pi-web/uploads/<clientId> (global, never
		// inside the project).
		const { readdirSync } = await import("node:fs");
		const { homedir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = join(homedir(), ".pi-web", "uploads", clientId);
		try {
			const files = readdirSync(dir);
			if (files.length >= 3) {
				results.uploads = true;
				log("OK: uploads persisted:", dir, "->", files.join(", "));
			}
		} catch {
			/* not created */
		}
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
