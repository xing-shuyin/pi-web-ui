import { armDelay } from "../plugin-schedule.js";
import { botMemoryRoot, createBotMemory } from "./bot-memory.js";

/**
 * Bot 记忆的日常维护（衰减 + 归档 + 重建投影）。
 *
 * 红线：远期定时不能一次 `setTimeout` 到 24h 之后——必须用 `armDelay()` 分片（≤6h 一片，
 * 守卫 `plugin-cron-overflow-test`），否则进程休眠/时钟跳变会让定时器提前或延后很久触发。
 *
 * 这里只做"每个 Bot 跑一次 compact"，单 Bot 失败不影响其他 Bot；产物是各自的
 * `memory/REPORT.md` 与索引重建。
 */

export interface BotMemoryMaintenanceOptions {
	dataDir: string;
	bots: { list(): { id: string; name: string }[] };
	/** 默认 24h。 */
	intervalMs?: number;
	now?: () => number;
	onError?: (botId: string, error: unknown) => void;
}

export interface BotMemoryMaintenanceResult {
	bots: number;
	expired: number;
	demoted: number;
	archived: number;
}

export async function runBotMemoryMaintenanceOnce(
	options: Pick<BotMemoryMaintenanceOptions, "dataDir" | "bots" | "onError">,
): Promise<BotMemoryMaintenanceResult> {
	const result: BotMemoryMaintenanceResult = { bots: 0, expired: 0, demoted: 0, archived: 0 };
	for (const bot of options.bots.list()) {
		try {
			const memory = createBotMemory({ root: botMemoryRoot(options.dataDir, bot.id) });
			const outcome = await memory.compact();
			result.bots += 1;
			result.expired += outcome.expired;
			result.demoted += outcome.demoted;
			result.archived += outcome.archived;
		} catch (error) {
			options.onError?.(bot.id, error);
		}
	}
	return result;
}

export interface BotMemoryMaintenanceHandle {
	stop(): void;
	/** 立即跑一次（测试与手动整理共用）。 */
	runNow(): Promise<BotMemoryMaintenanceResult>;
}

export function startBotMemoryMaintenance(options: BotMemoryMaintenanceOptions): BotMemoryMaintenanceHandle {
	const now = options.now ?? (() => Date.now());
	const interval = Math.max(60 * 60 * 1000, options.intervalMs ?? 24 * 60 * 60 * 1000);
	let nextAt = now() + interval;
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;

	const schedule = () => {
		if (stopped) return;
		const delay = armDelay(nextAt, now());
		timer = setTimeout(() => {
			timer = undefined;
			if (stopped) return;
			if (now() < nextAt) {
				schedule();
				return;
			}
			nextAt = now() + interval;
			void runBotMemoryMaintenanceOnce(options)
				.catch((error) => options.onError?.("*", error))
				.finally(schedule);
		}, delay);
		timer.unref?.();
	};

	schedule();

	return {
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
		runNow: () => runBotMemoryMaintenanceOnce(options),
	};
}
