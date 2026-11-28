import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildOpenInstallerCommand,
	findDesktopInstaller,
	resolveDesktopTarget,
} from "../../scripts/install-desktop-local.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
	const dir = mkdtempSync(join(tmpdir(), "install-desktop-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("install-desktop-local", () => {
	it("resolves electron-builder target by platform and arch", () => {
		expect(resolveDesktopTarget("darwin", "arm64")).toEqual({
			platform: "darwin",
			arch: "arm64",
			label: "macOS (arm64) .dmg",
			ext: ".dmg",
			builderArgs: ["--mac", "dmg", "--arm64", "--publish", "never"],
		});
		expect(resolveDesktopTarget("win32", "x64")).toEqual({
			platform: "win32",
			arch: "x64",
			label: "Windows (x64) NSIS .exe",
			ext: ".exe",
			builderArgs: ["--win", "nsis", "--x64", "--publish", "never"],
		});
		expect(resolveDesktopTarget("linux", "x64")).toEqual({
			platform: "linux",
			arch: "x64",
			label: "Linux (x64) .AppImage",
			ext: ".AppImage",
			builderArgs: ["--linux", "AppImage", "--x64", "--publish", "never"],
		});
		expect(() => resolveDesktopTarget("freebsd" as NodeJS.Platform, "x64")).toThrow("不支持的桌面平台");
	});

	it("finds matching installer in release directory", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "keel-0.124.0-arm64.dmg"), "old");
		writeFileSync(join(dir, "keel-0.125.0-arm64-mac.zip"), "zip");
		writeFileSync(join(dir, "keel-0.125.0-x64.dmg"), "x64");
		writeFileSync(join(dir, "keel-0.125.0-arm64.dmg"), "arm64");
		writeFileSync(join(dir, "keel-0.125.0-setup.exe"), "setup");
		writeFileSync(join(dir, "keel-0.125.0-other.exe"), "other");
		writeFileSync(join(dir, "keel-0.125.0-x86_64.AppImage"), "appimage");

		expect(findDesktopInstaller(dir, { platform: "darwin", arch: "arm64", version: "0.125.0" })).toBe(
			join(dir, "keel-0.125.0-arm64.dmg"),
		);
		expect(findDesktopInstaller(dir, { platform: "darwin", arch: "x64", version: "0.125.0" })).toBe(
			join(dir, "keel-0.125.0-x64.dmg"),
		);
		expect(findDesktopInstaller(dir, { platform: "win32", arch: "x64", version: "0.125.0" })).toBe(
			join(dir, "keel-0.125.0-setup.exe"),
		);
		expect(findDesktopInstaller(dir, { platform: "linux", arch: "x64", version: "0.125.0" })).toBe(
			join(dir, "keel-0.125.0-x86_64.AppImage"),
		);
		expect(findDesktopInstaller(dir, { platform: "darwin", arch: "arm64", version: "9.9.9" })).toBeNull();
		expect(
			findDesktopInstaller(join(dir, "missing"), { platform: "darwin", arch: "arm64", version: "0.125.0" }),
		).toBeNull();
	});

	it("builds platform-specific open installer commands", () => {
		expect(buildOpenInstallerCommand("/tmp/keel.dmg", "darwin")).toEqual({
			command: "open",
			argv: ["/tmp/keel.dmg"],
			detached: false,
		});
		expect(buildOpenInstallerCommand("C:\\release\\keel-setup.exe", "win32")).toEqual({
			command: "powershell.exe",
			argv: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath 'C:\\release\\keel-setup.exe'"],
			detached: false,
		});
		expect(buildOpenInstallerCommand("/tmp/keel.AppImage", "linux")).toEqual({
			command: "/tmp/keel.AppImage",
			argv: [],
			detached: true,
			chmodExecutable: true,
		});
	});
});
