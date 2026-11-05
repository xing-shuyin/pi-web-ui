import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dockerfilePath = join(root, "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");

describe("Dockerfile structure and hermetic packaging guard", () => {
	it("uses hermetic npm pack in build stage as the SSOT delivery artifact", () => {
		expect(dockerfile).toMatch(/npm pack\s+--pack-destination/);
	});

	it("installs packaged tarball in installer stage and copies /usr/local to runtime", () => {
		expect(dockerfile).toMatch(/npm install -g \/tmp\/app\.tgz/);
		expect(dockerfile).toMatch(/COPY --from=installer \/usr\/local \/usr\/local/);
	});

	it("uses standard global CLI ENTRYPOINT and --no-browser CMD (no fragile relative paths)", () => {
		expect(dockerfile).toMatch(/ENTRYPOINT\s*\["pi-web-ui"\]/);
		expect(dockerfile).toMatch(/CMD\s*\["--no-browser"\]/);
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
