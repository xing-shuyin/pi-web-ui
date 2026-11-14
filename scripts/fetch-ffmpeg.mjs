// Prepare the embedded Windows encoder on any build host. Users never download it separately.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCompatibleFfmpeg } from "./fetch-ffmpeg-compat.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const arg = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const platform = arg("platform") ?? `${process.platform}-${process.arch}`;
const pinned = JSON.parse(await readFile(new URL("./ffmpeg-build.json", import.meta.url), "utf8"));
if (platform !== "win32-x64") {
	console.log(`[ffmpeg] ${platform}: no bundled encoder required`);
	process.exit(0);
}
const url = arg("url") ?? process.env.PI_FFMPEG_URL ?? pinned.url;
const sha256 = arg("sha256") ?? process.env.PI_FFMPEG_SHA256 ?? (url === pinned.url ? pinned.sha256 : "");
if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("A pinned --sha256 is required for the encoder archive");
const directory = join(root, "bin/ffmpeg", platform);
const target = join(directory, "ffmpeg.exe");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let current = false;
try {
	const manifest = JSON.parse(await readFile(join(directory, "build.json"), "utf8"));
	if (
		!args.includes("--force") &&
		manifest.archiveSha256 === sha256 &&
		manifest.binarySha256 === digest(await readFile(target))
	) {
		await readFile(join(directory, "LICENSE.txt"));
		await readFile(join(directory, "THIRD_PARTY_NOTICES.txt"));
		current = true;
	}
} catch {}
if (current) {
	console.log(`[ffmpeg] Verified embedded encoder: ${target}`);
	await ensureCompatibleFfmpeg(directory);
	process.exit(0);
}

function run(command, argv) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, argv, { stdio: "inherit", windowsHide: true });
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
	});
}
async function find(directory, name) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = await find(full, name);
			if (nested) return nested;
		} else if (entry.name.toLowerCase() === name.toLowerCase()) return full;
	}
}
const temporary = await mkdtemp(join(tmpdir(), "pi-ffmpeg-"));
try {
	console.log(`[ffmpeg] Downloading pinned build: ${url}`);
	const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
	if (!response.ok) throw new Error(`Encoder download failed: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (digest(bytes) !== sha256) throw new Error("Encoder archive SHA-256 mismatch");
	const archive = join(temporary, "ffmpeg.zip");
	await writeFile(archive, bytes);
	if (process.platform === "linux") await run("unzip", ["-q", archive, "-d", temporary]);
	else await run("tar", ["-xf", archive, "-C", temporary]);
	const binary = await find(temporary, "ffmpeg.exe");
	const license = await find(temporary, "LICENSE.txt");
	if (!binary || !license) throw new Error("Encoder archive is missing binary or license");
	await mkdir(directory, { recursive: true });
	await copyFile(binary, target);
	await copyFile(license, join(directory, "LICENSE.txt"));
	await writeFile(
		join(directory, "THIRD_PARTY_NOTICES.txt"),
		`FFmpeg standalone encoder, GPL v3 or later. See LICENSE.txt.\nDistributed as a separate process, without changes.\nBuild: ${url}\nBuild recipes and dependencies: https://github.com/FFmpeg-Builds/FFmpeg-Builds\nFFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/${pinned.sourceRevision}\nSource and build details: ${pinned.sourceUrl}\n`,
	);
	await writeFile(
		join(directory, "build.json"),
		JSON.stringify({ url, archiveSha256: sha256, binarySha256: digest(await readFile(target)) }, null, 2) + "\n",
	);
	console.log(`[ffmpeg] Embedded encoder ready: ${target}`);
	await ensureCompatibleFfmpeg(directory);
} finally {
	// temporary is the exact directory returned by mkdtemp, never a caller-supplied path.
	await rm(temporary, { recursive: true, force: true, maxRetries: 2 });
}
