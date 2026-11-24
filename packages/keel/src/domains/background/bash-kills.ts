import type { BashAbortHandle, BashAbortRegistry } from "../../contracts/background.js";

/**
 * 对话级 bash 中止表：老实现 `ClientSession.bashKills`（按对话一个 `Set<AbortController>`）的替代。
 *
 * 为什么归内核：新树的 bash 是 SDK 的 `createBashToolDefinition`（`adapters/tools/guarded.ts`），
 * 它的 `execute` 第三参就是 `AbortSignal`，abort 时 SDK 自己 `killProcessTree`。句柄只在工具执行期存在，
 * 所以「登记 / 注销 / 按对话 aborts」三件事全在内核一侧，宿主既看不见也不需要看。
 *
 * 三条硬约束：
 * - **不漏表**：`release()` 必须在工具执行的 `finally` 里调（`guarded.ts` 就是这么包的）；
 *   分桶空了立刻删键，`abortAll()` 在运行时断开时收口一次。
 * - **不误杀**：按对话 id 分桶，多条对话并发时 `abort("A")` 只动 A 那一桶。
 * - **不猜主人**：没有对话身份就不登记（返回 `undefined`），免得中止落到错的对话上。
 */
export class BashKills implements BashAbortRegistry {
	private readonly table = new Map<string, Set<AbortController>>();

	/** 开始执行：登记一条句柄。没有对话身份 → 不登记（调用方直接透传上游 signal）。 */
	register(conversationId: string | undefined): BashAbortHandle | undefined {
		const key = conversationId?.trim();
		if (!key) return undefined;
		const controller = new AbortController();
		const bucket = this.table.get(key) ?? new Set<AbortController>();
		bucket.add(controller);
		this.table.set(key, bucket);
		let released = false;
		return {
			signal: controller.signal,
			release: () => {
				// 幂等：工具层可能在中止监听里顺手 release 一次，重复调不能把别人的桶删掉。
				if (released) return;
				released = true;
				bucket.delete(controller);
				if (bucket.size === 0 && this.table.get(key) === bucket) this.table.delete(key);
			},
		};
	}

	/** 这条对话还有几条命令在跑（测试与「有没有在跑」的判定都读它）。 */
	running(conversationId: string | undefined): number {
		const key = conversationId?.trim();
		return key ? (this.table.get(key)?.size ?? 0) : 0;
	}

	/**
	 * 中止这条对话的全部在跑命令，返回中止的条数（0 = 没有在跑的命令）。
	 * 只 abort 不删表：注销由各句柄自己的 `release()` 负责（对应工具的 `finally`）。
	 */
	abort(conversationId: string | undefined): number {
		const key = conversationId?.trim();
		const bucket = key ? this.table.get(key) : undefined;
		if (!bucket || bucket.size === 0) return 0;
		// 快照遍历：abort 会同步触发监听，监听里可能注销（老实现同一个 `[...kills]` 口径）。
		const controllers = [...bucket];
		for (const controller of controllers) controller.abort();
		return controllers.length;
	}

	/** 收口（运行时断开 / 引擎 dispose）：中止所有对话的在跑命令并清表。 */
	abortAll(): number {
		let count = 0;
		// 快照遍历：abort 会同步触发监听，监听里可能 release（甚至改到这张表）——与 `abort()` 同一个口径。
		const buckets = Array.from(this.table.values());
		for (const bucket of buckets) {
			for (const controller of Array.from(bucket)) {
				count++;
				controller.abort();
			}
		}
		this.table.clear();
		return count;
	}
}
