import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDataDir, migrateLegacyDirSync, resolveDefaultDataDir } from "../../shared/data-dir.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "keel-data-dir-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("data-dir migration", () => {
	it("migrates ~/.pi-web to ~/.keel by moving when ~/.keel does not exist", () => {
		const home = makeTempDir();
		const legacy = join(home, ".pi-web");
		const target = defaultDataDir(home);
		mkdirSync(join(legacy, "nested"), { recursive: true });
		writeFileSync(join(legacy, "server-config.json"), '{"port":8787}\n', "utf8");
		writeFileSync(join(legacy, "nested", "note.txt"), "hello", "utf8");

		const resolved = resolveDefaultDataDir({ home, env: {} });
		expect(resolved).toBe(target);
		expect(existsSync(legacy)).toBe(false);
		expect(readFileSync(join(target, "server-config.json"), "utf8")).toBe('{"port":8787}\n');
		expect(readFileSync(join(target, "nested", "note.txt"), "utf8")).toBe("hello");
	});

	it("does not overwrite existing ~/.keel when both ~/.keel and ~/.pi-web exist", () => {
		const home = makeTempDir();
		const legacy = join(home, ".pi-web");
		const target = defaultDataDir(home);
		mkdirSync(legacy, { recursive: true });
		mkdirSync(target, { recursive: true });
		writeFileSync(join(legacy, "marker.txt"), "old", "utf8");
		writeFileSync(join(target, "marker.txt"), "new", "utf8");

		const resolved = resolveDefaultDataDir({ home, env: {} });
		expect(resolved).toBe(target);
		expect(readFileSync(join(target, "marker.txt"), "utf8")).toBe("new");
		expect(readFileSync(join(legacy, "marker.txt"), "utf8")).toBe("old");
	});

	it("respects explicit or PI_WEB_DATA_DIR without migrating ~/.pi-web", () => {
		const home = makeTempDir();
		const legacy = join(home, ".pi-web");
		const custom = join(home, "custom-data");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "keep.txt"), "1", "utf8");

		expect(resolveDefaultDataDir({ explicit: custom, home, env: {} })).toBe(resolve(custom));
		expect(resolveDefaultDataDir({ home, env: { PI_WEB_DATA_DIR: custom } })).toBe(resolve(custom));
		expect(existsSync(legacy)).toBe(true);
		expect(existsSync(defaultDataDir(home))).toBe(false);
	});

	it("migrates first matching desktop legacy userData directory into keel", () => {
		const appData = makeTempDir();
		const target = join(appData, "keel");
		const oldAgent = join(appData, "keel-agent");
		const oldDesktop = join(appData, "pi-web-ui-desktop");
		mkdirSync(oldAgent, { recursive: true });
		mkdirSync(oldDesktop, { recursive: true });
		writeFileSync(join(oldAgent, "prefs.json"), '{"ok":true}', "utf8");

		const res = migrateLegacyDirSync(target, [oldAgent, oldDesktop], "desktop-userData");
		expect(res.migrated).toBe(true);
		expect(res.from).toBe(oldAgent);
		expect(res.to).toBe(target);
		expect(existsSync(oldAgent)).toBe(false);
		expect(readFileSync(join(target, "prefs.json"), "utf8")).toBe('{"ok":true}');
		expect(existsSync(oldDesktop)).toBe(true);
	});
});
