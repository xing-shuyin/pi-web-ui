import { resolve } from "node:path";
import type { StatePort } from "../../contracts/ports.js";
import { openVersionedDoc, type DocState } from "../../versioned-doc.js";

const DOC_VERSION = 1;

export interface FileStatePortOptions {
	file: string;
	namespace: string;
}

export interface FileStateSnapshot {
	state: DocState;
	keys: string[];
}

export interface FileStatePort extends StatePort {
	/** 不再受理写入（读仍可用）；已受理的写入照旧落盘，可用 `flush` 等它们。 */
	close(): void;
	/** 等本实例已受理的写入全部落盘。落盘失败在这里抛（`write` 同步抛的是拒写）。 */
	flush(): Promise<void>;
	/** 磁盘判态 + 本 namespace 的可读键（裸键、排序）。 */
	snapshot(): FileStateSnapshot;
}

type Entries = Record<string, unknown>;

function isEntryMap(value: unknown): value is Entries {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 同一文件上的写入必须串行：每个写者都要「读整份 → 只替换自己 namespace 那一段 → 写回」，
 * 两次「读整份」交错就会互相抹掉对方刚写的新键。
 */
const fileChains = new Map<string, Promise<void>>();

function enqueueWrite(file: string, task: () => Promise<void>): Promise<void> {
	const key = resolve(file);
	const previous = fileChains.get(key) ?? Promise.resolve();
	const result = previous.then(task);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	fileChains.set(key, tail);
	void tail.then(() => {
		if (fileChains.get(key) === tail) fileChains.delete(key);
	});
	return result;
}

/**
 * `StatePort` 的落盘实现：一个 namespace 一段前缀键（内部真键 `$namespace:$key`），对外只见裸键。
 *
 * 读服务内存副本（设置域「落盘后同一回合再读」必须看到新值），落盘只经 `versioned-doc`；
 * 认不出的文件（`foreign` / `damaged`）一律只读，`write` 当场抛 `StorageBlockedError`，绝不写回。
 * 同一 namespace 只允许一个写者（内存即该段的权威），其它 namespace 的键在落盘时按盘上原样保留。
 */
export function createFileStatePort(options: FileStatePortOptions): FileStatePort {
	const { file, namespace } = options;
	const prefix = `${namespace}:`;
	const doc = openVersionedDoc<Entries>({
		file,
		label: `core-state(${namespace})`,
		versions: [DOC_VERSION],
		parse: (value) => (isEntryMap(value.entries) ? { ...value.entries } : null),
		serialize: (entries) => ({ entries }),
		empty: () => ({}),
	});

	const entries = new Map<string, unknown>();
	for (const [fullKey, value] of Object.entries(doc.read())) {
		if (fullKey.startsWith(prefix)) entries.set(fullKey.slice(prefix.length), value);
	}

	let chain: Promise<void> = Promise.resolve();
	let failure: { error: unknown } | null = null;
	let closed = false;

	const persist = (): Promise<void> =>
		enqueueWrite(file, async () => {
			const disk = doc.assertWritable();
			const next: Entries = {};
			for (const [fullKey, value] of Object.entries(disk)) {
				if (!fullKey.startsWith(prefix)) next[fullKey] = value;
			}
			for (const [key, value] of entries) next[`${prefix}${key}`] = value;
			await doc.write(next);
		});

	function read(key: string): unknown {
		return entries.get(key);
	}

	function write(key: string, value: unknown): void {
		if (closed) throw new Error(`state port 已关闭（${namespace}），拒绝写入`);
		// 判态在同步段完成：认不出就当场抛，调用方拿到的就是 versioned-doc 的原始 StorageBlockedError。
		doc.assertWritable();
		if (value === undefined) entries.delete(key);
		else entries.set(key, value);
		const accepted = persist().then(
			() => undefined,
			(error: unknown) => {
				failure ??= { error };
			},
		);
		chain = chain.then(() => accepted);
	}

	async function flush(): Promise<void> {
		await chain;
		if (!failure) return;
		const { error } = failure;
		failure = null;
		throw error;
	}

	function close(): void {
		closed = true;
	}

	function snapshot(): FileStateSnapshot {
		doc.read();
		return { state: doc.state, keys: [...entries.keys()].sort() };
	}

	return { read, write, close, flush, snapshot };
}
