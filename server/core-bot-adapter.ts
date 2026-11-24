import type { BotChatPort, BotChatTarget } from "../packages/keel/src/contracts/bots.js";
import { latestBotChatTranscript, resolveBotChatBot } from "./device-center/bot-chat.js";

/**
 * 宿主侧适配器：把设备中心的 Bot 叶子按 `BotChatPort` 的窄面交给内核。
 *
 * 三件事都在老叶子里，内核不复制：
 * - `resolve` → `resolveBotChatBot`（本机 `device-bots/` 注册表 + `enabled` 判定；停用也当不存在）；
 * - `latestTranscript` → `latestBotChatTranscript`（`<agentDir>/bot-sessions/<botId>` 的排布 +
 *   `webui/bot-chat` 锚点 + cwd 校验，只有这里知道 `agentDir`）；
 * - `rebindIfStale` 不实现：能力快照（工具白名单 / 提示词 / 模型 / 记忆）的持有者是设备中心的会话运行时，
 *   内核侧还没有可重绑的句柄（会话身份里没有 `botId`）。等那条边接上再补，不在这里写空实现。
 */
export function createCoreBotChat(input: { agentDir: string }): BotChatPort {
	return {
		async resolve(botId: string): Promise<BotChatTarget | undefined> {
			const bot = await resolveBotChatBot(botId);
			if (!bot) return undefined;
			return { id: bot.id, cwd: bot.cwd, revision: bot.revision };
		},
		latestTranscript: (botId: string, cwd: string) => latestBotChatTranscript(input.agentDir, botId, cwd),
	};
}
