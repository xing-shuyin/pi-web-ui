/**
 * 私聊 = 普通对话 + Bot 绑定（`server/device-center/bot-chat.ts`）。
 *
 * 这里守三条最容易退化的行为：
 * 1. 绑定从会话转录里的 `webui/bot-chat` 条目读回来（重启 / 重新打开会话都靠它）；
 * 2. 同一条目出现多次时取最后一条（换绑要覆盖旧值）；
 * 3. Bot 不存在或已停用时不建能力——上层据此降级成普通对话并给提示，而不是建半个会话。
 */
import { describe, expect, it, afterEach } from "vitest";
import type { LocalBot } from "../../server/device-center/bots.js";
import {
	BOT_CHAT_ENTRY,
	BOT_EXECUTION_ENTRY,
	createBotChatCapability,
	decideTranscriptBotBinding,
	readBotChatBinding,
	readBotExecutionAnchor,
	resolveBotChatBot,
	setBotChatHost,
} from "../../server/device-center/bot-chat.js";

function bot(overrides: Partial<LocalBot> = {}): LocalBot {
	return {
		id: "bot-1",
		name: "爱山东",
		description: "",
		systemPrompt: "你是爱山东。",
		cwd: process.cwd(),
		tools: ["read"],
		skills: [],
		mcpServers: [],
		enabled: true,
		revision: 1,
		...overrides,
	};
}

const entry = (customType: string, data: unknown) => ({ type: "custom", customType, data }) as never;

afterEach(() => {
	setBotChatHost(undefined as never);
});

describe("会话里的 Bot 绑定条目", () => {
	it("从 webui/bot-chat 条目读回 botId，忽略其它 custom 条目", () => {
		const binding = readBotChatBinding([
			entry("device-bot-execution", { botId: "stale" }),
			entry(BOT_CHAT_ENTRY, { botId: "bot-1", revision: 1 }),
		]);
		expect(binding?.botId).toBe("bot-1");
	});

	it("同类型条目出现多次时取最后一条（换绑覆盖旧值）", () => {
		const binding = readBotChatBinding([
			entry(BOT_CHAT_ENTRY, { botId: "bot-old" }),
			entry(BOT_CHAT_ENTRY, { botId: "bot-new" }),
		]);
		expect(binding?.botId).toBe("bot-new");
	});

	it("没有绑定条目时返回 undefined（普通对话）", () => {
		expect(readBotChatBinding([entry("webui/independent", { independent: true })])).toBeUndefined();
	});
});

describe("转录的 Bot 归属判定（decideTranscriptBotBinding）", () => {
	const chat = { botId: "bot-1", revision: 1 };

	it("没有执行锚点 → 照常接受（新会话/普通会话）", () => {
		expect(decideTranscriptBotBinding({ current: { id: "bot-1", revision: 2 } })).toEqual({ action: "accept" });
	});

	it("同一个 Bot 的同一版配置 → 接受", () => {
		expect(decideTranscriptBotBinding({ execution: chat, chat, current: { id: "bot-1", revision: 1 } })).toEqual({
			action: "accept",
		});
	});

	it("私聊 + Bot 改过配置 → 重绑（配置升级不换主人，不能把会话锁死）", () => {
		expect(decideTranscriptBotBinding({ execution: chat, chat, current: { id: "bot-1", revision: 2 } })).toEqual({
			action: "rebind",
		});
	});

	it("非私聊的执行转录 + 版本变了 → 拒绝（那是按旧快照授权过的执行）", () => {
		expect(decideTranscriptBotBinding({ execution: chat, current: { id: "bot-1", revision: 2 } })).toEqual({
			action: "reject",
			reason: "revision",
		});
	});

	it("换了 Bot → 拒绝（所有权不符）", () => {
		expect(decideTranscriptBotBinding({ execution: chat, chat, current: { id: "bot-2", revision: 1 } })).toEqual({
			action: "reject",
			reason: "owner",
		});
	});

	it("私聊的 Bot 被删/停用 → 降级只读历史，不当普通会话继续说", () => {
		expect(decideTranscriptBotBinding({ execution: chat, chat })).toEqual({ action: "degrade" });
		// 不是私聊的执行转录失去能力 → 不能当普通会话重开。
		expect(decideTranscriptBotBinding({ execution: chat })).toEqual({ action: "reject", reason: "orphan" });
	});
});

describe("执行锚点读回（readBotExecutionAnchor）", () => {
	it("只认 device-bot-execution，且多条时取最后一条（重绑是追加）", () => {
		const anchor = readBotExecutionAnchor([
			{ type: "custom", customType: BOT_CHAT_ENTRY, data: { botId: "bot-1", revision: 9 } },
			{ type: "custom", customType: BOT_EXECUTION_ENTRY, data: { botId: "bot-1", revision: 1 } },
			{ type: "message" },
			{ type: "custom", customType: BOT_EXECUTION_ENTRY, data: { botId: "bot-1", revision: 2 } },
		] as never);
		expect(anchor).toEqual({ botId: "bot-1", revision: 2 });
	});

	it("没有锚点或数据不完整时返回 undefined", () => {
		expect(readBotExecutionAnchor([])).toBeUndefined();
		expect(
			readBotExecutionAnchor([{ type: "custom", customType: BOT_EXECUTION_ENTRY, data: {} }] as never),
		).toBeUndefined();
	});
});

describe("私聊能力解析", () => {
	it("Bot 不存在 → 拿不到能力（上层降级成普通对话）", async () => {
		setBotChatHost({ resolve: () => undefined });
		expect(await resolveBotChatBot("missing")).toBeUndefined();
		expect(await createBotChatCapability("missing")).toBeUndefined();
	});

	it("Bot 已停用 → 同样拿不到能力", async () => {
		setBotChatHost({ resolve: (id) => bot({ id, enabled: false }) });
		expect(await resolveBotChatBot("bot-1")).toBeUndefined();
	});

	it("正常 Bot → 能力带着它的模型/工具白名单，且不会在一轮后就失效", async () => {
		const target = bot({ model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" }, tools: ["read", "grep"] });
		setBotChatHost({ resolve: (id) => (id === target.id ? target : undefined) });
		const made = await createBotChatCapability(target.id);
		expect(made?.bot.id).toBe(target.id);
		expect(made?.capability.captureModel(undefined)).toEqual({
			provider: "opencode-go",
			modelId: "deepseek-v4.1-flash",
		});
		expect(made?.capability.allowsTool("read")).toBe(true);
		// 私聊会话要一直能接着聊：register 的能力不能像设备任务那样一轮就 release。
		expect(made?.capability.allowsTool("bash")).toBe(false);
	});
});
