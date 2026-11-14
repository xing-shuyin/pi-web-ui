import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { resolveFfmpeg } from "./ffmpeg-path.js";
import type { DesktopProfile } from "./desktop-quality.js";

export type VideoFrame = { data: Uint8Array; key: boolean; codec?: string; reset?: boolean; timestampMs?: number };

export function h264Codec(bytes: Uint8Array): string | undefined {
	for (let i = 0; i + 6 < bytes.length; i++)
		if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 31) === 7)
			return "avc1." + Buffer.from(bytes.subarray(i + 4, i + 7)).toString("hex");
}

/**
 * Split a raw Annex-B H.264 stream into access units (one per picture).
 *
 * NVENC emits one VCL NAL per picture, preceded by the parameter sets (SPS/PPS) and an SEI.
 * A picture therefore starts at a VCL NAL whose `first_mb_in_slice` is 0 (first bit of the RBSP),
 * and every non-VCL NAL seen between pictures belongs to the next one.
 */
export function createH264Splitter(emit: (frame: VideoFrame) => void) {
	let buffer: Buffer = Buffer.alloc(0);
	let pending: Buffer[] = [];
	let current: Buffer[] | undefined;
	let key = false;
	const finish = () => {
		if (!current?.length) return;
		emit({ data: Buffer.concat(current), key });
		current = undefined;
		key = false;
	};
	return (chunk: Buffer) => {
		if (
			buffer.length +
				chunk.length +
				pending.reduce((n, b) => n + b.length, 0) +
				(current?.reduce((n, b) => n + b.length, 0) ?? 0) >
			16 * 1024 * 1024
		)
			throw new Error("Video access unit exceeds limit");
		buffer = buffer.length ? Buffer.concat([buffer as Uint8Array, chunk as Uint8Array]) : chunk;
		let offset = 0;
		for (;;) {
			const at = buffer.indexOf(Buffer.from([0, 0, 1]), offset);
			if (at < 0) break;
			const header = at + 3;
			if (header >= buffer.length) break;
			const type = buffer[header] & 0x1f;
			// An AUD already proves the preceding picture is complete, even if this NAL is partial.
			if (type === 9 && current?.length) finish();
			const next = buffer.indexOf(Buffer.from([0, 0, 1]), header + 1);
			if (next < 0) break;
			// A previous 4-byte start code leaves a trailing zero inside this NAL; drop padding.
			let end = next;
			while (end > header + 1 && buffer[end - 1] === 0) end--;
			const nal = buffer.subarray(at, end);
			if (type === 1 || type === 5) {
				const pictureStart = header + 1 < buffer.length && (buffer[header + 1] & 0x80) !== 0;
				if (pictureStart || !current) {
					finish();
					current = pending;
					pending = [];
				}
				current.push(nal);
				if (type === 5) key = true;
			} else {
				// Parameter sets and SEI that follow a picture belong to the next one: they close the
				// current access unit, so a frame is emitted as soon as the next one starts (1 frame latency).
				if (current?.length) finish();
				pending.push(nal);
			}
			offset = next;
		}
		buffer = offset ? buffer.subarray(offset) : buffer;
	};
}

type VideoOptions = {
	display?: string;
	profile: DesktopProfile;
	onFrame: (frame: VideoFrame) => void;
	onError: (message: string) => void;
	onClose: () => void;
};

export type VideoDesktopHandle = {
	configure(profile: DesktopProfile): void;
	input(): void;
	close(): void;
};

function outputIndex(display?: string) {
	const match = display?.match(/DISPLAY\s*(\d+)/i);
	const index = match ? Number(match[1]) - 1 : 0;
	return Number.isInteger(index) && index >= 0 && index < 16 ? index : 0;
}

/** Bits per second for the H.264 session; JPEG used ~10x more for the same desktop. */
export function videoBitrate(profile: DesktopProfile): number {
	const edge = Math.max(640, profile.maxEdge);
	const base = edge >= 2400 ? 14_000_000 : edge >= 1700 ? 9_000_000 : edge >= 1200 ? 5_000_000 : 2_500_000;
	const quality = Math.min(1.25, Math.max(0.6, profile.quality / 70));
	const highFps = profile.fps >= 90 ? 1.4 : 1;
	return Math.round((base * quality * highFps) / 100_000) * 100_000;
}

function args(profile: DesktopProfile, display?: string) {
	const fps = Math.max(5, Math.min(240, Math.round(profile.fps)));
	const bitrate = videoBitrate(profile);
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-fflags",
		"nobuffer",
		"-flags",
		"low_delay",
		"-f",
		"lavfi",
		"-i",
		`ddagrab=output_idx=${outputIndex(display)}:framerate=${fps}:draw_mouse=0`,
		"-an",
		"-c:v",
		"h264_nvenc",
		"-preset",
		"p1",
		"-tune",
		"ll",
		"-rc",
		"cbr",
		"-b:v",
		String(bitrate),
		"-maxrate",
		String(bitrate),
		"-bufsize",
		String(Math.round(bitrate / 10)),
		"-g",
		String(fps),
		"-bf",
		"0",
		"-flush_packets",
		"1",
		"-f",
		"h264",
		"pipe:1",
	];
}

let probe: { ok: boolean; checkedAt: number } | undefined;

/** Cheap capability probe: does ffmpeg exist and can it open an NVENC encoder? */
export function videoDesktopAvailable(): boolean {
	if (process.platform !== "win32") return false;
	const binary = resolveFfmpeg();
	if (!binary) return false;
	if (probe && Date.now() - probe.checkedAt < 60_000) return probe.ok;
	probe = { ok: false, checkedAt: Date.now() };
	try {
		const result = spawn(
			binary,
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=size=64x64:rate=5:duration=0.2",
				"-c:v",
				"h264_nvenc",
				"-f",
				"null",
				"-",
			],
			{ stdio: "ignore", windowsHide: true },
		);
		result.on("error", () => {});
		result.on("exit", (code) => {
			probe = { ok: code === 0, checkedAt: Date.now() };
		});
		// Synchronous answer for the first call: treat as available and let the session fail over.
		probe.ok = true;
	} catch {
		probe.ok = false;
	}
	return probe.ok;
}

export function startVideoDesktop(options: VideoOptions): VideoDesktopHandle | undefined {
	const binary = resolveFfmpeg();
	if (!binary) return undefined;
	let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
	let closing = false;
	let finished = false;
	let stderr = "";
	let profile = options.profile;
	const splitter = createH264Splitter((frame) => {
		if (!closing) options.onFrame(frame);
	});
	function finish() {
		if (finished) return;
		finished = true;
		closing = true;
		options.onClose();
	}
	function close() {
		if (closing) return;
		closing = true;
		if (!child) return finish();
		child.kill("SIGTERM");
		const timer = setTimeout(() => child?.kill("SIGKILL"), 1500);
		timer.unref();
	}
	function fail(message: string) {
		if (closing || finished) return;
		try {
			options.onError(message);
		} finally {
			close();
		}
	}
	function launch() {
		closing = false;
		const current = spawn(binary!, args(profile, options.display), {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child = current;
		current.stdout.on("data", (chunk: Buffer) => {
			if (child !== current || closing) return;
			try {
				splitter(chunk);
			} catch {
				fail("Desktop video stream produced an unreadable H.264 frame.");
			}
		});
		current.stdout.on("error", () => fail("Desktop video stream failed."));
		current.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4096);
		});
		current.on("error", (error) => fail(`Desktop video encoder failed: ${error.message}`));
		current.on("close", (code, signal) => {
			if (child !== current) return;
			fail(stderr.trim() || `Desktop video encoder exited (${signal || code || "EOF"}).`);
		});
	}
	launch();
	return {
		configure(next: DesktopProfile) {
			const key = JSON.stringify(next);
			if (key === JSON.stringify(profile) || closing) return;
			profile = next;
			// FPS/bitrate are encoder parameters: restart and let the viewer resynchronise on the next IDR.
			const previous = child;
			child = undefined;
			previous?.kill("SIGTERM");
			launch();
		},
		input() {},
		close,
	};
}
