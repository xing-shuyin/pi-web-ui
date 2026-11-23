import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomicFile from "../../packages/keel/src/atomic-file.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginSecrets, SETTINGS_SECRETS_KEY } from "../../server/plugin-secrets.js";
import { PluginStorage } from "../../server/plugin-facilities.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "plugin-secret-commit-"));
	dirs.push(dir);
	return { dir, a: new PluginSecrets(dir, dir), b: new PluginSecrets(dir, dir) };
}
describe("secret commit failures", () => {
	it("failed secret writes never change the file or cross-instance reads", async () => {
		const { dir, a, b } = fixture();
		await a.set("token", "old");
		const file = join(dir, "secrets.bin");
		const original = readFileSync(file, "utf8");
		const fail = vi.spyOn(atomicFile, "writeAtomic").mockImplementation(() => {
			throw new Error("injected write failure");
		});
		try {
			await expect(a.set("token", "new")).rejects.toThrow("injected write failure");
			await expect(a.delete("token")).rejects.toThrow("injected write failure");
			expect(a.get("token")).toBe("old");
			expect(b.get("token")).toBe("old");
			expect(readFileSync(file, "utf8")).toBe(original);
		} finally {
			fail.mockRestore();
		}
	});
	it("reserved metadata is hidden and survives public storage mutation and clear", async () => {
		const { dir, a } = fixture();
		await a.commitSettings({ name: "old" }, { "setting:key": "value" });
		const storage = new PluginStorage(join(dir, "storage.json"));
		expect(storage.get(SETTINGS_SECRETS_KEY)).toBeUndefined();
		expect(storage.has(SETTINGS_SECRETS_KEY)).toBe(false);
		expect(storage.keys()).not.toContain(SETTINGS_SECRETS_KEY);
		expect(storage.all()).not.toHaveProperty(SETTINGS_SECRETS_KEY);
		expect(() => storage.set(SETTINGS_SECRETS_KEY, {})).toThrow();
		expect(() => storage.delete(SETTINGS_SECRETS_KEY)).toThrow();
		await storage.set("other", 1);
		await storage.clear(false);
		expect(a.get("setting:key")).toBe("value");
	});
	it("legacy values remain readable, migrated values survive a corrupt unrelated legacy file", async () => {
		const { dir, a, b } = fixture();
		await a.set("legacy", "old");
		const file = join(dir, "secrets.bin");
		const raw = JSON.parse(readFileSync(file, "utf8"));
		raw.items["setting:key"] = raw.items.legacy;
		writeFileSync(file, JSON.stringify(raw));
		expect(b.get("setting:key")).toBe("old");
		await a.commitSettings({}, { "setting:key": "new" });
		writeFileSync(file, "broken");
		expect(b.get("setting:key")).toBe("new");
		expect(b.getAll()).toEqual({ "setting:key": "new" });
		await a.commitSettings({}, {});
		expect(b.get("setting:key")).toBe("new");
	});
	it("failed set/delete rejects and never publishes candidate values across instances", async () => {
		const { dir, a, b } = fixture();
		await a.set("token", "before");
		expect(b.get("token")).toBe("before");
		const file = join(dir, "secrets.bin");
		const old = readFileSync(file, "utf8");
		rmSync(file);
		mkdirSync(file);
		await expect(async () => a.set("token", "after")).rejects.toThrow();
		await expect(async () => a.delete("token")).rejects.toThrow();
		rmSync(file, { recursive: true });
		writeFileSync(file, old);
		expect(a.get("token")).toBe("before");
		expect(b.get("token")).toBe("before");
		await a.delete("token");
		expect(b.get("token")).toBeUndefined();
	});
	it("a failed atomic replace retains committed settings and encrypted secrets", async () => {
		const { dir, a, b } = fixture();
		await a.commitSettings({ name: "old" }, { "setting:key": "old-secret" });
		const file = join(dir, "storage.json");
		const old = readFileSync(file, "utf8");
		expect(old).not.toContain("old-secret");
		rmSync(file);
		mkdirSync(file);
		await expect(a.commitSettings({ name: "new" }, { "setting:key": "new-secret" })).rejects.toThrow();
		rmSync(file, { recursive: true });
		writeFileSync(file, old);
		expect(a.get("setting:key")).toBe("old-secret");
		expect(b.get("setting:key")).toBe("old-secret");
		await a.delete("setting:key");
		expect(b.has("setting:key")).toBe(false);
	});
});
