import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return { ...fs, rmSync: vi.fn(fs.rmSync), renameSync: vi.fn(fs.renameSync) };
});
import { renameSync } from "node:fs";
import { cleanupRemovedPlugins, removePlugin } from "../../server/plugin-removal.js";

const dirs: string[] = [];
function installed() {
	const root = mkdtempSync(join(tmpdir(), "plugin-removal-"));
	dirs.push(root);
	const target = join(root, "plugins", "desktop-use");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "manifest.json"), '{"id":"desktop-use"}');
	writeFileSync(join(target, "libnut.node"), "native addon");
	const state = join(root, "plugin-data", "desktop-use");
	mkdirSync(state, { recursive: true });
	writeFileSync(join(state, "storage.json"), '{"settings":{"token":"keep-until-uninstall"}}');
	return { root, target, state };
}
afterEach(() => {
	vi.mocked(rmSync).mockReset().mockImplementation(actualRm);
	vi.mocked(renameSync).mockReset().mockImplementation(actualRename);
	for (const dir of dirs.splice(0)) actualRm(dir, { recursive: true, force: true });
});
const { rmSync: actualRm, renameSync: actualRename } = await vi.importActual<typeof import("node:fs")>("node:fs");

describe("plugin removal", () => {
	it("removes an installation without leaving a loadable directory", () => {
		const { root, target, state } = installed();
		expect(removePlugin(root, "desktop-use")).toEqual({ deferred: false });
		expect(existsSync(target)).toBe(false);
		// 卸载即删：状态跟代码一起走，重装不会闯回旧设置与机密
		expect(existsSync(state)).toBe(false);
		expect(readdirSync(join(root, "plugin-trash"))).toEqual([]);
	});

	it("defers locked native files and cleans them on the next startup", () => {
		const { root, target } = installed();
		vi.mocked(rmSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("DLL in use"), { code: "EPERM" });
		});
		expect(removePlugin(root, "desktop-use")).toEqual({ deferred: true });
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(join(root, "plugin-trash"))).toHaveLength(1);
		cleanupRemovedPlugins(root);
		expect(readdirSync(join(root, "plugin-trash"))).toEqual([]);
	});

	it("preserves the installation if moving it fails", () => {
		const { root, target, state } = installed();
		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw new Error("rename denied");
		});
		expect(() => removePlugin(root, "desktop-use")).toThrow("rename denied");
		expect(existsSync(join(target, "manifest.json"))).toBe(true);
		expect(existsSync(join(target, "libnut.node"))).toBe(true);
		// 代码没动，状态也不能提前没了
		expect(existsSync(join(state, "storage.json"))).toBe(true);
	});

	it("does not clean unrelated files and rejects path traversal", () => {
		const { root, target } = installed();
		mkdirSync(join(root, "plugin-trash"));
		writeFileSync(join(root, "plugin-trash", "keep"), "keep");
		cleanupRemovedPlugins(root);
		expect(existsSync(join(root, "plugin-trash", "keep"))).toBe(true);
		expect(() => removePlugin(root, "../desktop-use")).toThrow("Invalid plugin id");
		expect(existsSync(target)).toBe(true);
	});
});
