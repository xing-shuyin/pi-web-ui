import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bundleNativeDesktopCodec, nativeDesktopSourceInputs } from "../../scripts/bundle-native-desktop-codec.mjs";
import { verifyDesktopCodec } from "../../scripts/verify-desktop-codec.mjs";
import { ensureCompatibleFfmpeg } from "../../scripts/fetch-ffmpeg-compat.mjs";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
it("requires a matching native binary and intact source and relink material before release", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-codec-package-"));
	roots.push(root);
	const build = join(root, "build"),
		output = join(root, "bin/desktop-codec/win32-x64");
	await mkdir(output, { recursive: true });
	await expect(verifyDesktopCodec(root)).rejects.toThrow();
	for (const source of nativeDesktopSourceInputs) {
		const file = join(build, source);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, source);
	}
	const binary = Buffer.from("test native codec");
	await writeFile(join(output, "pi-desktop-codec.dll"), binary);
	await writeFile(join(output, "build.json"), JSON.stringify({ backend: "native-d3d11", binarySha256: hash(binary) }));
	await writeFile(join(output, "COPYING.LGPLv2.1"), "license");
	await writeFile(join(output, "README.md"), "source instructions");
	await bundleNativeDesktopCodec(build, output);
	await expect(verifyDesktopCodec(root)).resolves.toBeUndefined();
	const material = join(output, "relink", basename(nativeDesktopSourceInputs[0]));
	await writeFile(material, "changed");
	await expect(verifyDesktopCodec(root)).rejects.toThrow(/Relink material checksum mismatch/);
	expect(await readFile(join(output, "relink", "README.txt"), "utf8")).toContain("replaceable");
});
it("requires a locally built compatible FFmpeg instead of fetching a contributor's release", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-compat-package-"));
	roots.push(root);
	await expect(ensureCompatibleFfmpeg(root)).rejects.toThrow(/npm run build:desktop-codec/);
	const dir = join(root, "nvenc-compat"),
		binary = Buffer.from("test encoder");
	await mkdir(dir);
	await writeFile(join(dir, "ffmpeg.exe"), binary);
	await writeFile(
		join(dir, "build.json"),
		JSON.stringify({
			sourceRevision: "986bab2b47540c3d45d1299a40a3b103b344323c",
			desktopPatchRevision: "desktop-timing-v2",
			binarySha256: hash(binary),
		}),
	);
	for (const name of [
		"LICENSE.txt",
		"THIRD_PARTY_NOTICES.txt",
		"NVIDIA-CODEC-HEADERS-LICENSE.h",
		"INTEL-VPL-LICENSE.txt",
		"AMD-AMF-LICENSE.h",
	])
		await writeFile(join(dir, name), "notice");
	await expect(ensureCompatibleFfmpeg(root)).resolves.toBeUndefined();
	await writeFile(join(dir, "ffmpeg.exe"), "modified");
	await expect(ensureCompatibleFfmpeg(root)).rejects.toThrow(/missing or invalid/);
});
