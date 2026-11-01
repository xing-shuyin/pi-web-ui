import type { DeviceTaskPlanReadyFrame, PlanStep } from "../protocol.js";

/** Reject invalid plans whole; never turn truncated or defaulted steps into an approval target. */
export function validateTaskPlan(value: unknown): DeviceTaskPlanReadyFrame["plan"] | undefined {
	if (!value || typeof value !== "object") return;
	const plan = value as Record<string, unknown>;
	if (plan.state !== "ready" || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 32) return;
	if (plan.summary !== undefined && (typeof plan.summary !== "string" || plan.summary.length > 500)) return;
	const ids = new Set<string>();
	const steps: PlanStep[] = [];
	for (const raw of plan.steps) {
		if (!raw || typeof raw !== "object") return;
		const step = raw as Record<string, unknown>;
		if (typeof step.id !== "string" || !step.id.trim() || step.id.length > 64 || ids.has(step.id.trim())) return;
		if (typeof step.title !== "string" || !step.title.trim() || step.title.length > 200) return;
		if (!["pending", "in_progress", "done", "failed"].includes(step.status as string)) return;
		if (step.description !== undefined && (typeof step.description !== "string" || step.description.length > 1000))
			return;
		ids.add(step.id.trim());
		steps.push({
			id: step.id.trim(),
			title: step.title.trim(),
			status: step.status as PlanStep["status"],
			...(step.description === undefined ? {} : { description: step.description as string }),
		});
	}
	return { state: "ready", steps, ...(plan.summary === undefined ? {} : { summary: plan.summary as string }) };
}
