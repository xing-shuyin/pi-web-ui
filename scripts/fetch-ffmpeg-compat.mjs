import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopPatchRevision } from "./patch-ffmpeg-desktop.mjs";

/** Require locally built and verified assets; do not depend on a contributor's release. */
export async function ensureCompatibleFfmpeg(directory) {
	const target = join(directory, "nvenc-compat");
	try {
		const manifest = JSON.parse(await readFile(join(target, "build.json"), "utf8"));
		const binary = await readFile(join(target, "ffmpeg.exe"));
		if (
			manifest.sourceRevision !== "986bab2b47540c3d45d1299a40a3b103b344323c" ||
			manifest.desktopPatchRevision !== desktopPatchRevision ||
			manifest.binarySha256 !== createHash("sha256").update(binary).digest("hex")
		)
			throw new Error("checksum or source mismatch");
		for (const name of [
			"LICENSE.txt",
			"THIRD_PARTY_NOTICES.txt",
			"NVIDIA-CODEC-HEADERS-LICENSE.h",
			"INTEL-VPL-LICENSE.txt",
			"AMD-AMF-LICENSE.h",
		])
			await readFile(join(target, name));
		console.log("[ffmpeg] Verified locally built compatibility runtime");
	} catch {
		throw new Error(
			"Native desktop assets are missing or invalid. On a Windows x64 build host, run npm run build:desktop-codec before packaging.",
		);
	}
}
