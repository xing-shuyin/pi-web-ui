import { describe, expect, it } from "vitest";
import { createH264Splitter, videoBitrate } from "../../server/device-center/desktop-video.js";

/** Minimal Annex-B writer: 3-byte start code + NAL header + payload. */
function nal(type: number, payload: number[], long = false) {
	return Buffer.from([...(long ? [0, 0, 0, 1] : [0, 0, 1]), type, ...payload]);
}
// VCL payloads start with first_mb_in_slice = 0 → first bit set.
const idr = nal(5, [0x80, 0x11, 0x22]);
const p = (byte: number) => nal(1, [0x80, byte]);
const sps = nal(7, [0x42, 0xe0, 0x1f]);
const pps = nal(8, [0xce, 0x3c, 0x80]);
const sei = nal(6, [0x05]);

describe("H.264 access unit splitting", () => {
	it("emits one frame per picture with parameter sets attached to the keyframe", () => {
		const frames: { data: Buffer; key: boolean }[] = [];
		const split = createH264Splitter((frame) => frames.push({ data: Buffer.from(frame.data), key: frame.key }));
		split(Buffer.concat([sps, pps, sei, idr, sei, p(1), sei, p(2)]));
		// A picture is only known to be complete when the next one starts (one frame of latency).
		expect(frames).toHaveLength(2);
		expect(frames[0].key).toBe(true);
		expect(frames[1].key).toBe(false);
		// SPS + PPS + SEI + IDR travel together so a decoder can start from the keyframe.
		expect(frames[0].data.equals(Buffer.concat([sps, pps, sei, idr]))).toBe(true);
		expect(frames[1].data.equals(Buffer.concat([sei, p(1)]))).toBe(true);
	});

	it("keeps a partial tail buffered across chunks", () => {
		const frames: Buffer[] = [];
		const split = createH264Splitter((frame) => frames.push(Buffer.from(frame.data)));
		const stream = Buffer.concat([sps, pps, idr, p(1), p(2)]);
		for (const byte of stream) split(Buffer.from([byte]));
		// Without SEI delimiters a picture is only recognised once the next VCL arrives.
		expect(frames).toHaveLength(1);
		split(p(3));
		expect(frames).toHaveLength(2);
	});

	it("ignores a lone start code and tolerates 4-byte start codes", () => {
		const frames: { key: boolean }[] = [];
		const split = createH264Splitter((frame) => frames.push({ key: frame.key }));
		split(Buffer.from([0, 0]));
		split(nal(7, [0x42], true));
		split(pps);
		split(idr);
		split(nal(1, [0x80, 0x33], true));
		expect(frames).toHaveLength(0);
		split(p(0x44));
		expect(frames).toHaveLength(1);
		expect(frames[0].key).toBe(true);
		split(p(0x55));
		expect(frames).toHaveLength(2);
		expect(frames[1].key).toBe(false);
	});
});

describe("H.264 bitrate profile", () => {
	it("scales with resolution, quality and high frame rates", () => {
		const base = videoBitrate({ maxEdge: 1920, quality: 70, fps: 60 });
		expect(videoBitrate({ maxEdge: 2560, quality: 70, fps: 60 })).toBeGreaterThan(base);
		expect(videoBitrate({ maxEdge: 1920, quality: 85, fps: 60 })).toBeGreaterThan(base);
		expect(videoBitrate({ maxEdge: 1920, quality: 70, fps: 120 })).toBeGreaterThan(base);
		expect(videoBitrate({ maxEdge: 1920, quality: 40, fps: 30 })).toBeLessThan(base);
		// Well under the JPEG pipeline (~100 Mbps at 1080p60) but enough for a sharp desktop.
		expect(base).toBeGreaterThan(2_000_000);
		expect(base).toBeLessThan(20_000_000);
	});
});
