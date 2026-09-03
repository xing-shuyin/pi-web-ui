/**
 * image-paste-test.mjs — 纯 WebSocket 冒烟测试：验证「粘贴图片」协议路径。
 *
 * 发送带 imageData（raw base64）附件的 prompt，验证：
 *   1. 服务端把它变成 image content 的 custom message（details.mode === "image"）
 *   2. 快照里该消息的 content 含 { type: "image", dataUrl: "data:image/..." }
 *   3. 超限图片（>2MB）被拒并回 notice
 *
 * 用法（需先有 server 在跑）:
 *   node image-paste-test.mjs   # 连 ws://localhost:${PORT:-8787}
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const PORT = Number(process.env.PI_WEB_PORT ?? 8787);
const WS_URL = `ws://localhost:${PORT}/ws`;

const clientId = randomUUID();
const ws = new WebSocket(WS_URL);

// 1x1 透明 PNG (base64)
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let step = 0;
let sawImageMsg = false;
let sawOversizeNotice = false;
const timer = setTimeout(() => {
	console.error("TIMEOUT — image message not observed");
	process.exit(1);
}, 15000);

function log(...a) {
	console.log(`[image-paste ${step}]`, ...a);
}

ws.on("open", () => {
	log("open, sending hello");
	ws.send(JSON.stringify({ type: "hello", clientId }));
});

ws.on("message", (d) => {
	const m = JSON.parse(d.toString());

	if (m.type === "ready") {
		log("ready, sending prompt with tiny pasted image");
		step = 1;
		ws.send(
			JSON.stringify({
				type: "prompt",
				text: "描述这张图片",
				attachments: [
					{
						path: "",
						imageData: TINY_PNG,
						mimeType: "image/png",
						name: "粘贴测试.png",
						size: 0,
					},
					{
						// 超限：1.5MB 的假 base64（>2MB 解码后）→ 应回 warning notice
						path: "",
						imageData: "A".repeat(3 * 1024 * 1024),
						mimeType: "image/png",
						name: "超大.png",
						size: 0,
					},
				],
			}),
		);
	} else if (m.type === "snapshot") {
		for (const msg of m.state?.messages ?? []) {
			if (msg.customType !== "file") continue;
			if (msg.details?.mode !== "image") continue;
			const img = (msg.content ?? []).find((b) => b.type === "image");
			if (!img) continue;
			if (!String(img.dataUrl ?? "").startsWith("data:image/png;base64,")) {
				console.error("FAIL: image dataUrl prefix wrong:", img.dataUrl?.slice(0, 40));
				process.exit(1);
			}
			sawImageMsg = true;
			log("OK: image custom message in snapshot:", JSON.stringify(msg.details));
		}
	} else if (m.type === "notice") {
		if (m.level === "warning" && m.text.includes("超大.png")) {
			sawOversizeNotice = true;
			log("OK: oversize notice:", m.text);
		} else {
			log("notice:", m.level, m.text);
		}
	} else if (m.type === "heartbeat") {
		// ignore
	}

	if (sawImageMsg && sawOversizeNotice) {
		clearTimeout(timer);
		log("PASS");
		ws.send(JSON.stringify({ type: "abort" }));
		ws.close();
		process.exit(0);
	}
});

ws.on("error", (e) => {
	console.error("ws error:", e.message);
	process.exit(1);
});
