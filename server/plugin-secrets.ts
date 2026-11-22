import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod as chmodAsync } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic-file.js";
import { createSerializedJsonWriter, type SerializedJsonWriter } from "./serialized-json-writer.js";

export const SETTINGS_SECRETS_KEY = "__settingsSecrets";

/**
 * 同一文件的排队写 + 「读己之写」视图，本模块是单源。
 *
 * 为什么住在这里：`<stateDir>/storage.json` 有两条写入方（`PluginStorage`（plugin-facilities）
 * 与设置/secret 提交），排队必须共用一份，否则后写会吞前写；`secrets.bin` 也因为
 * `new PluginSecrets(...)` 每个调用点各建实例而需要跨实例排队。`plugin-facilities` 已经依赖本模块，
 * 把原语放这里不新增环状依赖。
 *
 * 视图（`queuedValues`）只解决「老插件不 await `host.storage.set()` 后立刻 `get()`」这一条源码兼容：
 * 落盘一结束（无论成败）立即撤掉，失败后读回落盘旧值，不会把失败伪装成成功。
 */
const writers = new Map<string, SerializedJsonWriter>();
const queuedValues = new Map<string, unknown>();
/** 进行中的整笔提交（含「等密钥落盘」前置）；flushQueuedJson 靠它才能等到真正的落定。 */
const pendingCommits = new Set<Promise<unknown>>();

function trackCommit<T>(promise: Promise<T>): Promise<T> {
	pendingCommits.add(promise);
	const drop = (): void => {
		pendingCommits.delete(promise);
	};
	promise.then(drop, drop);
	return promise;
}

function writerFor(file: string): SerializedJsonWriter {
	let writer = writers.get(file);
	if (!writer) {
		writer = createSerializedJsonWriter(file, { indent: 0, label: file });
		writers.set(file, writer);
	}
	return writer;
}

/** 把 `value` 排队写到 `file` 并等待落盘（同文件按提交顺序；失败会 reject）。 */
export function commitJsonQueued(file: string, value: unknown): Promise<void> {
	const snapshot = JSON.parse(JSON.stringify(value ?? null)) as unknown;
	queuedValues.set(file, snapshot);
	const settled = writerFor(file).writeNow(snapshot);
	const clear = (): void => {
		if (queuedValues.get(file) === snapshot) queuedValues.delete(file);
	};
	settled.then(clear, clear);
	return settled;
}

/** 已登记但可能尚未落盘的最新内容；没有排队写时返回 undefined（调用方回落到读盘）。 */
export function readQueuedView<T>(file: string): T | undefined {
	const queued = queuedValues.get(file);
	return queued === undefined ? undefined : (JSON.parse(JSON.stringify(queued)) as T);
}

/** 等所有排队中的 JSON 写落地（关停与测试用）。 */
export async function flushQueuedJson(): Promise<void> {
	// 两阶段：先等「整笔提交」（其中可能包含等密钥落盘才排队的写），再等它排进队列的写。
	for (let round = 0; round < 8; round++) {
		const pending = [...pendingCommits];
		await Promise.all(pending.map((p) => p.catch(() => {})));
		await Promise.all([...writers.values()].map((writer) => writer.flush()));
		if (pendingCommits.size === 0) return;
	}
}

/** 宿主 API 放宽成 Promise 后老插件可能不 await：挂一个 catch 记录，避免 unhandledRejection（接口只放宽不破坏）。 */
function keepCallable(promise: Promise<void>, label: string): Promise<void> {
	promise.catch((err: unknown) => console.error(`[plugin-secrets] ${label} 落盘失败：`, err));
	return promise;
}

interface SealedBlob {
	iv: string;
	tag: string;
	ct: string;
}
type SecretFile = { v: 1; items: Record<string, SealedBlob> };

interface SecretKey {
	key: Buffer;
	/** 首次生成密钥时的落盘：写机密前必须先等它（否则密钥丢了，机密就永久解不开）。 */
	persist: Promise<void>;
}

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

/**
 * 读密钥是同步的（64 字节小文件，不在 #966 的退避路径上）；**写**密钥是异步的：
 * 生成后的落盘排进队列，`set()` / `commitSettings()` 写机密前先 await 它。
 */
function loadOrCreateKey(dataDir: string): SecretKey {
	const keyFile = join(dataDir, "secrets.key");
	try {
		if (existsSync(keyFile)) {
			const loaded = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
			if (loaded.length === 32) return { key: loaded, persist: Promise.resolve() };
			console.warn(`[secrets] ${keyFile} 长度异常（${loaded.length} 字节），重新生成密钥（旧机密将不可读）`);
		}
	} catch {}
	const key = randomBytes(32);
	const persist = (async (): Promise<void> => {
		await writeAtomic(keyFile, `${key.toString("hex")}\n`, { mode: 0o600 });
		try {
			await chmodAsync(keyFile, 0o600);
		} catch {}
	})();
	persist.catch((err: unknown) => console.error(`[secrets] 写入 ${keyFile} 失败：`, err));
	return { key, persist };
}

export class PluginSecrets {
	private readonly file: string;
	private readonly settingsFile: string;
	private readonly key: Buffer;
	private readonly keyPersist: Promise<void>;
	/**
	 * @param stateDir 插件**状态**目录（`pluginStateDir(dataDir, id)`）。机密与设置都属于状态，
	 * 不放在代码目录里 —— 代码目录是纯缓存，随时可能被重新物化。
	 */
	constructor(dataDir: string, stateDir: string) {
		this.file = join(stateDir, "secrets.bin");
		this.settingsFile = join(stateDir, "storage.json");
		const { key, persist } = PluginSecrets.keyFor(dataDir);
		this.key = key;
		this.keyPersist = persist;
	}
	private static keys = new Map<string, SecretKey>();
	static keyFor(dataDir: string): SecretKey {
		let entry = this.keys.get(dataDir);
		if (!entry) {
			entry = loadOrCreateKey(dataDir);
			this.keys.set(dataDir, entry);
		}
		return entry;
	}
	private load(): SecretFile {
		const queued = readQueuedView<SecretFile>(this.file);
		if (queued) return queued;
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
		const queued = readQueuedView<Record<string, unknown>>(this.settingsFile);
		if (queued) {
			if (!queued || typeof queued !== "object" || Array.isArray(queued)) throw new Error("Invalid plugin storage");
			return queued;
		}
		try {
			const parsed = JSON.parse(readFileSync(this.settingsFile, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid plugin storage");
			return parsed;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw err;
		}
	}
	/**
	 * 同步登记「已排队的最新视图」（老插件不 await `set()` 就 `get()` 也读得到），返回清除器。
	 * 密钥落盘是机密落盘的前置，必须等它——但视图不能等，否则不 await 的调用读不到自己的写。
	 */
	private stage(file: string, value: unknown): () => void {
		const snapshot = JSON.parse(JSON.stringify(value ?? null)) as unknown;
		queuedValues.set(file, snapshot);
		return () => {
			if (queuedValues.get(file) === snapshot) queuedValues.delete(file);
		};
	}
	private async persistStaged(file: string, value: unknown, clear: () => void): Promise<void> {
		try {
			await this.keyPersist;
			await writerFor(file).writeNow(value);
		} finally {
			clear();
		}
	}
	commitSettings(settings: Record<string, unknown>, updates: Record<string, string>): Promise<void> {
		// async 体在第一个 await 之前同步执行：视图登记是同步的，落盘才是异步的。
		const run = trackCommit(
			(async (): Promise<void> => {
				const storage = this.storage();
				const items = { ...this.settingsItems(storage) };
				for (const [name, value] of Object.entries(updates)) items[name] = seal(this.key, value);
				const next = { ...storage, settings, [SETTINGS_SECRETS_KEY]: items };
				await this.persistStaged(this.settingsFile, next, this.stage(this.settingsFile, next));
			})(),
		);
		return keepCallable(run, `commitSettings(${this.settingsFile})`);
	}
	set(name: string, value: string): Promise<void> {
		if (!name) throw new Error("secrets.set: name must not be empty");
		if (name.startsWith("setting:")) {
			const storage = this.storage();
			return this.commitSettings((storage.settings ?? {}) as Record<string, unknown>, { [name]: value });
		}
		const store = this.load();
		const items = { ...store.items, [name]: seal(this.key, value) };
		const next: SecretFile = { v: 1, items };
		const clear = this.stage(this.file, next);
		return keepCallable(trackCommit(this.persistStaged(this.file, next, clear)), `set(${name})`);
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
	private async writeSecrets(store: SecretFile): Promise<void> {
		const clear = this.stage(this.file, store);
		await trackCommit(this.persistStaged(this.file, store, clear));
	}
	delete(name: string): Promise<void> {
		if (name.startsWith("setting:")) {
			const storage = this.storage();
			const next = { ...storage, [SETTINGS_SECRETS_KEY]: { ...this.settingsItems(storage), [name]: null } };
			return keepCallable(trackCommit(commitJsonQueued(this.settingsFile, next)), `delete(${name})`);
		}
		const store = this.load();
		if (!(name in store.items)) return Promise.resolve();
		delete store.items[name];
		return keepCallable(this.writeSecrets(store), `delete(${name})`);
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
