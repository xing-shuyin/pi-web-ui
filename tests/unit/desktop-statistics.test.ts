import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { desktopPage } from "../../server/device-center/desktop-page.js";

it("keeps source FPS stable across delayed delivery without inventing video ACK latency", () => {
	const elements: any = { statistics: {}, "quality-fps": { value: "240" } };
	let now = 2500;
	const context: any = {
		performance: { now: () => now },
		sampleAt: 0,
		lastStatsElapsed: 0,
		lastCaptured: 0,
		lastSent: 0,
		rendered: 120,
		decodeMs: 2,
		videoMode: true,
		zh: false,
		captureBackend: "dxgi",
		videoAcceleration: "hardware decode",
		canvas: { width: 1920, height: 1080 },
		$: (id: string) => elements[id],
		t: () => "{captureFps}/{sendFps}; draw={fps}; ack={ackMs}",
	};
	const page = desktopPage();
	runInNewContext(page.slice(page.indexOf("function updateStatistics("), page.indexOf("function connect()")), context);
	const stats = { captured: 120, sent: 120, replaced: 0, ackMs: 0, queued: 0, elapsedMs: 2000, ackMeasured: false };
	context.updateStatistics(stats);
	expect(elements.statistics.textContent).toContain("60.0/60.0; draw=48.0; ack=—");
	now = 4000;
	context.rendered = 120;
	context.updateStatistics({ ...stats, captured: 240, sent: 240, elapsedMs: 4000 });
	expect(elements.statistics.textContent).toContain("60.0/60.0; draw=80.0; ack=—");
	// Older hosts have no source clock; JPEG keeps its measured ACK.
	now = 6000;
	context.rendered = 120;
	context.videoMode = false;
	context.updateStatistics({ captured: 360, sent: 360, replaced: 0, ackMs: 25, queued: 0 });
	expect(elements.statistics.textContent).toContain("60.0/60.0; draw=60.0; ack=25");
});
