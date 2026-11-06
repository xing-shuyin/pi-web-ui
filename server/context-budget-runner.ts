import { contextWindowOf, modelKeyOf } from "./agent-formatters.js";
import { effectiveSoftCap, softCapToReserve, DEFAULT_COMPACTION_RESERVE_TOKENS } from "./soft-cap.js";
import { pruneContextHierarchically } from "./context-budget.js";
import type { Conversation } from "./agent-service.js";

export interface ContextPruningResult {
	pruned: boolean;
	tokensSaved: number;
}

export function executeContextBudgetPruning(
	conv: Conversation,
	settings: {
		softCapTokens?: number;
		softCapByModel?: Record<string, number>;
	},
): ContextPruningResult {
	if (!conv?.session) return { pruned: false, tokensSaved: 0 };
	try {
		const contextWindow = contextWindowOf(conv.session);
		if (!contextWindow || contextWindow <= 0) return { pruned: false, tokensSaved: 0 };
		const modelId = modelKeyOf(conv.session);
		const cap = effectiveSoftCap(settings.softCapTokens ?? 0, settings.softCapByModel, modelId);
		const reserve = softCapToReserve(contextWindow, cap) ?? DEFAULT_COMPACTION_RESERVE_TOKENS;

		const messages = conv.session.agent.state.messages;
		if (!messages || messages.length === 0) return { pruned: false, tokensSaved: 0 };

		const result = pruneContextHierarchically(messages, {
			contextWindow,
			reserveTokens: reserve,
			softCap: cap > 0 ? cap : null,
		});

		if (result.tier1.trimmedCount > 0 || result.tier2.foldedCount > 0) {
			conv.session.agent.state.messages = result.messages;
			const tokensSaved = result.tokensBefore - result.tokensAfter;
			return { pruned: true, tokensSaved };
		}
		return { pruned: false, tokensSaved: 0 };
	} catch {
		return { pruned: false, tokensSaved: 0 };
	}
}
