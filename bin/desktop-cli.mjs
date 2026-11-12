import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function consoleArguments(args) {
	if (
		args.length < 1 ||
		args[0] !== "console" ||
		args.length > 2 ||
		(args[1] && !["--check", "--confirm"].includes(args[1]))
	)
		throw new Error("Usage: pi-web-ui desktop console [--check | --confirm]");
	return args[1] === "--confirm" ? ["-Apply"] : [];
}

export async function runDesktopCli(args) {
	const flags = consoleArguments(args);
	if (process.platform !== "win32") throw new Error("This command is only for Windows RDP sessions.");
	if (flags.length)
		console.error(
			"Moving this RDP session to the physical console. RDP will disconnect; the local desktop will remain logged in and accessible.",
		);
	const command = join(
		process.env.SystemRoot || "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	await new Promise((resolve, reject) => {
		const child = spawn(
			command,
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				fileURLToPath(new URL("./windows-desktop-console.ps1", import.meta.url)),
				...flags,
			],
			{ windowsHide: true, stdio: ["ignore", "inherit", "inherit"] },
		);
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Desktop session command timed out."));
		}, 30000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`Desktop session command failed (${code}).`));
		});
	});
}
