/**
 * 记忆写入配额（`docs/agent-bot-design.md` §7.2）。
 *
 * 规则是**服务端常量**：Bot 既不能用提示词、也不能用工具参数放宽它。
 * 两道上限分开记：
 * - 每回合 ≤2 条：防止一轮对话里把索引刷成"聊天记录"；
 * - 每会话 ≤20 条：防止长会话无限膨胀，超了先 promote/forget 再写。
 *
 * 计数在 `prompt()` 开新回合时归零（`beginTurn`），私聊、群任务各自一份。
 */

export const MEMORY_WRITES_PER_TURN = 2;
export const MEMORY_WRITES_PER_SESSION = 20;

export interface MemoryWriteQuota {
	/** 新回合开始（每轮 prompt 一次）。 */
	beginTurn(): void;
	/** 申请一次写入；被拒时不占用任何配额。 */
	consume(): { ok: true } | { ok: false; reason: string };
	/**
	 * 归还一次已申请的配额（写入在校验/落盘阶段失败时）。
	 * 配额算的是「存下来的记忆条数」：参数写错（scope/confidence 不合规）不是一条记忆，
	 * 不能因此把整回合的额度吃掉——否则模型改对参数后也写不进任何东西。
	 */
	release(): void;
	snapshot(): { turn: number; session: number };
}

export function createMemoryWriteQuota(limits: { perTurn?: number; perSession?: number } = {}): MemoryWriteQuota {
	const perTurn = limits.perTurn ?? MEMORY_WRITES_PER_TURN;
	const perSession = limits.perSession ?? MEMORY_WRITES_PER_SESSION;
	let turn = 0;
	let session = 0;
	return {
		beginTurn() {
			turn = 0;
		},
		release() {
			if (turn > 0) turn -= 1;
			if (session > 0) session -= 1;
		},
		consume() {
			if (turn >= perTurn)
				return {
					ok: false,
					reason: `At most ${perTurn} memory writes per turn; keep the rest for later turns.`,
				};
			if (session >= perSession)
				return {
					ok: false,
					reason: `This session already wrote ${perSession} memories; promote or forget some before adding more.`,
				};
			turn += 1;
			session += 1;
			return { ok: true };
		},
		snapshot() {
			return { turn, session };
		},
	};
}
