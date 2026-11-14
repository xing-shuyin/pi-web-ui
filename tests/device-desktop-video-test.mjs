// Manual integration: bundled FFmpeg -> H.264 -> the real desktop viewer in Chrome.
// Synthetic pixels validate the codec/resize path; they are not a desktop FPS benchmark.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { WebSocketServer } from "ws";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { desktopPage } from "../server/device-center/desktop-page.ts";
import { resolveFfmpeg } from "../server/device-center/ffmpeg-path.ts";
import {
	rawVideoArguments,
	selectDesktopVideoRuntime,
	h264Codec,
} from "../server/device-center/desktop-video-encoder.ts";
import { createH264Splitter } from "../server/device-center/desktop-video.ts";

const embedded = resolveFfmpeg();
assert.ok(embedded, "Build the embedded encoder before this manual test");
const selected = await selectDesktopVideoRuntime(embedded);
assert.ok(selected, "No usable H.264 encoder");
const { path: binary, encoder } = selected;
async function encode(width, height, fps, color) {
	const child = spawn(binary, rawVideoArguments(encoder, width, height, { maxEdge: 1920, quality: 70, fps }), {
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const frames = [];
	const split = createH264Splitter((frame) => frames.push(frame));
	let stderr = "";
	child.stdout.on("data", split);
	child.stderr.on("data", (bytes) => {
		stderr += bytes;
	});
	const done = once(child, "exit");
	child.stdin.on("error", () => {});
	const pixels = Buffer.alloc(width * height * 4 * 12);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		pixels[offset] = color[2];
		pixels[offset + 1] = color[1];
		pixels[offset + 2] = color[0];
		pixels[offset + 3] = 255;
	}
	child.stdin.end(pixels);
	const [code] = await done;
	assert.equal(code, 0, stderr);
	split(Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 9, 0xf0]));
	assert.ok(frames.length >= 10, `Only ${frames.length} encoded frames`);
	assert.ok(frames[0].key);
	return { frames, codec: h264Codec(frames[0].data), width, height, fps };
}
const samples = [
	await encode(640, 360, 60, [255, 0, 0]),
	await encode(960, 540, 120, [0, 255, 0]),
	await encode(1280, 720, 240, [0, 0, 255]),
];
let socket,
	requestedVideo = false;
const server = createServer((req, res) => {
	if (req.url?.startsWith("/desktop")) {
		res.setHeader("content-type", "text/html");
		res.end(desktopPage());
	} else {
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				enabled: true,
				available: true,
				environmentEnabled: false,
				supported: true,
				os: "win32",
				backend: "synthetic",
			}),
		);
	}
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, connection, head) =>
	wss.handleUpgrade(req, connection, head, (ws) => {
		socket = ws;
		requestedVideo = new URL(req.url, "http://localhost").searchParams.get("video") === "1";
		ws.on("error", () => {});
		ws.on("message", () => {});
	}),
);
let browser;
try {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	assert.ok(port >= 8900);
	browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ["--no-sandbox"] });
	const page = await browser.newPage();
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${port}/desktop`);
	await page.waitForFunction(() => typeof VideoDecoder === "function");
	await page.waitForFunction(() => document.querySelector("#disconnect").disabled === false);
	assert.ok(socket);
	assert.ok(requestedVideo, "Viewer did not negotiate video");
	for (const sample of samples) {
		socket.send(JSON.stringify({ type: "video", codec: sample.codec }));
		socket.send(JSON.stringify({ type: "ready", dynamicQuality: true, video: true }));
		for (const frame of sample.frames) socket.send(frame.data, { binary: true });
		await page.waitForFunction(
			({ width, height }) => {
				const canvas = document.querySelector("#canvas");
				return (
					canvas.width === width &&
					canvas.height === height &&
					canvas.getContext("2d").getImageData(0, 0, 1, 1).data[3] > 0
				);
			},
			sample,
			{ timeout: 5000 },
		);
	}
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify(
			{
				ok: true,
				encoder,
				checks: ["real H.264 encode/decode", "60/120/240 FPS profiles accepted", "resolution changes in one viewer"],
				scope: "synthetic pixels; not capture performance, NAT or lock-screen verification",
			},
			null,
			2,
		),
	);
} finally {
	await browser?.close();
	for (const client of wss.clients) client.terminate();
	wss.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}
