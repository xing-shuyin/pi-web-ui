import { describe, expect, it, vi } from "vitest";
import { makeSubagentTools, type SubagentToolHost } from "../../server/subagents.js";
import { mergeConversationTools } from "../../server/conversation-tool.js";
import { makeConversationReadTool } from "../../server/conversation-read-tool.js";
import { planModeDenial } from "../../server/plan-mode.js";
import { delegationDenial } from "../../server/delegate-mode.js";
import { goalReviewDenial } from "../../server/goal-review-gate.js";
import { normalizeDisabledAgentTools } from "../../server/tool-manager.js";
import { syncSubagentOverride } from "../../server/tool-overrides.js";
import { normalizeToolPromptOverrides, toolPromptOverrideOf } from "../../server/tool-prompt-overrides.js";

describe("conversation compatibility", () => {
	it("merges transcript inspection and management while forwarding execution context", async () => {
		const management = makeSubagentTools({} as SubagentToolHost);
		const reader = makeConversationReadTool({} as any);
		const manageExecute = vi.fn(async () => ({ content: [], details: {} }));
		const readExecute = vi.fn(async () => ({ content: [], details: {} }));
		management.forEach((tool) => {
			tool.execute = manageExecute;
		});
		reader.execute = readExecute;
		const tools = mergeConversationTools([...management, reader]);
		expect(tools.map((tool) => tool.name)).toEqual(["conversation"]);
		const schema = tools[0].parameters as any;
		expect(schema.properties.action.enum).toEqual(
			expect.arrayContaining(["spawn", "dismiss", "list", "read", "files", "status"]),
		);
		expect(schema.properties.scope.enum).toContain("finished_all");
		const signal = new AbortController().signal;
		const context = {} as any;
		for (const tool of tools) {
			for (const action of ["read", "files", "status", "list"]) {
				const params = { action, id: "c1", path: "session.jsonl", view: "full" };
				await tool.execute("call", params, signal, undefined, context);
				expect(readExecute).toHaveBeenLastCalledWith("call", params, signal, undefined, context);
			}
			for (const params of [
				{ action: "spawn", prompt: "work" },
				{ action: "list", kind: "subagent" },
				{ action: "dismiss", scope: "finished_all" },
			]) {
				await tool.execute("call", params, signal, undefined, context);
				expect(manageExecute).toHaveBeenLastCalledWith("call", params, signal, undefined, context);
			}
		}
	});

	it("keeps the merged schema flat and compact", () => {
		const tools = mergeConversationTools([
			...makeSubagentTools({} as SubagentToolHost),
			makeConversationReadTool({} as any),
		]);
		const schema = tools[0].parameters as any;
		const json = JSON.stringify(schema);
		expect(Object.keys(schema.properties)).toEqual([
			"action",
			"prompt",
			"key",
			"tasks",
			"message",
			"summary",
			"evidence",
			"payload",
			"runId",
			"runIds",
			"toRunId",
			"requestId",
			"type",
			"model",
			"thinking",
			"notifyOnDone",
			"cwd",
			"persist",
			"isolation",
			"kind",
			"scope",
			"force",
			"includePersisted",
			"query",
			"view",
			"last",
			"id",
			"path",
			"offset",
			"limit",
			"maxChars",
			"timeoutSeconds",
		]);
		expect(schema.required).toEqual(["action"]);
		expect(schema.properties.action.enum).toHaveLength(17);
		expect(json).not.toMatch(/"(anyOf|oneOf|allOf|minLength|minItems|maxItems|minimum|maximum)"/);
		expect(json.length).toBeLessThan(2600);
		// 纯文本问答：结构化问题/回答只留在 ask_user_question。
		expect(schema.properties.questions).toBeUndefined();
		expect(schema.properties.answers).toBeUndefined();
		// 联合类型上不写 enum：Moonshot 等严格端点只接受「单一 primitive + enum」，
		// 联合类型带 enum 会让整轮请求 400；约束改由 handler 收口（见 subagents 单测）。
		expect(schema.properties.notifyOnDone.enum).toBeUndefined();
		// 严格校验端点（Moonshot 等）要求 Type.Unsafe 显式声明 type，见 tool-registration 单测。
		expect(schema.properties.notifyOnDone.type).toEqual(["boolean", "string"]);
	});

	it("keeps inspection available without registering dispatch for restricted sessions", () => {
		const tools = mergeConversationTools([makeConversationReadTool({} as any)]);
		expect(tools.map((tool) => tool.name)).toEqual(["conversation"]);
		expect((tools[0].parameters as any).properties.action.enum).toEqual(["list", "read", "files", "status"]);
	});

	it.each(["read", "files", "status", "list"])("allows %s in read-only modes", (action) => {
		for (const gate of [planModeDenial, delegationDenial, goalReviewDenial]) {
			expect(gate("conversation", { action })).toBeUndefined();
			expect(gate("conversation", { action: "spawn" })).toBeDefined();
		}
	});
	it("only registers the conversation tool (the legacy subagent alias is gone)", async () => {
		const listSubagents = vi.fn(() => []);
		const host = { listSubagents, getWatchdogTimeoutMs: () => 120000 } as unknown as SubagentToolHost;
		const tools = makeSubagentTools(host, () => "en");
		expect(tools.map((tool) => tool.name)).toEqual(["conversation"]);
		await tools[0].execute("call", { action: "list" }, undefined, undefined, {} as any);
		expect(listSubagents).toHaveBeenCalledTimes(1);
	});

	it.each(["conversation", "conversation_read", "subagent", "subagent_spawn", "subagent_list"])(
		"disabling %s folds into the conversation switch",
		(name) => {
			expect(normalizeDisabledAgentTools([name])).toEqual(["conversation"]);
			expect(normalizeDisabledAgentTools([name, "conversation"])).toEqual(["conversation"]);
		},
	);

	it("migrates legacy subagent prompt settings onto conversation", () => {
		const old = { description: "legacy preference" };
		const current = { description: "current preference" };
		expect(toolPromptOverrideOf({ subagent: old }, "conversation")).toEqual(old);
		const merged = normalizeToolPromptOverrides({ subagent: old, conversation: current });
		expect(merged.conversation).toEqual(current);
		expect(merged.subagent).toBeUndefined();
	});

	it("restores each first-party entry with the matching name after extension passthrough", () => {
		const tools = makeSubagentTools({} as SubagentToolHost);
		const session = {
			_customTools: [...tools],
			_refreshToolRegistry: vi.fn(),
			extensionRunner: { getAllRegisteredTools: () => tools.map((definition) => ({ definition })) },
		};
		syncSubagentOverride(session as any, true);
		expect(session._customTools).toEqual([]);
		syncSubagentOverride(session as any, false, (name) => tools.find((tool) => tool.name === name)!);
		expect(session._customTools.map((tool) => tool.name)).toEqual(["conversation"]);
	});
});
