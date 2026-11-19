import { afterEach, describe, expect, it, vi } from "vitest";
import { desktopPreferences } from "../../server/device-center/desktop-preferences.js";
import { parseDesktopCursor } from "../../server/device-center/desktop-cursor.js";
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
			resolution: "custom",
			width: 3840,
			height: 2160,
			colorRange: "full",
			diagnostics: false,
			mapShortcuts: true,
			cursor: "remote",
		});
		expect(desktopPreferences(scope).read()).toEqual({
			clipboard: "both",
			quality: "sharp",
			edge: 2560,
			fps: 240,
			scale: false,
			viewOnly: true,
			resolution: "custom",
			width: 3840,
			height: 2160,
			colorRange: "full",
			diagnostics: false,
			mapShortcuts: true,
			cursor: "remote",
		});
		expect(desktopPreferences(JSON.stringify(["https://hub.example", "mac-b"])).read()).toEqual({});
		desktopPreferences(scope).write({ clipboard: "bogus", fps: -1, scale: "false", token: "must-not-save" });
		expect(desktopPreferences(scope).read().fps).toBe(240);
		expect([...values.values()].join()).not.toContain("must-not-save");
		expect(
			desktopPreferences(scope).clean({
				resolution: "9999x9999",
				width: NaN,
				height: "1080",
				colorRange: "hdr",
				diagnostics: 1,
				mapShortcuts: "yes",
				cursor: "both",
			}),
		).toEqual({});
	});
	it("bounds cursor packets and obtains sprite dimensions from the image header", () => {
		const cursor = { type: "cursor", kind: "position", x: 0, y: 1 };
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm4kAAAAASUVORK5CYII=";
		expect(parseDesktopCursor({ ...cursor, shape: { png, hotX: 0, hotY: 0, width: 500 } })).toEqual({
			...cursor,
			shape: { png, width: 1, height: 1, hotX: 0, hotY: 0 },
		});
		for (const bad of [
			{ ...cursor, x: NaN },
			{ ...cursor, y: -1 },
			{ ...cursor, shape: { png: "////", hotX: 0, hotY: 0 } },
			{ ...cursor, shape: { png, hotX: 3, hotY: 0 } },
		])
			expect(parseDesktopCursor(bad)).toBeUndefined();
	});
	it("keeps transfer errors and progress distinct from disabling sync", () => {
		expect(clipboardStatus("warning:clipboard-space", true)).toContain("同步仍开启");
		expect(clipboardStatus("clipboard-progress:send:1073741824:2147483648", true)).toContain("50%");
	});
});
