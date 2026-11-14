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
	flow.ack(flow.frame(2400), 9, 2800);
	flow.ack(flow.frame(3400), 9, 3800);
	flow.ack(flow.frame(4400), 9, 4800);
	expect(flow.profile(base, true).quality).toBeLessThan(70);
	expect(flow.profile(base, true).fps).toBe(120);
	for (let t = 5000; t < 45000; t += 1000) flow.ack(flow.frame(t), 9, t + 400);
	const limited = flow.profile(base, true);
	expect(limited.fps).toBeLessThan(120);
	expect(limited.maxEdge).toBe(1920);
	expect(flow.profile(base, false)).toEqual(base);
	for (let t = 46000; t < 500000; t += 1000) flow.ack(flow.frame(t), 0, t + 12);
	expect(flow.profile(base, true)).toEqual(base);
});

it("does not reconfigure a recovered WAN burst every second", () => {
	const flow = new DesktopVideoFlow();
	const base = { maxEdge: 1920, fps: 60, quality: 70 };
	flow.ack(flow.frame(0), 0, 330);
	for (let second = 1; second <= 60; second++) {
		// First ACK of the burst waited for retransmission/decoder scheduling.
		// Later ACKs in the same second prove the queue drained normally.
		flow.ack(flow.frame(second * 1000 - 500), 9, second * 1000 + 330);
		for (let offset = 100; offset <= 900; offset += 100)
			flow.ack(flow.frame(second * 1000 + offset), 0, second * 1000 + offset + 330);
		expect(flow.profile(base, true)).toEqual(base);
	}
});

it("requires sustained recovery before raising quality and ignores encoder startup delay", () => {
	const flow = new DesktopVideoFlow(),
		base = { fps: 60, quality: 70 };
	for (let t = 0; t < 1000; t += 100) flow.ack(flow.frame(t), 0, t + 20);
	for (let t = 1000; t <= 4000; t += 100) flow.ack(flow.frame(t), 0, t + 400);
	const reduced = flow.profile(base, true);
	expect(reduced.quality).toBeLessThan(base.quality);
	flow.reset();
	flow.ack(flow.frame(5000), 9, 6000);
	for (let t = 6100; t <= 10000; t += 100) flow.ack(flow.frame(t), 0, t + 20);
	expect(flow.profile(base, true)).toEqual(reduced);
	for (let t = 10100; t < 25000; t += 100) flow.ack(flow.frame(t), 0, t + 20);
	expect(flow.profile(base, true)).toEqual(reduced);
	for (let t = 25100; t < 45000; t += 100) flow.ack(flow.frame(t), 0, t + 20);
	expect(flow.profile(base, true).quality).toBeGreaterThan(reduced.quality);
});

it("reacts to mobile congestion promptly without immediately raising quality again", () => {
	const flow = new DesktopVideoFlow(),
		base = { fps: 60, quality: 70 };
	let deliveredAt = 0;
	for (let t = 0; t < 10000; t += 100) {
		const delay = t >= 8000 ? 650 : 330;
		deliveredAt = Math.max(deliveredAt, t + delay);
		flow.ack(flow.frame(t), 0, deliveredAt);
	}
	const reduced = flow.profile(base, true);
	expect(reduced.quality).toBeLessThan(base.quality);
	for (let t = 10000; t < 20000; t += 100) flow.ack(flow.frame(t), 0, t + 330);
	expect(flow.profile(base, true).quality).toBeLessThanOrEqual(reduced.quality);
});

it("does not let a minority of timely ACKs hide delayed delivery for most frames", () => {
	const flow = new DesktopVideoFlow(),
		base = { fps: 240, quality: 70 };
	for (let t = 0; t < 1000; t += 100) flow.ack(flow.frame(t), 0, t + 50);
	let deliveredAt = 0;
	for (let t = 1000; t < 6000; t += 100) {
		const delay = t % 1000 < 600 ? 400 : 50;
		deliveredAt = Math.max(deliveredAt, t + delay);
		flow.ack(flow.frame(t), 0, deliveredAt);
	}
	expect(flow.profile(base, true).quality).toBeLessThan(base.quality);
});

it("does not impose a five-second cooldown on sustained severe queueing", () => {
	const flow = new DesktopVideoFlow(),
		base = { fps: 240, quality: 70 };
	for (let t = 0; t < 1000; t += 100) flow.ack(flow.frame(t), 0, t + 30);
	for (let t = 1000; t < 7000; t += 100) flow.ack(flow.frame(t), 10, t + 500);
	expect(flow.profile(base, true).quality).toBe(42);
	expect(flow.profile(base, true).fps).toBeLessThan(240);
});

// Deterministic serial link, with independent frame generation and receiver ACKs.
// This reproduces the HTTP Hub JPEG path without relying on the test host's LAN.
function jpegLink(mbps: number, rtt: number, fps = 60, dropAfterMs = Infinity, slowMbps = mbps) {
	const flow = new DesktopVideoFlow({ deliveryBudgetMs: 100 });
	const size = 200 * 1024;
	let nextFrame = 0,
		candidate: number | undefined,
		transmissionEnd = 0,
		pendingBytes = 0,
		peakBytes = 0;
	let received = 0,
		totalAge = 0,
		stalled = false;
	const wire: { id: number; captureAt: number; ackAt: number }[] = [];
	for (let now = 0; now < 60_000; now++) {
		while (wire.length && wire[0].ackAt <= now) {
			const frame = wire.shift()!;
			flow.ack(frame.id, 0, now);
			pendingBytes -= size;
			received++;
			totalAge += now - frame.captureAt;
		}
		if (now >= nextFrame) {
			candidate = now;
			nextFrame += 1000 / fps;
		}
		if (candidate !== undefined && !flow.blocked(fps, size) && pendingBytes + size <= 4 * 1024 ** 2) {
			const id = flow.frame(now, size);
			transmissionEnd = Math.max(now, transmissionEnd) + (size * 8) / (now >= dropAfterMs ? slowMbps : mbps) / 1000;
			wire.push({ id, captureAt: candidate, ackAt: transmissionEnd + rtt });
			pendingBytes += size;
			candidate = undefined;
		}
		peakBytes = Math.max(peakBytes, pendingBytes);
		if (flow.progressAt !== undefined && now - flow.progressAt > 15000) {
			stalled = true;
			break;
		}
	}
	return { peakBytes, received, averageAge: totalAge / received, stalled };
}

it("keeps slow JPEG paths live and bounds frame age instead of filling the 4 MiB safety limit", () => {
	const slow = jpegLink(1, 100),
		medium = jpegLink(4, 100);
	expect(slow.stalled).toBe(false);
	expect(slow.received).toBeGreaterThan(30);
	expect(slow.peakBytes).toBeLessThanOrEqual(600 * 1024);
	expect(medium.averageAge).toBeLessThan(1000);
	expect(medium.received).toBeGreaterThan(140);
	const changed = jpegLink(20, 100, 60, 10000, 1);
	expect(changed.stalled).toBe(false);
	expect(changed.averageAge).toBeLessThan(2000);
});

it("preserves LAN throughput and fills fast high-latency paths from measured delivery", () => {
	const lan = jpegLink(100, 5),
		wan = jpegLink(100, 180, 120);
	expect(lan.received).toBeGreaterThan(3500);
	expect(lan.averageAge).toBeLessThan(40);
	// 200 KiB JPEGs on 100 Mbps top out near 61 FPS, even with 120 requested.
	expect(wan.received).toBeGreaterThan(3500);
	expect(wan.averageAge).toBeLessThan(350);
});

it("times out lack of valid ACK progress, not old frames while the receiver is still advancing", () => {
	const flow = new DesktopVideoFlow({ deliveryBudgetMs: 100 });
	const first = flow.frame(0, 1000);
	flow.frame(1, 1000);
	expect(flow.progressAt).toBe(0);
	flow.ack(first, 0, 14000);
	expect(flow.oldest).toBe(1);
	expect(flow.progressAt).toBe(14000);
	flow.ack(first, 0, 20000);
	flow.ack(first + 100, 0, 21000);
	expect(flow.progressAt).toBe(14000);
	flow.reset();
	expect(flow.progressAt).toBeUndefined();
});
