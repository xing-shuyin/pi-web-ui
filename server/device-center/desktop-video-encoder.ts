import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveFfmpeg } from "./ffmpeg-path.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createH264Splitter, h264Codec, videoBitrate, type VideoFrame } from "./desktop-video.js";
export { h264Codec } from "./desktop-video.js";
import { startNativeDesktop, type NativeDesktopHandle, type NativeDesktopOptions } from "./desktop-native.js";
import { parseDesktopProfile, type DesktopProfile } from "./desktop-quality.js";

export const VIDEO_ENCODERS = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264"] as const;
export type DesktopVideoEncoder = (typeof VIDEO_ENCODERS)[number];
type EncoderSelection = { path: string; encoder: DesktopVideoEncoder };
const selections = new Map<string, { time: number; value: Promise<EncoderSelection | undefined> }>();

export function encoderArguments(encoder: DesktopVideoEncoder): string[] {
	switch (encoder) {
		case "h264_nvenc":
			return ["-preset", "p1", "-tune", "ull", "-rc", "cbr", "-zerolatency", "1"];
		case "h264_qsv":
			return ["-preset", "veryfast", "-async_depth", "1", "-look_ahead", "0"];
		case "h264_amf":
			return ["-usage", "ultralowlatency", "-quality", "speed", "-rc", "cbr"];
		case "h264_mf":
			return ["-hw_encoding", "1", "-scenario", "display_remoting"];
		case "libx264":
			return ["-preset", "ultrafast", "-tune", "zerolatency"];
	}
}

export async function selectDesktopVideoEncoder(path: string): Promise<DesktopVideoEncoder | undefined> {
	return (await selectDesktopVideoRuntime(path))?.encoder;
}
export function selectDesktopVideoRuntime(
	path: string,
	rejected = new Set<string>(),
): Promise<EncoderSelection | undefined> {
	const probe = async () => {
		const compatible = join(dirname(path), "nvenc-compat", "ffmpeg.exe");
		const candidates = VIDEO_ENCODERS.flatMap((encoder) =>
			encoder !== "libx264" && existsSync(compatible)
				? [
						{ path: compatible, encoder },
						{ path, encoder },
					]
				: [{ path, encoder }],
		);
		for (const candidate of candidates) {
			if (rejected.has(candidate.path + ":" + candidate.encoder)) continue;
			const { encoder } = candidate;
			const ok = await new Promise<boolean>((resolve) => {
				const child = spawn(
					candidate.path,
					[
						"-hide_banner",
						"-loglevel",
						"error",
						"-nostdin",
						"-f",
						"lavfi",
						"-i",
						"color=size=1280x720:rate=10:duration=0.2",
						"-an",
						"-c:v",
						encoder,
						...encoderArguments(encoder),
						"-bf",
						"0",
						"-f",
						"null",
						"-",
					],
					{ windowsHide: true, stdio: "ignore" },
				);
				const timer = setTimeout(() => {
					child.kill();
					resolve(false);
				}, 3000);
				timer.unref();
				child.once("error", () => {
					clearTimeout(timer);
					resolve(false);
				});
				child.once("exit", (code) => {
					clearTimeout(timer);
					resolve(code === 0);
				});
			});
			if (ok) return candidate;
		}
	};
	if (rejected.size) return probe();
	if (!selections.has(path) || Date.now() - selections.get(path)!.time > 60_000)
		selections.set(path, { time: Date.now(), value: probe() });
	return selections.get(path)!.value;
}

export function rawVideoArguments(
	encoder: DesktopVideoEncoder,
	width: number,
	height: number,
	profile: DesktopProfile,
): string[] {
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 2 ||
		height < 2 ||
		width > 2560 ||
		height > 2560 ||
		!parseDesktopProfile(profile)
	)
		throw new Error("Invalid encoder profile");
	const bitrate = videoBitrate(profile);
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-f",
		"rawvideo",
		"-pixel_format",
		"bgra",
		"-video_size",
		`${width}x${height}`,
		"-framerate",
		String(profile.fps),
		"-i",
		"pipe:0",
		"-an",
		"-vf",
		"scale=trunc(iw/2)*2:trunc(ih/2)*2",
		"-c:v",
		encoder,
		...encoderArguments(encoder),
		"-pix_fmt",
		encoder === "libx264" ? "yuv420p" : "nv12",
		"-b:v",
		String(bitrate),
		"-maxrate",
		String(bitrate),
		"-bufsize",
		String(Math.round(bitrate / 10)),
		"-g",
		String(profile.fps),
		"-bf",
		"0",
		"-flush_packets",
		"1",
		"-f",
		"h264",
		"pipe:1",
	];
}

export function startEncodedServiceDesktop(
	options: NativeDesktopOptions & { profile: DesktopProfile; onVideo(frame: VideoFrame): void },
): NativeDesktopHandle {
	let closed = false,
		generation = 0,
		profile = options.profile,
		applied = "",
		codec: string | undefined;
	let source: NativeDesktopHandle | undefined;
	let encoder: ChildProcessWithoutNullStreams | undefined;
	let drainTimer: ReturnType<typeof setTimeout> | undefined;
	function stopEncoder() {
		generation++;
		clearTimeout(drainTimer);
		const previous = encoder;
		encoder = undefined;
		applied = "";
		if (previous) {
			previous.stdin.destroy();
			previous.kill();
		}
	}
	function close() {
		if (closed) return;
		closed = true;
		source?.close();
		stopEncoder();
	}
	function fail(message: string) {
		if (closed) return;
		if (path) selections.delete(path);
		close();
		options.onError(message);
		options.onClose();
	}
	const path = resolveFfmpeg();
	void (async () => {
		let selected = path ? await selectDesktopVideoRuntime(path) : undefined;
		if (closed) return;
		if (!path || !selected) {
			source = startNativeDesktop(options);
			source.configure?.(profile);
			return;
		}
		const rejected = new Set<string>();
		let recovering = false;
		let releaseFrame: (() => void) | undefined;
		async function recover(message: string) {
			if (closed || recovering || !selected) return;
			if (selected.encoder === "libx264") {
				fail(message);
				return;
			}
			recovering = true;
			rejected.add(selected.path + ":" + selected.encoder);
			selections.delete(path!);
			stopEncoder();
			releaseFrame?.();
			releaseFrame = undefined;
			try {
				selected = await selectDesktopVideoRuntime(path!, rejected);
				if (!closed && !selected) fail(message);
			} catch {
				fail(message);
			} finally {
				recovering = false;
			}
		}
		source = startNativeDesktop({
			...options,
			onDisplays: (value) =>
				options.onDisplays?.({
					...value,
					encoder: selected?.encoder,
					encoderRuntime: selected?.path === path ? "default" : "desktop-timing-v2",
				}),
			onClose: () => {
				if (!closed) {
					close();
					options.onClose();
				}
			},
			onError: fail,
			onRawFrame(frame, ack) {
				if (closed) return;
				if (recovering || !selected) {
					ack();
					return;
				}
				releaseFrame = ack;
				const key = JSON.stringify([frame.width, frame.height, profile]);
				if (key !== applied) {
					stopEncoder();
					applied = key;
					codec = undefined;
					const id = generation;
					encoder = spawn(selected.path, rawVideoArguments(selected.encoder, frame.width, frame.height, profile), {
						windowsHide: true,
						stdio: ["pipe", "pipe", "pipe"],
					});
					const current = encoder;
					let reset = true;
					const split = createH264Splitter((value) => {
						if (closed || id !== generation) return;
						codec = h264Codec(value.data) ?? codec;
						options.onVideo({ ...value, codec, reset });
						reset = false;
					});
					current.stdout.on("data", (bytes: Buffer) => {
						if (id === generation && !closed) {
							try {
								split(bytes);
							} catch {
								fail("Desktop video encoder returned an invalid stream.");
							}
						}
					});
					current.stderr.resume();
					current.stdin.on("error", () => {
						if (id === generation) void recover("Desktop video encoder input closed.");
					});
					current.on("error", () => {
						if (id === generation) void recover("Could not start the built-in desktop video encoder.");
					});
					current.on("exit", () => {
						if (id === generation) void recover("Desktop video encoder stopped.");
					});
				}
				const id = generation;
				drainTimer = setTimeout(() => {
					if (id === generation) void recover("Desktop video encoder stopped accepting frames.");
				}, 5000);
				drainTimer.unref();
				encoder!.stdin.write(frame.data, (error) => {
					if (id !== generation || closed) return;
					clearTimeout(drainTimer);
					if (error) void recover("Desktop video encoder input failed.");
					else {
						releaseFrame = undefined;
						ack();
					}
				});
			},
		});
		source.configure?.(profile);
	})().catch(() => fail("Could not initialize the built-in desktop video encoder."));
	return {
		input: (event) => {
			if (!closed) source?.input(event);
		},
		configure: (value) => {
			const validated = parseDesktopProfile(value);
			if (validated && !closed) {
				profile = validated;
				source?.configure?.(profile);
			}
		},
		close,
	};
}
