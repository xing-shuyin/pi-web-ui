import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeDesktopRelinkCodeInputs, nativeDesktopSourceInputs } from "./bundle-native-desktop-codec.mjs";

export async function verifyDesktopCodec(root) {
	const output = join(root, "bin/desktop-codec/win32-x64"),
		relink = join(output, "relink");
	const manifest = JSON.parse(await readFile(join(output, "build.json"), "utf8"));
	const hash = async (file) =>
		createHash("sha256")
			.update(await readFile(file))
			.digest("hex");
	if (
		manifest.backend !== "native-d3d11" ||
		!/^[a-f0-9]{64}$/.test(manifest.binarySha256) ||
		manifest.binarySha256 !== (await hash(join(output, "pi-desktop-codec.dll")))
	)
		throw new Error("Native codec fingerprint mismatch");
	for (const name of ["COPYING.LGPLv2.1", "README.md"]) await readFile(join(output, name));
	const hashes = JSON.parse(await readFile(join(relink, "SHA256.json"), "utf8"));
	for (const name of [
		...nativeDesktopSourceInputs.map((input) => basename(input)),
		...nativeDesktopRelinkCodeInputs.map(([, name]) => name),
	]) {
		if (!/^[a-f0-9]{64}$/.test(hashes[name]) || hashes[name] !== (await hash(join(relink, name))))
			throw new Error("Relink material checksum mismatch: " + name);
	}
	await readFile(join(relink, "README.txt"));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	try {
		await verifyDesktopCodec(root);
		console.log("Verified native desktop codec and relink materials");
	} catch (error) {
		console.error(`[desktop] ${error.message}. On Windows x64 run npm run build:desktop-codec before packaging.`);
		process.exitCode = 1;
	}
}
