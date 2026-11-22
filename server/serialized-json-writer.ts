import { writeAtomic } from "./atomic-file.js";

/**
 * 串行 JSON 落盘器：同一文件的写入排队、按提交顺序落盘，**从不阻塞事件循环**。
 *
 * 为什么需要它：`writeJsonAtomicSync` 的退避等待发生在调用线程上（最坏 630ms 全进程停摆，
 * issue #966）。把落盘改成异步就够了吗？不够——多个 store 会并发触发同一文件的写，
 * 异步而无序会让「后写」被「先写」覆盖。所以顺序这条不变量必须由一个原语统一持有，
 * 而不是让每个 store 各自 `void writeJsonAtomic(...)`。
 *
 * 两个入口按语义分工：
 * - `write()`：把当时的快照排进队列就返回。适用于可重建的缓存/投影（真值在别处）。
 * - `writeNow()`：排队并等到这一笔真正落盘再返回。适用于真值存储（用户数据、授权、账本），
 *   保证「先持久化成功 → 再改内存投影 → 再公告」。
 */
export interface SerializedJsonWriter {
	/** 排队写入，返回即代表「已按当时的快照登记」，不代表已落盘。 */
	write(data: unknown): void;
	/** 排队写入并等待它落盘；失败会抛出（真值存储用）。 */
	writeNow(data: unknown): Promise<void>;
	/** 等待队列里所有未完成的写入。 */
	flush(): Promise<void>;
	/** 最近一次写入失败的原因；成功后清空。 */
	lastError(): unknown;
}

export function createSerializedJsonWriter(
	file: string,
	options: { indent?: number | string; label?: string; mode?: number; fsync?: boolean } = {},
): SerializedJsonWriter {
	const label = options.label ?? file;
	let chain: Promise<unknown> = Promise.resolve();
	let lastError: unknown;

	const enqueue = (snapshot: string): Promise<void> => {
		// 链必须自愈：某一次写失败（ENOSPC / 权限 / 认不出的文件）不能把后续写入永久卡死，
		// 否则一次瞬时失败就等于该文件从此静默丢写。失败只记录到 lastError，链本身总是 resolve。
		const run = chain.then(async () => {
			try {
				await writeAtomic(file, snapshot, { mode: options.mode, fsync: options.fsync });
				lastError = undefined;
			} catch (error) {
				lastError = error;
				throw error;
			}
		});
		chain = run.catch(() => undefined);
		return run;
	};

	return {
		write(data: unknown): void {
			// 立即序列化：调用方随后对内存做的改动不得影响这笔已登记的快照。
			const snapshot = JSON.stringify(data, null, options.indent ?? 2) + "\n";
			void enqueue(snapshot).catch((error: unknown) => {
				console.error(`[storage] ${label} 写入失败（已排队，后续写入继续尝试）：`, error);
			});
		},
		async writeNow(data: unknown): Promise<void> {
			const snapshot = JSON.stringify(data, null, options.indent ?? 2) + "\n";
			await enqueue(snapshot);
		},
		async flush(): Promise<void> {
			await chain;
		},
		lastError(): unknown {
			return lastError;
		},
	};
}
