import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGENT_TOOL_CATALOG, COMMUNICATE_TOOL_NAME, normalizeDisabledAgentTools } from "../../server/tool-manager.js";
import { subagentSecurityDenial } from "../../server/subagent-security-gate.js";
import { planModeDenial, readOnlyToolCallAllowed } from "../../server/plan-mode.js";
import { delegationDenial } from "../../server/delegate-mode.js";
import { goalReviewDenial } from "../../server/goal-review-gate.js";
import { evaluateSandboxJail, withSandboxJailGate } from "../../server/sandbox-service.js";
import type { SandboxInfo } from "../../server/protocol.js";

const actions = ["read", "send", "request", "reply", "escalate"];
const root = mkdtempSync(join(tmpdir(), "communicate-gates-"));
const sandbox = { id: "communication-boundary", path: root } as SandboxInfo;
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("communication catalog", () => {
	it("has an independent default-on switch and localized help keys", () => {
		const entry = AGENT_TOOL_CATALOG.find((tool) => tool.name === COMMUNICATE_TOOL_NAME)!;
		expect(entry).toMatchObject({ group: "subagent", defaultOn: true, dshVisible: false });
		expect(COMMUNICATE_TOOL_NAME).toBe("communicate");
		expect(entry.descKey).toBe("communicateEnabledDesc");
		expect(entry.offHintKey).toBe("communicateOffHint");
		expect(entry.descKey).not.toMatch(/[\u3400-\u9fff]/);
		expect(entry.descKey!.length).toBeLessThan(600);
		expect(normalizeDisabledAgentTools([COMMUNICATE_TOOL_NAME])).toEqual([COMMUNICATE_TOOL_NAME]);
		expect(normalizeDisabledAgentTools(["conversation"])).not.toContain(COMMUNICATE_TOOL_NAME);
	});
});

describe.each(["readonly", "verify"] as const)("restricted %s communication", (mode) => {
	it.each(actions)("permits %s without granting execution capabilities", (action) => {
		expect(subagentSecurityDenial(mode, "communicate", { action })).toBeUndefined();
		expect(subagentSecurityDenial(mode, "write", { path: "out.txt" })).toBeDefined();
		expect(subagentSecurityDenial(mode, "conversation", { action: "spawn" })).toBeDefined();
	});
	it("allows completion for the conversation tool", () => {
		for (const name of ["conversation"])
			expect(subagentSecurityDenial(mode, name, { action: "complete" })).toBeUndefined();
	});
	it("permits inbox reads only when the communication tool is allowed", () => {
		expect(
			subagentSecurityDenial(mode, COMMUNICATE_TOOL_NAME, { action: "read" }, new Set([COMMUNICATE_TOOL_NAME])),
		).toBeUndefined();
		expect(subagentSecurityDenial(mode, COMMUNICATE_TOOL_NAME, { action: "read" }, new Set(["read"]))?.kind).toBe(
			"not-allowed-tool",
		);
	});
	it("preserves explicit tool allowlists", () => {
		expect(subagentSecurityDenial(mode, "communicate", { action: "reply" }, new Set(["read"]))?.kind).toBe(
			"not-allowed-tool",
		);
		expect(subagentSecurityDenial(mode, "communicate", { action: "reply" }, new Set(["communicate"]))).toBeUndefined();
	});
	it.each([undefined, null, "spawn", "SEND", " reply "])("rejects unknown action %s", (action) => {
		expect(subagentSecurityDenial(mode, "communicate", { action })).toBeDefined();
	});
});

describe.each([
	["plan", planModeDenial],
	["delegate", delegationDenial],
	["goal review", goalReviewDenial],
] as const)("%s communication gate", (_name, denial) => {
	it.each([...actions, "complete", undefined])("blocks action %s even when it carries a reply", (action) => {
		expect(denial("communicate", { action, message: "Write the requested file", requestId: "pending" })).toBeDefined();
		expect(readOnlyToolCallAllowed("communicate", { action })).toBe(false);
	});
});

describe("sandbox communication gate", () => {
	it.each(actions)("recognizes trusted host action %s", (action) => {
		expect(evaluateSandboxJail(sandbox, "communicate", { action }, root, { trustedTool: true })).toBeNull();
		expect(evaluateSandboxJail(sandbox, "communicate", { action, trustedTool: true }, root)).not.toBeNull();
	});
	it.each([undefined, "spawn", "complete", "SEND"])("rejects unknown action %s", (action) => {
		expect(evaluateSandboxJail(sandbox, "communicate", { action }, root, { trustedTool: true })).not.toBeNull();
	});
	it("rejects a workspace outside the sandbox before communication", () => {
		expect(
			evaluateSandboxJail(sandbox, "communicate", { action: "send" }, tmpdir(), { trustedTool: true }),
		).not.toBeNull();
	});
	it("propagates the host boundary rejection for every action", async () => {
		const tool = withSandboxJailGate(
			{
				name: "communicate",
				execute: async () => {
					throw new Error("Different sandbox identity");
				},
			} as any,
			() => sandbox,
			() => root,
			() => "en",
			{ trustedTool: true },
		);
		for (const action of actions)
			await expect(tool.execute("call", { action }, undefined, undefined, {} as any)).rejects.toThrow(
				"Different sandbox identity",
			);
	});
});
