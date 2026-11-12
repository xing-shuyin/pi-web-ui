import { createHash } from "node:crypto";
import type { DesktopProfile } from "./desktop-quality.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeDesktopHandle, NativeDesktopOptions } from "./desktop-native.js";

/** Only the administrator-installed, protected binary is eligible for system desktop capture. */
export function windowsDesktopServicePath(): string | undefined {
	if (process.platform !== "win32") return;
	const path = join(
		process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files",
		"pi-web-ui-desktop",
		"PiDesktopService.exe",
	);
	return existsSync(path) && existsSync(join(path, "..", "enabled")) ? path : undefined;
}

/** Bind capability to the installed binary, so an old/rolled-back service receives no new commands. */
export function windowsDesktopServiceProfiles(path: string): boolean {
	try {
		return (
			readFileSync(join(path, "..", "profile-v1"), "utf8")
				.trim()
				.toLowerCase() === createHash("sha256").update(readFileSync(path)).digest("hex")
		);
	} catch {
		return false;
	}
}

/** Session changes replace the SYSTEM worker, not the authenticated browser connection. */
export function startWindowsServiceDesktop(
	options: NativeDesktopOptions,
	start: (options: NativeDesktopOptions) => NativeDesktopHandle,
): NativeDesktopHandle {
	// Freeze the mode across retries; never replay input from the previous Windows desktop.
	const mode = { readOnly: options.preview === true || options.readOnly !== false, preview: options.preview === true };
	let current: NativeDesktopHandle | undefined;
	let profile: DesktopProfile | undefined;
	let closed = false;
	let generation = 0;
	let attempts = 0;
	let lastError = "Windows desktop session changed.";
	let retry: ReturnType<typeof setTimeout> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;

	function close(error?: string) {
		if (closed) return;
		closed = true;
		generation++;
		clearTimeout(retry);
		clearTimeout(deadline);
		const previous = current;
		current = undefined;
		try {
			previous?.close();
			if (error) options.onError(error);
		} finally {
			options.onClose();
		}
	}
	function interrupted() {
		if (deadline) return;
		deadline = setTimeout(() => close(`WINDOWS_DESKTOP_UNAVAILABLE: ${lastError}`), 30000);
		deadline.unref();
	}
	function connect() {
		if (closed) return;
		const id = ++generation;
		let failed = false;
		const next = start({
			...mode,
			onFrame(jpeg) {
				if (closed || failed || id !== generation) return;
				clearTimeout(deadline);
				deadline = undefined;
				attempts = 0;
				options.onFrame(jpeg);
			},
			onError(message) {
				if (closed || id !== generation) return;
				failed = true;
				current = undefined;
				if (
					!message.startsWith("WINDOWS_DESKTOP_UNAVAILABLE:") &&
					!/^Native desktop (helper exited|capture (timed out|stream failed)|input stream closed)/.test(message)
				) {
					close(message);
					return;
				}
				lastError = message.replace(/^(WINDOWS_DESKTOP_UNAVAILABLE:\s*)+/, "");
				interrupted();
			},
			onClose() {
				if (closed || id !== generation) return;
				generation++;
				current = undefined;
				interrupted();
				retry = setTimeout(connect, Math.min(250 * 2 ** attempts++, 2000));
				retry.unref();
			},
		});
		if (closed || failed || id !== generation) next.close();
		else {
			current = next;
			if (profile) current.configure?.(profile);
		}
	}
	connect();
	return {
		...(current?.configure
			? {
					configure(next: DesktopProfile) {
						profile = next;
						if (!closed) current?.configure?.(next);
					},
				}
			: {}),
		input(event) {
			if (!closed && !mode.readOnly) current?.input(event);
		},
		close: () => close(),
	};
}
