import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../bin/pi-web-ui.mjs", import.meta.url), "utf8");
const root = fileURLToPath(new URL("../../", import.meta.url));

function functionSource(name: string): string {
	const start = source.indexOf(`function ${name}(`);
	const end = source.indexOf("\n}", start);
	if (start < 0 || end < 0) throw new Error(`Missing CLI function: ${name}`);
	return source.slice(start, end + 2);
}

function harness(argv: string[]) {
	const startForeground = vi.fn();
	const serverCmd = vi.fn();
	const log = vi.fn();
	const main = runInNewContext(`${functionSource("parseFlags")}\nasync ${functionSource("main")}\nmain`, {
		process: { argv: ["node", "pwu", ...argv] },
		checkNodeVersion: vi.fn(),
		startForeground,
		serverCmd,
		resolve: (...parts: string[]) => resolve(root, ...parts),
		statSync,
		ZH: false,
		HELP: "CLI help",
		pkg: { version: "test-version" },
		console: { log },
		fail: (message: string) => {
			throw new Error(message);
		},
	}) as () => Promise<void>;
	return { main, startForeground, serverCmd, log };
}

describe("CLI entry", () => {
	it("publishes all command aliases through the same entry point", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
		const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
		for (const alias of ["pwu", "piwebui", "pi-web-ui"]) {
			expect(pkg.bin[alias]).toBe("bin/pi-web-ui.mjs");
			expect(lock.packages[""].bin[alias]).toBe(pkg.bin[alias]);
		}
	});

	it.each([".", "./bin", "./server/device-center", root])("starts in directory %s", async (directory) => {
		const { main, startForeground } = harness([directory]);
		await main();
		expect(startForeground).toHaveBeenCalledWith(expect.objectContaining({ cwd: resolve(root, directory) }));
	});

	it.each([
		[".", "--port", "9000", "--no-browser"],
		["--port=9000", "--no-browser", "."],
	])("accepts options with a directory: %j", async (...argv) => {
		const { main, startForeground } = harness(argv);
		await main();
		expect(startForeground).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: resolve(root), port: "9000", noBrowser: true }),
		);
	});

	it.each(["./package.json", "./nonexistent-cli-test-directory"])("rejects non-directory %s", async (directory) => {
		const { main, startForeground } = harness([directory]);
		await expect(main()).rejects.toThrow("Directory does not exist or is inaccessible");
		expect(startForeground).not.toHaveBeenCalled();
	});

	it("rejects multiple directory arguments", async () => {
		const { main, startForeground } = harness([".", "./bin"]);
		await expect(main()).rejects.toThrow("Unknown command");
		expect(startForeground).not.toHaveBeenCalled();
	});

	it("rejects combining a directory with --cwd", async () => {
		const { main, startForeground } = harness([".", "--cwd", "./bin"]);
		await expect(main()).rejects.toThrow("Cannot combine");
		expect(startForeground).not.toHaveBeenCalled();
	});

	it("preserves launching without arguments", async () => {
		const { main, startForeground } = harness([]);
		await main();
		expect(startForeground).toHaveBeenCalledWith({});
	});

	it("preserves --cwd", async () => {
		const { main, startForeground } = harness(["--cwd", "./bin"]);
		await main();
		expect(startForeground).toHaveBeenCalledWith(expect.objectContaining({ cwd: "./bin" }));
	});

	it("dispatches existing subcommands", async () => {
		const { main, startForeground, serverCmd } = harness(["server", "status"]);
		await main();
		expect(serverCmd).toHaveBeenCalledWith(["status"]);
		expect(startForeground).not.toHaveBeenCalled();
	});

	it.each([["--help"], [".", "--help"]])("shows help without launching: %j", async (...argv) => {
		const { main, startForeground, log } = harness(argv);
		await main();
		expect(log).toHaveBeenCalledWith("CLI help");
		expect(startForeground).not.toHaveBeenCalled();
	});
});
