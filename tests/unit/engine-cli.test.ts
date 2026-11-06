import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_CATALOG, isBuiltinEngineId, isNativeCliEngineId } from "../../server/engine-catalog.js";
import { probeGlobalPackage } from "../../server/global-loader.js";
import { findNativeCliExecutable } from "../../server/native-cli-discovery.js";
import { probeEngineCliVersion, resolveEngineCliLaunch } from "../../server/engine-cli.js";

vi.mock("../../server/global-loader.js", () => ({ probeGlobalPackage: vi.fn() }));
vi.mock("../../server/native-cli-discovery.js", () => ({ findNativeCliExecutable: vi.fn() }));
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-engine-cli-"));
	vi.mocked(findNativeCliExecutable).mockReset().mockReturnValue(undefined);
	vi.mocked(probeGlobalPackage).mockReset().mockReturnValue({ installed: false });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cliEngines = ["pi", "claude", "codex"] as const;
describe("shared engine CLI discovery", () => {
	it.each(cliEngines)("uses %s's declared npm bin when PATH and conventional launchers are absent", (id) => {
		const meta = ENGINE_CATALOG[id];
		const script = join(root, "bin", "entry.js");
		mkdirSync(join(root, "bin"));
		writeFileSync(script, "// CLI fixture");
		writeFileSync(join(root, "package.json"), JSON.stringify({ bin: { [meta.cliCommand]: "bin/entry.js" } }));
		vi.mocked(probeGlobalPackage).mockReturnValue({ installed: true, packagePath: root, version: "1.2.3" });
		expect(resolveEngineCliLaunch(id, { args: ["literal argument", "a&b"], refresh: true })).toEqual({
			file: process.execPath,
			args: [script, "literal argument", "a&b"],
		});
		expect(probeGlobalPackage).toHaveBeenCalledWith(meta.packageName, { refresh: true });
	});
	it("also accepts package.json's single string bin declaration", () => {
		const script = join(root, "entry.mjs");
		writeFileSync(script, "// CLI fixture");
		writeFileSync(join(root, "package.json"), JSON.stringify({ bin: "entry.mjs" }));
		vi.mocked(probeGlobalPackage).mockReturnValue({ installed: true, packagePath: root });
		expect(resolveEngineCliLaunch("pi")).toEqual({ file: process.execPath, args: [script] });
	});
	it("prefers the current CLI search result over another installed npm package", () => {
		vi.mocked(findNativeCliExecutable).mockReturnValue(process.execPath);
		expect(resolveEngineCliLaunch("claude", { args: ["literal value"] })).toEqual({
			file: process.execPath,
			args: ["literal value"],
		});
		expect(probeGlobalPackage).not.toHaveBeenCalled();
	});
	it("keeps an explicitly configured executable ahead of automatic discovery", () => {
		vi.mocked(findNativeCliExecutable).mockReturnValue(process.execPath);
		expect(resolveEngineCliLaunch("codex", { executablePath: process.execPath, args: ["--version"] })).toEqual({
			file: process.execPath,
			args: ["--version"],
		});
		expect(probeGlobalPackage).not.toHaveBeenCalled();
		if (process.platform === "win32")
			expect(findNativeCliExecutable).toHaveBeenCalledWith(
				process.execPath,
				expect.objectContaining({ autoDetect: false }),
			);
	});
	it.each([{}, { bin: {} }, { bin: { pi: "missing.js" } }])(
		"does not mistake a library or incomplete bin for an installed CLI: %j",
		(manifest) => {
			writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
			vi.mocked(probeGlobalPackage).mockReturnValue({ installed: true, packagePath: root });
			expect(() => resolveEngineCliLaunch("pi")).toThrow(/CLI executable not found/);
		},
	);
	it("reports an actionable missing CLI error", () => {
		expect(() => resolveEngineCliLaunch("codex")).toThrow(/npm i -g @openai\/codex/);
	});
	it.each(["dsh", "durable"] as const)("never invents an interactive %s CLI", async (id) => {
		expect(() => resolveEngineCliLaunch(id)).toThrow(/no standalone CLI/);
		expect(await probeEngineCliVersion(id)).toMatchObject({
			available: false,
			error: expect.stringContaining("no standalone CLI"),
		});
		expect(findNativeCliExecutable).not.toHaveBeenCalled();
		expect(probeGlobalPackage).not.toHaveBeenCalled();
	});
	it("launches Antigravity's native binary without an npm package or forced noninteractive mode", () => {
		vi.mocked(findNativeCliExecutable).mockReturnValue(process.execPath);
		expect(resolveEngineCliLaunch("agy")).toEqual({ file: process.execPath, args: [] });
		expect(findNativeCliExecutable).toHaveBeenCalledWith("agy", expect.objectContaining({ autoDetect: true }));
		expect(probeGlobalPackage).not.toHaveBeenCalled();
	});
	it("offers the official CLI installer when Antigravity is missing instead of probing a fictitious npm package", () => {
		expect(() => resolveEngineCliLaunch("agy")).toThrow(
			/https:\/\/antigravity\.google\/docs\/getting-started\?tab=cli/,
		);
		expect(probeGlobalPackage).not.toHaveBeenCalled();
	});
	it("probes versions using the very same resolved command and literal argv", async () => {
		vi.mocked(findNativeCliExecutable).mockReturnValue(process.execPath);
		const result = await probeEngineCliVersion("pi");
		expect(result).toEqual({ available: true, version: process.version });
	});
	it("uses own catalog keys rather than prototype properties", () => {
		for (const value of ["toString", "__proto__", "unknown", null]) expect(isBuiltinEngineId(value)).toBe(false);
		for (const value of Object.keys(ENGINE_CATALOG)) {
			expect(isNativeCliEngineId(value)).toBe(true);
			expect(isBuiltinEngineId(value)).toBe(value !== "agy");
		}
	});
});
