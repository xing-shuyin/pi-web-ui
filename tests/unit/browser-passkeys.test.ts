import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserStorage, type CredentialEncryption } from "../../browser/storage/index.js";
import {
	passkeyFromCredential,
	passkeysForHost,
	publicPasskey,
	toCdpCredential,
	upsertPasskey,
	type StoredPasskey,
} from "../../browser/runtime/passkeys.js";

const directories: string[] = [];
function directory(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-passkeys-"));
	directories.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const encryption: CredentialEncryption = {
	isEncryptionAvailable: () => true,
	encryptString: (value) => Buffer.from(`protected:${value}`),
	decryptString: (value) => {
		const text = value.toString();
		if (!text.startsWith("protected:")) throw new Error("Wrong OS key");
		return text.slice(10);
	},
};
const entry: StoredPasskey = {
	id: "pk-1",
	rpId: "example.com",
	origin: "https://www.example.com",
	credentialId: "credential-id",
	privateKey: "pkcs8-secret",
	userHandle: "handle",
	userName: "ann@example.com",
	userDisplayName: "Ann",
	signCount: 3,
	label: "ann@example.com",
	createdAt: "2026-01-01T00:00:00.000Z",
};

describe("passkey records", () => {
	it("matches credentials by WebAuthn rpId suffix semantics", () => {
		expect(passkeysForHost([entry], "example.com")).toHaveLength(1);
		expect(passkeysForHost([entry], "www.example.com")).toHaveLength(1);
		expect(passkeysForHost([entry], "login.www.example.com")).toHaveLength(1);
		// rpId 是 example.com 时，别的站点不能借用
		expect(passkeysForHost([entry], "notexample.com")).toHaveLength(0);
		expect(passkeysForHost([entry], "example.com.evil.test")).toHaveLength(0);
		expect(passkeysForHost([{ ...entry, rpId: "www.example.com" }], "example.com")).toHaveLength(0);
	});
	it("never exposes the private key in the projection sent to the renderer", () => {
		const projected = publicPasskey(entry);
		expect(projected).not.toHaveProperty("privateKey");
		expect(JSON.stringify(projected)).not.toContain("pkcs8-secret");
	});
	it("round-trips through the CDP credential shape", () => {
		expect(toCdpCredential(entry)).toEqual({
			credentialId: "credential-id",
			isResidentCredential: true,
			rpId: "example.com",
			privateKey: "pkcs8-secret",
			userHandle: "handle",
			signCount: 3,
			userName: "ann@example.com",
			userDisplayName: "Ann",
		});
	});
	it("builds a record from what CDP reports after a registration", () => {
		const built = passkeyFromCredential(
			{
				credentialId: "abc",
				isResidentCredential: true,
				rpId: "Example.COM",
				privateKey: "key",
				userHandle: "h",
				signCount: 1,
				userName: "ann@example.com",
			},
			"https://example.com",
			"2026-01-01T00:00:00.000Z",
		);
		expect(built).toMatchObject({ rpId: "example.com", origin: "https://example.com", signCount: 1 });
		expect(built?.label).toBe("ann@example.com");
		// 没有私钥/凭据 id 的“凭据”不能入库
		expect(
			passkeyFromCredential(
				{ credentialId: "", rpId: "x", privateKey: "k", signCount: 0 } as any,
				"https://example.com",
			),
		).toBeNull();
	});
	it("keeps one record per credential id and refreshes the sign count", () => {
		const next = upsertPasskey([entry], { ...entry, id: "other", signCount: 9, createdAt: "2027-01-01" });
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({ id: "pk-1", signCount: 9, createdAt: "2026-01-01T00:00:00.000Z" });
	});
});

describe("passkey storage", () => {
	it("encrypts only the private key and keeps the rest readable", () => {
		const dir = directory();
		const storage = new BrowserStorage(dir, encryption);
		storage.savePasskeys([entry]);
		const disk = fs.readFileSync(path.join(dir, "passkeys.json"), "utf8");
		expect(disk).not.toContain("pkcs8-secret");
		expect(JSON.parse(disk)[0].privateKey).toMatch(/^enc:/);
		expect(JSON.parse(disk)[0].userName).toBe("ann@example.com");
		expect(storage.listPasskeys()).toEqual([entry]);
	});
	it("drops records without a private key instead of breaking the whole list", () => {
		const storage = new BrowserStorage(directory(), encryption);
		storage.savePasskeys([entry, { ...entry, credentialId: "broken", privateKey: "" }, null, 42]);
		expect(storage.listPasskeys().map((item) => item.credentialId)).toEqual(["credential-id"]);
	});
	it("refuses to store or read passkeys without OS encryption", () => {
		const dir = directory();
		const locked = new BrowserStorage(dir, { ...encryption, isEncryptionAvailable: () => false });
		expect(() => locked.savePasskeys([entry])).toThrow(/unavailable/);
		expect(fs.existsSync(path.join(dir, "passkeys.json"))).toBe(false);
	});
});
