import { describe, expect, it } from "vitest";
import { desktopResolution, desktopViewportEdge } from "../../server/device-center/desktop-resolution.js";
import { parseDesktopPreferences, parseDesktopProfile } from "../../server/device-center/desktop-quality.js";
describe("live stream resolution", () => {
	it("fits the selected box without stretching, upscaling or exceeding the channel", () => {
		expect(desktopResolution("1280x720", 0, 0, 1920, 1080, 900, 4096)).toBe(1280);
		expect(desktopResolution("custom", 1280, 720, 1080, 1920, 900, 4096)).toBe(720);
		expect(desktopResolution("native", 0, 0, 3840, 2160, 900, 4096)).toBe(3840);
		expect(desktopResolution("native", 0, 0, 3840, 2160, 900, 2560)).toBe(2560);
		expect(desktopResolution("3840x2160", 0, 0, 1920, 1080, 900, 4096)).toBe(1920);
		expect(desktopResolution("window", 0, 0, 3840, 2160, 900, 4096)).toBe(900);
		for (const width of [NaN, Infinity, 10000, 1280.5])
			expect(desktopResolution("custom", width, 720, 1920, 1080, 900)).toBeUndefined();
	});
	it("fits letterboxing and retains native text detail near 1:1 without upscaling", () => {
		expect(desktopViewportEdge(1600, 950, 1, 1920, 1080, "auto", 4096)).toBe(1920);
		expect(desktopViewportEdge(1600, 950, 1, 1920, 1080, "smooth", 4096)).toBe(1600);
		expect(desktopViewportEdge(900, 1400, 1, 1920, 1080, "sharp", 4096)).toBe(1350);
		expect(desktopViewportEdge(850, 600, 2, 1920, 1080, "sharp", 4096)).toBe(1920);
		expect(desktopViewportEdge(1920, 1080, 2, 3840, 2160, "auto", 2560)).toBe(2560);
	});
	it("accepts bounded 4K and SDR ranges while refusing unknown color modes", () => {
		const profile = { maxEdge: 4096, quality: 70, fps: 60, colorRange: "full" };
		expect(parseDesktopProfile(profile)).toEqual(profile);
		const preferences = { mode: "auto", maxEdge: 3840, viewportEdge: 4096, fps: 60, colorRange: "limited" };
		expect(parseDesktopPreferences(preferences)).toEqual(preferences);
		for (const bad of [{ maxEdge: 4097 }, { colorRange: "hdr" }, { colorRange: 1 }]) {
			expect(parseDesktopProfile({ ...profile, ...bad })).toBeUndefined();
			expect(parseDesktopPreferences({ ...preferences, ...bad })).toBeUndefined();
		}
	});
});
