import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_CATALOG, normalizeNativeCliInheritModel } from "../../server/engine-catalog.js";
import { ENGINE_PACKAGES, getCachedEngineStatuses } from "../../server/engine-probe.js";
import { findNativeCliExecutable } from "../../server/native-cli-discovery.js";
import { parseNativeCliMetadata, resolveNativeCliLaunch, validateNativeCliConfig } from "../../server/native-cli.js";

const windows = process.platform === "win32";
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-agy-cli-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function install(directory: string): string {
	mkdirSync(directory, { recursive: true });
	const file = join(directory, windows ? "agy.exe" : "agy");
	writeFileSync(file, "fixture", { mode: 0o755 });
	return file;
}

describe("standalone Antigravity CLI", () => {
	it("stays out of SDK chat engines and npm install/update actions", () => {
		expect(ENGINE_CATALOG.agy.packageName).toBeNull();
		expect(ENGINE_PACKAGES).not.toHaveProperty("agy");
		expect(getCachedEngineStatuses().some((engine) => engine.id === "agy")).toBe(false);
		expect(ENGINE_PACKAGES).toHaveProperty("dsh");
	});
	it("round-trips persisted agy metadata and supports the documented model option", () => {
		const config = { preset: "agy", model: { provider: "google", id: "gemini-model" } } as const;
		expect(parseNativeCliMetadata({ version: 1, config })).toEqual(config);
		expect(normalizeNativeCliInheritModel({ agy: true, dsh: true })).toEqual({ agy: true });
		expect(resolveNativeCliLaunch({ ...config, executable: process.execPath })).toEqual({
			file: process.execPath,
			args: ["--model", "gemini-model"],
		});
	});
	it("keeps an explicit model and literal interactive arguments", () => {
		expect(
			resolveNativeCliLaunch({
				preset: "agy",
				executable: process.execPath,
				model: { provider: "google", id: "inherited" },
				args: ["--model=explicit", "--prompt-interactive", "a task with spaces"],
			}),
		).toEqual({ file: process.execPath, args: ["--model=explicit", "--prompt-interactive", "a task with spaces"] });
	});
	it("rejects DSH's profile launcher as a native terminal preset", () => {
		expect(() => validateNativeCliConfig({ preset: "dsh" })).toThrow(/no standalone CLI/);
		expect(() => validateNativeCliConfig({ preset: "dsh", args: ["web"] })).toThrow(/no standalone CLI/);
	});
	it.skipIf(!windows)("finds the official Windows installer location without PATH", () => {
		const localData = join(root, "local data");
		const file = install(join(localData, "agy", "bin"));
		expect(
			findNativeCliExecutable("agy", {
				env: { LocalAppData: localData },
				homeDir: root,
				cwd: root,
				nodeExecutable: join(root, "runtime", "node.exe"),
				autoDetect: true,
			}),
		).toBe(file);
	});
	it.skipIf(!windows)("uses the conventional LocalAppData path when the service environment omits it", () => {
		const file = install(join(root, "AppData", "Local", "agy", "bin"));
		expect(findNativeCliExecutable("agy", { env: {}, homeDir: root, cwd: root, autoDetect: true })).toBe(file);
	});
	it.skipIf(windows)("finds the official macOS/Linux installer location without PATH", () => {
		const file = install(join(root, ".local", "bin"));
		expect(findNativeCliExecutable("agy", { env: {}, homeDir: root, cwd: root, autoDetect: true })).toBe(file);
	});
});
