import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicSync, writeJsonAtomicSync } from "./atomic-file.js";

export const SETTINGS_SECRETS_KEY = "__settingsSecrets";

interface SealedBlob {
	iv: string;
	tag: string;
	ct: string;
}
type SecretFile = { v: 1; items: Record<string, SealedBlob> };

function seal(key: Buffer, plaintext: string): SealedBlob {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}

function unseal(key: Buffer, blob: SealedBlob): string {
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
	decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
	return Buffer.concat([decipher.update(Buffer.from(blob.ct, "hex")), decipher.final()]).toString("utf8");
}

function loadOrCreateKey(dataDir: string): Buffer {
	const keyFile = join(dataDir, "secrets.key");
	try {
		if (existsSync(keyFile)) {
			const loaded = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
			if (loaded.length === 32) return loaded;
			console.warn(`[secrets] ${keyFile} 长度异常（${loaded.length} 字节），重新生成密钥（旧机密将不可读）`);
		}
	} catch {}
	const key = randomBytes(32);
	writeAtomicSync(keyFile, `${key.toString("hex")}\n`);
	try {
		chmodSync(keyFile, 0o600);
	} catch {}
	return key;
}

export class PluginSecrets {
	private readonly file: string;
	private readonly settingsFile: string;
	private readonly key: Buffer;
	constructor(dataDir: string, pluginDir: string) {
		this.file = join(pluginDir, "secrets.bin");
		this.settingsFile = join(pluginDir, "storage.json");
		this.key = PluginSecrets.keyFor(dataDir);
	}
	private static keys = new Map<string, Buffer>();
	static keyFor(dataDir: string): Buffer {
		let key = this.keys.get(dataDir);
		if (!key) {
			key = loadOrCreateKey(dataDir);
			this.keys.set(dataDir, key);
		}
		return key;
	}
	private load(): SecretFile {
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as SecretFile;
			if (parsed?.v !== 1 || !parsed.items || typeof parsed.items !== "object" || Array.isArray(parsed.items))
				throw new Error("Invalid secrets file");
			return parsed;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, items: {} };
			throw err;
		}
	}
	private storage(): Record<string, unknown> {
		try {
			const parsed = JSON.parse(readFileSync(this.settingsFile, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid plugin storage");
			return parsed;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw err;
		}
	}
	commitSettings(settings: Record<string, unknown>, updates: Record<string, string>): void {
		const storage = this.storage();
		const items = { ...this.settingsItems(storage) };
		for (const [name, value] of Object.entries(updates)) items[name] = seal(this.key, value);
		writeJsonAtomicSync(this.settingsFile, { ...storage, settings, [SETTINGS_SECRETS_KEY]: items }, 0);
	}
	set(name: string, value: string): void {
		if (!name) throw new Error("secrets.set: name must not be empty");
		if (name.startsWith("setting:")) {
			const storage = this.storage();
			this.commitSettings((storage.settings ?? {}) as Record<string, unknown>, { [name]: value });
			return;
		}
		const store = this.load();
		const items = { ...store.items, [name]: seal(this.key, value) };
		writeJsonAtomicSync(this.file, { v: 1, items });
	}
	private settingsItems(storage = this.storage()): Record<string, SealedBlob | null> {
		const items = storage[SETTINGS_SECRETS_KEY];
		if (items === undefined) return {};
		if (!items || typeof items !== "object" || Array.isArray(items))
			throw new Error("Invalid settings secrets metadata");
		return items as Record<string, SealedBlob | null>;
	}
	private items(): Record<string, SealedBlob | null> {
		let legacy: SecretFile["items"] = {};
		try {
			legacy = this.load().items;
		} catch {}
		return { ...legacy, ...this.settingsItems() };
	}
	get(name: string): string | undefined {
		const migrated = this.settingsItems();
		let blob: SealedBlob | null | undefined;
		if (migrated && Object.hasOwn(migrated, name)) blob = migrated[name];
		else {
			try {
				blob = this.load().items[name];
			} catch {
				return undefined;
			}
		}
		if (!blob) return undefined;
		try {
			return unseal(this.key, blob);
		} catch {
			return undefined;
		}
	}
	has(name: string): boolean {
		return this.get(name) !== undefined;
	}
	delete(name: string): void {
		if (name.startsWith("setting:")) {
			const storage = this.storage();
			writeJsonAtomicSync(
				this.settingsFile,
				{ ...storage, [SETTINGS_SECRETS_KEY]: { ...this.settingsItems(storage), [name]: null } },
				0,
			);
			return;
		}
		const store = this.load();
		if (!(name in store.items)) return;
		delete store.items[name];
		writeJsonAtomicSync(this.file, store);
	}
	list(): string[] {
		return Object.entries(this.items())
			.filter(([, value]) => !!value)
			.map(([name]) => name);
	}
	getAll(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const name of this.list()) {
			const value = this.get(name);
			if (value !== undefined) out[name] = value;
		}
		return out;
	}
}
