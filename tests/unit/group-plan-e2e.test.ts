import { describe, it, expect } from "vitest";
import { registerBotExecution } from "../../server/device-center/bot-execution.js";
import { atomicApproveGroupPlan } from "../../server/device-center/group-plan-guard.js";
import {
	shouldAutoExecuteCanvas,
	isSnapshotApplicableToTask,
	sanitizeBotPreset,
} from "../../web/src/group-capabilities";

describe("group-plan-e2e: End-to-End Hard Guard & Lifecycle Pipeline", () => {
	const baseBot: import("../../server/device-center/bots.js").LocalBot = {
		id: "test-bot-1",
		name: "PlannerBot",
		description: "Plan testing bot",
		systemPrompt: "You plan tasks.",
		cwd: process.cwd(),
		enabled: true,
		revision: 1,
		tools: ["read", "write", "bash", "device_collab", "plan_update"],
		skills: [],
		mcpServers: [],
	};

	it("enforces planOnly hard guard on Bot execution capability", () => {
		const { capability } = registerBotExecution(baseBot, undefined, {
			primary: false,
			planOnly: true,
		});

		expect(capability.allowsToolRegistration("plan_update")).toBe(true);
		expect(capability.allowsTool("plan_update", { steps: [{ id: "1", title: "Inspect", status: "pending" }] })).toBe(
			true,
		);

		expect(capability.allowsTool("read", { path: "package.json" })).toBe(true);

		expect(capability.allowsTool("write", { path: "bad.txt", content: "evil" })).toBe(false);
		expect(capability.allowsTool("edit", { path: "a.ts" })).toBe(false);

		expect(capability.allowsTool("bash", { command: "git status" })).toBe(true);
		expect(capability.allowsTool("bash", { command: "rm -rf /" })).toBe(false);

		expect(capability.allowsToolRegistration("write")).toBe(false);
		expect(capability.allowsToolRegistration("bash")).toBe(true);
		expect(capability.allowsToolRegistration("device_collab")).toBe(true);
		expect(capability.allowsTool("bash", undefined)).toBe(false);
		expect(capability.allowsTool("device_collab", undefined)).toBe(false);
		expect(capability.allowsTool("plan_update", undefined)).toBe(false);

		capability.revoke();
	});

	it("strictly enforces atomic plan approval state machine", () => {
		const draftPlan = {
			state: "draft" as const,
			steps: [{ id: "1", title: "Survey API" }],
		};

		const draftAttempt = atomicApproveGroupPlan(draftPlan, "Alice");
		expect(draftAttempt.ok).toBe(false);

		const readyPlan = {
			state: "ready" as const,
			steps: [{ id: "1", title: "Survey API" }],
			summary: "API survey ready",
		};
		const readyAttempt = atomicApproveGroupPlan(readyPlan, "Alice", 999999);
		expect(readyAttempt.ok).toBe(true);
		if (readyAttempt.ok) {
			expect(readyAttempt.plan.state).toBe("approved");
			expect(readyAttempt.plan.approvedBy).toBe("Alice");
			expect(readyAttempt.plan.approvedAt).toBe(999999);

			const duplicateAttempt = atomicApproveGroupPlan(readyAttempt.plan, "Alice");
			expect(duplicateAttempt.ok).toBe(false);
		}
	});

	it("enforces canvas no-auto-run and preset version locking", () => {
		expect(shouldAutoExecuteCanvas({ graphId: "flow-1", title: "Test", boundAt: Date.now() })).toBe(false);

		expect(isSnapshotApplicableToTask(1, 2)).toBe(false);
		expect(isSnapshotApplicableToTask(2, 2)).toBe(true);
		expect(isSnapshotApplicableToTask(undefined, 2)).toBe(true);

		const clean = sanitizeBotPreset({ name: "SafeBot", token: "secret", tools: ["read"] }, "b1", 1);
		expect((clean as any).token).toBeUndefined();
		expect(clean.name).toBe("SafeBot");
	});
});
