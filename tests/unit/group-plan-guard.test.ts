import { describe, it, expect } from "vitest";
import {
	checkGroupTaskPlanGuard,
	atomicApproveGroupPlan,
	isGroupToolForbiddenInPlanCatalog,
	type GroupTaskPlanRecord,
} from "../../server/device-center/group-plan-guard.js";

describe("group-plan-guard: Tool Calling Hard Guard", () => {
	it("allows all tools when planOnly is false", () => {
		expect(checkGroupTaskPlanGuard("write", { path: "a.ts" }, false)).toBeUndefined();
		expect(checkGroupTaskPlanGuard("bash", { command: "rm -rf /" }, false)).toBeUndefined();
		expect(checkGroupTaskPlanGuard("device_collab", { action: "sync_files" }, false)).toBeUndefined();
	});

	it("allows plan_update specifically to build plan steps", () => {
		expect(
			checkGroupTaskPlanGuard("plan_update", { steps: [{ id: "1", title: "Inspect", status: "pending" }] }, true),
		).toBeUndefined();
		expect(checkGroupTaskPlanGuard("plan_update", { steps: [] }, true)).toBeDefined();
	});

	it("keeps catalog filtering separate from execution with missing parameters", () => {
		for (const name of ["unknown_plugin", "bash", "device_collab", "conversation", "terminal", "plan_update"]) {
			expect(isGroupToolForbiddenInPlanCatalog(name, true)).toBe(false);
			expect(checkGroupTaskPlanGuard(name, undefined, true)).toBeDefined();
		}
		for (const name of ["write", "edit", "codemode", "eval", "schedule", "communicate"]) {
			expect(isGroupToolForbiddenInPlanCatalog(name, true)).toBe(true);
		}
	});

	it("blocks write tools and terminal write tools under planOnly", () => {
		const writeDenial = checkGroupTaskPlanGuard("write", { path: "test.txt" }, true);
		expect(writeDenial).toBeDefined();
		expect(writeDenial?.kind).toBe("write-tool");

		const termDenial = checkGroupTaskPlanGuard("terminal_input", { text: "abc" }, true);
		expect(termDenial).toBeDefined();
		expect(termDenial?.kind).toBe("write-tool");
	});

	it("discriminates device_collab actions: allows read-only and blocks mutating actions", () => {
		// Read-only actions allowed
		expect(checkGroupTaskPlanGuard("device_collab", { action: "read_history" }, true)).toBeUndefined();
		expect(checkGroupTaskPlanGuard("device_collab", { action: "context_metrics" }, true)).toBeUndefined();
		expect(checkGroupTaskPlanGuard("device_collab", { action: "execution_guide" }, true)).toBeUndefined();

		// Mutating / dispatch actions blocked
		const syncDenial = checkGroupTaskPlanGuard("device_collab", { action: "sync_files" }, true);
		expect(syncDenial).toBeDefined();
		expect(syncDenial?.kind).toBe("write-tool");

		const deliverDenial = checkGroupTaskPlanGuard("device_collab", { action: "conversation_deliver" }, true);
		expect(deliverDenial).toBeDefined();
	});

	it("checks bash commands: allows read-only and blocks mutating/syntax", () => {
		expect(checkGroupTaskPlanGuard("bash", { command: "git status" }, true)).toBeUndefined();
		expect(checkGroupTaskPlanGuard("bash", { command: "ls -la" }, true)).toBeUndefined();

		const rmDenial = checkGroupTaskPlanGuard("bash", { command: "rm -rf ./tmp" }, true);
		expect(rmDenial).toBeDefined();
		expect(rmDenial?.kind).toBe("bash");
	});

	it("fails closed on unknown tools (e.g. plugins) in plan mode", () => {
		const unknownDenial = checkGroupTaskPlanGuard("custom_unknown_tool_xyz", {}, true);
		expect(unknownDenial).toBeDefined();
		expect(["write-tool", "bypass-tool"]).toContain(unknownDenial?.kind);
	});
});

describe("group-plan-guard: Atomic Plan Approval Machine", () => {
	it("approves ready plan with steps atomically", () => {
		const readyPlan: GroupTaskPlanRecord = {
			state: "ready",
			steps: [{ id: "1", title: "Survey architecture" }],
			summary: "Plan ready",
		};

		const res = atomicApproveGroupPlan(readyPlan, "alice", 12345678);
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.plan.state).toBe("approved");
			expect(res.plan.approvedBy).toBe("alice");
			expect(res.plan.approvedAt).toBe(12345678);
		}
	});

	it("rejects draft plans, empty steps, and duplicate approvals", () => {
		const draftPlan: GroupTaskPlanRecord = {
			state: "draft",
			steps: [{ id: "1", title: "Still drafting" }],
		};
		expect(atomicApproveGroupPlan(draftPlan).ok).toBe(false);

		const emptyPlan: GroupTaskPlanRecord = {
			state: "ready",
			steps: [],
		};
		expect(atomicApproveGroupPlan(emptyPlan).ok).toBe(false);

		const approvedPlan: GroupTaskPlanRecord = {
			state: "approved",
			steps: [{ id: "1", title: "Done" }],
		};
		expect(atomicApproveGroupPlan(approvedPlan).ok).toBe(false);
	});
});
