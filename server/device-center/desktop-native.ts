import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rm, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { windowsDesktopScript } from "./native-desktop/windows.js";
import { macDesktopScript } from "./native-desktop/macos.js";

export type NativeDesktopInput =
	| { type: "pointer"; x: number; y: number; button?: 0 | 1 | 2; action: "move" | "down" | "up" }
	| { type: "wheel"; deltaY: number }
	| { type: "key"; code: string; action: "down" | "up" }
	| { type: "text"; text: string }
	| { type: "release" };

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_INPUT_QUEUE = 64 * 1024;
const specialKeys = new Set([
	"Enter",
	"Escape",
	"Backspace",
	"Tab",
	"Space",
	"ShiftLeft",
	"ShiftRight",
	"ControlLeft",
	"ControlRight",
	"AltLeft",
	"AltRight",
	"MetaLeft",
	"MetaRight",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"Insert",
	"Delete",
	"CapsLock",
	"Backquote",
	"Minus",
	"Equal",
	"BracketLeft",
	"BracketRight",
	"Backslash",
	"Semicolon",
	"Quote",
	"Comma",
	"Period",
	"Slash",
]);

function validatedInput(value: NativeDesktopInput): NativeDesktopInput | undefined {
	if (!value || typeof value !== "object") return;
	switch (value.type) {
		case "release":
			return { type: "release" };
		case "pointer":
			if (
				!Number.isFinite(value.x) ||
				!Number.isFinite(value.y) ||
				value.x < 0 ||
				value.x > 1 ||
				value.y < 0 ||
				value.y > 1
			)
				return;
			if (
				!["move", "down", "up"].includes(value.action) ||
				(value.button !== undefined && ![0, 1, 2].includes(value.button))
			)
				return;
			return { type: "pointer", x: value.x, y: value.y, action: value.action, button: value.button ?? 0 };
		case "wheel":
			if (!Number.isFinite(value.deltaY)) return;
			return { type: "wheel", deltaY: Math.max(-1200, Math.min(1200, Math.round(value.deltaY))) };
		case "key":
			if (
				typeof value.code !== "string" ||
				(!specialKeys.has(value.code) && !/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2]))$/.test(value.code))
			)
				return;
			if (value.action !== "down" && value.action !== "up") return;
			return { type: "key", code: value.code, action: value.action };
		case "text":
			if (typeof value.text !== "string" || value.text.length > 4096 || value.text.includes("\0")) return;
			return { type: "text", text: value.text };
	}
}

function powershellPath(): string {
	return join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function nativeDesktopStatus(): { supported: boolean; backend: string; reason?: string } {
	if (process.platform === "win32") {
		return existsSync(powershellPath())
			? { supported: true, backend: "windows-gdi-sendinput" }
			: {
					supported: false,
					backend: "windows-gdi-sendinput",
					reason: "Windows PowerShell 5.1 is required for native desktop capture.",
				};
	}
	if (process.platform === "darwin") {
		if (Number.parseInt(release(), 10) < 23)
			return {
				supported: false,
				backend: "macos-screencapturekit",
				reason: "Native capture requires macOS 14 or newer.",
			};
		let swiftAvailable = false;
		try {
			swiftAvailable = Boolean(
				execFileSync("/usr/bin/xcrun", ["--find", "swift"], {
					encoding: "utf8",
					timeout: 1500,
					maxBuffer: 4096,
					stdio: ["ignore", "pipe", "ignore"],
				}).trim(),
			);
		} catch {}
		return swiftAvailable
			? { supported: true, backend: "macos-screencapturekit" }
			: {
					supported: false,
					backend: "macos-screencapturekit",
					reason:
						"Install/select Apple Command Line Tools (xcode-select --install) or Xcode. Screen Recording permission is required; Accessibility permission is required for control.",
				};
	}
	return {
		supported: false,
		backend: "unsupported",
		reason: "Native desktop capture is unavailable on this platform; Linux requires a separate X11/Wayland backend.",
	};
}

export async function requestNativeDesktopPermissions(
	kind: "screen" | "control",
	signal?: AbortSignal,
): Promise<{ screen: boolean; accessibility: boolean }> {
	if (signal?.aborted) throw new Error("Native desktop permission request aborted.");
	if (process.platform !== "darwin") throw new Error("Native desktop permission requests require macOS.");
	if (kind !== "screen" && kind !== "control") throw new Error("Invalid native desktop permission kind.");
	const status = nativeDesktopStatus();
	if (!status.supported) throw new Error(status.reason);
	return new Promise((resolve, reject) => {
		let directory: string | undefined;
		let child: ChildProcessWithoutNullStreams | undefined;
		let settled = false;
		let closed = false;
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		function cleanup() {
			closed = true;
			clearTimeout(timeout);
			clearTimeout(killTimer);
			signal?.removeEventListener("abort", abort);
			if (directory) rm(directory, { recursive: true, force: true, maxRetries: 2 }, () => {});
		}
		function fail(error: Error) {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			if (child && !closed) {
				child.kill("SIGTERM");
				if (!closed) {
					killTimer = setTimeout(() => child?.kill("SIGKILL"), 1500);
					killTimer.unref();
				}
			}
			reject(error);
		}
		function abort() {
			fail(new Error("Native desktop permission request aborted."));
		}
		try {
			directory = mkdtempSync(join(tmpdir(), "pi-native-desktop-"));
			const path = join(directory, "capture.swift");
			writeFileSync(path, macDesktopScript, { mode: 0o600 });
			child = spawn("/usr/bin/swift", [path, `permissions-${kind}`], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
			child.stdout.on("data", (chunk: Buffer) => {
				if (settled) return;
				if (stdout.length + chunk.length > 4096) {
					fail(new Error("Native desktop permission response exceeds 4 KB."));
					return;
				}
				stdout = Buffer.concat([stdout, chunk]);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (!settled) stderr = Buffer.concat([stderr, chunk.subarray(-8192)]).subarray(-8192);
			});
			child.stdout.on("error", (error) => fail(error));
			child.stderr.on("error", (error) => fail(error));
			child.stdin.on("error", (error) => fail(error));
			child.on("error", (error) => fail(error));
			child.on("close", (code, exitSignal) => {
				cleanup();
				if (settled) return;
				settled = true;
				if (code !== 0 || exitSignal) {
					reject(
						new Error(
							stderr.toString("utf8").trim() || `Native desktop permission helper exited (${exitSignal || code}).`,
						),
					);
					return;
				}
				try {
					const result: unknown = JSON.parse(stdout.toString("utf8"));
					if (
						!result ||
						typeof result !== "object" ||
						!("screen" in result) ||
						!("accessibility" in result) ||
						typeof result.screen !== "boolean" ||
						typeof result.accessibility !== "boolean"
					) {
						throw new Error("Invalid native desktop permission response.");
					}
					resolve({ screen: result.screen, accessibility: result.accessibility });
				} catch {
					reject(new Error("Invalid native desktop permission response."));
				}
			});
			timeout = setTimeout(() => fail(new Error("Native desktop permission request timed out.")), 120000);
			timeout.unref();
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		} catch (error) {
			if (!child) cleanup();
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export function startNativeDesktop(options: {
	onFrame: (jpeg: Buffer) => void;
	onError: (message: string) => void;
	onClose: () => void;
	readOnly?: boolean;
}): { input(event: NativeDesktopInput): void; close(): void } {
	const status = nativeDesktopStatus();
	const readOnly = options.readOnly !== false;
	let child: ChildProcessWithoutNullStreams | undefined;
	let directory: string | undefined;
	let closing = false;
	let finished = false;
	let reported = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	let stderr = "";
	const header = Buffer.alloc(4);
	let headerUsed = 0;
	let frame: Buffer | undefined;
	let frameUsed = 0;

	function finish() {
		if (finished) return;
		finished = true;
		closing = true;
		clearTimeout(timer);
		clearTimeout(watchdog);
		if (directory) rm(directory, { recursive: true, force: true, maxRetries: 2 }, () => {});
		options.onClose();
	}
	function close() {
		if (closing) return;
		closing = true;
		clearTimeout(watchdog);
		frame = undefined;
		if (!child) {
			finish();
			return;
		}
		if (!child.stdin.destroyed) child.stdin.end('{"type":"close"}\n');
		timer = setTimeout(() => {
			child?.kill();
		}, 1500);
		timer.unref();
	}
	function fail(message: string) {
		if (closing || finished) return;
		try {
			if (!reported) {
				reported = true;
				options.onError(message);
			}
		} finally {
			close();
		}
	}
	function write(message: object) {
		if (!child || closing || child.stdin.destroyed) return;
		const line = JSON.stringify(message) + "\n";
		if (child.stdin.writableLength + Buffer.byteLength(line) > MAX_INPUT_QUEUE) {
			fail("Native desktop input consumer stalled; connection closed to release held input.");
			return;
		}
		child.stdin.write(line);
	}
	function armWatchdog() {
		clearTimeout(watchdog);
		watchdog = setTimeout(
			() => fail("Native desktop capture timed out. Check OS permissions and an active desktop session."),
			45000,
		);
		watchdog.unref();
	}
	function receive(chunk: Buffer) {
		if (closing) return;
		let offset = 0;
		while (offset < chunk.length && !closing) {
			if (!frame) {
				const n = Math.min(4 - headerUsed, chunk.length - offset);
				chunk.copy(header, headerUsed, offset, offset + n);
				headerUsed += n;
				offset += n;
				if (headerUsed < 4) continue;
				headerUsed = 0;
				const length = header.readUInt32BE();
				if (length < 4 || length > MAX_FRAME) {
					fail("Invalid native desktop frame length (maximum 4 MB).");
					return;
				}
				frame = Buffer.allocUnsafe(length);
				frameUsed = 0;
			}
			const n = Math.min(frame.length - frameUsed, chunk.length - offset);
			chunk.copy(frame, frameUsed, offset, offset + n);
			frameUsed += n;
			offset += n;
			if (frameUsed === frame.length) {
				const jpeg = frame;
				frame = undefined;
				if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
					fail("Native desktop helper returned an invalid JPEG.");
					return;
				}
				armWatchdog();
				try {
					options.onFrame(jpeg);
				} catch {
					fail("Native desktop frame consumer failed.");
					return;
				}
				write({ type: "ack" });
			}
		}
	}
	const handle = {
		input(event: NativeDesktopInput) {
			if (readOnly || closing) return;
			const validated = validatedInput(event);
			if (validated) write(validated);
		},
		close,
	};
	try {
		if (!status.supported) throw new Error(status.reason);
		directory = mkdtempSync(join(tmpdir(), "pi-native-desktop-"));
		const windows = process.platform === "win32";
		const path = join(directory, windows ? "capture.ps1" : "capture.swift");
		writeFileSync(path, windows ? "\ufeff" + windowsDesktopScript : macDesktopScript, { mode: 0o600 });
		const mode = readOnly ? "view" : "control";
		child = spawn(
			windows ? powershellPath() : "/usr/bin/swift",
			windows
				? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, mode]
				: [path, mode],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		child.stdout.on("data", receive);
		child.stdout.on("error", () => fail("Native desktop capture stream failed."));
		child.stdin.on("error", () => fail("Native desktop input stream closed."));
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-8192);
		});
		child.on("error", (error) => {
			fail(`Native desktop helper failed: ${error.message}`);
		});
		child.on("close", (code, signal) => {
			try {
				if (!closing) {
					reported = true;
					options.onError(stderr.trim() || `Native desktop helper exited (${signal || code || "EOF"}).`);
				}
			} finally {
				finish();
			}
		});
		armWatchdog();
	} catch (error) {
		queueMicrotask(() => {
			if (finished) return;
			try {
				fail(error instanceof Error ? error.message : String(error));
			} finally {
				finish();
			}
		});
	}
	return handle;
}
