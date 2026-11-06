import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./serialize.js";
import {
	DEFAULT_PROMPT_TEMPLATE,
	renderPromptTemplate,
	resolveSectionTexts,
	type PromptComposerInputs,
} from "./prompt-composer.js";

export function hasSettledAssistantUsage(messages: unknown[]): boolean {
	if (!Array.isArray(messages)) return false;
	try {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as {
				role?: unknown;
				usage?: { input?: number; totalTokens?: number; output?: number };
			} | null;
			if (m && m.role === "assistant" && m.usage) {
				const u = m.usage;
				if ((u.input ?? 0) > 0 || (u.totalTokens ?? 0) > 0 || (u.output ?? 0) > 0) {
					return true;
				}
			}
		}
	} catch {}
	return false;
}

export function estimateNonSystemTokens(messages: unknown[], streamingMessage?: unknown): number {
	let total = 0;
	if (!Array.isArray(messages)) return total;
	try {
		for (const m of messages) {
			if ((m as { role?: string })?.role !== "system") {
				total += estimateTokens(m as AgentMessage);
			}
		}
		if (streamingMessage) {
			total += estimateTokens(streamingMessage as AgentMessage);
		}
	} catch {}
	return total;
}

export function shouldRenderMainCompose(opts: {
	promptTemplate?: string;
	promptOverrides?: Record<string, string>;
	promptDisabled?: string[];
	preset?: string;
	disabledToolCount: number;
	isLazy?: boolean;
	hasSkills?: boolean;
	hasSkillsFullText?: boolean;
}): boolean {
	const tpl = (opts.promptTemplate ?? "").trim();
	const ovs = opts.promptOverrides ?? {};
	const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
	const preset = opts.preset ?? "standard";
	return (
		!!tpl ||
		hasOverride ||
		(opts.promptDisabled?.length ?? 0) > 0 ||
		preset !== "standard" ||
		opts.disabledToolCount > 0 ||
		opts.isLazy === true ||
		opts.hasSkills === true ||
		opts.hasSkillsFullText === true
	);
}

export function renderMainCompose(
	inputs: PromptComposerInputs,
	opts: {
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		promptDisabled?: string[];
		preset?: string;
		disabledToolCount: number;
		isLazy?: boolean;
		hasSkills?: boolean;
		hasSkillsFullText?: boolean;
	},
): string | undefined {
	if (!shouldRenderMainCompose(opts)) return undefined;
	const texts = resolveSectionTexts(inputs);
	const tpl = (opts.promptTemplate ?? "").trim();
	const ovs = opts.promptOverrides ?? {};
	const hasOverride = Object.values(ovs).some((v) => typeof v === "string" && v.trim());
	return renderPromptTemplate(
		tpl || DEFAULT_PROMPT_TEMPLATE,
		texts,
		hasOverride ? ovs : undefined,
		new Set(opts.promptDisabled ?? []),
	);
}
