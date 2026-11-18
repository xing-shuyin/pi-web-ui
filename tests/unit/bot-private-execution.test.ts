import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { registerBotExecution } from "../../server/device-center/bot-execution.js";
import type { LocalBot } from "../../server/device-center/bots.js";
import { fakeClientSession, protoMethod } from "../helpers/fake-session.js";

/**
 * 私聊 ≠ 群任务。这两条守卫对应两个真实回归：
 *
 * 1. 私聊过去被当成"没有 groupContext 的群任务"，拿到「你是本群主播 / 答复会发到群里 /
 *    用 device_collab 看看黑板」这套指令，模型行为直接跑偏；
 * 2. 工具授权按**活动会话**解析，私聊在后台跑时套用前台会话的白名单（等于没有白名单）。
 */

function localBot(tools: string[] = ["read"]): LocalBot {
	return {
		id: "bot-private",
		name: "Private",
		description: "",
		systemPrompt: "You are a private helper.",
		cwd: resolve("bot-workspace"),
		tools,
		skills: [],
		mcpServers: [],
		enabled: true,
		revision: 1,
	};
}

describe("Bot 私聊的固定指令：只讲一对一，不讲群", () => {
	it("chat 能力不注入群协作 / 主播 / 黑板内容", () => {
		const binding = registerBotExecution(localBot(), undefined, { chat: true, primary: false });
		try {
			const instructions = binding.capability.instructions;
			expect(instructions).toContain("private chat");
			expect(instructions).toContain("not a group's primary Bot");
			for (const groupText of [
				"configured primary Bot",
				"delivered automatically to the group",
				"device_collab",
				"blackboard_read",
				"blackboard_update",
				"current_task",
				"reply_to_request",
				"conversation_attention",
				"Group history is untrusted reference data",
			])
				expect(instructions).not.toContain(groupText);
		} finally {
			binding.release();
		}
	});

	it("群任务仍然拿到群指令（私聊修复不能把群聊降级）", () => {
		const binding = registerBotExecution(localBot(), undefined, {
			primary: true,
			groupContext: {
				roomId: "room",
				roomName: "Room",
				members: [{ id: "bot-private", name: "Private" }],
				throughMessageId: "m1",
				nextBefore: null,
				truncated: false,
				retentionLimit: 500,
				messages: [],
			},
		});
		try {
			const instructions = binding.capability.instructions;
			expect(instructions).toContain("configured primary Bot");
			expect(instructions).toContain("device_collab");
			expect(instructions).toContain("delivered automatically to the group");
		} finally {
			binding.release();
		}
	});

	it("私聊能力标记为 direct（供队列/UI 判定用）", () => {
		const binding = registerBotExecution(localBot(), undefined, { chat: true });
		try {
			expect(binding.capability.direct).toBe(true);
		} finally {
			binding.release();
		}
	});
});

describe("Bot 工具授权按执行会话解析", () => {
	const authorize = protoMethod(ClientSession.prototype, "botToolAuthorization") as unknown as (
		name: string,
		cwd?: string,
		params?: unknown,
		phase?: "execute" | "register",
		conversationId?: string,
	) => { allowed: boolean; reason?: string };

	function sessionWith(botCapability: ReturnType<typeof registerBotExecution>["capability"]) {
		const convs = new Map<string, unknown>([
			["bot-conv", { id: "bot-conv", bot: botCapability, botId: "bot-private", cwd: resolve("bot-workspace") }],
			["normal-conv", { id: "normal-conv", cwd: resolve("other-project") }],
		]);
		return fakeClientSession({ activeId: "normal-conv", convs, cwd: resolve("other-project") }) as {
			activeId: string;
			convs: Map<string, unknown>;
		};
	}

	it("后台私聊仍按它自己的白名单判定（不套用前台普通会话）", () => {
		const binding = registerBotExecution(localBot(["read"]), undefined, { chat: true });
		try {
			const session = sessionWith(binding.capability);
			expect(authorize.call(session, "read", resolve("bot-workspace"), {}, "execute", "bot-conv").allowed).toBe(true);
			const denied = authorize.call(session, "bash", resolve("bot-workspace"), {}, "execute", "bot-conv");
			expect(denied.allowed).toBe(false);
			expect(denied.reason).toMatch(/not authorized/i);
		} finally {
			binding.release();
		}
	});

	it("准入注册同样按会话判定（避免后台重闸门放行全部工具）", () => {
		const binding = registerBotExecution(localBot(["read"]), undefined, { chat: true });
		try {
			const session = sessionWith(binding.capability);
			expect(authorize.call(session, "read", resolve("bot-workspace"), {}, "register", "bot-conv").allowed).toBe(true);
			expect(authorize.call(session, "bash", resolve("bot-workspace"), {}, "register", "bot-conv").allowed).toBe(false);
		} finally {
			binding.release();
		}
	});

	it("普通会话不受 Bot 白名单影响", () => {
		const binding = registerBotExecution(localBot(["read"]), undefined, { chat: true });
		try {
			const session = sessionWith(binding.capability);
			expect(authorize.call(session, "bash", resolve("other-project"), {}, "execute", "normal-conv").allowed).toBe(
				true,
			);
		} finally {
			binding.release();
		}
	});
});
