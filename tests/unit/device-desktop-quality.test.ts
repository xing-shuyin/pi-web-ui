import { describe, it, expect } from "vitest";
import {
	DesktopQuality,
	parseDesktopPreferences,
	parseDesktopProfile,
} from "../../server/device-center/desktop-quality.js";

describe("desktop quality", () => {
	it("bounds profiles and rejects coercion and invalid values", () => {
		const p = { maxEdge: 1280, quality: 65, fps: 30 };
		expect(parseDesktopProfile(p)).toEqual(p);
		for (const change of [
			{ maxEdge: Infinity },
			{ maxEdge: 10000 },
			{ maxEdge: 1 },
			{ quality: 100 },
			{ quality: "65" },
			{ fps: 241 },
			{ fps: 1.2 },
		])
			expect(parseDesktopProfile({ ...p, ...change })).toBeUndefined();
		const prefs = { mode: "auto", maxEdge: 0, viewportEdge: 1280, fps: 30 };
		for (const fps of [60, 120, 240]) expect(parseDesktopProfile({ ...p, fps })?.fps).toBe(fps);
		expect(parseDesktopPreferences(prefs)).toEqual(prefs);
		for (const change of [{ mode: "unknown" }, { maxEdge: -1 }, { viewportEdge: 0 }, { fps: "30" }])
			expect(parseDesktopPreferences({ ...prefs, ...change })).toBeUndefined();
	});
	it("follows the viewport and manual resolution without changing aspect or host settings", () => {
		const q = new DesktopQuality();
		expect(q.set({ mode: "balanced", maxEdge: 0, viewportEdge: 960, fps: 15 })).toEqual({
			maxEdge: 960,
			quality: 65,
			fps: 15,
		});
		expect(q.set({ mode: "sharp", maxEdge: 2560, viewportEdge: 960, fps: 30 }).maxEdge).toBe(2560);
		for (let i = 0; i < 20; i++) q.sample(1000);
		expect(q.profile).toEqual({ maxEdge: 2560, quality: 85, fps: 30 });
	});
	it("ignores one jitter sample, lowers on confirmed congestion, and restores gradually", () => {
		const q = new DesktopQuality();
		const initial = q.profile;
		q.sample(200);
		expect(q.profile).toEqual(initial);
		q.sample(200);
		expect(q.profile.maxEdge).toBeLessThan(initial.maxEdge);
		const lower = q.profile;
		for (let i = 0; i < 3; i++) q.sample(20);
		expect(q.profile).toEqual(lower);
		q.sample(20);
		expect(q.profile.maxEdge).toBeGreaterThan(lower.maxEdge);
		for (let i = 0; i < 50; i++) q.sample(2000);
		expect(q.profile.maxEdge).toBeGreaterThanOrEqual(640);
		expect(q.profile.quality).toBeGreaterThanOrEqual(35);
		for (let i = 0; i < 100; i++) q.sample(10);
		expect(q.profile).toEqual(initial);
	});
});
