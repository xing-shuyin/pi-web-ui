import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, access, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { macDesktopScript } from "./macos.js";

let building: Promise<string> | undefined;
/** Permission requests and capture run the identical executable, across reconnects and Node updates. */
export function macDesktopHelper(): Promise<string> {
	if (process.platform !== "darwin") return Promise.reject(new Error("macOS desktop helper requires macOS."));
	return (building ??= build().catch((error) => {
		building = undefined;
		throw error;
	}));
}
async function build(): Promise<string> {
	const directory = join(homedir(), "Library", "Application Support", "pi-web-ui", "native-desktop");
	const executable = join(directory, "PiWebDesktop"),
		stamp = join(directory, "source.sha256");
	const hash = createHash("sha256").update(process.arch).update(macDesktopScript).digest("hex");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		if ((await readFile(stamp, "utf8")) === hash) {
			await access(executable);
			return executable;
		}
	} catch {}
	const stage = await mkdtemp(join(directory, "build-"));
	try {
		const source = join(stage, "main.swift"),
			output = join(stage, "PiWebDesktop");
		await writeFile(source, macDesktopScript, { mode: 0o600 });
		await new Promise<void>((resolve, reject) => {
			const child = spawn("/usr/bin/xcrun", ["swiftc", "-O", "-module-name", "PiWebDesktop", source, "-o", output], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			let errors = "";
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(
					new Error(
						"MAC_DESKTOP_BUILD_FAILED: Desktop helper compilation timed out. Check Apple Command Line Tools on this Mac.",
					),
				);
			}, 120_000);
			timeout.unref();
			child.stderr.on("data", (data) => {
				errors = (errors + data.toString()).slice(-8192);
			});
			child.on("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.on("close", (code) => {
				clearTimeout(timeout);
				if (code === 0) resolve();
				else reject(new Error("MAC_DESKTOP_BUILD_FAILED: " + errors.trim()));
			});
		});
		await chmod(output, 0o700);
		await rename(output, executable);
		await writeFile(stamp, hash, { mode: 0o600 });
		return executable;
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}
