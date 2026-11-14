import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rmdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
export const desktopInstallInputs = [
	"desktop-service/install.ps1",
	"desktop-service/NativeDesktop.cs",
	"desktop-service/Native.cs",
	"desktop-service/DesktopVideo.cs",
	"desktop-service/DesktopEncoder.cs",
	"desktop-service/DesktopHardware.cs",
	"desktop-service/DesktopWgc.cs",
	"desktop-service/DesktopUserVideo.cs",
	"desktop-service/Service.cs",
	"ffmpeg/win32-x64/build.json",
	"ffmpeg/win32-x64/nvenc-compat/build.json",
	"desktop-codec/win32-x64/build.json",
];
export async function desktopInstallFingerprint(directory = root) {
	const hashes = await Promise.all(
		desktopInstallInputs.map(async (name) =>
			createHash("sha256")
				.update(await readFile(join(directory, name)))
				.digest("hex"),
		),
	);
	return createHash("sha256").update(hashes.join("\n")).digest("hex");
}
export function shouldBootstrapDesktop({
	platform = process.platform,
	arch = process.arch,
	env = process.env,
	interactive = !!process.stdout.isTTY,
	reason = "start",
} = {}) {
	return (
		platform === "win32" &&
		arch === "x64" &&
		!env.CI &&
		env.SESSIONNAME !== "Services" &&
		env.PI_DESKTOP_SERVICE_AUTO !== "0" &&
		(reason === "install" ? env.npm_config_global === "true" : interactive)
	);
}
export async function runDesktopServiceInstaller(action) {
	if (!["install", "uninstall"].includes(action)) throw new Error("Invalid desktop service action");
	const command = join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
	await new Promise((resolve, reject) => {
		const child = spawn(
			command,
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(root, "desktop-service/elevate.ps1"),
				"-Action",
				action,
			],
			{ windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
		);
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Desktop service installation timed out"));
		}, 180_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			code === 0
				? resolve()
				: reject(Object.assign(new Error(`Desktop service installation cancelled or failed (${code})`), { code }));
		});
	});
}
// Shared by npm and interactive launch. Background launches never display UAC.
export async function ensureDesktopService(options = {}) {
	if (!shouldBootstrapDesktop(options)) return "skipped";
	const installDir = options.installDir ?? join(process.env.ProgramFiles || "C:\\Program Files", "pi-web-ui-desktop");
	const stateDir =
		options.stateDir ??
		join(process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "pi-web-ui", "desktop-install");
	let lockOwned = false;
	let attempted;
	const lock = join(stateDir, "lock");
	try {
		try {
			await readFile(join(installDir, "auto-disabled"));
			return "disabled";
		} catch {}
		const fingerprint = await (options.fingerprint ?? desktopInstallFingerprint)();
		try {
			if (
				(await readFile(join(installDir, "source.sha256"), "utf8")).trim() === fingerprint &&
				(await readFile(join(installDir, "enabled"), "utf8")).trim() === "1"
			)
				return "current";
		} catch {}
		await mkdir(stateDir, { recursive: true });
		// One attempt per package fingerprint, even after UAC cancellation. Explicit install can retry.
		const attempt = join(stateDir, fingerprint + ".attempt");
		try {
			await readFile(attempt);
			return "deferred";
		} catch {}
		try {
			await mkdir(lock);
			lockOwned = true;
		} catch {
			if (Date.now() - (await stat(lock)).mtimeMs > 300_000) await rmdir(lock);
			return "busy";
		}
		await writeFile(attempt, new Date().toISOString(), { flag: "wx" });
		attempted = attempt;
		console.error(
			"[desktop] Installing/updating the built-in remote desktop component. Confirm the Windows administrator prompt.",
		);
		await (options.install ?? runDesktopServiceInstaller)("install");
		return "installed";
	} catch (error) {
		if (error.code === 42 && attempted) {
			await unlink(attempted).catch(() => {});
			return "skipped";
		}
		console.error(`[desktop] ${error.message}. pi-web-ui can still start with user-session capture.`);
		return "failed";
	} finally {
		if (lockOwned) await rmdir(lock).catch(() => {});
	}
}
