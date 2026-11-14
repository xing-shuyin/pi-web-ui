import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const encoder = process.env.PI_DESKTOP_TEST_ENCODER ?? "h264_amf";
assert.ok(["h264_amf", "h264_nvenc", "h264_qsv"].includes(encoder));
const hardware = resolve("bin/ffmpeg/win32-x64/nvenc-compat/ffmpeg.exe");
const decoder = resolve("bin/ffmpeg/win32-x64/ffmpeg.exe");
function run(binary, args, input) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(binary, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
			windowsHide: true,
			stdio: "pipe",
		});
		const output = [];
		let error = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Hardware color test timed out"));
		}, 15000);
		child.stdout.on("data", (bytes) => output.push(bytes));
		child.stderr.on("data", (bytes) => {
			error = (error + bytes).slice(-2048);
		});
		child.stdin.on("error", () => {});
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timer);
			code === 0 ? resolveRun(Buffer.concat(output)) : reject(new Error(error || `Encoder exited ${code}`));
		});
		child.stdin.end(input);
	});
}
for (const [color, expected] of [
	["red", [255, 0, 0]],
	["lime", [0, 255, 0]],
	["blue", [0, 0, 255]],
	["white", [255, 255, 255]],
	["black", [0, 0, 0]],
]) {
	const h264 = await run(hardware, [
		"-init_hw_device",
		"d3d11va=capture:0",
		"-filter_hw_device",
		"capture",
		"-f",
		"lavfi",
		"-i",
		`color=c=${color}:s=1920x1080:r=60`,
		"-vf",
		"format=bgra,hwupload,scale_d3d11=width=1280:height=720:format=nv12" +
			(encoder === "h264_qsv" ? ",hwmap=derive_device=qsv" : ""),
		"-frames:v",
		"3",
		"-c:v",
		encoder,
		"-bf",
		"0",
		"-b:v",
		"8000000",
		"-bsf:v",
		"h264_metadata=aud=insert:matrix_coefficients=1:video_full_range_flag=0",
		"-f",
		"h264",
		"pipe:1",
	]);
	const rgb = await run(
		decoder,
		[
			"-f",
			"h264",
			"-i",
			"pipe:0",
			"-vf",
			"crop=2:2:100:100,format=rgb24",
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"pipe:1",
		],
		h264,
	);
	assert.equal(rgb.length, 12);
	for (let i = 0; i < 3; i++)
		assert.ok(Math.abs(rgb[i] - expected[i]) <= 20, `${color}: expected ${expected}, got ${[...rgb.subarray(0, 3)]}`);
	console.log(JSON.stringify({ color, rgb: [...rgb.subarray(0, 3)], encoder }));
}
