import { describe, expect, it } from "vitest";
import { prepareBotExecutionSystemPrompt } from "../../server/device-center/execution-system-prompt.js";
import { getBotExecutionInstructions } from "../../server/device-center/execution-instructions.js";

// Exercise the installed SDK renderer without importing agent-service or starting a server.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", sdkEntry).href);

function makeEvent() {
	const systemPromptOptions = {
		cwd: "/workspace",
		selectedTools: ["read"],
		sections: { other_extension: "keep this extension" } as Record<string, string>,
		forceSystemPrompt: undefined as string | undefined,
	};
	return {
		systemPromptOptions,
		get systemPrompt(): string {
			return buildSystemPrompt(systemPromptOptions);
		},
	};
}
const execution = {
	bot: { systemPrompt: "Custom Bot role" },
	instructions: "Local execution authority",
};

function expectOwnedOnce(prompt: string) {
	for (const text of ["<device_bot>", execution.bot.systemPrompt, "<device_execution>", execution.instructions]) {
		expect(prompt.split(text)).toHaveLength(2);
	}
}

describe("Bot execution system prompt sections", () => {
	it("adds deterministic owned sections while leaving the ordinary SDK path structured", () => {
		const event = makeEvent();
		prepareBotExecutionSystemPrompt(event, execution);
		expect(event.systemPromptOptions.forceSystemPrompt).toBeUndefined();
		expect(event.systemPromptOptions.sections).toEqual({
			other_extension: "keep this extension",
			device_bot: execution.bot.systemPrompt,
			device_execution: execution.instructions,
		});
		expectOwnedOnce(event.systemPrompt);
		prepareBotExecutionSystemPrompt(event, execution);
		expectOwnedOnce(event.systemPrompt);
	});

	it.each(["composer", "template replace", "remote cwd patch"])("preserves sections exactly once through %s", () => {
		const event = makeEvent();
		const original = event.systemPrompt;
		event.systemPromptOptions.forceSystemPrompt = `EXTENSION PRE\n${original}\nEXTENSION POST`;
		const { core, rewrap } = prepareBotExecutionSystemPrompt(event, execution);
		expect(core).toBe(original);
		// Renderers can replace the entire baseline, or retain its SDK sections.
		for (const replacement of ["Replacement prompt", event.systemPrompt, core]) {
			const rendered = rewrap(replacement);
			expectOwnedOnce(rendered);
			expect(rendered).toContain("EXTENSION PRE");
			expect(rendered).toContain("EXTENSION POST");
		}
	});

	it("preserves an earlier opaque force override even when no renderer returns text", () => {
		const event = makeEvent();
		event.systemPromptOptions.forceSystemPrompt = "Opaque extension replacement";
		prepareBotExecutionSystemPrompt(event, execution);
		expect(event.systemPrompt).toContain("Opaque extension replacement");
		expectOwnedOnce(event.systemPrompt);
		prepareBotExecutionSystemPrompt(event, execution);
		expectOwnedOnce(event.systemPrompt);
	});

	it("replaces restored primary instructions with the current execution's member instructions", () => {
		const event = makeEvent();
		const primary = getBotExecutionInstructions(true);
		const member = getBotExecutionInstructions(false);
		expect(primary).not.toBe(member);
		event.systemPromptOptions.sections.device_execution = primary;
		event.systemPromptOptions.sections.device_bot = "Restored Bot role";
		prepareBotExecutionSystemPrompt(event, { bot: {}, instructions: member });
		expect(event.systemPromptOptions.sections.device_execution).toBe(member);
		expect(event.systemPromptOptions.sections).not.toHaveProperty("device_bot");
		expect(event.systemPrompt).not.toContain(primary);
		expect(event.systemPrompt).not.toContain("Restored Bot role");
		expect(event.systemPromptOptions.sections.other_extension).toBe("keep this extension");
	});

	it("does not mutate non-Bot events or change previous extension wrapping", () => {
		const event = makeEvent();
		const original = event.systemPrompt;
		const before = structuredClone(event.systemPromptOptions);
		const plain = prepareBotExecutionSystemPrompt(event);
		expect(plain.core).toBe(original);
		expect(plain.rewrap("new")).toBe("new");
		expect(event.systemPromptOptions).toEqual(before);
		event.systemPromptOptions.forceSystemPrompt = `PRE\n${original}\nPOST`;
		const forcedBefore = structuredClone(event.systemPromptOptions);
		const wrapped = prepareBotExecutionSystemPrompt(event);
		expect(wrapped.core).toBe(original);
		expect(wrapped.rewrap("new")).toBe("PRE\nnew\nPOST");
		expect(event.systemPromptOptions).toEqual(forcedBefore);
	});
});
