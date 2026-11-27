import { describe, expect, it } from "vitest";
import { imageMimeForPath } from "../../plugins/vscode-editor/index.mjs";

describe("vscode-editor image preview mime (issue #1001)", () => {
	it("maps supported extensions", () => {
		expect(imageMimeForPath("a.png")).toBe("image/png");
		expect(imageMimeForPath("a.jpg")).toBe("image/jpeg");
		expect(imageMimeForPath("a.jpeg")).toBe("image/jpeg");
		expect(imageMimeForPath("a.gif")).toBe("image/gif");
		expect(imageMimeForPath("a.webp")).toBe("image/webp");
		expect(imageMimeForPath("a.svg")).toBe("image/svg+xml");
		expect(imageMimeForPath("a.bmp")).toBe("image/bmp");
		expect(imageMimeForPath("a.ico")).toBe("image/x-icon");
		expect(imageMimeForPath("a.avif")).toBe("image/avif");
	});

	it("is case-insensitive and path-safe", () => {
		expect(imageMimeForPath("DIR/Shot.PNG")).toBe("image/png");
		expect(imageMimeForPath("a.JpG")).toBe("image/jpeg");
		expect(imageMimeForPath(null)).toBeNull();
		expect(imageMimeForPath(undefined)).toBeNull();
		expect(imageMimeForPath("")).toBeNull();
		expect(imageMimeForPath("noext")).toBeNull();
		expect(imageMimeForPath(".png")).toBe("image/png");
	});

	it("rejects non-images and lookalikes", () => {
		for (const p of ["a.txt", "a.exe", "a.png.exe", "a.jp", "a.svgz", "png", "a.PNG.bak"]) {
			expect(imageMimeForPath(p), p).toBeNull();
		}
	});
});
