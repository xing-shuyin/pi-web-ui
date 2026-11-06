#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFile, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
	console.error("Usage: node assets/readme/build-media.mjs <recording-directory>");
	console.error("Expected: workspace-frames/00000.png and canvas-frames/00000.png (6 fps).");
	process.exit(1);
}
const input = resolve(source);
const output = dirname(fileURLToPath(import.meta.url));
const fps = 6;
const recordings = ["workspace", "canvas"];
const counts = await Promise.all(
	recordings.map(async (name) => {
		const files = (await readdir(join(input, `${name}-frames`))).filter((file) => /^\d{5}\.png$/.test(file)).sort();
		if (!files.length || files.some((file, i) => file !== `${String(i).padStart(5, "0")}.png`)) {
			throw new Error(`${name}-frames must contain sequential PNG files starting at 00000.png`);
		}
		return files.length;
	}),
);

function ffmpeg(args) {
	return new Promise((accept, reject) => {
		const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let error = "";
		child.stderr.on("data", (data) => {
			error = (error + data).slice(-8000);
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? accept() : reject(new Error(error || `ffmpeg exited ${code}`))));
	});
}

for (const [i, name] of recordings.entries()) {
	console.log(`Building ${name}.gif (${counts[i]} frames)…`);
	await ffmpeg([
		"-framerate",
		String(fps),
		"-i",
		join(input, `${name}-frames`, "%05d.png"),
		"-filter_complex_threads",
		"1",
		"-filter_complex",
		"[0:v]scale=1080:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
		"-loop",
		"0",
		join(output, `${name}.gif`),
	]);
	const posterFrame = String(Math.min(i === 0 ? 14 : counts[i] - 1, counts[i] - 1)).padStart(5, "0");
	await copyFile(join(input, `${name}-frames`, `${posterFrame}.png`), join(output, `${name}-poster.png`));
}

console.log("Building showcase.mp4…");
await ffmpeg([
	"-framerate",
	String(fps),
	"-i",
	join(input, "workspace-frames", "%05d.png"),
	"-framerate",
	String(fps),
	"-i",
	join(input, "canvas-frames", "%05d.png"),
	"-filter_complex_threads",
	"1",
	"-filter_complex",
	"[0:v]setsar=1,setpts=PTS-STARTPTS[a];[1:v]setsar=1,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0,fps=24,format=yuv420p[out]",
	"-map",
	"[out]",
	"-c:v",
	"libx264",
	"-preset",
	"medium",
	"-crf",
	"20",
	"-movflags",
	"+faststart",
	join(output, "showcase.mp4"),
]);
console.log(`Done: ${output}`);
