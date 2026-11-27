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
	/** 启动时装载的记忆块（常驻 + 目录 + 预取），单独成节，与平台规则分开。 */
	readonly memoryBlock?: string;
}

const ownedSections = ["device_bot", "device_execution", "device_memory"] as const;

function stripOwnedSections(text: string): string {
	for (const name of ownedSections) {
		text = text.replace(new RegExp(`<${name}>\\n[\\s\\S]*?\\n</${name}>`, "g"), "");
	}
	return text;
}

function buildExecutionSections(execution: ExecutionPrompt): Record<string, string> {
	const sections: Record<string, string> = {};
	if (execution.bot.systemPrompt?.trim()) sections.device_bot = execution.bot.systemPrompt.trim();
	if (execution.instructions.trim()) sections.device_execution = execution.instructions.trim();
	if (execution.memoryBlock?.trim()) sections.device_memory = execution.memoryBlock.trim();
	return sections;
}

function renderExecutionSections(sections: Record<string, string>): string {
	return Object.entries(sections)
		.map(([name, content]) => `<${name}>\n${content}\n</${name}>`)
		.join("\n\n");
}

/** 将 Bot 自身提示词、执行指令与记忆块追加到系统提示词末尾（幂等替换同名标签段）。 */
export function appendBotExecutionSections(base: string, execution: ExecutionPrompt): string {
	const cleaned = stripOwnedSections(base).trimEnd();
	const rendered = renderExecutionSections(buildExecutionSections(execution));
	if (!rendered) return cleaned;
	return cleaned ? `${cleaned}\n\n${rendered}` : rendered;
}

export function prepareBotExecutionSystemPrompt(event: PromptEvent, execution?: ExecutionPrompt) {
	const { pre, core, post } = splitAgentStartPrompt(event);
	if (!execution) return { core, rewrap: (next: string) => pre + next + post };
	const sections = buildExecutionSections(execution);
	if (event.systemPromptOptions) {
		const target = (event.systemPromptOptions.sections ??= {});
		for (const name of ownedSections) delete target[name];
		Object.assign(target, sections);
	}
	const rendered = renderExecutionSections(sections);
	const rewrap = (next: string) => {
		const wrapped = stripOwnedSections(pre + next + post);
		return rendered ? `${wrapped.trimEnd()}\n\n${rendered}` : wrapped;
	};
	if (typeof event.systemPromptOptions?.forceSystemPrompt === "string") {
		event.systemPromptOptions.forceSystemPrompt = rewrap(core);
	}
	return { core: stripOwnedSections(core), rewrap };
}
