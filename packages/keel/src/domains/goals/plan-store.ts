import { readFileSync } from "node:fs";
import type { PlanState, PlanStep, PlanStepStatus } from "../../protocol.js";
import { createSerializedJsonWriter, type SerializedJsonWriter } from "../../serialized-json-writer.js";

const VALID_STATUSES = new Set<PlanStepStatus>(["pending", "in_progress", "done", "failed"]);
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 1000;

export interface PlanStoreOptions {
	/** `plans.json` 的落点（宿主 `stateStore.dataDir` 下）；缺省 = 只存内存。 */
	file?: string;
	now?(): number;
}

/**
 * 计划状态的唯一所有者（老树 `PlanManager` 的口径照搬，只换掉「会话绑定」的入口）：
 * 键是**会话 id**（`c-1` 这类对话 id 跨重启就没了，只做本进程的别名），
 * `plans.json` 是可重建的缓存投影，落盘走串行队列、不阻塞事件循环。
 */
export class PlanStore {
	private readonly writer: SerializedJsonWriter | undefined;
	private readonly now: () => number;
	private readonly bySession = new Map<string, PlanState>();
	private readonly byConversation = new Map<string, PlanState>();

	constructor(options: PlanStoreOptions = {}) {
		this.now = options.now ?? Date.now;
		this.writer = options.file ? createSerializedJsonWriter(options.file, { label: "plans.json" }) : undefined;
		if (options.file) this.load(options.file);
	}

	private load(file: string): void {
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		} catch {
			// 没有 / 读不动 / 不是 JSON：都当空缓存（投影可重建，不值得让进程起不来）。
			return;
		}
		for (const [key, value] of Object.entries(raw)) {
			if (!value || typeof value !== "object") continue;
			if (!Array.isArray((value as { steps?: unknown }).steps)) continue;
			this.bySession.set(key, value as PlanState);
		}
	}

	/**
	 * 写盘快照：只有「认得会话 id」的计划才落盘（对话 id 是进程内别名，写进去就是垃圾）。
	 * `write()` 排队即返回：这份文件是缓存，丢一次能从下一轮的帧重建。
	 */
	private save(): void {
		if (!this.writer) return;
		const snapshot: Record<string, PlanState> = {};
		for (const [key, plan] of this.bySession) snapshot[key] = { ...plan };
		this.writer.write(snapshot);
	}

	/** 等排队中的写入落定（测试 / 关停用）。 */
	async flush(): Promise<void> {
		await this.writer?.flush();
	}

	private remember(conversationId: string, sessionId: string | undefined, plan: PlanState): PlanState {
		this.byConversation.set(conversationId, plan);
		if (sessionId) {
			this.bySession.set(sessionId, plan);
			this.save();
		}
		return plan;
	}

	getPlan(conversationId: string, sessionId?: string): PlanState | null {
		const byConv = this.byConversation.get(conversationId);
		if (byConv) return byConv;
		const key = sessionId ?? conversationId;
		const plan = this.bySession.get(key);
		if (plan) this.byConversation.set(conversationId, plan);
		return plan ?? null;
	}

	/** 整份替换（面板 `plan_update` 与工具链共用）：归一化后 `activeStepId` 缺省取第一个在跑的步骤。 */
	setPlan(conversationId: string, steps: PlanStep[], activeStepId?: string | null, sessionId?: string): PlanState {
		const normalized: PlanStep[] = (Array.isArray(steps) ? steps : []).map((step, index) => {
			const status = VALID_STATUSES.has(step.status) ? step.status : "pending";
			const title = String(step.title ?? "").slice(0, TITLE_MAX);
			const description = String(step.description ?? "").slice(0, DESCRIPTION_MAX);
			return {
				id: String(step.id || `step-${index + 1}`),
				title,
				status,
				...(description ? { description } : {}),
			};
		});
		let effectiveActiveId = activeStepId;
		if (effectiveActiveId === undefined) {
			const running = normalized.find((step) => step.status === "in_progress");
			effectiveActiveId = running ? running.id : null;
		}
		const plan: PlanState = { steps: normalized, activeStepId: effectiveActiveId, updatedAt: this.now() };
		if (sessionId) {
			if (normalized.length === 0) this.bySession.delete(sessionId);
			else this.bySession.set(sessionId, plan);
		}
		this.byConversation.set(conversationId, plan);
		this.save();
		return plan;
	}

	updateStep(conversationId: string, stepId: string, patch: Partial<PlanStep>, sessionId?: string): PlanState | null {
		const current = this.getPlan(conversationId, sessionId);
		if (!current) return null;
		const index = current.steps.findIndex((step) => step.id === stepId);
		if (index === -1) return null;
		const before = current.steps[index];
		const status = patch.status && VALID_STATUSES.has(patch.status) ? patch.status : before.status;
		const { id: _ignored, ...rest } = patch;
		const next: PlanStep = {
			...before,
			...rest,
			status,
			title: String(rest.title ?? before.title ?? "").slice(0, TITLE_MAX),
		};
		const description = String(rest.description ?? before.description ?? "").slice(0, DESCRIPTION_MAX);
		if (description) next.description = description;
		else delete next.description;
		const steps = [...current.steps];
		steps[index] = next;
		// 状态换了就跟一次焦点：在跑 = 接棒；离开焦点 = 往后找第一个还没完成的。
		let activeStepId = current.activeStepId;
		if (patch.status === "in_progress") activeStepId = stepId;
		else if (current.activeStepId === stepId && patch.status) {
			activeStepId = steps.find((step) => step.status === "pending" || step.status === "in_progress")?.id ?? null;
		}
		return this.remember(conversationId, sessionId, { steps, activeStepId, updatedAt: this.now() });
	}

	deleteStep(conversationId: string, stepId: string, sessionId?: string): PlanState | null {
		const current = this.getPlan(conversationId, sessionId);
		if (!current) return null;
		if (!current.steps.some((step) => step.id === stepId)) return current;
		const steps = current.steps.filter((step) => step.id !== stepId);
		const activeStepId =
			current.activeStepId === stepId
				? (steps.find((step) => step.status === "pending" || step.status === "in_progress")?.id ?? null)
				: current.activeStepId;
		return this.remember(conversationId, sessionId, { steps, activeStepId, updatedAt: this.now() });
	}

	addStep(conversationId: string, step: PlanStep, afterStepId?: string, sessionId?: string): PlanState | null {
		const current = this.getPlan(conversationId, sessionId);
		const existing = current?.steps ?? [];
		const status = step.status && VALID_STATUSES.has(step.status) ? step.status : "pending";
		const description = String(step.description ?? "").slice(0, DESCRIPTION_MAX);
		const added: PlanStep = {
			id: String(step.id || `step-${this.now()}`),
			title: String(step.title ?? "").slice(0, TITLE_MAX),
			status,
			...(description ? { description } : {}),
		};
		const at = afterStepId ? existing.findIndex((item) => item.id === afterStepId) : -1;
		const steps = at === -1 ? [...existing, added] : [...existing.slice(0, at + 1), added, ...existing.slice(at + 1)];
		const activeStepId = current?.activeStepId ?? (added.status === "in_progress" ? added.id : null);
		return this.remember(conversationId, sessionId, { steps, activeStepId, updatedAt: this.now() });
	}

	/** 工具上下文里的那份人读摘要（老树 `describePlan` 逐字同形）。 */
	describePlan(conversationId: string, sessionId?: string): string {
		const plan = this.getPlan(conversationId, sessionId);
		if (!plan || plan.steps.length === 0) return "No active plan.";
		const done = plan.steps.filter((step) => step.status === "done").length;
		const lines = [`Plan Progress: ${done}/${plan.steps.length} completed`];
		plan.steps.forEach((step, index) => {
			const icon =
				step.status === "done"
					? "[x]"
					: step.status === "in_progress"
						? "[>]"
						: step.status === "failed"
							? "[!]"
							: "[ ]";
			const current = step.id === plan.activeStepId ? " (current)" : "";
			lines.push(`${icon} ${index + 1}. ${step.title}${current}`);
			if (step.description) lines.push(`     ${step.description}`);
		});
		return lines.join("\n");
	}
}
