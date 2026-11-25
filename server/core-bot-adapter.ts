import type { BotChatPort, BotChatTarget } from "../packages/keel/src/contracts/bots.js";
import { deviceTaskToolFace } from "./device-center/bot-tool-face.js";
import {
	BOT_CHAT_ENTRY,
	BOT_EXECUTION_ENTRY,
	botChatSessionDir,
	createBotChatCapability,
	decideTranscriptBotBinding,
	latestBotChatTranscript,
	readBotChatBinding,
	readBotExecutionAnchor,
	resolveBotChatBot,
} from "./device-center/bot-chat.js";

/**
 * 宿主侧适配器：把设备中心的 Bot 叶子按 `BotChatPort` 的窄面交给内核。
 *
 * 核心原语在 `server/device-center/bot-chat.ts` 中，内核通过窄面调用：
 * - `resolve` → `resolveBotChatBot`（本机 `device-bots/` 注册表 + `enabled` 判定；停用也当不存在）；
 * - `latestTranscript` → `latestBotChatTranscript`（`<agentDir>/bot-sessions/<botId>` 的排布 +
 *   `webui/bot-chat` 锚点 + cwd 校验，只有这里知道 `agentDir`）；
 * - `sessionDir` → `botChatSessionDir`（转录落盘路径）；
 * - `bindTranscriptSession` → 锚点追加、版本断言、停用只读与孤儿执行拦截。
 */
export function createCoreBotChat(input: { agentDir: string }): BotChatPort {
	return {
		async resolve(botId: string): Promise<BotChatTarget | undefined> {
			const bot = await resolveBotChatBot(botId);
			if (!bot) return undefined;
			return { id: bot.id, name: bot.name, cwd: bot.cwd, revision: bot.revision, model: bot.model };
		},
		latestTranscript: (botId: string, cwd: string) => latestBotChatTranscript(input.agentDir, botId, cwd),
		sessionDir: (botId: string) => botChatSessionDir(input.agentDir, botId),
		// 设备任务执行的工具面（白名单 + `device_collab`）：按执行客户端解析，不是私聊那条。
		toolFace: (toolInput) => deviceTaskToolFace(toolInput),
		async bindTranscriptSession(bindInput) {
			let botId = bindInput.botId;
			const executionAnchor = readBotExecutionAnchor(bindInput.entries as any);
			const chatAnchor = readBotChatBinding(bindInput.entries as any);
			if (!botId && chatAnchor) {
				botId = chatAnchor.botId;
			}
			let created: Awaited<ReturnType<typeof createBotChatCapability>> | undefined;
			if (botId) {
				created = await createBotChatCapability(botId);
			}
			const decision = decideTranscriptBotBinding({
				execution: executionAnchor,
				chat: chatAnchor,
				current: created ? { id: created.bot.id, revision: created.bot.revision } : undefined,
			});
			if (decision.action === "reject") {
				throw new Error(
					decision.reason === "orphan"
						? "Bot execution transcripts cannot be resumed as ordinary sessions"
						: decision.reason === "owner"
							? "Bot execution transcript ownership does not match the active capability"
							: "Bot execution transcript was authorized for a different Bot revision",
				);
			}
			if (decision.action === "degrade") {
				return {
					readOnly: true,
					warningNotice: {
						text: "这个智能体已停用或删除：这条私聊只能查看历史，不能接着对话。",
						textEn: "This agent is disabled or deleted: this chat is read-only and cannot be resumed.",
					},
				};
			}
			if (created) {
				const { bot, capability } = created;
				let fixedModel: { provider: string; modelId: string } | undefined;
				try {
					fixedModel = capability.captureModel(bindInput.fallbackModel);
				} catch {}
				const revision = bot.revision;
				const rebind = decision.action === "rebind";
				if (!executionAnchor || rebind) {
					bindInput.appendCustomEntry(BOT_EXECUTION_ENTRY, { botId: bot.id, revision });
				}
				if (chatAnchor?.botId !== bot.id || rebind) {
					bindInput.appendCustomEntry(BOT_CHAT_ENTRY, {
						botId: bot.id,
						revision,
						name: bot.name,
					});
				}
				return {
					bot: { id: bot.id, name: bot.name, revision },
					model: fixedModel,
				};
			}
			return {};
		},
		async rebindIfStale(_conversationId, _botId, _target) {
			// 在 bindTranscriptSession 已经按当前 revision 写了最新锚点
		},
	};
}
