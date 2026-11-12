import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "bin/device-p2p");
const platforms = [
	["win32", "x64", "windows", "amd64"],
	["darwin", "arm64", "darwin", "arm64"],
	["darwin", "x64", "darwin", "amd64"],
	["linux", "x64", "linux", "amd64"],
	["linux", "arm64", "linux", "arm64"],
];
await mkdir(out, { recursive: true });
const checksums = {};
const selected = process.argv.includes("--host")
	? platforms.filter(([platform, arch]) => platform === process.platform && arch === process.arch)
	: platforms;
if (!selected.length) throw new Error("Unsupported P2P helper host");
for (const [platform, arch, GOOS, GOARCH] of selected) {
	const name = `${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
	await new Promise((resolve, reject) => {
		const child = spawn(
			process.env.PI_DEVICE_P2P_GO || "go",
			["build", "-trimpath", "-ldflags=-s -w", "-o", join(out, name), "."],
			{
				cwd: join(root, "native/device-p2p"),
				env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: "0", GOTOOLCHAIN: "local" },
				stdio: "inherit",
				windowsHide: true,
			},
		);
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`P2P helper build failed: ${name}`))));
	});
	await chmod(join(out, name), 0o755);
	checksums[name] = createHash("sha256")
		.update(await readFile(join(out, name)))
		.digest("hex");
	console.log(`Built ${name}`);
}
await writeFile(join(out, "checksums.json"), JSON.stringify(checksums, null, 2) + "\n");
await copyFile(join(root, "native/device-p2p/THIRD_PARTY_NOTICES.txt"), join(out, "THIRD_PARTY_NOTICES.txt"));
