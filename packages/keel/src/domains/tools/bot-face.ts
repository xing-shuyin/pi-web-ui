import type { BotToolFace } from "../../contracts/bots.js";
import type { ActiveToolSet } from "../../tool-catalog.js";

/**
 * Bot 执行的工具门禁：老实现 `applyToolGating`（`agentService:10746`）那一支的 **早返回**。
 *
 * 老实现逐字是：
 * ```ts
 * if (this.botOf(conv?.id)) {
 *   session.setActiveToolsByName(getAllTools().filter((t) => botToolRegistrationAllowed(t.name, cwd, conv?.id)).map((t) => t.name));
 *   return; // 不再叠预设 / 设置开关 / 懒加载 / 子代理白名单
 * }
 * ```
 * 「早返回」是语义的一部分，不是省事：Bot 的白名单本身就是最终口径，再叠一层预设减法
 * 只会把 Bot 要的工具也减掉（这正是「说了能跑 bash、实际没有 bash」的那类假开关）。
 *
 * 判定本身不在这里：谁允许哪条工具由宿主端口（`BotToolFace`）持有，内核只负责把结果落到
 * 活动集这**一个**写口上。
 */

/** 门禁只需要这两件事：读全部工具、写活动工具集（与 `ActiveToolSet` 同形，避开 SDK 类型）。 */
export type BotToolGateHost = Pick<ActiveToolSet, "getAllTools" | "setActiveToolsByName">;

/**
 * 会话 → 门禁句柄。只认结构（`presetToolHostOf` 同一手法）：假体 / 半成品会话拿不到就返回
 * `undefined`，调用方据此**拒绝执行**，而不是当作「没有门禁」放行。
 */
export function botToolGateHostOf(session: unknown): BotToolGateHost | undefined {
	const surface = session as Partial<BotToolGateHost> | undefined;
	if (!surface) return undefined;
	if (typeof surface.getAllTools !== "function") return undefined;
	if (typeof surface.setActiveToolsByName !== "function") return undefined;
	return surface as BotToolGateHost;
}

/**
 * 按 Bot 工具面重设活动工具集，返回重设后的名字（调用方用它证明工具集真的变了）。
 *
 * 判定抛错一律按**拒绝**处理（fail-closed）：能力已撤销、注册表读不出来时，宁可少一条工具，
 * 也不把整张工具表交给一次过期的执行。
 */
export function applyBotToolGate(input: { host: BotToolGateHost; face: BotToolFace }): string[] {
	const names: string[] = [];
	for (const tool of input.host.getAllTools()) {
		let allowed = false;
		try {
			allowed = input.face.allows(tool.name);
		} catch {
			allowed = false;
		}
		if (allowed) names.push(tool.name);
	}
	input.host.setActiveToolsByName(names);
	return names;
}
