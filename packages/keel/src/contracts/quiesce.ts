/**
 * 「引擎正在排空」（quiesce）这一类拒绝的唯一形状。
 *
 * 为什么要有内核这一份：拒绝是**内核**做的（`CoreEngine.attach()` 拒新连接、连接期挂上的
 * quiesce 门拒新回合），判定却在**宿主**（`server/index.ts` 收到就按 4403 关连接）。
 * 两边各有一个同名类（老实现 `server/agent-service.ts` 的同名类不能反向被内核引用），
 * 所以跨界只认 `code`：`isQuiesceRejection()` 是宿主那一侧唯一该用的判定口。
 *
 * 文案与老实现逐字同形（含 "quiesce" 这个词）：客户端 `/quiesce/` 的断言与运维手册都按它认。
 */
export class QuiesceRejectedError extends Error {
	readonly code = "QUIESCED";

	constructor(detail: string) {
		super(`服务器正在排空存量工作（quiesce）——${detail}`);
		this.name = "QuiesceRejectedError";
	}
}

/** 宿主侧判定口：不靠 `instanceof` 跨包匹配（老树与内核各有一份同名类，构造器不同源）。 */
export function isQuiesceRejection(error: unknown): boolean {
	return (error as { code?: unknown } | null | undefined)?.code === "QUIESCED";
}
