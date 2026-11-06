import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserStorage, type CredentialEncryption } from "../../browser/storage/index.js";

const directories: string[] = [];
function directory(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-storage-"));
	directories.push(dir);
	return dir;
}
const encryption: CredentialEncryption = {
	isEncryptionAvailable: () => true,
	encryptString: (value) => Buffer.from(`protected:${value}`),
	decryptString: (value) => {
		const text = value.toString();
		if (!text.startsWith("protected:")) throw new Error("Wrong OS key");
		return text.slice(10);
	},
};
const credential = {
	id: "id-1",
	name: "Example",
	url: "https://example.com/",
	username: "user",
	password: "test-secret-value",
	createdAt: "2026-01-01",
};
const tree = {
	name: "收藏",
	type: "folder",
	children: [{ name: "Example", type: "link", url: "https://example.com/", bg: "#123456", char: "E" }],
};
afterEach(() => {
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("BrowserStorage", () => {
	it("round-trips legacy bookmark folders and merges settings without discarding unrelated choices", () => {
		const storage = new BrowserStorage(directory(), encryption);
		expect(storage.listBookmarks().children).toEqual([]);
		storage.saveBookmarks(tree);
		storage.saveSettings({
			theme: "light",
			searchEngine: "google",
			agentUrl: "https://agent.example",
			mode: "split",
			splitRatio: 0.6,
		});
		storage.saveSettings({
			splitRatio: 8,
			shortcuts: { reload: "Ctrl+R", unsafe: {} },
			agentUrl: "javascript:alert(1)",
		});
		expect(storage.listBookmarks()).toEqual(tree);
		expect(storage.getSettings()).toMatchObject({
			theme: "light",
			searchEngine: "google",
			mode: "split",
			splitRatio: 0.85,
			agentUrl: "https://agent.example",
			shortcuts: { reload: "Ctrl+R" },
		});
		expect(() =>
			storage.saveBookmarks({ ...tree, children: [{ name: "Unsafe", type: "link", url: "file:///secret" }] }),
		).toThrow();
		expect(storage.listBookmarks()).toEqual(tree);
	});

	it("persists automation consent and sanitizes permission choices", () => {
		const storage = new BrowserStorage(directory(), encryption);
		expect(storage.getSettings()).toMatchObject({ allowEval: false, sitePermissions: {} });
		storage.saveSettings({
			allowEval: true,
			sitePermissions: JSON.parse(
				'{"https://example.com|media":true,"https://other.example|notifications":false,"invalid":"yes","__proto__":true}',
			),
		});
		expect(storage.getSettings()).toMatchObject({
			allowEval: true,
			sitePermissions: { "https://example.com|media": true, "https://other.example|notifications": false },
		});
		expect(Object.keys(storage.getSettings().sitePermissions)).toHaveLength(2);
		storage.saveSettings({ theme: "light", allowEval: "yes" });
		expect(storage.getSettings().allowEval).toBe(true);
		expect(storage.getSettings().sitePermissions["https://other.example|notifications"]).toBe(false);
	});

	it("encrypts every credential, including plaintext starting with enc:, and never persists unknown fields", () => {
		const dir = directory();
		const storage = new BrowserStorage(dir, encryption);
		const input = { ...credential, password: "enc:literal-secret", extra: "must-not-persist" };
		storage.savePasswords([input]);
		const disk = fs.readFileSync(path.join(dir, "passwords.json"), "utf8");
		expect(disk).not.toContain("literal-secret");
		expect(disk).not.toContain("must-not-persist");
		expect(JSON.parse(disk)[0].password).toMatch(/^enc:/);
		expect(storage.listPasswords()).toEqual([{ ...credential, password: input.password }]);
	});

	it.each([false, "basic_text"])("fails closed for unavailable or insecure encryption (%s)", (backend) => {
		const dir = directory();
		const unavailable = new BrowserStorage(dir, {
			...encryption,
			isEncryptionAvailable: () => backend !== false,
			getSelectedStorageBackend: () => (backend === "basic_text" ? backend : "dpapi"),
		});
		expect(unavailable.isEncryptionAvailable()).toBe(false);
		expect(() => unavailable.savePasswords([credential])).toThrow(/unavailable/);
		expect(fs.existsSync(path.join(dir, "passwords.json"))).toBe(false);
	});

	it("leaves existing encrypted credentials untouched on encryption or decryption failure", () => {
		const dir = directory();
		new BrowserStorage(dir, encryption).savePasswords([credential]);
		const original = fs.readFileSync(path.join(dir, "passwords.json"), "utf8");
		const broken = new BrowserStorage(dir, {
			...encryption,
			encryptString: () => {
				throw new Error("OS failed");
			},
			decryptString: () => {
				throw new Error("OS failed");
			},
		});
		expect(() => broken.savePasswords([credential])).toThrow();
		expect(() => broken.listPasswords()).toThrow();
		expect(fs.readFileSync(path.join(dir, "passwords.json"), "utf8")).toBe(original);
		expect(fs.readdirSync(dir)).toEqual(["passwords.json"]);
	});

	it("imports legacy files independently without overwriting existing files or changing the source", () => {
		const source = directory();
		const destination = directory();
		fs.writeFileSync(path.join(source, "bookmarks.json"), JSON.stringify(tree));
		fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify({ theme: "light" }));
		fs.writeFileSync(
			path.join(source, "history.json"),
			JSON.stringify([
				{ url: "https://example.com", title: "Example", timestamp: 123 },
				{ url: "file:///secret", timestamp: 124 },
			]),
		);
		const plaintext = JSON.stringify([credential]);
		fs.writeFileSync(path.join(source, "passwords.json"), plaintext);
		const storage = new BrowserStorage(destination, encryption);
		storage.saveSettings({ theme: "midnight" });
		expect(storage.importLegacyData(source)).toEqual({
			imported: ["bookmarks", "history", "passwords"],
			skipped: ["settings"],
			errors: [],
		});
		expect(storage.listBookmarks()).toEqual(tree);
		expect(storage.getSettings().theme).toBe("midnight");
		expect(storage.listHistory()).toEqual([{ url: "https://example.com", title: "Example", visitedAt: 123 }]);
		expect(storage.listPasswords()).toEqual([credential]);
		expect(fs.readFileSync(path.join(destination, "passwords.json"), "utf8")).not.toContain(credential.password);
		expect(fs.readFileSync(path.join(source, "passwords.json"), "utf8")).toBe(plaintext);
		expect(storage.importLegacyData(source).imported).toEqual([]);
	});

	it("reports failed imports and does not create plaintext files without encryption", () => {
		const source = directory();
		const destination = directory();
		fs.writeFileSync(path.join(source, "passwords.json"), JSON.stringify([credential]));
		fs.writeFileSync(path.join(source, "bookmarks.json"), "{bad json");
		fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify({ theme: "light" }));
		const storage = new BrowserStorage(destination, { ...encryption, isEncryptionAvailable: () => false });
		expect(storage.importLegacyData(source)).toEqual({
			imported: ["settings"],
			skipped: ["history"],
			errors: ["bookmarks", "passwords"],
		});
		expect(fs.existsSync(path.join(destination, "passwords.json"))).toBe(false);
	});

	it("upgrades legacy plaintext in place only when protected encryption is available", () => {
		const dir = directory();
		fs.writeFileSync(path.join(dir, "passwords.json"), JSON.stringify([credential]));
		const unavailable = new BrowserStorage(dir, { ...encryption, isEncryptionAvailable: () => false });
		expect(() => unavailable.listPasswords()).toThrow();
		const storage = new BrowserStorage(dir, encryption);
		expect(storage.listPasswords()).toEqual([credential]);
		expect(fs.readFileSync(path.join(dir, "passwords.json"), "utf8")).not.toContain(credential.password);
	});

	it("records web history only and restores tabs without leaking references", () => {
		const dir = directory();
		const storage = new BrowserStorage(dir, encryption);
		storage.addHistory("file:///secret", "Secret");
		storage.addHistory("https://example.com", "First");
		storage.addHistory("https://example.com", "Second");
		expect(storage.listHistory()).toHaveLength(1);
		expect(storage.listHistory()[0].title).toBe("Second");
		storage.saveTabs({ urls: ["https://example.com"], activeIndex: 0 });
		expect(new BrowserStorage(dir, encryption).loadTabs()).toEqual({ urls: ["https://example.com"], activeIndex: 0 });
	});
});
