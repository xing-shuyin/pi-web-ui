import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPreferences } from "../../server/device-center/desktop-preferences.js";
import { clipboardStatus } from "../../server/device-center/desktop-clipboard-status.js";

afterEach(() => vi.unstubAllGlobals());
describe("desktop settings persistence", () => {
	it("restores after reopening while separating devices and excluding invalid settings", () => {
		const values = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (k: string) => values.get(k) ?? null,
			setItem: (k: string, v: string) => values.set(k, v),
		});
		const scope = JSON.stringify(["https://hub.example", "mac-a"]);
		desktopPreferences(scope).write({
			clipboard: "both",
			quality: "sharp",
			edge: 2560,
			fps: 240,
			scale: false,
			viewOnly: true,
		});
		expect(desktopPreferences(scope).read()).toEqual({
			clipboard: "both",
			quality: "sharp",
			edge: 2560,
			fps: 240,
			scale: false,
			viewOnly: true,
		});
		expect(desktopPreferences(JSON.stringify(["https://hub.example", "mac-b"])).read()).toEqual({});
		desktopPreferences(scope).write({ clipboard: "bogus", fps: -1, scale: "false", token: "must-not-save" });
		expect(desktopPreferences(scope).read().fps).toBe(240);
		expect([...values.values()].join()).not.toContain("must-not-save");
	});
	it("keeps transfer errors and progress distinct from disabling sync", () => {
		expect(clipboardStatus("warning:clipboard-space", true)).toContain("同步仍开启");
		expect(clipboardStatus("clipboard-progress:send:1073741824:2147483648", true)).toContain("50%");
	});
});
