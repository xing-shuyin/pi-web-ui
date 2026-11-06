import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { NativeDesktopInput } from "./desktop-native.js";

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_QUEUE = 128;
const PROBE_OPTIONS = { encoding: "utf8", timeout: 2000, maxBuffer: 256 * 1024, shell: false } as const;

function executable(name: string): string | undefined {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return undefined;
}

export function linuxDesktopStatus(): { supported: boolean; backend: string; reason?: string } {
	const unsupported = (reason: string) => ({ supported: false, backend: "x11", reason });
	if (process.platform !== "linux") return unsupported("Linux X11 desktop capture requires Linux.");
	if (process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" || process.env.WAYLAND_DISPLAY)
		return unsupported("Wayland desktop capture requires Portal/PipeWire and is not supported yet.");
	if (!process.env.DISPLAY) return unsupported("No X11 DISPLAY is available; Wayland requires Portal/PipeWire.");
	if (!executable("ffmpeg")) return unsupported("X11 desktop capture requires ffmpeg (x11grab).");
	return {
		supported: true,
		backend: "x11",
		...(!executable("xdotool") ? { reason: "View only: install xdotool to enable desktop control." } : {}),
	};
}

function screenSize(): [number, number] {
	const display = process.env.DISPLAY!;
	const info = executable("xdpyinfo");
	if (info) {
		try {
			const output = execFileSync(info, ["-display", display], PROBE_OPTIONS);
			const defaultScreen = output.match(/default screen number:\s*(\d+)/)?.[1];
			const section = defaultScreen
				? output.split(new RegExp(`screen #${defaultScreen}:`))[1]?.split(/screen #\d+:/)[0]
				: output;
			const match = section?.match(/dimensions:\s*(\d+)x(\d+)\s+pixels/);
			if (match && +match[1] > 0 && +match[2] > 0) return [+match[1], +match[2]];
		} catch {}
	}
	const randr = executable("xrandr");
	if (randr) {
		try {
			const output = execFileSync(randr, ["--display", display, "--current"], PROBE_OPTIONS);
			const match = output.match(/current\s+(\d+)\s+x\s+(\d+)/);
			if (match && +match[1] > 0 && +match[2] > 0) return [+match[1], +match[2]];
		} catch {}
	}
	throw new Error("Cannot determine X11 screen dimensions; install xdpyinfo or xrandr and check DISPLAY/XAUTHORITY.");
}

function keySymbol(code: string): string | undefined {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
	if (/^Digit[0-9]$/.test(code)) return code.slice(5);
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
	return (
		{
			Enter: "Return",
			NumpadEnter: "KP_Enter",
			Escape: "Escape",
			Backspace: "BackSpace",
			Tab: "Tab",
			Space: "space",
			ShiftLeft: "Shift_L",
			ShiftRight: "Shift_R",
			ControlLeft: "Control_L",
			ControlRight: "Control_R",
			AltLeft: "Alt_L",
			AltRight: "Alt_R",
			MetaLeft: "Super_L",
			MetaRight: "Super_R",
			ArrowLeft: "Left",
			ArrowRight: "Right",
			ArrowUp: "Up",
			ArrowDown: "Down",
			Home: "Home",
			End: "End",
			PageUp: "Prior",
			PageDown: "Next",
			Delete: "Delete",
			Insert: "Insert",
			CapsLock: "Caps_Lock",
			Minus: "minus",
			Equal: "equal",
			BracketLeft: "bracketleft",
			BracketRight: "bracketright",
			Backslash: "backslash",
			Semicolon: "semicolon",
			Quote: "apostrophe",
			Backquote: "grave",
			Comma: "comma",
			Period: "period",
			Slash: "slash",
		} as Record<string, string>
	)[code];
}

export function startLinuxDesktop(options: {
	onFrame: (jpeg: Buffer) => void;
	onError: (message: string) => void;
	onClose: () => void;
	readOnly?: boolean;
}): { input(event: NativeDesktopInput): void; close(): void } {
	let closed = false;
	let capture: ChildProcess | undefined;
	let command: ChildProcess | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let pending = Buffer.alloc(0);
	let stderr = "";
	let queue: string[][] = [];
	const keys = new Set<string>();
	const buttons = new Set<string>();
	let control: string | undefined;
	let missingControlReported = false;
	let width = 0,
		height = 0;
	const report = (message: string) => {
		options.onError(message);
	};
	const releaseArgs = () => {
		const args: string[] = [];
		for (const key of keys) args.push("keyup", key);
		for (const button of buttons) args.push("mouseup", button);
		return args;
	};
	const releaseAfterStop = () => {
		const args = releaseArgs();
		keys.clear();
		buttons.clear();
		if (!control || !args.length) return;
		execFile(control, args, { timeout: 2000, killSignal: "SIGKILL", maxBuffer: 16384, shell: false }, () => {});
	};
	const close = () => {
		if (closed) return;
		closed = true;
		pending = Buffer.alloc(0);
		queue = [];
		if (capture && capture.exitCode === null && capture.signalCode === null) {
			capture.kill("SIGTERM");
			killTimer = setTimeout(() => capture?.kill("SIGKILL"), 1000);
			killTimer.unref();
		}
		if (command) command.kill("SIGKILL");
		else releaseAfterStop();
		options.onClose();
	};
	const fail = (message: string) => {
		if (closed) return;
		try {
			report(message);
		} finally {
			close();
		}
	};
	const drain = () => {
		if (closed || command || !queue.length || !control) return;
		const args = queue.shift()!;
		for (let i = 0; i < args.length - 1; i++) {
			if (args[i] === "keydown") keys.add(args[i + 1]);
			if (args[i] === "mousedown") buttons.add(args[i + 1]);
		}
		try {
			command = execFile(
				control,
				args,
				{ timeout: 2000, killSignal: "SIGKILL", maxBuffer: 16384, shell: false },
				(error) => {
					command = undefined;
					if (closed) {
						releaseAfterStop();
						return;
					}
					if (error) {
						fail(`xdotool input failed: ${error.message}`);
						return;
					}
					for (let i = 0; i < args.length - 1; i++) {
						if (args[i] === "keyup") keys.delete(args[i + 1]);
						if (args[i] === "mouseup") buttons.delete(args[i + 1]);
					}
					drain();
				},
			);
		} catch (error) {
			command = undefined;
			fail(`xdotool input failed: ${String(error)}`);
		}
	};
	const input = (event: NativeDesktopInput) => {
		if (closed || options.readOnly !== false) return;
		if (!control) {
			if (!missingControlReported) {
				missingControlReported = true;
				report("Desktop control requires xdotool; viewing remains available.");
			}
			return;
		}
		let args: string[] = [];
		switch (event.type) {
			case "pointer": {
				if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
				args = [
					"mousemove",
					"--sync",
					String(Math.round(Math.max(0, Math.min(1, event.x)) * (width - 1))),
					String(Math.round(Math.max(0, Math.min(1, event.y)) * (height - 1))),
				];
				if (event.action === "down" || event.action === "up") {
					if (![0, 1, 2].includes(event.button!)) return;
					args.push(event.action === "down" ? "mousedown" : "mouseup", String([1, 2, 3][event.button!]));
				} else if (event.action !== "move") return;
				break;
			}
			case "wheel":
				if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
				args = [
					"click",
					"--repeat",
					String(Math.min(10, Math.max(1, Math.ceil(Math.abs(event.deltaY) / 100)))),
					"--delay",
					"0",
					event.deltaY > 0 ? "5" : "4",
				];
				break;
			case "key": {
				const key = keySymbol(event.code);
				if (!key || (event.action !== "down" && event.action !== "up")) return;
				args = [event.action === "down" ? "keydown" : "keyup", key];
				break;
			}
			case "text":
				if (
					typeof event.text !== "string" ||
					!event.text ||
					Buffer.byteLength(event.text) > 4096 ||
					event.text.includes("\0")
				)
					return;
				args = ["type", "--clearmodifiers", "--delay", "0", "--", event.text];
				break;
			case "release":
				queue = [];
				args = releaseArgs();
				break;
			default:
				return;
		}
		if (!args.length) return;
		if (queue.length >= MAX_QUEUE) {
			fail("Desktop input queue exceeded its limit.");
			return;
		}
		queue.push(args);
		drain();
	};
	try {
		const status = linuxDesktopStatus();
		if (!status.supported) throw new Error(status.reason);
		control = executable("xdotool");
		[width, height] = screenSize();
		capture = spawn(
			executable("ffmpeg")!,
			[
				"-nostdin",
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"x11grab",
				"-framerate",
				"8",
				"-video_size",
				`${width}x${height}`,
				"-i",
				process.env.DISPLAY!,
				"-an",
				"-vf",
				"scale=w='min(1600,iw)':h='min(1600,ih)':force_original_aspect_ratio=decrease",
				"-c:v",
				"mjpeg",
				"-q:v",
				"5",
				"-f",
				"image2pipe",
				"pipe:1",
			],
			{ shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env },
		);
		capture.stdout!.on("data", (chunk: Buffer) => {
			if (closed) return;
			for (let offset = 0; offset < chunk.length && !closed; offset += 65536) {
				pending = Buffer.concat([pending, chunk.subarray(offset, offset + 65536)]);
				while (pending.length && !closed) {
					const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
					if (start < 0) {
						pending = Buffer.from(pending.subarray(-1));
						break;
					}
					if (start) pending = pending.subarray(start);
					const end = pending.indexOf(Buffer.from([0xff, 0xd9]), 2);
					if (end < 0) {
						if (pending.length > MAX_FRAME) fail("ffmpeg JPEG frame exceeded 4 MiB.");
						break;
					}
					if (end + 2 > MAX_FRAME) {
						fail("ffmpeg JPEG frame exceeded 4 MiB.");
						break;
					}
					const frame = Buffer.from(pending.subarray(0, end + 2));
					pending = pending.subarray(end + 2);
					try {
						options.onFrame(frame);
					} catch (error) {
						fail(`Desktop frame callback failed: ${String(error)}`);
					}
				}
			}
		});
		capture.stderr!.on("data", (chunk: Buffer) => {
			if (!closed) stderr = (stderr + chunk.toString()).slice(-4096);
		});
		capture.on("error", (error) => fail(`ffmpeg capture failed: ${error.message}`));
		capture.stdout!.on("error", (error) => fail(`ffmpeg output failed: ${error.message}`));
		capture.stderr!.on("error", (error) => fail(`ffmpeg stderr failed: ${error.message}`));
		capture.on("close", (code, signal) => {
			if (killTimer) clearTimeout(killTimer);
			if (!closed)
				fail(
					`ffmpeg capture stopped (${signal ?? code}): ${stderr || "check X11 permissions and ffmpeg x11grab support"}`,
				);
		});
	} catch (error) {
		queueMicrotask(() => fail(String(error)));
	}
	return { input, close };
}
