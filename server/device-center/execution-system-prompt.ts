import { splitAgentStartPrompt } from "../persona-chain.js";

interface PromptEvent {
	readonly systemPrompt: string;
	systemPromptOptions?: {
		forceSystemPrompt?: string;
		sections?: Record<string, string>;
	};
}

interface ExecutionPrompt {
	readonly bot: { readonly systemPrompt?: string };
	readonly instructions: string;
}

const ownedSections = ["device_bot", "device_execution"] as const;

/** Keep execution authority in SDK sections, including when a renderer forces opaque text. */
export function prepareBotExecutionSystemPrompt(event: PromptEvent, execution?: ExecutionPrompt) {
	// Split before adding sections: earlier extensions wrapped the previous SDK baseline.
	const { pre, core, post } = splitAgentStartPrompt(event);
	if (!execution) return { core, rewrap: (next: string) => pre + next + post };
	const sections: Record<string, string> = {};
	if (execution.bot.systemPrompt?.trim()) sections.device_bot = execution.bot.systemPrompt.trim();
	if (execution.instructions.trim()) sections.device_execution = execution.instructions.trim();
	if (event.systemPromptOptions) {
		const target = (event.systemPromptOptions.sections ??= {});
		for (const name of ownedSections) delete target[name];
		Object.assign(target, sections);
	}
	const stripOwnedSections = (text: string) => {
		for (const name of ownedSections) {
			text = text.replace(new RegExp(`<${name}>\\n[\\s\\S]*?\\n</${name}>`, "g"), "");
		}
		return text;
	};
	const rendered = Object.entries(sections)
		.map(([name, content]) => `<${name}>\n${content}\n</${name}>`)
		.join("\n\n");
	const rewrap = (next: string) => {
		const wrapped = stripOwnedSections(pre + next + post);
		return rendered ? `${wrapped.trimEnd()}\n\n${rendered}` : wrapped;
	};
	// SDK ignores sections when an earlier extension has already forced the prompt.
	if (typeof event.systemPromptOptions?.forceSystemPrompt === "string") {
		event.systemPromptOptions.forceSystemPrompt = rewrap(core);
	}
	return { core: stripOwnedSections(core), rewrap };
}
