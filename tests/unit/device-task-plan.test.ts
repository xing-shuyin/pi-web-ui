import { describe, expect, it } from "vitest";
import { validateTaskPlan } from "../../server/device-center/task-plan.js";
import { registerBotExecution } from "../../server/device-center/bot-execution.js";

describe("task-plan validation", () => {
	const step = { id: "1", title: "Inspect implementation", status: "pending" };
	it("preserves complete valid steps", () => {
		expect(validateTaskPlan({ state: "ready", steps: [step] })).toEqual({ state: "ready", steps: [step] });
	});
	it.each(
		[
			[],
			Array.from({ length: 33 }, (_, index) => ({ ...step, id: String(index) })),
			[step, step],
			[{ ...step, status: undefined }],
			[{ ...step, status: "approved" }],
			[{ ...step, title: "x".repeat(201) }],
			[{ ...step, description: "x".repeat(1001) }],
		].map((steps) => ({ steps })),
	)("rejects invalid steps without defaulting or truncating", ({ steps }) => {
		expect(validateTaskPlan({ state: "ready", steps })).toBeUndefined();
	});
	it("never grants plan_update outside the Bot tool allowlist", () => {
		const binding = registerBotExecution(
			{
				id: "bot",
				name: "Bot",
				description: "",
				systemPrompt: "",
				cwd: process.cwd(),
				enabled: true,
				revision: 1,
				tools: ["read"],
				skills: [],
				mcpServers: [],
			},
			undefined,
			{ primary: false, planOnly: true },
		);
		expect(binding.capability.allowsTool("plan_update")).toBe(false);
		binding.capability.revoke();
	});
});
