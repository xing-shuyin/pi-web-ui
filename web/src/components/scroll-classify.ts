export function classifyScroll(args: {
	dSt: number;
	dSh: number;
	escaped: boolean;
	graceActive: boolean;
	stuck: boolean;
}): { flipEscape: boolean; reassert: boolean } {
	const { dSt, dSh, escaped, graceActive, stuck } = args;
	if (graceActive) return { flipEscape: false, reassert: false };
	if (dSt >= -4 || dSt <= -500) return { flipEscape: false, reassert: false };
	if (dSh < 0) {
		return { flipEscape: false, reassert: stuck && !escaped };
	}
	return { flipEscape: true, reassert: false };
}

export function shouldEscapeOnScroll(args: {
	decisionFlipEscape: boolean;
	hasUserUpwardIntent: boolean;
	stuck: boolean;
	escaped: boolean;
}): { shouldEscape: boolean; shouldReassert: boolean } {
	const { decisionFlipEscape, hasUserUpwardIntent, stuck, escaped } = args;
	if (!decisionFlipEscape) {
		return { shouldEscape: false, shouldReassert: false };
	}
	if (hasUserUpwardIntent) {
		return { shouldEscape: true, shouldReassert: false };
	}
	return {
		shouldEscape: false,
		shouldReassert: stuck && !escaped,
	};
}

export function shouldScrollToBottomOnStreamChange(args: {
	wasStreaming: boolean;
	isStreaming: boolean;
	escaped: boolean;
	hasJumpTarget: boolean;
}): boolean {
	const { wasStreaming, isStreaming, escaped, hasJumpTarget } = args;
	if (hasJumpTarget) return false;
	if (!wasStreaming && isStreaming) {
		return !escaped;
	}
	return false;
}

export function classifyQuestionAddedScroll(args: {
	convChanged: boolean;
	lastQuestionId: string | null;
	prevLastQuestionId: string | null;
	escaped: boolean;
	nearBottom?: boolean;
	hasJumpTarget: boolean;
}): { shouldScroll: boolean; reason: "conv_changed" | "question_added" | "initial_load" | "none" } {
	const { convChanged, lastQuestionId, prevLastQuestionId, escaped, hasJumpTarget } = args;
	if (hasJumpTarget) return { shouldScroll: false, reason: "none" };
	if (convChanged) {
		return { shouldScroll: true, reason: "conv_changed" };
	}
	const questionAdded = lastQuestionId !== null && prevLastQuestionId !== null && lastQuestionId !== prevLastQuestionId;
	if (questionAdded) {
		return { shouldScroll: !escaped, reason: "question_added" };
	}
	const initialLoad = prevLastQuestionId === null && lastQuestionId !== null;
	if (initialLoad) {
		return { shouldScroll: !escaped, reason: "initial_load" };
	}
	return { shouldScroll: false, reason: "none" };
}

export function shouldPreloadEarlier(args: {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	hasEarlier: boolean;
	isMovingUp: boolean;
}): boolean {
	const { scrollTop, scrollHeight, clientHeight, hasEarlier, isMovingUp } = args;
	if (!hasEarlier || !isMovingUp) return false;
	const threshold = Math.max(clientHeight * 2, scrollHeight * 0.5, 800);
	return scrollTop <= threshold;
}
