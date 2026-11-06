import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanBrokenSymlinks, linkPlugin, unlinkPlugin } from "../../scripts/link-plugins.mjs";

describe("scripts/link-plugins", () => {
	let testDir: string;
	let repoDir: string;
	let targetDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-link-test-"));
		repoDir = join(testDir, "repo-plugins");
		targetDir = join(testDir, "user-plugins");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(targetDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("links plugin from repoDir to targetDir and preserves source", () => {
		const pluginSrc = join(repoDir, "my-plugin");
		mkdirSync(pluginSrc);
		writeFileSync(join(pluginSrc, "manifest.json"), JSON.stringify({ id: "my-plugin", version: "1.0.0" }));

		const ok = linkPlugin("my-plugin", { repoDir, targetDir });
		expect(ok).toBe(true);

		const dest = join(targetDir, "my-plugin");
		expect(existsSync(dest)).toBe(true);
		expect(lstatSync(dest).isSymbolicLink()).toBe(true);

		const readManifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
		expect(readManifest.version).toBe("1.0.0");

		writeFileSync(join(pluginSrc, "manifest.json"), JSON.stringify({ id: "my-plugin", version: "1.0.1" }));
		const updated = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
		expect(updated.version).toBe("1.0.1");

		const unlinked = unlinkPlugin("my-plugin", { repoDir, targetDir });
		expect(unlinked).toBe(true);
		expect(lstatSync(dest).isSymbolicLink()).toBe(false);
	});

	it("cleans up broken symlinks pointing to non-existent targets", () => {
		const isWin = process.platform === "win32";
		const deadTarget = join(repoDir, "ghost-plugin");
		const deadLink = join(targetDir, "ghost-plugin");

		symlinkSync(deadTarget, deadLink, isWin ? "junction" : "dir");
		expect(lstatSync(deadLink).isSymbolicLink()).toBe(true);
		expect(existsSync(deadLink)).toBe(false);

		const removed = cleanBrokenSymlinks({ targetDir });
		expect(removed).toContain("ghost-plugin");
		expect(existsSync(deadLink)).toBe(false);
		try {
			lstatSync(deadLink);
			expect.unreachable("deadLink should have been removed");
		} catch (err: any) {
			expect(err.code).toBe("ENOENT");
		}
	});
});
