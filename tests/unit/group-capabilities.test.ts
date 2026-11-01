import { describe, it, expect } from "vitest";
import {
	canExecuteGroupPlan,
	validatePlanReadyForApproval,
	createGroupCanvasRef,
	shouldAutoExecuteCanvas,
	createCanvasLaunchPayload,
	sanitizeBotPreset,
	isSnapshotApplicableToTask,
	createStableNotificationKey,
	GroupNotificationTracker,
} from "../../web/src/group-capabilities";

describe("group-capabilities: Group Task Plan Lifecycle", () => {
	it("canExecuteGroupPlan returns true only when plan is approved or absent", () => {
		expect(canExecuteGroupPlan(null)).toBe(true);
		expect(canExecuteGroupPlan(undefined)).toBe(true);
		expect(canExecuteGroupPlan({ state: "draft", steps: [] })).toBe(false);
		expect(canExecuteGroupPlan({ state: "ready", steps: [{ id: "1", title: "Step 1" }] })).toBe(false);
		expect(canExecuteGroupPlan({ state: "approved", steps: [{ id: "1", title: "Step 1" }] })).toBe(true);
	});

	it("validatePlanReadyForApproval checks state and steps strictly", () => {
		expect(validatePlanReadyForApproval(null).ok).toBe(false);
		expect(validatePlanReadyForApproval({ state: "draft", steps: [{ id: "1", title: "S1" }] }).ok).toBe(false);
		expect(validatePlanReadyForApproval({ state: "approved", steps: [{ id: "1", title: "S1" }] }).ok).toBe(false);
		expect(validatePlanReadyForApproval({ state: "ready", steps: [] }).ok).toBe(false);
		expect(validatePlanReadyForApproval({ state: "ready", steps: [{ id: "1", title: "S1" }] }).ok).toBe(true);
	});
});

describe("group-capabilities: Canvas Binding & Explicit Launch Boundary", () => {
	it("createGroupCanvasRef rejects empty graphId and trims values", () => {
		expect(() => createGroupCanvasRef("")).toThrow();
		const ref = createGroupCanvasRef("  graph-123  ", " My Workflow ");
		expect(ref.graphId).toBe("graph-123");
		expect(ref.title).toBe("My Workflow");
		expect(ref.boundAt).toBeGreaterThan(0);
	});

	it("shouldAutoExecuteCanvas always returns false (hard invariant)", () => {
		const ref = createGroupCanvasRef("graph-1");
		expect(shouldAutoExecuteCanvas(ref)).toBe(false);
	});

	it("createCanvasLaunchPayload generates explicit run_all request", () => {
		const ref = createGroupCanvasRef("graph-1", "Flow");
		const payload = createCanvasLaunchPayload(ref, "room-abc", "task-xyz");
		expect(payload).toEqual({
			action: "run_all",
			graphId: "graph-1",
			roomId: "room-abc",
			taskId: "task-xyz",
		});
	});
});

describe("group-capabilities: Bot Preset Snapshot & Isolation", () => {
	it("sanitizeBotPreset strips unallowed private fields and keeps whitelist only", () => {
		const dirtyRaw = {
			name: "  DevBot  ",
			privateApiKey: "secret-key-leaked",
			adminPrivilege: true,
			internalPath: "/root/private",
			model: {
				provider: "openai",
				modelId: "gpt-4o",
				temperature: 0.7,
			},
			toolWhitelist: ["read", "grep", "write", "malicious/tool", ""],
			customInstructions: "Follow instructions strictly.",
		};

		const snapshot = sanitizeBotPreset(dirtyRaw, "bot-1", 1);
		expect(snapshot.botId).toBe("bot-1");
		expect(snapshot.revision).toBe(1);
		expect(snapshot.name).toBe("DevBot");
		expect(snapshot.model).toEqual({ provider: "openai", modelId: "gpt-4o" });
		expect(snapshot.toolWhitelist).toEqual(["read", "grep", "write"]);
		expect(snapshot.customInstructions).toBe("Follow instructions strictly.");
		expect((snapshot as any).privateApiKey).toBeUndefined();
		expect((snapshot as any).adminPrivilege).toBeUndefined();
	});

	it("isSnapshotApplicableToTask protects active running tasks from hot reload", () => {
		// New task with no snapshot revision yet is applicable
		expect(isSnapshotApplicableToTask(undefined, 2)).toBe(true);
		// In-flight task locked to revision 1 rejects revision 2
		expect(isSnapshotApplicableToTask(1, 2)).toBe(false);
		// Matching revision is allowed
		expect(isSnapshotApplicableToTask(2, 2)).toBe(true);
	});
});

describe("group-capabilities: Stable Notification Tracker", () => {
	it("generates deterministic keys", () => {
		const key1 = createStableNotificationKey("interaction", "room-1", "task-1", "req-1");
		const key2 = createStableNotificationKey("interaction", "room-1", "task-1", "req-1");
		expect(key1).toBe(key2);
		expect(key1).toBe("group-notify:interaction:room-1:task-1:req-1");
	});

	it("deduplicates notifications and enforces maxEntries capacity", () => {
		const tracker = new GroupNotificationTracker(3);
		expect(tracker.checkAndRecord("interaction", "r1", "t1", "req1")).toBe(true);
		expect(tracker.checkAndRecord("interaction", "r1", "t1", "req1")).toBe(false);
		expect(tracker.hasSeen("interaction", "r1", "t1", "req1")).toBe(true);

		// Fill capacity
		tracker.checkAndRecord("completed", "r1", "t2");
		tracker.checkAndRecord("failed", "r1", "t3");
		expect(tracker.size()).toBe(3);

		// Adding 4th item evicts the oldest (LRU / FIFO eviction)
		tracker.checkAndRecord("completed", "r1", "t4");
		expect(tracker.size()).toBe(3);
		expect(tracker.hasSeen("interaction", "r1", "t1", "req1")).toBe(false);
		expect(tracker.hasSeen("completed", "r1", "t4")).toBe(true);
	});
});
