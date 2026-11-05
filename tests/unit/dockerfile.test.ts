import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dockerfilePath = join(root, "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");

describe("Dockerfile structure and runtime guard", () => {
	it("uses relative or absolute path for --import in CMD to prevent bare package resolution (issue #837)", () => {
		// Bare specifiers like "dist/server/..." cause Node ESM loader to treat "dist" as an npm package:
		// Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dist' imported from /app/
		const cmdMatch = dockerfile.match(/CMD\s*\[(.*)\]/s);
		expect(cmdMatch).toBeTruthy();
		const cmdContent = cmdMatch![1];
		expect(cmdContent).toMatch(/--import['"],\s*['"]\.\//);
		expect(cmdContent).not.toMatch(/--import['"],\s*['"]dist\//);
	});

	it("copies package.json and required runtime assets to /app in the runtime stage", () => {
		const stages = dockerfile.split(/FROM\s+/i);
		const runtimeStage = stages[stages.length - 1];

		// package.json is required for ESM module detection and getPkgRoot() resolution
		expect(runtimeStage).toMatch(/COPY.*package\.json/);

		// Core assets required by server endpoints (/api/themes, plugin SDK, CLI installer, etc.)
		expect(runtimeStage).toMatch(/COPY.*themes/);
		expect(runtimeStage).toMatch(/COPY.*bin/);
		expect(runtimeStage).toMatch(/COPY.*plugin-sdk/);
		expect(runtimeStage).toMatch(/COPY.*plugins/);
	});

	it("initializes data directory permissions before USER node to avoid EACCES", () => {
		const stages = dockerfile.split(/FROM\s+/i);
		const runtimeStage = stages[stages.length - 1];

		const chownIndex = runtimeStage.indexOf("chown -R node:node");
		const userNodeIndex = runtimeStage.indexOf("USER node");

		expect(chownIndex).toBeGreaterThan(-1);
		expect(userNodeIndex).toBeGreaterThan(-1);
		expect(chownIndex).toBeLessThan(userNodeIndex);
		expect(runtimeStage).toContain("/app/.pi-web");
	});

	it("sets default PI_WEB_HOST to 0.0.0.0 for container networking", () => {
		expect(dockerfile).toMatch(/ENV\s+PI_WEB_HOST=0\.0\.0\.0/);
	});
});
