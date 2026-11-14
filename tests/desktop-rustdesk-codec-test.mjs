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
	await run(resolve(".safe-exec/ffmpeg-compat-build/w64devkit/bin/g++.exe"), [
		"-std=c++17",
		"-O2",
		"-static",
		resolve("tests/desktop-rustdesk-codec-test.cpp"),
		"-ld3d11",
		"-ldxgi",
		"-o",
		exe,
	]);
	const result = await run(exe, [dll]);
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
			"scale=1:1",
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
	assert.equal(decoded.data.length, 120 * 3, decoded.errors + result.errors);
	const expected = [
		[255, 0, 0],
		[0, 255, 0],
		[0, 0, 255],
		[255, 255, 255],
		[0, 0, 0],
	];
	for (let i = 0; i < 120; i++)
		for (let c = 0; c < 3; c++)
			assert.ok(
				Math.abs(decoded.data[i * 3 + c] - expected[i % 5][c]) <= 12,
				`Color or frame order mismatch: frame ${i} channel ${c}: ${decoded.data[i * 3 + c]}`,
			);
	console.log(
		JSON.stringify({
			ok: true,
			frames: 120,
			scope:
				"real hardware codec, generated GPU textures, scaling, live bitrate/FPS change and decoded colors; not desktop/network FPS",
			native: result.errors.trim(),
		}),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
