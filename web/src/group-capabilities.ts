/**
 * web/src/group-capabilities.ts
 *
 * 群组协作生态接入客户端辅助定义与类型（计划生命周期、画布显式引用、Bot预设快照净化、通知稳定去重）。
 * 遵循项目规范：无副作用纯函数、明确类型、严格白名单净化、在途任务不热改。
 * 注：写工具硬门禁事实单源位于 server/device-center/group-plan-guard.ts。
 */

// ==========================================
// 1. 群任务计划生命周期定义
// ==========================================

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

/**
 * 校验群任务计划是否已获批允许开始执行
 */
export function canExecuteGroupPlan(plan?: GroupTaskPlan | null): boolean {
	if (!plan) return true; // 非计划模式任务直接可执行
	return plan.state === "approved";
}

/**
 * 客户端请求批准前的预校验（与服务端 atomicApproveGroupPlan 语义一致）
 */
export function validatePlanReadyForApproval(plan?: GroupTaskPlan | null): { ok: boolean; reason?: string } {
	if (!plan) return { ok: false, reason: "No plan" };
	if (plan.state === "draft") return { ok: false, reason: "Plan is still drafting" };
	if (plan.state === "approved") return { ok: false, reason: "Plan already approved" };
	if (plan.state !== "ready") return { ok: false, reason: "Invalid plan state" };
	if (!plan.steps || plan.steps.length === 0) return { ok: false, reason: "Plan has no steps" };
	return { ok: true };
}

// ==========================================
// 2. 画布协同（Canvas）引用与显式启动硬边界
// ==========================================

export interface GroupCanvasRef {
	graphId: string;
	title: string;
	boundAt: number;
}

/**
 * 构建群聊画布引用元数据
 */
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

/**
 * 画布引用绝不能自动触发执行的权威判定
 */
export function shouldAutoExecuteCanvas(_ref: GroupCanvasRef): false {
	return false;
}

/**
 * 构造显式启动画布的请求载荷（只有用户在群操作栏显式点击后才发出）
 */
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

// ==========================================
// 3. Bot 预设白名单净化与版本化快照
// ==========================================

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

/**
 * 净化并生成 Bot 预设的版本化安全快照
 * 严格丢弃任何未认可的字段，绝不把主会话的私有/特权运行设置泄漏给 Bot
 */
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

/**
 * 校验快照版本与在途任务的兼容性：在途任务锁定创建时刻的版本，禁止热改
 */
export function isSnapshotApplicableToTask(taskSnapshotRevision: number | undefined, currentRevision: number): boolean {
	if (taskSnapshotRevision === undefined || taskSnapshotRevision === null) {
		return true; // 尚未绑定快照的任务可绑定
	}
	return taskSnapshotRevision === currentRevision;
}

// ==========================================
// 4. 通知稳定去重机制
// ==========================================

export type GroupNotificationKind = "interaction" | "completed" | "failed";

export interface GroupNotificationRecord {
	key: string;
	kind: GroupNotificationKind;
	roomId: string;
	taskId: string;
	detailId?: string;
	seenAt: number;
}

/**
 * 生成稳定的通知去重 Key
 * 保证 WebSocket 重连或状态重放时不出现重复弹窗
 */
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

/**
 * 通知去重跟踪器（带容量上限，防止长跑内存溢出）
 */
export class GroupNotificationTracker {
	private readonly seen = new Map<string, GroupNotificationRecord>();
	private readonly maxEntries: number;

	constructor(maxEntries = 500) {
		this.maxEntries = Math.max(1, maxEntries);
	}

	/**
	 * 检查并标记通知是否为首次发生（未见过则记录并返回 true，已见过返回 false）
	 */
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
