import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeLookupResult,
	executableLookupTarget,
	functionBody,
	isPatchableFormat,
	patchExecutableLookupSource,
	PREAMBLE_END,
	PREAMBLE_START,
	shouldPatchExecutableLookup,
	SENTINEL,
} from "../../server/patch-executable-lookup.js";

/*
 * Header + lookup verbatim from @earendil-works/pi-coding-agent@1.1.0
 * (`dist/utils/shell.js`): the POSIX `which` child process, and a module header that
 * imports `existsSync` and has **no** `shellPathExists` helper. The patch may not borrow
 * any binding from the module it rewrites — 1.1.0 is the shape that caught exactly that.
 */
const SHELL_SOURCE = `import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "child_process";
/**
 * Find bash executable on PATH (cross-platform)
 */
function findExecutableOnPath(executable) {
    if (process.platform === "win32") {
        // Windows: Use 'where' and verify file exists (where can return non-existent paths)
        try {
            const result = spawnSync("where", [executable], {
                encoding: "utf-8",
                timeout: 5000,
                windowsHide: true,
            });
            if (result.status === 0 && result.stdout) {
                const firstMatch = result.stdout.trim().split(/\\r?\\n/)[0];
                if (firstMatch && existsSync(firstMatch)) {
                    return firstMatch;
                }
            }
        }
        catch {
            // Ignore errors
        }
        return null;
    }
    // Unix: Use 'which' and trust its output (handles Termux and special filesystems)
    try {
        const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
        if (result.status === 0 && result.stdout) {
            const firstMatch = result.stdout.trim().split(/\\r?\\n/)[0];
            if (firstMatch) {
                return firstMatch;
            }
        }
    }
    catch {
        // Ignore errors
    }
    return null;
}`;

/* Header + `commandExists` verbatim from @earendil-works/pi-coding-agent@1.1.0
 * (`dist/utils/tools-manager.js`). */
const TOOLS_SOURCE = `import { spawnSync } from "child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
// Check if a command exists in PATH by trying to run it
function commandExists(cmd) {
    try {
        const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
        // Check for ENOENT error (command not found)
        return result.error === undefined || result.error === null;
    }
    catch {
        return false;
    }
}`;

const POSIX_ONLY = process.platform === "win32" ? it.skip : it;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "exec-lookup-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** A directory with `name` as an executable script — the "later usable PATH entry". */
function programDir(root: string, name: string): string {
	const dir = join(root, `${name}-program`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, "#!/bin/sh\nprintf ok\n");
	chmodSync(file, 0o755);
	return dir;
}

/** A directory holding a subdirectory called `name`, which must never resolve. */
function directoryEntry(root: string, name: string): string {
	const dir = join(root, `${name}-dir`);
	mkdirSync(join(dir, name), { recursive: true });
	return dir;
}

/** A directory holding a non-executable file called `name`. */
function inertEntry(root: string, name: string): string {
	const dir = join(root, `${name}-inert`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, "not a program\n");
	chmodSync(file, 0o644);
	return dir;
}

function declaration(code: string, name: string): string {
	const start = code.indexOf(`function ${name}`);
	const body = functionBody(code, `function ${name}`);
	if (start < 0 || body === null) throw new Error(`missing ${name}`);
	return code.slice(start, code.indexOf(body, start) + body.length);
}

let moduleCounter = 0;

/**
 * Runs the patched lookup for real: the patch preamble plus the rewritten function are
 * written to a module and imported, so the test exercises actual filesystem semantics
 * instead of a hand-supplied helper or a text assertion.
 */
async function runPatched<T>(code: string, functionName: string, prelude = ""): Promise<T> {
	const start = code.indexOf(PREAMBLE_START);
	const end = code.indexOf(PREAMBLE_END);
	if (start < 0 || end < 0) throw new Error("patch preamble missing");
	const preamble = code.slice(start, end + PREAMBLE_END.length);
	const file = join(tempDir("exec-lookup-module-"), `patched-${moduleCounter++}.mjs`);
	writeFileSync(file, `${preamble}\n${prelude}\n${declaration(code, functionName)}\nexport { ${functionName} };\n`);
	return (await import(`${pathToFileURL(file).href}?v=${moduleCounter}`)) as T;
}

/** Runs `body` with PATH temporarily replaced — the patch reads `process.env.PATH`. */
function withPath<T>(path: string, body: () => T): T {
	const previous = process.env.PATH;
	process.env.PATH = path;
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
}

describe("fork-free executable lookup patch", () => {
	it("replaces the POSIX `which` child process with a PATH scan", () => {
		const result = patchExecutableLookupSource(SHELL_SOURCE, "shell");
		expect(result.status).toBe("patched");
		expect(result.code).not.toContain('spawnSync("which"');
		expect(result.code).toContain("__piWebExecDelimiter");
		expect(result.code).toContain("__piWebExecProgram(candidate)");
		expect(result.code).toContain(SENTINEL);
		// untouched: the Windows branch, and the SDK's own helper (which 1.1.0 does not have)
		expect(result.code).toContain('if (process.platform === "win32")');
		expect(result.code).not.toContain("shellPathExists");
	});

	POSIX_ONLY("resolves a runnable bash from PATH in SDK 1.1.0's own source shape (no helper to borrow)", async () => {
		const patched = patchExecutableLookupSource(SHELL_SOURCE, "shell");
		const { findExecutableOnPath } = await runPatched<{
			findExecutableOnPath: (executable: string) => string | null;
		}>(patched.code, "findExecutableOnPath");

		const root = tempDir();
		const asDirectory = directoryEntry(root, "bash");
		const inert = inertEntry(root, "bash");
		const program = programDir(root, "bash");
		const link = join(root, "bash-link");
		mkdirSync(link);
		symlinkSync(join(program, "bash"), join(link, "bash"));

		// A directory and an inert file on PATH do not end the search: the resolver
		// continues to the later entry that really is a program.
		const resolved = withPath([asDirectory, inert, program].join(delimiter), () => findExecutableOnPath("bash"));
		expect(resolved).toBe(join(program, "bash"));

		// A symlink to a program is a program, and it wins over a later entry.
		expect(withPath([asDirectory, inert, link, program].join(delimiter), () => findExecutableOnPath("bash"))).toBe(
			join(link, "bash"),
		);

		// Nothing runnable anywhere: no candidate at all, so the SDK keeps its own
		// fallbacks instead of being handed a path that cannot execute.
		expect(withPath([asDirectory, inert].join(delimiter), () => findExecutableOnPath("bash"))).toBeNull();

		// The resolved candidate is a path the kernel will actually run.
		const run = spawnSync(resolved as string, [], { encoding: "utf-8", timeout: 10_000 });
		expect(run.status).toBe(0);
		expect(run.stdout).toBe("ok");
	});

	POSIX_ONLY("accepts only a tool that can really be spawned", async () => {
		const patched = patchExecutableLookupSource(TOOLS_SOURCE, "tools-manager");
		expect(patched.status).toBe("patched");
		const { commandExists } = await runPatched<{ commandExists: (cmd: string) => boolean }>(
			patched.code,
			"commandExists",
		);

		const root = tempDir();
		const asDirectory = directoryEntry(root, "rg");
		const inert = inertEntry(root, "rg");

		// Existence alone used to be enough — `ensureTool` then claimed a tool whose
		// subsequent spawn failed with ENOENT.
		expect(withPath(asDirectory, () => commandExists("rg"))).toBe(false);
		expect(withPath(inert, () => commandExists("rg"))).toBe(false);

		expect(withPath([asDirectory, inert, programDir(root, "rg")].join(delimiter), () => commandExists("rg"))).toBe(
			true,
		);

		// The tool the lookup just accepted is one a real invocation can run.
		const run = spawnSync("rg", ["--version"], {
			encoding: "utf-8",
			timeout: 10_000,
			env: { ...process.env, PATH: [asDirectory, inert, programDir(root, "rg")].join(delimiter) },
		});
		expect(run.error).toBeUndefined();
		expect(run.status).toBe(0);
	});

	it("keeps CreateProcess' Windows rules and still refuses a directory named like a tool", async () => {
		const patched = patchExecutableLookupSource(TOOLS_SOURCE, "tools-manager");
		const root = tempDir();
		const asDirectory = directoryEntry(root, "rg.exe");
		const scriptOnly = join(root, "rg-cmd");
		mkdirSync(scriptOnly);
		writeFileSync(join(scriptOnly, "rg.cmd"), "@echo off\r\n");
		const rimraf = join(root, "rg-exe");
		mkdirSync(rimraf);
		writeFileSync(join(rimraf, "rg.exe"), "MZ");

		// `process.platform` is shadowed inside the imported module: the Windows branch of
		// the lookup runs against the real filesystem, without needing a Windows machine.
		const winPrelude = (path: string) =>
			`const process = { platform: "win32", env: { PATH: ${JSON.stringify(path)} } };`;
		const lookup = (path: string) =>
			runPatched<{ commandExists: (cmd: string) => boolean }>(patched.code, "commandExists", winPrelude(path));

		// A directory named rg.exe is not a program.
		expect((await lookup(asDirectory)).commandExists("rg")).toBe(false);

		// A `.cmd` needs a shell to run; CreateProcess does not start it, so claiming it
		// would be the very false positive this patch removes.
		expect((await lookup(scriptOnly)).commandExists("rg")).toBe(false);

		// The plain executable is found, on a later PATH entry as well.
		expect((await lookup(`${asDirectory};${scriptOnly};${rimraf}`)).commandExists("rg")).toBe(true);
	});

	POSIX_ONLY("resolves a name given as a path as that path, not through PATH", async () => {
		const patched = patchExecutableLookupSource(TOOLS_SOURCE, "tools-manager");
		const { commandExists } = await runPatched<{ commandExists: (cmd: string) => boolean }>(
			patched.code,
			"commandExists",
		);
		const root = tempDir();
		const program = join(programDir(root, "mytool"), "mytool");
		const inert = join(inertEntry(root, "othertool"), "othertool");

		// An absolute path is answered by that path, whatever PATH says.
		expect(withPath(inertEntry(root, "unrelated"), () => commandExists(program))).toBe(true);
		expect(withPath(programDir(root, "unrelated"), () => commandExists(inert))).toBe(false);
	});

	it("does not let a regex literal hide a child process from the fork-free check", () => {
		// A `}` inside a regex used to close the brace scan early, so the later spawnSync
		// fell outside the extracted body and the lookup passed for fork-free.
		const withRegex = `import { spawnSync } from "child_process";
function commandExists(cmd) {
    if (process.env.PATH && /\\}/.test(cmd)) return false;
    try {
        const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
        return result.error === undefined || result.error === null;
    }
    catch {
        return false;
    }
}`;
		expect(functionBody(withRegex, "function commandExists")).toContain("spawnSync");
		expect(patchExecutableLookupSource(withRegex, "tools-manager")).toEqual({
			code: withRegex,
			status: "unsupported",
		});
	});

	it("only rewrites ES modules, so a CommonJS copy is left alone", () => {
		expect(isPatchableFormat("module")).toBe(true);
		expect(isPatchableFormat("module-typescript")).toBe(true);
		expect(isPatchableFormat("commonjs")).toBe(false);
		expect(isPatchableFormat(undefined)).toBe(false);
	});

	it("recognizes the bundled SDK's own source, if it is installed", () => {
		const sdk = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/utils");
		for (const [target, file] of [
			["shell", "shell.js"],
			["tools-manager", "tools-manager.js"],
		] as const) {
			if (!existsSync(join(sdk, file))) continue;
			const status = patchExecutableLookupSource(readFileSync(join(sdk, file), "utf8"), target).status;
			// A pristine copy patches; a copy a local patch script already made fork-free is a
			// no-op. Anything unrecognized is exactly what the warning exists for.
			expect([target, status === "unsupported" ? "unrecognized" : "recognized"]).toEqual([target, "recognized"]);
		}
	});

	it("never reports an unrecognized rewrite as already fixed", () => {
		// Only the spacing of the probe changes: the child process is still there, so this
		// must not pass for a fork-free lookup (it used to say `already`).
		const reformatted = TOOLS_SOURCE.replace("spawnSync(cmd,", "spawnSync (cmd,");
		expect(reformatted).not.toBe(TOOLS_SOURCE);
		expect(patchExecutableLookupSource(reformatted, "tools-manager")).toEqual({
			code: reformatted,
			status: "unsupported",
		});

		const requoted = SHELL_SOURCE.replace('spawnSync("which"', "spawnSync( 'which'");
		expect(patchExecutableLookupSource(requoted, "shell").status).toBe("unsupported");

		// Comment-only drift is not an identification either.
		const recommented = SHELL_SOURCE.replace("trust its output", "trust its output (unforked)");
		expect(patchExecutableLookupSource(recommented, "shell").status).toBe("unsupported");

		expect(patchExecutableLookupSource("export function unrelated() {}", "shell")).toEqual({
			code: "export function unrelated() {}",
			status: "unsupported",
		});
	});

	it("treats a positively identified fork-free lookup as a no-op, not a warning", () => {
		const head = SHELL_SOURCE.slice(0, SHELL_SOURCE.indexOf("function findExecutableOnPath"));
		const forkFree = `${head}function findExecutableOnPath(executable) {
    // Resolved from PATH by whoever patched this copy before us.
    for (const directory of (process.env.PATH ?? "").split(":")) {
        if (!directory) continue;
        const candidate = directory + "/" + executable;
        if (existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}
`;
		expect(patchExecutableLookupSource(forkFree, "shell")).toEqual({ code: forkFree, status: "already" });

		// Not positively identified: no PATH scan, nothing recognizable.
		const unrelatedPathScan = forkFree.replace(/process\.env\.PATH \?\? ""/, '"."');
		expect(patchExecutableLookupSource(unrelatedPathScan, "shell").status).toBe("unsupported");
	});

	it("never applies twice", () => {
		const once = patchExecutableLookupSource(SHELL_SOURCE, "shell");
		const twice = patchExecutableLookupSource(once.code, "shell");
		expect(twice.status).toBe("already");
		expect(twice.code).toBe(once.code);
	});

	it("matches the loaded URL of either SDK copy but nothing else", () => {
		expect(
			executableLookupTarget(
				"file:///data/data/com.termux/files/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js",
			),
		).toBe("shell");
		expect(
			executableLookupTarget("file:///app/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js"),
		).toBe("tools-manager");
		expect(executableLookupTarget("file:///app/dist/utils/tools-manager.js")).toBeNull();
		expect(
			executableLookupTarget("file:///app/node_modules/@earendil-works/pi-coding-agent/dist/utils/child-process.js"),
		).toBeNull();
	});

	it("states its verdict on every load, so a restart shows whether the patch is in place", () => {
		const url = "file:///x/@earendil-works/pi-coding-agent/dist/utils/shell.js";
		expect(describeLookupResult("shell", "patched", url)).toEqual({
			level: "log",
			message: "[executable-lookup] shell: patched",
		});
		expect(describeLookupResult("tools-manager", "already", url)).toEqual({
			level: "log",
			message: "[executable-lookup] tools-manager: already patched",
		});
		const unsupported = describeLookupResult("shell", "unsupported", url);
		expect(unsupported.level).toBe("warn");
		expect(unsupported.message).toContain("[executable-lookup] shell: NOT patched");
		expect(unsupported.message).toContain("can hang on Android/Termux");
	});

	it("is enabled on Android/Termux only, unless explicitly forced", () => {
		expect(shouldPatchExecutableLookup("android", {})).toBe(true);
		expect(shouldPatchExecutableLookup("linux", { TERMUX_VERSION: "0.118" })).toBe(true);
		expect(shouldPatchExecutableLookup("linux", {})).toBe(false);
		expect(shouldPatchExecutableLookup("darwin", {})).toBe(false);
		expect(shouldPatchExecutableLookup("android", { PI_WEB_EXEC_LOOKUP: "off" })).toBe(false);
		expect(shouldPatchExecutableLookup("android", { PI_WEB_EXEC_LOOKUP: "0" })).toBe(false);
		expect(shouldPatchExecutableLookup("linux", { PI_WEB_EXEC_LOOKUP: "on" })).toBe(true);
		expect(shouldPatchExecutableLookup("win32", { PI_WEB_EXEC_LOOKUP: "true" })).toBe(true);
	});
});
