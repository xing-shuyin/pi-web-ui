import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopSetup } from "../../server/device-center/desktop-setup.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() {
	const path = mkdtempSync(join(tmpdir(), "desktop-setup-"));
	directories.push(path);
	return path;
}

describe("desktop enable settings", () => {
	it("defaults to disabled and persists enable and disable across instances", async () => {
		const dataDir = directory();
		const options = { dataDir, environmentEnabled: false };
		const setup = createDesktopSetup(options);
		expect(setup.enabled).toBe(false);
		await setup.setEnabled(true);
		expect(setup.enabled).toBe(true);
		expect(JSON.parse(readFileSync(join(dataDir, "desktop-settings.json"), "utf8"))).toEqual({ enabled: true });
		setup.close();
		const reopened = createDesktopSetup(options);
		expect(reopened.enabled).toBe(true);
		await reopened.setEnabled(false);
		expect(reopened.enabled).toBe(false);
		reopened.close();
		expect(createDesktopSetup(options).enabled).toBe(false);
	});

	it.each(["invalid json", "null", '{"enabled":"true"}'])(
		"defaults to disabled for invalid settings: %s",
		(settings) => {
			const dataDir = directory();
			writeFileSync(join(dataDir, "desktop-settings.json"), settings);
			expect(createDesktopSetup({ dataDir, environmentEnabled: false }).enabled).toBe(false);
		},
	);

	it("keeps the environment override enabled while persisting the local preference", async () => {
		const dataDir = directory();
		const setup = createDesktopSetup({ dataDir, environmentEnabled: true });
		expect(setup.enabled).toBe(true);
		await setup.setEnabled(true);
		await setup.setEnabled(false);
		expect(setup.enabled).toBe(true);
		expect(JSON.parse(readFileSync(join(dataDir, "desktop-settings.json"), "utf8"))).toEqual({ enabled: false });
		setup.close();
		expect(createDesktopSetup({ dataDir, environmentEnabled: false }).enabled).toBe(false);
	});

	it("closes idempotently and rejects further writes without changing settings", async () => {
		const dataDir = directory();
		const setup = createDesktopSetup({ dataDir, environmentEnabled: false });
		await setup.setEnabled(true);
		setup.close();
		setup.close();
		await expect(setup.setEnabled(false)).rejects.toThrow("Desktop setup closed");
		expect(setup.enabled).toBe(true);
		expect(createDesktopSetup({ dataDir, environmentEnabled: false }).enabled).toBe(true);
	});

	it.each([false, true])(
		"does not change the in-memory preference after a failed write (enabled=%s)",
		async (enabled) => {
			const dataDir = join(directory(), "settings");
			const setup = createDesktopSetup({ dataDir, environmentEnabled: false });
			await setup.setEnabled(enabled);
			rmSync(dataDir, { recursive: true });
			writeFileSync(dataDir, "blocks the settings directory");
			await expect(setup.setEnabled(!enabled)).rejects.toThrow();
			expect(setup.enabled).toBe(enabled);
			expect(readFileSync(dataDir, "utf8")).toBe("blocks the settings directory");
		},
	);
});
