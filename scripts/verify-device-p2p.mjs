import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const names = ["win32-x64.exe", "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const base = new URL("../bin/device-p2p/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("checksums.json", base), "utf8"));
if (!(await readFile(new URL("THIRD_PARTY_NOTICES.txt", base), "utf8")).includes("Go runtime"))
	throw new Error("Missing P2P dependency notices");
for (const name of names) {
	const bytes = await readFile(new URL(name, base));
	if (createHash("sha256").update(bytes).digest("hex") !== manifest[name])
		throw new Error(`Invalid P2P helper: ${name}`);
}
console.log("Verified five P2P helper binaries");
