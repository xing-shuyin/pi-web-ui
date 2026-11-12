import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserCustomization, MAX_DESIGN_BYTES, NEWTAB_STARTER } from "../../browser/runtime/customize.js";

const directories: string[] = [];
function directory(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-custom-"));
	directories.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const BUILTIN = "file:///app/dist/browser/renderer/newtab.html";
const PAGE = "<!doctype html><title>mine</title><h1>hi</h1>";

describe("BrowserCustomization", () => {
	it("starts empty: status says default, document returns the starter template", () => {
		const custom = new BrowserCustomization(directory());
		expect(custom.statuses().map((status) => [status.kind, status.custom])).toEqual([
			["newtab", false],
			["theme", false],
		]);
		const document = custom.document("newtab");
		expect(document.starter).toBe(true);
		expect(document.content).toBe(NEWTAB_STARTER);
		expect(document.content).toContain("piBrowserShell");
		expect(document.status.path).toBe(custom.path("newtab"));
		expect(document.status.maxBytes).toBe(MAX_DESIGN_BYTES);
		expect(custom.themeCss()).toBe("");
		expect(custom.newTabUrl(BUILTIN)).toBe(BUILTIN);
	});

	it("stores user content under the data dir, atomically and outside the build output", () => {
		const dataDir = directory();
		const custom = new BrowserCustomization(dataDir);
		const status = custom.write("newtab", PAGE);
		expect(status).toMatchObject({ kind: "newtab", file: "newtab.html", custom: true });
		expect(status.bytes).toBe(Buffer.byteLength(PAGE));
		expect(custom.read("newtab")).toBe(PAGE);
		expect(fs.readdirSync(custom.dir)).toEqual(["newtab.html"]);
		expect(path.dirname(custom.dir)).toBe(dataDir);
		expect(custom.document("newtab")).toMatchObject({ content: PAGE, starter: false });
		expect(custom.newTabUrl(BUILTIN)).toBe(pathToFileURL(custom.path("newtab")).href);
	});

	it("treats an empty body as reset, so a blank page cannot trap the user", () => {
		const custom = new BrowserCustomization(directory());
		custom.write("theme", ":root{--pb-accent:#f0f}");
		expect(custom.themeCss()).toContain("--pb-accent");
		const status = custom.write("theme", "   \n\t ");
		expect(status.custom).toBe(false);
		expect(custom.themeCss()).toBe("");
		expect(fs.existsSync(custom.path("theme"))).toBe(false);
	});

	it("rejects non-text payloads and oversized files instead of truncating", () => {
		const custom = new BrowserCustomization(directory());
		expect(() => custom.write("newtab", 42)).toThrow(/must be a string/);
		expect(() => custom.write("newtab", "<p>a\u0000b</p>")).toThrow(/binary/);
		expect(() => custom.write("newtab", `<!--${"x".repeat(MAX_DESIGN_BYTES)}-->`)).toThrow(/limit is 512KB/);
		expect(custom.status("newtab").custom).toBe(false);
	});

	it("strips a BOM so a Windows-edited file does not start with a stray character", () => {
		const custom = new BrowserCustomization(directory());
		custom.write("newtab", `\uFEFF${PAGE}`);
		expect(custom.read("newtab")).toBe(PAGE);
	});

	it("recognises its own file URLs (with query/hash) and leaves everything else alone", () => {
		const custom = new BrowserCustomization(directory());
		custom.write("newtab", PAGE);
		const url = pathToFileURL(custom.path("newtab")).href;
		expect(custom.isNewTabFile(url)).toBe(true);
		expect(custom.isNewTabFile(`${url}?panel=1#top`)).toBe(true);
		expect(custom.isNewTabFile(BUILTIN)).toBe(false);
		expect(custom.isNewTabFile("https://example.com/newtab.html")).toBe(false);
		expect(custom.isNewTabFile("not a url")).toBe(false);
		expect(custom.isCustomFile(pathToFileURL(custom.path("theme")).href)).toBe(true);
		expect(custom.isCustomFile(pathToFileURL(path.join(custom.dir, "other.html")).href)).toBe(false);
	});

	it("rejects unknown kinds and unknown design kinds never leak into a file path", () => {
		const custom = new BrowserCustomization(directory());
		expect(() => custom.write("scripts" as never, "x")).toThrow(/Invalid design kind/);
		expect(() => custom.read("../../evil" as never)).toThrow(/Invalid design kind/);
	});
});
