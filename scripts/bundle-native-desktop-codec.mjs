import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const nativeDesktopSourceInputs = [
	"ffmpeg.tar.gz",
	"nv-codec-headers.tar.gz",
	"amf-headers.tar.gz",
	"libvpl.tar.gz",
	"FFmpeg-986bab2b47540c3d45d1299a40a3b103b344323c/libavcodec/libavcodec.a",
	"FFmpeg-986bab2b47540c3d45d1299a40a3b103b344323c/libavutil/libavutil.a",
	"prefix/lib/libvpl.a",
];
export const nativeDesktopRelinkCodeInputs = [
	["native/desktop-codec/ffmpeg-bridge.cpp", "ffmpeg-bridge.cpp"],
	["scripts/build-ffmpeg-compat.mjs", "build-ffmpeg-compat.mjs"],
	["scripts/build-native-desktop-codec.mjs", "build-native-desktop-codec.mjs"],
	["scripts/bundle-native-desktop-codec.mjs", "bundle-native-desktop-codec.mjs"],
	["scripts/patch-ffmpeg-desktop.mjs", "patch-ffmpeg-desktop.mjs"],
	["LICENSE", "PI-ADAPTER-MIT-LICENSE.txt"],
];

/** Ship the exact inputs and relinkable libraries used for this replaceable adapter. */
export async function bundleNativeDesktopCodec(build, output) {
	const target = join(output, "relink");
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	await mkdir(target, { recursive: true });
	const hashes = {};
	for (const source of nativeDesktopSourceInputs) {
		const name = basename(source),
			bytes = await readFile(join(build, source));
		hashes[name] = createHash("sha256").update(bytes).digest("hex");
		await copyFile(join(build, source), join(target, name));
	}
	for (const [source, name] of nativeDesktopRelinkCodeInputs) {
		const bytes = await readFile(join(root, source));
		hashes[name] = createHash("sha256").update(bytes).digest("hex");
		await copyFile(join(root, source), join(target, name));
	}
	await writeFile(join(target, "SHA256.json"), JSON.stringify(hashes, null, 2) + "\n");
	await writeFile(
		join(target, "README.txt"),
		"Exact source archives and static libraries used to build the replaceable pi-desktop-codec.dll. The adapter source and scripts/build-ffmpeg-compat.mjs, scripts/build-native-desktop-codec.mjs and scripts/patch-ffmpeg-desktop.mjs accompany the package. To rebuild on Windows x64, run npm run build:desktop-codec in the corresponding pi-web-ui source tree. See ../COPYING.LGPLv2.1 and ../README.md.\n",
	);
}
