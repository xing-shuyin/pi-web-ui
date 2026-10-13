import { describe, expect, it } from "vitest";
import { getAppVersion, getPkgRoot } from "../../server/pkg-info.js";
import { DshClientSession } from "../../server/dsh/dsh-agent-service.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("server/pkg-info", () => {
	it("finds the repository root and non-empty version", () => {
		const root = getPkgRoot();
		expect(root).toBeDefined();
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; version?: string };
		expect(pkg.name).toBe("pi-web-ui");
		expect(pkg.version).toBeDefined();

		const ver = getAppVersion();
		expect(ver).toBe(pkg.version);
		expect(ver).not.toBe("0.0.0");
		expect(ver).not.toBe("");
	});

	it("DshClientSession.currentAppVersion returns real version instead of 0.0.0", () => {
		const ver = DshClientSession.currentAppVersion();
		expect(ver).not.toBe("0.0.0");
		expect(ver).toBe(getAppVersion());
	});
});
