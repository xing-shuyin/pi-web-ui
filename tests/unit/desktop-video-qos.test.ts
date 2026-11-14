import { expect, it } from "vitest";
import { DesktopVideoFlow } from "../../server/device-center/desktop-video-flow.js";

it("bounds a silent receiver and ignores stale, future and malformed acknowledgements", () => {
	const flow = new DesktopVideoFlow();
	for (let i = 0; i < 6; i++) flow.frame(i);
	expect(flow.blocked(60)).toBe(true);
	expect(flow.ack(100, 0, 25)).toBe(false);
	expect(flow.ack(6, NaN, 25)).toBe(false);
	expect(flow.count).toBe(6);
	expect(flow.ack(6, 0, 25)).toBe(true);
	expect(flow.count).toBe(0);
	expect(flow.ack(6, 0, 26)).toBe(false);
	const stale = flow.frame(30);
	flow.reset();
	expect(flow.ack(stale, 0, 40)).toBe(false);
	expect(flow.frame(41)).toBeGreaterThan(stale);
});

it("allows a bandwidth-delay window without mistaking propagation latency for congestion", () => {
	const flow = new DesktopVideoFlow();
	const base = { maxEdge: 1920, fps: 120, quality: 70 };
	for (let t = 0; t < 10000; t += 1000) flow.ack(flow.frame(t), 0, t + 180);
	expect(flow.profile(base, true)).toEqual(base);
	for (let i = 0; i < 24; i++) flow.frame(11000 + i);
	expect(flow.blocked(120)).toBe(false);
	flow.frame(11025);
	expect(flow.blocked(120)).toBe(true);
});

it("reduces bitrate before FPS and recovers gradually, retaining explicit quality choices", () => {
	const flow = new DesktopVideoFlow();
	const base = { maxEdge: 1920, fps: 120, quality: 70 };
	flow.ack(flow.frame(0), 0, 10);
	flow.ack(flow.frame(1000), 9, 1400);
	expect(flow.profile(base, true).quality).toBeLessThan(70);
	expect(flow.profile(base, true).fps).toBe(120);
	for (let t = 2000; t < 9000; t += 1000) flow.ack(flow.frame(t), 9, t + 400);
	const limited = flow.profile(base, true);
	expect(limited.fps).toBeLessThan(120);
	expect(limited.maxEdge).toBe(1920);
	expect(flow.profile(base, false)).toEqual(base);
	for (let t = 10000; t < 60000; t += 1000) flow.ack(flow.frame(t), 0, t + 12);
	expect(flow.profile(base, true)).toEqual(base);
});
