import { parseDesktopProfile, type DesktopProfile } from "./desktop-quality.js";
import { parseDesktopDisplays, type DesktopDisplays } from "./desktop-displays.js";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rm, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { windowsDesktopScript } from "./native-desktop/windows.js";
import { macDesktopHelper } from "./native-desktop/macos-helper.js";
import { createH264Splitter, h264Codec, type VideoFrame } from "./desktop-video.js";
import {
	startWindowsServiceDesktop,
	windowsDesktopServicePath,
	windowsDesktopServiceProfiles,
} from "./windows-desktop-service.js";

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
	"NumLock",
	"NumpadEnter",
	"NumpadAdd",
	"NumpadSubtract",
	"NumpadMultiply",
	"NumpadDivide",
	"NumpadDecimal",
	"NumpadComma",
	"NumpadEqual",
	"NumpadClear",
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
				(!specialKeys.has(value.code) && !/^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-2]))$/.test(value.code))
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
		if (windowsDesktopServicePath()) return { supported: true, backend: "windows-system-desktop" };
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
	const helper = await macDesktopHelper();
	if (signal?.aborted) throw new Error("Native desktop permission request aborted.");
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
			child = spawn(helper, [`permissions-${kind}`], {
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

export type NativeDesktopOptions = {
	onVideoAlive?: () => void;
	onRawFrame?: (frame: { data: Buffer; width: number; height: number }, ack: () => void) => void;
	onDisplays?: (displays: DesktopDisplays) => void;
	display?: string;
	onFrame: (jpeg: Buffer) => void;
	onError: (message: string) => void;
	onClose: () => void;
	readOnly?: boolean;
	preview?: boolean;
	/** 原生采集编码通道：帧走 onVideo，不传输原始像素。 */
	video?: boolean;
	/** H.264 访问单元；只有 video 模式会调用。 */
	onVideo?: (frame: VideoFrame) => void;
};
export type NativeDesktopHandle = {
	requestKeyframe?(): void;
	videoFeedback?(paused: boolean): void;
	input(event: NativeDesktopInput): void;
	configure?(profile: DesktopProfile): void;
	close(): void;
};

export function startNativeDesktop(options: NativeDesktopOptions): NativeDesktopHandle {
	const service = windowsDesktopServicePath();
	return service
		? startWindowsServiceDesktop(options, (next) => startNativeDesktopOnce(next, service))
		: startNativeDesktopOnce(options);
}

/** Input-only helper for the H.264 backend: same SendInput path, no screen capture thread. */
export function startNativeDesktopInput(options: NativeDesktopOptions): NativeDesktopHandle {
	return startNativeDesktopOnce(options, undefined, true);
}

function startNativeDesktopOnce(
	options: NativeDesktopOptions,
	service?: string,
	inputOnly = false,
): NativeDesktopHandle {
	const status = nativeDesktopStatus();
	const readOnly = options.preview === true || options.readOnly !== false;
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
	let rawBuffer: Buffer | undefined;
	let frameUsed = 0;
	let displayConfirmed = !options.display;
	let videoCodec: string | undefined;
	let videoReset = true;
	let pendingConfiguration: object | undefined;
	const splitVideo = () =>
		createH264Splitter((value) => {
			if (value.data.length > MAX_FRAME) throw new Error("Encoded desktop frame exceeds limit.");
			videoCodec = h264Codec(value.data) ?? videoCodec;
			if (displayConfirmed && (!videoReset || value.key)) {
				options.onVideo?.({ ...value, codec: videoCodec, reset: videoReset });
				videoReset = false;
			}
		});
	let videoChunks = splitVideo();

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
		rawBuffer = undefined;
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
		if (closing) return;
		if (!child) {
			if ((message as { type?: string }).type === "configure") pendingConfiguration = message;
			return;
		}
		if (child.stdin.destroyed) return;
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
				if (
					length < (options.video ? (service ? 1 : 3) : 4) ||
					length > (options.onRawFrame ? 32 * 1024 * 1024 : MAX_FRAME + (service && options.video ? 10 : 0))
				) {
					fail("Invalid native desktop frame length (maximum 4 MB).");
					return;
				}
				frame = rawBuffer?.length === length ? rawBuffer : Buffer.allocUnsafe(length);
				rawBuffer = undefined;
				frameUsed = 0;
			}
			const n = Math.min(frame.length - frameUsed, chunk.length - offset);
			chunk.copy(frame, frameUsed, offset, offset + n);
			frameUsed += n;
			offset += n;
			if (frameUsed === frame.length) {
				const jpeg = frame;
				frame = undefined;
				if (jpeg[0] === 5 && jpeg.length === 1 && service && options.video) {
					armWatchdog();
					options.onVideoAlive?.();
					continue;
				}
				if (jpeg[0] === 6 && service && options.video && options.onVideo) {
					if (jpeg.length < 11 || jpeg[1] > 3) return fail("Invalid native video frame.");
					const pts = Number(jpeg.readBigUInt64BE(2));
					if (!Number.isSafeInteger(pts)) return fail("Invalid native video timestamp.");
					armWatchdog();
					const data = jpeg.subarray(10),
						key = Boolean(jpeg[1] & 1),
						reset = Boolean(jpeg[1] & 2);
					if (reset) {
						videoCodec = undefined;
						videoReset = true;
					}
					videoCodec = h264Codec(data) ?? videoCodec;
					if (displayConfirmed && (!videoReset || key)) {
						try {
							options.onVideo({ data, key, reset: videoReset, codec: videoCodec, timestampMs: pts });
							videoReset = false;
						} catch {
							return fail("Native desktop video consumer failed.");
						}
					}
					continue;
				}
				if (jpeg[0] === 4 && options.video && options.onVideo && service) {
					if (jpeg.length > 65538 || jpeg[1] > 1) return fail("Invalid encoded desktop chunk.");
					armWatchdog();
					try {
						if (jpeg[1] === 1) {
							videoCodec = undefined;
							videoReset = true;
							videoChunks = splitVideo();
						}
						videoChunks(jpeg.subarray(2));
					} catch {
						fail("Native desktop video stream failed.");
					}
					continue;
				}
				if (jpeg[0] === 3 && options.onRawFrame && jpeg.length >= 9) {
					const width = jpeg.readUInt32BE(1),
						height = jpeg.readUInt32BE(5);
					if (!width || !height || width > 2560 || height > 2560 || width * height * 4 !== jpeg.length - 9)
						return fail("Invalid raw desktop frame.");
					armWatchdog();
					let acknowledged = false;
					const ack = () => {
						if (!acknowledged && !closing) {
							acknowledged = true;
							rawBuffer = jpeg;
							write({ type: "ack" });
						}
					};
					try {
						if (displayConfirmed) options.onRawFrame({ data: jpeg.subarray(9), width, height }, ack);
						else ack();
					} catch {
						fail("Native desktop raw frame consumer failed.");
					}
					continue;
				}
				if (jpeg[0] === 0x02 && options.onVideo) {
					armWatchdog();
					try {
						options.onVideo({ data: jpeg.subarray(2), key: (jpeg[1] & 1) === 1 });
					} catch {
						fail("Native desktop video consumer failed.");
						return;
					}
					continue;
				}
				if (jpeg[0] === 123 && jpeg.length <= 8192) {
					let displays: DesktopDisplays | undefined;
					try {
						displays = parseDesktopDisplays(JSON.parse(jpeg.toString("utf8")));
					} catch {}
					if (!displays) {
						fail("Invalid desktop display metadata.");
						return;
					}
					displayConfirmed =
						!options.display ||
						displays.selected === options.display ||
						!displays.displays.some((d) => d.id === options.display);
					armWatchdog();
					options.onDisplays?.(displays);
					continue;
				}
				if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) {
					fail("Native desktop helper returned an invalid JPEG.");
					return;
				}
				armWatchdog();
				try {
					if (displayConfirmed) options.onFrame(jpeg);
				} catch {
					fail("Native desktop frame consumer failed.");
					return;
				}
				write({ type: "ack" });
			}
		}
	}
	const handle: NativeDesktopHandle = {
		...(service && options.video && windowsDesktopServiceProfiles(service, "video-flow-v1")
			? {
					videoFeedback(paused: boolean) {
						if (!closing) write({ type: "video_flow", paused });
					},
					requestKeyframe() {
						if (!closing) write({ type: "video_keyframe" });
					},
				}
			: {}),
		...(!options.preview && (!service || windowsDesktopServiceProfiles(service))
			? {
					configure(profile: DesktopProfile) {
						const validated = parseDesktopProfile(profile);
						if (validated) write({ type: "configure", ...validated });
					},
				}
			: {}),
		input(event: NativeDesktopInput) {
			if (readOnly || closing) return;
			const validated = validatedInput(event);
			if (validated) write(validated);
		},
		close,
	};
	void (async () => {
		try {
			if (!status.supported) throw new Error(status.reason);
			const windows = process.platform === "win32";
			let path = "";
			if (!service && windows) {
				directory = mkdtempSync(join(tmpdir(), "pi-native-desktop-"));
				path = join(directory, "capture.ps1");
				writeFileSync(path, "\ufeff" + windowsDesktopScript, { mode: 0o600 });
			} else if (!windows) {
				path = await macDesktopHelper();
				if (closing) return;
			}
			if (options.onRawFrame && (!windows || (service && !windowsDesktopServiceProfiles(service, "raw-v1"))))
				throw new Error("Update the built-in Windows desktop service to enable video encoding.");
			if (options.video && service && !windowsDesktopServiceProfiles(service, "video-v1"))
				throw new Error("Update the built-in Windows desktop service to enable native video.");
			const mode =
				options.video && service && !options.preview
					? readOnly
						? windowsDesktopServiceProfiles(service, "video-flow-v1")
							? "video-flow-view"
							: "video-view"
						: windowsDesktopServiceProfiles(service, "video-flow-v1")
							? "video-flow-control"
							: "video-control"
					: options.onRawFrame
						? readOnly
							? "raw-view"
							: "raw-control"
						: inputOnly
							? "input"
							: options.video
								? "video"
								: options.preview
									? "preview"
									: readOnly
										? "view"
										: "control";
			child = spawn(
				service ?? (windows ? powershellPath() : path),
				service
					? ["--client", mode]
					: windows
						? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, mode]
						: [mode],
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
			if (
				!inputOnly &&
				(options.onDisplays || options.display) &&
				(!service || windowsDesktopServiceProfiles(service))
			) {
				write({ type: "displays" });
				if (options.display) write({ type: "display", id: options.display });
			}
			if (pendingConfiguration) {
				write(pendingConfiguration);
				pendingConfiguration = undefined;
			}
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
	})();
	return handle;
}
