import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratePluginState, pluginCodeDir, pluginStateDir, pluginStateFile } from "../../server/plugin-paths.js";

const roots: string[] = [];
function dataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "plugin-paths-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("plugin state layout", () => {
	it("keeps code and state in separate roots", () => {
		const dir = dataDir();
		expect(pluginCodeDir(dir, "demo")).toBe(join(dir, "plugins", "demo"));
		expect(pluginStateDir(dir, "demo")).toBe(join(dir, "plugin-data", "demo"));
		expect(pluginStateFile(dir, "demo", "storage.json")).toBe(join(dir, "plugin-data", "demo", "storage.json"));
	});

	it("moves legacy state out of the code directory once", () => {
		const dir = dataDir();
		const code = pluginCodeDir(dir, "demo");
		mkdirSync(code, { recursive: true });
		writeFileSync(join(code, "manifest.json"), '{"id":"demo"}');
		writeFileSync(join(code, "storage.json"), '{"settings":{"model":"x"}}');
		writeFileSync(join(code, "secrets.bin"), "sealed");
		writeFileSync(join(code, "schedules.json"), '{"v":1,"schedules":{}}');

		expect(migratePluginState(dir, "demo").sort()).toEqual(["schedules.json", "secrets.bin", "storage.json"]);
		expect(readFileSync(join(pluginStateDir(dir, "demo"), "storage.json"), "utf8")).toBe('{"settings":{"model":"x"}}');
		for (const name of ["storage.json", "secrets.bin", "schedules.json"]) {
			expect(existsSync(join(code, name))).toBe(false);
		}
		// 幂等：再跑一次什么都不动
		expect(migratePluginState(dir, "demo")).toEqual([]);
	});

	it("never overwrites newer state with a stale legacy copy", () => {
		const dir = dataDir();
		const code = pluginCodeDir(dir, "demo");
		mkdirSync(code, { recursive: true });
		mkdirSync(pluginStateDir(dir, "demo"), { recursive: true });
		writeFileSync(join(code, "storage.json"), '{"settings":{"model":"stale"}}');
		writeFileSync(join(pluginStateDir(dir, "demo"), "storage.json"), '{"settings":{"model":"fresh"}}');

		expect(migratePluginState(dir, "demo")).toEqual([]);
		expect(readFileSync(join(pluginStateDir(dir, "demo"), "storage.json"), "utf8")).toBe(
			'{"settings":{"model":"fresh"}}',
		);
		expect(existsSync(join(code, "storage.json"))).toBe(true);
	});
});
