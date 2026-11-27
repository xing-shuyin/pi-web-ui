import { describe, expect, it } from "vitest";
import { canOpenInEditor } from "../../web/src/editor-open-guard.js";

describe("editor open path guard (issue #1006)", () => {
	it("rejects roots, absolutes, and path traversal", () => {
		for (const bad of [
			"",
			" ",
			"@root",
			"/",
			"\\",
			".",
			"..",
			"/etc/passwd",
			"\\Windows\\System32",
			"C:\\a",
			"C:/a",
			"a/../../b",
			"a\\..\\b",
			"../x",
		]) {
			expect(canOpenInEditor(bad), bad).toBe(false);
		}
	});

	it("accepts workspace-relative file paths", () => {
		for (const good of ["a.ts", "src/a.ts", "dir with space/b.ts", "a.b/c.d.ts", ".gitignore"]) {
			expect(canOpenInEditor(good), good).toBe(true);
		}
	});
});
