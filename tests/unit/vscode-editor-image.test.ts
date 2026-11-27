import { describe, expect, it } from "vitest";
import { imageMimeFor } from "../../plugins/vscode-editor/index.mjs";

describe("vscode-editor image preview mime (issue #1001)", () => {
	it("maps supported binary image extensions", () => {
		expect(imageMimeFor("a.png")).toBe("image/png");
		expect(imageMimeFor("a.jpg")).toBe("image/jpeg");
		expect(imageMimeFor("a.jpeg")).toBe("image/jpeg");
		expect(imageMimeFor("a.gif")).toBe("image/gif");
		expect(imageMimeFor("a.webp")).toBe("image/webp");
		expect(imageMimeFor("a.bmp")).toBe("image/bmp");
		expect(imageMimeFor("a.ico")).toBe("image/x-icon");
		expect(imageMimeFor("a.avif")).toBe("image/avif");
	});

	it("is case-insensitive and handles invalid inputs", () => {
		expect(imageMimeFor("DIR/Shot.PNG")).toBe("image/png");
		expect(imageMimeFor("a.JpG")).toBe("image/jpeg");
		expect(imageMimeFor(null as unknown as string)).toBeNull();
		expect(imageMimeFor(undefined as unknown as string)).toBeNull();
		expect(imageMimeFor("")).toBeNull();
		expect(imageMimeFor("noext")).toBeNull();
	});

	it("rejects non-images and lookalikes", () => {
		for (const p of ["a.txt", "a.exe", "a.png.exe", "a.jp", "png", "a.PNG.bak"]) {
			expect(imageMimeFor(p), p).toBeNull();
		}
	});
});
