/**
 * pi-core version probe on Windows (issue #533): npm's cmd-shim writes a
 * regular `pi` script, so the POSIX realpath walk misses the package one
 * level below <prefix>. These tests use real temp dirs (no node:fs mocking)
 * to prove the sibling `<prefix>/node_modules/<pkg>` layout resolves, that the
 * POSIX symlink walk still works, and that an unresolvable version yields an
 * honest "could not detect" pi-core row instead of dropping it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { checkAll, collectTargets, readPiCoreVersionFromDisk, type LocalPackage } from "../../server/update-check.js";

const PI_CORE = "@earendil-works/pi-coding-agent";

/** Write a minimal pi-core package.json and return its dir. */
function writePiCorePackage(root: string, version: string): string {
	const dir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PI_CORE, version }));
	return dir;
}

/** Run fn with PATH set to exactly `dirs`, restoring the old PATH afterwards. */
function withPath<T>(dirs: string[], fn: () => T): T {
	const prev = process.env.PATH;
	process.env.PATH = dirs.join(delimiter);
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.PATH;
		else process.env.PATH = prev;
	}
}

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
	// readPiCoreVersionFromDisk is stateless; defaultProbePiCore memoization is
	// intentionally bypassed by testing the former directly.
});

describe("readPiCoreVersionFromDisk — sibling node_modules (Windows npm layout)", () => {
	it("reads the version from <binDir>/node_modules even when `pi` is a regular file (not a symlink)", () => {
		const prefix = makeTmp("pi-core-win-");
		// npm's cmd-shim writes a plain shell script on Windows — regular file.
		writeFileSync(
			join(prefix, "pi"),
			'#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n',
		);
		writePiCorePackage(prefix, "0.92.3");

		withPath([prefix], () => {
			expect(readPiCoreVersionFromDisk()).toBe("0.92.3");
		});
	});

	it("skips unresolvable candidate in early PATH entry and resolves from later entry", () => {
		const dummyDir = makeTmp("pi-dummy-");
		// First entry has a pi file that doesn't point to pi-core
		writeFileSync(join(dummyDir, "pi"), "#!/bin/sh\necho not-our-pi\n");

		const validDir = makeTmp("pi-valid-");
		writeFileSync(
			join(validDir, "pi"),
			'#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n',
		);
		writePiCorePackage(validDir, "1.2.3");

		withPath([dummyDir, validDir], () => {
			expect(readPiCoreVersionFromDisk()).toBe("1.2.3");
		});
	});

	it("resolves from wrapper script pointing to sibling package", () => {
		const binDir = makeTmp("pi-wrapper-bin-");
		const targetDir = makeTmp("pi-target-");
		writePiCorePackage(targetDir, "1.5.0");

		const cliPath = join(targetDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		writeFileSync(join(binDir, "pi"), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`);

		withPath([binDir], () => {
			expect(readPiCoreVersionFromDisk()).toBe("1.5.0");
		});
	});
});

describe("readPiCoreVersionFromDisk — POSIX symlink walk (unchanged)", () => {
	it("walks up from a symlinked bin that is NOT inside <binDir>/node_modules", () => {
		const root = makeTmp("pi-core-posix-");
		const real = join(root, "real");
		const pkgDir = writePiCorePackage(real, "0.91.0");
		const cliDir = join(pkgDir, "dist", "bundle");
		mkdirSync(cliDir, { recursive: true });
		writeFileSync(join(cliDir, "cli.js"), "// cli\n");

		const binDir = join(root, "bin");
		mkdirSync(binDir, { recursive: true });
		try {
			symlinkSync(join(cliDir, "cli.js"), join(binDir, "pi"), "file");
		} catch {
			// Windows without developer mode / privileges: skip, don't fail.
			return;
		}

		withPath([binDir], () => {
			expect(readPiCoreVersionFromDisk()).toBe("0.91.0");
		});
	});
});

describe("collectTargets — unknown pi-core version (issue #533)", () => {
	it("keeps a pi-core row carrying the unknown hint instead of dropping it", () => {
		const agentDir = makeTmp("pi-core-agent-");
		const targets = collectTargets(agentDir, "0.48.0", () => null);
		const core = targets.find((t) => t.kind === "pi-core");
		expect(core).toBeDefined();
		expect(core!.name).toBe(PI_CORE);
		expect(core!.version).toBe("unknown");
		expect(core!.error).toBe("pluginupdate.piCore.unknown");
	});
});

describe("checkAll — unknown pi-core hint reaches the panel item", () => {
	const target = (err: boolean): LocalPackage => ({
		name: PI_CORE,
		version: "unknown",
		kind: "pi-core",
		...(err ? { error: "pluginupdate.piCore.unknown" } : {}),
	});

	const okFetcher = async () => ({
		ok: true,
		status: 200,
		json: async () => ({ "dist-tags": { latest: "9.9.9" } }),
	});

	it("resolves the key into a localized error without a registry lookup (en)", async () => {
		const items = await checkAll([target(true)], okFetcher, () => "en");
		// 断言「key 被解析成了英文文案」而不是具体措辞（措辞会调，key 不会）。
		expect(items[0]!.error).not.toBe("pluginupdate.piCore.unknown");
		expect(items[0]!.error).toContain("engine version");
		expect(items[0]!.latest).toBeNull();
		expect(items[0]!.upToDate).toBe(false);
		expect(items[0]!.current).toBe("unknown");
	});

	it("localizes the key to Chinese", async () => {
		const items = await checkAll([target(true)], okFetcher, () => "zh");
		expect(items[0]!.error).not.toBe("pluginupdate.piCore.unknown");
		expect(items[0]!.error).toContain("引擎版本");
	});
});
