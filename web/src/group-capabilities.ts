export type GroupTaskPlanState = "draft" | "ready" | "approved";

export interface GroupPlanStep {
	id: string;
	title: string;
	status?: "pending" | "in_progress" | "done" | "failed";
	description?: string;
}

export interface GroupTaskPlan {
	state: GroupTaskPlanState;
	steps: GroupPlanStep[];
	summary?: string;
	approvedAt?: number;
	approvedBy?: string;
}

export function canExecuteGroupPlan(plan?: GroupTaskPlan | null): boolean {
	if (!plan) return true;
	return plan.state === "approved";
}

export function validatePlanReadyForApproval(plan?: GroupTaskPlan | null): { ok: boolean; reason?: string } {
	if (!plan) return { ok: false, reason: "No plan" };
	if (plan.state === "draft") return { ok: false, reason: "Plan is still drafting" };
	if (plan.state === "approved") return { ok: false, reason: "Plan already approved" };
	if (plan.state !== "ready") return { ok: false, reason: "Invalid plan state" };
	if (!plan.steps || plan.steps.length === 0) return { ok: false, reason: "Plan has no steps" };
	return { ok: true };
}

export interface GroupCanvasRef {
	graphId: string;
	title: string;
	boundAt: number;
}

export function createGroupCanvasRef(graphId: string, title?: string, boundAt: number = Date.now()): GroupCanvasRef {
	const cleanGraphId = (graphId || "").trim();
	if (!cleanGraphId) {
		throw new Error("graphId cannot be empty");
	}
	return {
		graphId: cleanGraphId,
		title: (title || cleanGraphId).trim(),
		boundAt,
	};
}

export function shouldAutoExecuteCanvas(_ref: GroupCanvasRef): false {
	return false;
}

export function createCanvasLaunchPayload(
	ref: GroupCanvasRef,
	roomId: string,
	taskId?: string,
): { action: "run_all"; graphId: string; roomId: string; taskId?: string } {
	return {
		action: "run_all",
		graphId: ref.graphId,
		roomId,
		...(taskId ? { taskId } : {}),
	};
}

export interface BotPresetSnapshot {
	botId: string;
	revision: number;
	name: string;
	model?: {
		provider: string;
		modelId: string;
	};
	toolWhitelist: string[];
	customInstructions?: string;
	capturedAt: number;
}

const SAFE_PRESET_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function sanitizeBotPreset(
	raw: unknown,
	botId: string,
	revision: number,
	capturedAt: number = Date.now(),
): BotPresetSnapshot {
	if (!raw || typeof raw !== "object") {
		return {
			botId,
			revision,
			name: botId,
			toolWhitelist: [],
			capturedAt,
		};
	}

	const source = raw as Record<string, unknown>;
	const name = typeof source.name === "string" && source.name.trim() ? source.name.trim().slice(0, 80) : botId;

	let model: { provider: string; modelId: string } | undefined;
	if (source.model && typeof source.model === "object") {
		const m = source.model as Record<string, unknown>;
		if (typeof m.provider === "string" && typeof m.modelId === "string" && m.provider && m.modelId) {
			model = {
				provider: m.provider.trim().slice(0, 60),
				modelId: m.modelId.trim().slice(0, 100),
			};
		}
	}

	const toolWhitelist: string[] = [];
	if (Array.isArray(source.toolWhitelist)) {
		for (const item of source.toolWhitelist) {
			if (typeof item === "string" && SAFE_PRESET_TOOL_NAME_RE.test(item.trim())) {
				toolWhitelist.push(item.trim());
			}
		}
	}

	let customInstructions: string | undefined;
	if (typeof source.customInstructions === "string") {
		const trimmed = source.customInstructions.trim();
		if (trimmed) {
			customInstructions = trimmed.slice(0, 16_000);
		}
	}

	return {
		botId,
		revision: Math.max(1, Math.floor(revision)),
		name,
		...(model ? { model } : {}),
		toolWhitelist: [...new Set(toolWhitelist)],
		...(customInstructions ? { customInstructions } : {}),
		capturedAt,
	};
}

export function isSnapshotApplicableToTask(taskSnapshotRevision: number | undefined, currentRevision: number): boolean {
	if (taskSnapshotRevision === undefined || taskSnapshotRevision === null) {
		return true;
	}
	return taskSnapshotRevision === currentRevision;
}

export type GroupNotificationKind = "interaction" | "completed" | "failed";

export interface GroupNotificationRecord {
	key: string;
	kind: GroupNotificationKind;
	roomId: string;
	taskId: string;
	detailId?: string;
	seenAt: number;
}

export function createStableNotificationKey(
	kind: GroupNotificationKind,
	roomId: string,
	taskId: string,
	detailId?: string,
): string {
	const parts = ["group-notify", kind, roomId.trim(), taskId.trim()];
	if (detailId && detailId.trim()) {
		parts.push(detailId.trim());
	}
	return parts.join(":");
}

export class GroupNotificationTracker {
	private readonly seen = new Map<string, GroupNotificationRecord>();
	private readonly maxEntries: number;

	constructor(maxEntries = 500) {
		this.maxEntries = Math.max(1, maxEntries);
	}

	checkAndRecord(
		kind: GroupNotificationKind,
		roomId: string,
		taskId: string,
		detailId?: string,
		now: number = Date.now(),
	): boolean {
		const key = createStableNotificationKey(kind, roomId, taskId, detailId);
		if (this.seen.has(key)) {
			return false;
		}

		if (this.seen.size >= this.maxEntries) {
			const oldestKey = this.seen.keys().next().value;
			if (oldestKey) {
				this.seen.delete(oldestKey);
			}
		}

		this.seen.set(key, {
			key,
			kind,
			roomId,
			taskId,
			detailId,
			seenAt: now,
		});
		return true;
	}

	hasSeen(kind: GroupNotificationKind, roomId: string, taskId: string, detailId?: string): boolean {
		const key = createStableNotificationKey(kind, roomId, taskId, detailId);
		return this.seen.has(key);
	}

	clear(): void {
		this.seen.clear();
	}

	size(): number {
		return this.seen.size;
	}
}
