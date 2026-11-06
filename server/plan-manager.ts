import { readFileSync } from "node:fs";
import { writeJsonAtomicSync } from "./atomic-file.js";
import type { PlanState, PlanStep, PlanStepStatus } from "./protocol.js";

const VALID_STATUSES = new Set<PlanStepStatus>(["pending", "in_progress", "done", "failed"]);

function isEphemeralConvId(id: string): boolean {
	return /^c\d+$/.test(id);
}

export class PlanManager {
	private plansBySession = new Map<string, PlanState>();
	private plansByConv = new Map<string, PlanState>();
	private convToSession = new Map<string, string>();

	constructor(private readonly filePath?: string) {
		if (filePath) {
			this.load();
		}
	}

	private load(): void {
		if (!this.filePath) return;
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
			for (const [key, val] of Object.entries(raw)) {
				if (isEphemeralConvId(key)) continue;
				if (val && typeof val === "object" && Array.isArray((val as { steps?: unknown }).steps)) {
					this.plansBySession.set(key, val as PlanState);
				}
			}
		} catch {}
	}

	private save(): void {
		if (!this.filePath) return;
		try {
			const obj: Record<string, PlanState> = {};
			for (const [k, v] of this.plansBySession.entries()) {
				if (isEphemeralConvId(k)) continue;
				obj[k] = v;
			}
			writeJsonAtomicSync(this.filePath, obj);
		} catch {}
	}

	bindSession(conversationId: string, sessionId: string): PlanState | null {
		this.convToSession.set(conversationId, sessionId);
		this.plansByConv.delete(conversationId);
		const existing = this.plansBySession.get(sessionId);
		if (existing) {
			this.plansByConv.set(conversationId, existing);
			return existing;
		}
		return null;
	}

	unbindConversation(conversationId: string): void {
		this.plansByConv.delete(conversationId);
		this.convToSession.delete(conversationId);
	}

	getPlan(id: string): PlanState | null {
		const directConv = this.plansByConv.get(id);
		if (directConv) return directConv;
		const sessionId = this.convToSession.get(id);
		if (sessionId) {
			const bySession = this.plansBySession.get(sessionId);
			if (bySession) {
				this.plansByConv.set(id, bySession);
				return bySession;
			}
		}
		const directSession = this.plansBySession.get(id);
		if (directSession) return directSession;
		return null;
	}

	setPlan(conversationId: string, steps: PlanStep[], activeStepId?: string | null, sessionId?: string): PlanState {
		const normalizedSteps: PlanStep[] = (Array.isArray(steps) ? steps : []).map((s, idx) => {
			const status = (VALID_STATUSES.has(s.status) ? s.status : "pending") as PlanStepStatus;
			return {
				id: String(s.id || `step-${idx + 1}`),
				title: String(s.title || "").slice(0, 200),
				status,
				...(s.description ? { description: String(s.description).slice(0, 1000) } : {}),
			};
		});

		let effectiveActiveId = activeStepId;
		if (effectiveActiveId === undefined) {
			const inProg = normalizedSteps.find((s) => s.status === "in_progress");
			effectiveActiveId = inProg ? inProg.id : null;
		}

		const state: PlanState = {
			steps: normalizedSteps,
			activeStepId: effectiveActiveId,
			updatedAt: Date.now(),
		};

		this.plansByConv.set(conversationId, state);

		const effectiveSessionId = sessionId ?? this.convToSession.get(conversationId);
		if (effectiveSessionId) {
			this.convToSession.set(conversationId, effectiveSessionId);
			if (normalizedSteps.length === 0) {
				this.plansBySession.delete(effectiveSessionId);
			} else {
				this.plansBySession.set(effectiveSessionId, state);
			}
			this.save();
		}

		return state;
	}

	updateStep(conversationId: string, stepId: string, patch: Partial<PlanStep>): PlanState | null {
		const current = this.getPlan(conversationId);
		if (!current) return null;

		const idx = current.steps.findIndex((s) => s.id === stepId);
		if (idx === -1) return null;

		const currentStep = current.steps[idx];
		const nextStatus = patch.status && VALID_STATUSES.has(patch.status) ? patch.status : currentStep.status;

		const { id: _ignored, ...rest } = patch;
		const nextStep: PlanStep = {
			...currentStep,
			...rest,
			status: nextStatus,
			title: String(rest.title ?? currentStep.title ?? "").slice(0, 200),
		};
		const description = String(rest.description ?? currentStep.description ?? "").slice(0, 1000);
		if (description) nextStep.description = description;
		else delete nextStep.description;

		const nextSteps = [...current.steps];
		nextSteps[idx] = nextStep;

		let nextActive = current.activeStepId;
		if (patch.status === "in_progress") {
			nextActive = stepId;
		} else if (current.activeStepId === stepId && patch.status) {
			const nextPending = nextSteps.find((s) => s.status === "pending" || s.status === "in_progress");
			nextActive = nextPending ? nextPending.id : null;
		}

		const nextState: PlanState = {
			steps: nextSteps,
			activeStepId: nextActive,
			updatedAt: Date.now(),
		};

		this.plansByConv.set(conversationId, nextState);
		const sessId = this.convToSession.get(conversationId);
		if (sessId) {
			this.plansBySession.set(sessId, nextState);
			this.save();
		}
		return nextState;
	}

	deleteStep(conversationId: string, stepId: string): PlanState | null {
		const current = this.getPlan(conversationId);
		if (!current) return null;

		const idx = current.steps.findIndex((s) => s.id === stepId);
		if (idx === -1) return current;

		const nextSteps = current.steps.filter((s) => s.id !== stepId);
		let nextActive = current.activeStepId;
		if (current.activeStepId === stepId) {
			const nextPending = nextSteps.find((s) => s.status === "pending" || s.status === "in_progress");
			nextActive = nextPending ? nextPending.id : null;
		}

		const nextState: PlanState = {
			steps: nextSteps,
			activeStepId: nextActive,
			updatedAt: Date.now(),
		};

		this.plansByConv.set(conversationId, nextState);
		const sessId = this.convToSession.get(conversationId);
		if (sessId) {
			this.plansBySession.set(sessId, nextState);
			this.save();
		}
		return nextState;
	}

	addStep(conversationId: string, step: PlanStep, afterStepId?: string): PlanState | null {
		const current = this.getPlan(conversationId);
		const existingSteps = current?.steps ?? [];

		const normalized: PlanStep = {
			id: String(step.id ?? `step-${Date.now()}`),
			title: String(step.title ?? "").slice(0, 200),
			status: step.status && VALID_STATUSES.has(step.status) ? step.status : "pending",
		};
		const description = String(step.description ?? "").slice(0, 1000);
		if (description) normalized.description = description;

		let nextSteps: PlanStep[];
		if (afterStepId) {
			const idx = existingSteps.findIndex((s) => s.id === afterStepId);
			if (idx !== -1) {
				nextSteps = [...existingSteps.slice(0, idx + 1), normalized, ...existingSteps.slice(idx + 1)];
			} else {
				nextSteps = [...existingSteps, normalized];
			}
		} else {
			nextSteps = [...existingSteps, normalized];
		}

		let nextActive = current?.activeStepId ?? null;
		if (!nextActive && normalized.status === "in_progress") {
			nextActive = normalized.id;
		}

		const nextState: PlanState = {
			steps: nextSteps,
			activeStepId: nextActive,
			updatedAt: Date.now(),
		};

		this.plansByConv.set(conversationId, nextState);
		const sessId = this.convToSession.get(conversationId);
		if (sessId) {
			this.plansBySession.set(sessId, nextState);
			this.save();
		}
		return nextState;
	}

	clearPlan(conversationId: string): void {
		this.plansByConv.delete(conversationId);
		const sessId = this.convToSession.get(conversationId);
		if (sessId) {
			this.plansBySession.delete(sessId);
			this.convToSession.delete(conversationId);
		}
		this.save();
	}

	describePlan(conversationId: string): string {
		const plan = this.getPlan(conversationId);
		if (!plan || plan.steps.length === 0) return "No active plan.";

		const doneCount = plan.steps.filter((s) => s.status === "done").length;
		const total = plan.steps.length;
		const lines = [`Plan Progress: ${doneCount}/${total} completed`];

		for (let i = 0; i < plan.steps.length; i++) {
			const s = plan.steps[i];
			const icon =
				s.status === "done" ? "[x]" : s.status === "in_progress" ? "[>]" : s.status === "failed" ? "[!]" : "[ ]";
			const activeTag = s.id === plan.activeStepId ? " (current)" : "";
			lines.push(`${icon} ${i + 1}. ${s.title}${activeTag}`);
			if (s.description) {
				lines.push(`     ${s.description}`);
			}
		}

		return lines.join("\n");
	}
}
