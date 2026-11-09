import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectScripts } from "../../server/project-scripts.js";

describe("resolveProjectScripts", () => {
	it("reads scripts from package.json and walks up", () => {
		const root = mkdtempSync(join(tmpdir(), "proj-scripts-"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "tsc" } }));
		mkdirSync(join(root, "sub", "deep"), { recursive: true });
		const found = resolveProjectScripts(join(root, "sub", "deep"));
		expect(found.cwd).toBe(root);
		expect(found.scripts).toMatchObject({ dev: "vite" });
	});

	it("returns empty when no package.json", () => {
		const root = mkdtempSync(join(tmpdir(), "proj-empty-"));
		const found = resolveProjectScripts(root);
		expect(found.scripts).toEqual({});
	});
});
