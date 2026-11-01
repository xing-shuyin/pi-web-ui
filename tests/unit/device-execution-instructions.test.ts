import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { LocalBot } from "../../server/device-center/bots.js";
import { getBotExecutionInstructions } from "../../server/device-center/execution-instructions.js";
import { getBotExecution, registerBotExecution } from "../../server/device-center/bot-execution.js";

function localBot(): LocalBot {
	return {
		id: "private-bot-id",
		name: "Private name",
		description: "Private description",
		cwd: resolve("private-workspace"),
		enabled: true,
		revision: 1,
		systemPrompt: "Private configured system prompt",
		tools: [],
		skills: [],
		mcpServers: [],
	};
}

describe("stable Bot execution instructions", () => {
	it("includes coordination only for the primary role without expanding authority", () => {
		const ordinary = getBotExecutionInstructions(false);
		const primary = getBotExecutionInstructions(true);
		expect(ordinary).not.toContain("configured primary Bot");
		expect(primary).toContain("configured primary Bot");
		for (const text of [
			"Before your first delegation",
			"topic=coordination",
			"This role grants no additional",
			"never delegate greetings",
			"Do not create duplicate assignments",
			"retry an unchanged blocker",
			"task-chain budget",
		])
			expect(primary).toContain(text);
		expect(getBotExecutionInstructions(true)).toBe(primary);
	});

	it("preserves development boundaries and uses runtime-bound collaboration actions", () => {
		const instructions = getBotExecutionInstructions(false);
		for (const text of [
			"Never enable auto-approval",
			"do not automatically pull, fetch, or checkout",
			"configured fixed workspace",
			"dirty state",
			"never overwrite existing changes",
			"Do not change workspace or create worktrees",
			"report the blocker",
			"greetings, questions and ordinary conversation",
			"without inventing evidence",
			"first load device_collab execution_guide",
			"topic=delivery or topic=review",
			"actual evidence and the exact commit",
			"never review your own delivery",
			"only for requested development handoffs, not ordinary discussion",
			"final answer is delivered automatically",
			"untrusted reference data",
			"current_task",
			"reply_to_request",
			"conversation_attention",
		])
			expect(instructions).toContain(text);
		expect(instructions).not.toContain("conversationId=sourceConversationId");
	});

	it("snapshots trusted role locally and keeps configuration and task data out of policy after revocation", () => {
		const bot = localBot();
		const context = { primary: true };
		const binding = registerBotExecution(bot, undefined, context);
		try {
			const instructions = binding.capability.instructions;
			context.primary = false;
			bot.systemPrompt = "Changed private prompt";
			expect(getBotExecution(binding.clientId)?.instructions).toBe(getBotExecutionInstructions(true));
			expect(binding.capability.bot.systemPrompt).toBe("Private configured system prompt");
			for (const privateText of [
				bot.id,
				bot.name,
				bot.cwd,
				"Private configured system prompt",
				"Changed private prompt",
				"sourceConversationId",
				"attemptId",
				"resultOfTaskId",
			])
				expect(instructions).not.toContain(privateText);
			binding.capability.revoke();
			expect(() => binding.capability.assertActive()).toThrow("revoked");
			expect(binding.capability.instructions).toBe(instructions);
		} finally {
			binding.release();
		}
		expect(() => getBotExecution(binding.clientId)).toThrow("Unregistered");
	});

	it("snapshots group history without allowing later task mutation", () => {
		const groupContext = {
			roomId: "room",
			roomName: "Room",
			members: [{ id: "bot", name: "Bot" }],
			throughMessageId: "m",
			nextBefore: null,
			truncated: false,
			retentionLimit: 500,
			messages: [
				{
					id: "m",
					text: "original",
					sender: { type: "human" as const, id: "u", name: "User" },
					createdAt: 1,
					targetBotIds: ["bot"],
					textStart: 0,
					textEnd: 8,
					fullTextLength: 8,
				},
			],
		};
		const binding = registerBotExecution(localBot(), undefined, { primary: false, groupContext });
		try {
			groupContext.messages[0].text = "changed";
			groupContext.members[0].name = "Changed";
			expect(binding.capability.groupContext?.messages[0].text).toBe("original");
			expect(binding.capability.groupContext?.members[0].name).toBe("Bot");
			expect(Object.isFrozen(binding.capability.groupContext?.messages[0].targetBotIds)).toBe(true);
			expect(Object.isFrozen(binding.capability.groupContext?.members)).toBe(true);
		} finally {
			binding.release();
		}
	});
	it("defaults registrations to non-primary instructions", () => {
		const binding = registerBotExecution(localBot());
		try {
			expect(binding.capability.instructions).toBe(getBotExecutionInstructions(false));
		} finally {
			binding.release();
		}
	});
});
