import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
// CLI module is intentionally plain JavaScript, shared with npm lifecycle scripts.
import { ensureDesktopService, shouldBootstrapDesktop } from "../../bin/desktop-bootstrap.mjs";
const dirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-desktop-install-"));
	dirs.push(directory);
	const installDir = join(directory, "installed"),
		stateDir = join(directory, "state");
	await mkdir(installDir);
	vi.spyOn(console, "error").mockImplementation(() => {});
	return {
		platform: "win32",
		arch: "x64",
		env: {},
		interactive: true,
		installDir,
		stateDir,
		fingerprint: async () => "a".repeat(64),
		install: vi.fn().mockResolvedValue(undefined),
	};
}
it("only installs on Windows global npm installation or interactive app launch", () => {
	const base = { platform: "win32", arch: "x64", env: {}, interactive: true } as const;
	expect(shouldBootstrapDesktop(base)).toBe(true);
	for (const override of [
		{ platform: "linux" },
		{ platform: "darwin" },
		{ interactive: false },
		{ env: { CI: "1" } },
		{ env: { PI_DESKTOP_SERVICE_AUTO: "0" } },
		{ env: { SESSIONNAME: "Services" } },
		{ reason: "install" },
	])
		expect(shouldBootstrapDesktop({ ...base, ...override } as any)).toBe(false);
	expect(
		shouldBootstrapDesktop({ ...base, interactive: false, reason: "install", env: { npm_config_global: "true" } }),
	).toBe(true);
});
it("does not elevate for an already current installation", async () => {
	const f = await fixture();
	await writeFile(join(f.installDir, "source.sha256"), await f.fingerprint());
	await writeFile(join(f.installDir, "enabled"), "1");
	expect(await ensureDesktopService(f)).toBe("current");
	expect(f.install).not.toHaveBeenCalled();
});
it("automatically installs a missing or outdated component once", async () => {
	const f = await fixture();
	expect(await ensureDesktopService(f)).toBe("installed");
	expect(f.install).toHaveBeenCalledWith("install");
	expect(await ensureDesktopService(f)).toBe("deferred");
	expect(f.install).toHaveBeenCalledOnce();
});
it("does not repeat UAC after cancellation, but retries a changed component", async () => {
	const f = await fixture();
	f.install.mockRejectedValue(new Error("cancelled"));
	expect(await ensureDesktopService(f)).toBe("failed");
	expect(await ensureDesktopService(f)).toBe("deferred");
	f.fingerprint = async () => "b".repeat(64);
	expect(await ensureDesktopService(f)).toBe("failed");
	expect(f.install).toHaveBeenCalledTimes(2);
});
it("respects explicit uninstall and serializes concurrent startup attempts", async () => {
	const f = await fixture();
	await writeFile(join(f.installDir, "auto-disabled"), "1");
	expect(await ensureDesktopService(f)).toBe("disabled");
	expect(f.install).not.toHaveBeenCalled();
	await rm(join(f.installDir, "auto-disabled"));
	const results = await Promise.all([ensureDesktopService(f), ensureDesktopService(f)]);
	expect(results).toContain("installed");
	expect(f.install).toHaveBeenCalledOnce();
});
