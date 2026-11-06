import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findNativeCliExecutable, type NativeCliDiscoveryOptions } from "../../server/native-cli-discovery.js";

const windows = process.platform === "win32";
const name = "pi-cli-discovery-fixture";
let root: string;
let options: NativeCliDiscoveryOptions;
function install(directory: string, command = name): string {
	mkdirSync(directory, { recursive: true });
	const file = join(directory, command + (windows ? ".exe" : ""));
	writeFileSync(file, "CLI fixture", { mode: 0o755 });
	return file;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-cli-discovery-"));
	options = { env: {}, cwd: root, homeDir: root, nodeExecutable: join(root, "runtime", "node"), autoDetect: true };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("native CLI executable discovery", () => {
	it("prefers PATH order over native user and runtime installations", () => {
		const first = install(join(root, "first with spaces"));
		install(join(root, "second"));
		install(join(root, ".local", "bin"));
		install(join(root, "runtime"));
		options.env = { PATH: [dirname(first), join(root, "second")].join(windows ? ";" : ":") };
		expect(findNativeCliExecutable(name, options)).toBe(first);
	});
	it("resolves an explicit path without substituting another installation", () => {
		const file = install(join(root, "explicit with spaces"));
		install(join(root, ".local", "bin"));
		expect(findNativeCliExecutable(file, options)).toBe(file);
		expect(findNativeCliExecutable(join(root, "missing", name), options)).toBeUndefined();
	});
	it("finds user native installations without PATH", () => {
		const file = install(join(root, ".local", "bin"));
		expect(findNativeCliExecutable(name, options)).toBe(file);
	});
	it("finds installations next to the running Node executable", () => {
		const file = install(join(root, "runtime"));
		expect(findNativeCliExecutable(name, options)).toBe(file);
	});
	it.each(["PNPM_HOME", "NVM_BIN", "NVM_SYMLINK", "FNM_MULTISHELL_PATH"])("honors %s", (key) => {
		const file = install(join(root, "manager with spaces"));
		options.env = { [key]: dirname(file) };
		expect(findNativeCliExecutable(name, options)).toBe(file);
	});
	it.each(["VOLTA_HOME", "BUN_INSTALL"])("honors %s bin directories", (key) => {
		const directory = join(root, "manager");
		const file = install(join(directory, "bin"));
		options.env = { [key]: directory };
		expect(findNativeCliExecutable(name, options)).toBe(file);
	});
	it.each(["npm_config_prefix", "NPM_CONFIG_PREFIX"])("honors %s", (key) => {
		const prefix = join(root, "npm prefix");
		const file = install(windows ? prefix : join(prefix, "bin"));
		options.env = { [key]: prefix };
		expect(findNativeCliExecutable(name, options)).toBe(file);
	});
	it("finds a persistent fnm installation and prefers the newest version without shell initialization", () => {
		const fnm = join(root, "fnm");
		const directory = (version: string) => {
			const installation = join(fnm, "node-versions", version, "installation");
			return windows ? installation : join(installation, "bin");
		};
		install(directory("v22.9.0"));
		const newest = install(directory("v22.10.0"));
		options.env = { FNM_DIR: fnm };
		expect(findNativeCliExecutable(name, options)).toBe(newest);
	});
	it("finds a persistent nvm installation without an active shell", () => {
		const nvm = join(root, "nvm");
		const directory = windows ? join(nvm, "v22.0.0") : join(nvm, "versions", "node", "v22.0.0", "bin");
		const file = install(directory);
		options.env = windows ? { NVM_HOME: nvm } : { NVM_DIR: nvm };
		expect(findNativeCliExecutable(name, options)).toBe(file);
	});
	it("only searches install directories when automatic detection is enabled", () => {
		install(join(root, ".local", "bin"));
		expect(findNativeCliExecutable(name, { ...options, autoDetect: false })).toBeUndefined();
	});
	it("detects an installation added after an unsuccessful attempt", () => {
		expect(findNativeCliExecutable(name, options)).toBeUndefined();
		const file = install(join(root, ".local", "bin"));
		expect(findNativeCliExecutable(name, options)).toBe(file);
	});
	it.skipIf(!windows)("handles quoted PATH entries and case-insensitive Windows environment names", () => {
		const file = install(join(root, "path with spaces"));
		options.env = { Path: `"${dirname(file)}"` };
		expect(findNativeCliExecutable(name, options)).toBe(file);
		options.env = { AppData: join(root, "roaming") };
		const npm = install(join(root, "roaming", "npm"));
		expect(findNativeCliExecutable(name, options)).toBe(npm);
	});
	it.skipIf(windows)("skips files without execute permission on POSIX", () => {
		const unavailable = install(join(root, "first"));
		chmodSync(unavailable, 0o644);
		const executable = install(join(root, "second"));
		options.env = { PATH: [dirname(unavailable), dirname(executable)].join(":") };
		expect(findNativeCliExecutable(name, options)).toBe(executable);
	});
});
