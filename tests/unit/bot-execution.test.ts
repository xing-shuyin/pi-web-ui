import { describe, expect, it } from "vitest";
import {
	botExecutionMessageAllowed,
	getBotExecution,
	registerBotExecution,
} from "../../server/device-center/bot-execution.js";
import type { LocalBot } from "../../server/device-center/bots.js";
import { resolve } from "node:path";
import { ClientSession } from "../../server/agent-service.js";
import { fakeClientSession } from "../helpers/fake-session.js";

const bot = (): LocalBot => ({
	id: "bot",
	name: "Bot",
	description: "",
	systemPrompt: "",
	cwd: resolve("."),
	tools: ["read", "device_collab", "conversation", "delegate_task", "codemode", "worktree"],
	skills: ["safe"],
	mcpServers: [],
	enabled: true,
	revision: 2,
});

describe("Bot execution capabilities", () => {
	it("permits restoration only for the exact locally authorized path while active", () => {
		const path = resolve("transcript.jsonl");
		const binding = registerBotExecution(bot(), path);
		try {
			expect(botExecutionMessageAllowed(binding.clientId, "switch_session", { path })).toBe(true);
			expect(botExecutionMessageAllowed(binding.clientId, "switch_session")).toBe(false);
			expect(botExecutionMessageAllowed(binding.clientId, "switch_session", { path: resolve("other.jsonl") })).toBe(
				false,
			);
			binding.capability.revoke();
			expect(botExecutionMessageAllowed(binding.clientId, "switch_session", { path })).toBe(false);
		} finally {
			binding.release();
		}
		const fresh = registerBotExecution(bot());
		try {
			expect(botExecutionMessageAllowed(fresh.clientId, "switch_session", { path })).toBe(false);
		} finally {
			fresh.release();
		}
	});
	it("captures immutable policy and a local default model exactly once", () => {
		const config = bot();
		const binding = registerBotExecution(config);
		try {
			config.tools.push("bash");
			config.skills.push("unsafe");
			expect(binding.capability.allowsTool("bash")).toBe(false);
			expect(binding.capability.filterSkills([{ name: "safe" }, { name: "unsafe" }])).toEqual([{ name: "safe" }]);
			expect(binding.capability.captureModel("provider/default")).toEqual({ provider: "provider", modelId: "default" });
			expect(binding.capability.captureModel("other/ui-active")).toEqual({ provider: "provider", modelId: "default" });
		} finally {
			binding.release();
		}
	});

	it("requires an explicit default when no model is configured", () => {
		const binding = registerBotExecution(bot());
		try {
			expect(() => binding.capability.captureModel(undefined)).toThrow("explicit local default");
		} finally {
			binding.release();
		}
	});

	it("keeps a configured model fixed and authorizes tools solely by the whitelist", () => {
		const binding = registerBotExecution({ ...bot(), model: { provider: "p", modelId: "fixed" } });
		try {
			expect(binding.capability.captureModel("other/default")).toEqual({ provider: "p", modelId: "fixed" });
			expect(binding.capability.allowsTool("device_collab")).toBe(true);
			for (const name of ["conversation", "delegate_task", "codemode", "worktree"])
				expect(binding.capability.allowsTool(name)).toBe(true);
			expect(binding.capability.allowsTool("mcp_manage")).toBe(false);
		} finally {
			binding.release();
		}
	});

	it("denies settings, history, engine and execution bypass commands", () => {
		const binding = registerBotExecution(bot());
		try {
			for (const type of ["hello", "new_chat", "prompt", "get_state", "abort"])
				expect(botExecutionMessageAllowed(binding.clientId, type)).toBe(true);
			for (const type of [
				"set_settings",
				"set_cwd",
				"set_model",
				"set_engine",
				"terminal_create",
				"open_session",
				"take_over_conversation",
			])
				expect(botExecutionMessageAllowed(binding.clientId, type)).toBe(false);
			binding.capability.revoke();
			expect(botExecutionMessageAllowed(binding.clientId, "prompt")).toBe(false);
			expect(botExecutionMessageAllowed(binding.clientId, "abort")).toBe(true);
			expect(botExecutionMessageAllowed(binding.clientId, "get_state")).toBe(true);
		} finally {
			binding.release();
		}
		expect(() => getBotExecution(binding.clientId)).toThrow("Unregistered");
		expect(() => binding.capability.assertActive()).toThrow("revoked");
		expect(botExecutionMessageAllowed("ordinary-ui", "set_model")).toBe(true);
	});

	it("refuses transfer before touching source or destination runtime state", async () => {
		const binding = registerBotExecution(bot());
		const client = fakeClientSession() as ClientSession;
		Object.assign(client, { botExecution: binding.capability });
		try {
			await expect(client.detachTakeoverConversations(["c1"])).resolves.toEqual({ ok: false, reason: "missing" });
			expect(() => client.insertTakeoverConvs({} as any)).toThrow("cannot receive");
		} finally {
			binding.release();
		}
	});
});
