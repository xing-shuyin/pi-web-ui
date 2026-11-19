import { chromium } from "playwright-core";
import { CHROME_PATH } from "./lib/chrome.mjs";
import { createH264Splitter, h264Codec } from "../server/device-center/desktop-video.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const root = process.cwd(),
	directory = await mkdtemp(join(tmpdir(), "pi-rustdesk-codec-"));
function run(command, args, input) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		let errors = "";
		const output = [];
		child.stdout.on("data", (b) => output.push(b));
		child.stderr.on("data", (b) => (errors += b));
		const timer = setTimeout(() => child.kill(), 45000);
		child.on("error", reject);
		child.on("exit", (code) => {
			clearTimeout(timer);
			code === 0
				? resolveRun({ data: Buffer.concat(output), errors })
				: reject(new Error(`Native codec test failed (${code}): ${errors}`));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}
try {
	const dll = resolve("bin/desktop-codec/win32-x64/pi-desktop-codec.dll");
	const manifest = JSON.parse(await readFile(resolve("bin/desktop-codec/win32-x64/build.json"), "utf8"));
	assert.equal(
		createHash("sha256")
			.update(await readFile(dll))
			.digest("hex"),
		manifest.binarySha256,
	);
	const exe = join(directory, "test.exe");
	await run(resolve(process.env.PI_FFMPEG_BUILD_DIR || ".safe-exec/ffmpeg-compat-build", "w64devkit/bin/g++.exe"), [
		"-std=c++17",
		"-O2",
		"-static",
		resolve("tests/desktop-rustdesk-codec-test.cpp"),
		"-ld3d11",
		"-ldxgi",
		"-o",
		exe,
	]);
	for (const range of [0, 1]) {
		const result = await run(exe, [dll, String(range)]);
		const decoded = await run(
			resolve("bin/ffmpeg/win32-x64/ffmpeg.exe"),
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"h264",
				"-i",
				"pipe:0",
				"-vf",
				"crop=2:2:100:100,format=rgb24",
				"-fps_mode",
				"passthrough",
				"-pix_fmt",
				"rgb24",
				"-f",
				"rawvideo",
				"pipe:1",
			],
			result.data,
		);
		assert.equal(decoded.data.length, 120 * 12, decoded.errors + result.errors);
		const expected = [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[255, 255, 255],
			[0, 0, 0],
			[128, 128, 128],
			[32, 32, 32],
			[255, 128, 64],
			[64, 128, 191],
			[191, 64, 128],
		];
		const colorAt = (i) => expected[(i === 19 ? 18 : i) % 10];
		for (let i = 0; i < 120; i++)
			for (let c = 0; c < 3; c++)
				assert.ok(
					Math.abs(decoded.data[i * 12 + c] - colorAt(i)[c]) <= 12,
					`Color or frame order mismatch: frame ${i} channel ${c}: ${decoded.data[i * 12 + c]}`,
				);
		const units = [];
		const splitter = createH264Splitter((frame) => units.push({ data: [...frame.data], key: frame.key }));
		splitter(result.data);
		splitter(Buffer.from([0, 0, 1, 9, 0xf0, 0, 0, 1, 9, 0xf0]));
		const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
		try {
			const page = await browser.newPage();
			await page.route("http://localhost:8997/**", (route) =>
				route.fulfill({ contentType: "text/html", body: "<canvas width=1280 height=720></canvas>" }),
			);
			await page.goto("http://localhost:8997/");
			const colors = await page.evaluate(
				async ({ units, codec }) => {
					const canvas = document.querySelector("canvas"),
						ctx = canvas.getContext("2d", { colorSpace: "srgb" });
					const colors = [];
					let error;
					const decoder = new VideoDecoder({
						output: (frame) => {
							ctx.drawImage(frame, 0, 0);
							colors.push([...ctx.getImageData(100, 100, 1, 1).data].slice(0, 3));
							frame.close();
						},
						error: (e) => {
							error = e.message;
						},
					});
					decoder.configure({ codec, hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } });
					for (let i = 0; i < units.length; i++) {
						decoder.decode(
							new EncodedVideoChunk({
								type: units[i].key ? "key" : "delta",
								timestamp: i * 10000,
								data: new Uint8Array(units[i].data),
							}),
						);
						while (decoder.decodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
					}
					await decoder.flush();
					decoder.close();
					if (error) throw Error(error);
					return colors;
				},
				{ units, codec: h264Codec(result.data) },
			);
			assert.equal(colors.length, 120);
			for (let i = 0; i < colors.length; i++)
				for (let c = 0; c < 3; c++)
					assert.ok(
						Math.abs(colors[i][c] - colorAt(i)[c]) <= 12,
						`Browser range=${range} frame=${i} expected=${colorAt(i)}, got=${colors[i]}`,
					);
		} finally {
			await browser.close();
		}
		console.log(
			JSON.stringify({
				ok: true,
				range,
				browserColors: true,
				frames: 120,
				scope:
					"real hardware codec, generated GPU textures, scaling, live bitrate/FPS change and decoded colors; not desktop/network FPS",
				native: result.errors.trim(),
			}),
		);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
