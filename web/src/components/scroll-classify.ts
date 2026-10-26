/** Pure classification of an onScroll event — no DOM, no refs. The onScroll
 *  handler in MessageList applies the returned actions. Semantics preserved
 *  verbatim from 5cd680b:
 *   - graceActive (programmatic snap window): do nothing — our own jumps must
 *     never be read as upward user intent.
 *   - Large negative jump (dSt <= -500): layout collapse clamp, not a gesture —
 *     no escape.
 *   - Moderate negative jump (-500 < dSt < -4):
 *       · dSh < 0  → layout shift above viewport, NOT user intent; keep the
 *         stick and re-assert the snap (only when currently stuck && !escaped).
 *       · dSh >= 0 → true user wheel-up (content height unchanged) → escape.
 *   - Otherwise (dSt >= -4): no-op from this classifier.
 *  NOTE: while graceActive the handler deliberately does NOT re-assert, so
 *  reassert stays false there — behavior identical to pre-refactor. */
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
		// Layout shift, NOT user intent: keep the stick and re-assert the snap —
		// the bottom moved up, follow it.
		return { flipEscape: false, reassert: stuck && !escaped };
	}
	// True user wheel-up: scrollHeight unchanged → escape.
	return { flipEscape: true, reassert: false };
}

/**
 * 判定在滚动事件触发时是否采纳逃逸或重新吸底。
 *
 * 核心准则（根治长输出工具与流式正文把跟随掐断）：
 *   - 仅当真正存在用户向上物理手势（滚轮向上 / 触屏向上翻页 / 拖动滚动条向上 / 键盘向上）时，
 *     才采纳逃逸并释放跟随；
 *   - 当没有任何物理手势时，即使发生了负向位移（长工具卡片插入、代码高亮重排、
 *     占位符替换或浏览器 scrollTop clamp 导致 dSt < 0），也坚决拒绝逃逸，并在
 *     处于吸底状态时重新拉回底部（shouldReassert = true）。
 */
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
	// 无用户物理向上意图：纯渲染布局突变，在吸底态下拒绝逃逸，必须重新吸底
	return {
		shouldEscape: false,
		shouldReassert: stuck && !escaped,
	};
}

/**
 * 判定流式状态发生变化时是否应当调用 scrollToBottom 吸底。
 *
 * 核心准则（根治刷新页面或工具多回合生成时向上滚动被瞬间拉回底部）：
 *   - 仅当用户此前未主动向上逃逸（!escaped）时，新一轮流式启动才吸底跟随；
 *   - 一旦用户已主动向上翻阅历史（escaped=true），无论流式如何开启、工具如何交替，坚决不吸底打扰。
 */
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

/**
 * 判定提问列表变化或首次载入时是否应当调用 scrollToBottom。
 *
 * 核心准则：
 *   - 切换会话（convChanged=true）：无条件对齐底部；
 *   - 用户新发提问（prevLastQuestionId !== null 且 id 变更）：无条件恢复吸底；
 *   - 页面刷新后首批消息后置载入（initialLoad，prevLastQuestionId === null）：
 *     仅在用户尚未逃逸浏览时才吸底；若用户在首载间隙已向上滚动手势逃逸，坚决不拉回底部。
 */
export function classifyQuestionAddedScroll(args: {
	convChanged: boolean;
	lastQuestionId: string | null;
	prevLastQuestionId: string | null;
	escaped: boolean;
	nearBottom?: boolean;
	hasJumpTarget: boolean;
}): { shouldScroll: boolean; reason: "conv_changed" | "question_added" | "initial_load" | "none" } {
	const { convChanged, lastQuestionId, prevLastQuestionId, escaped, nearBottom = true, hasJumpTarget } = args;
	if (hasJumpTarget) return { shouldScroll: false, reason: "none" };
	if (convChanged) {
		return { shouldScroll: true, reason: "conv_changed" };
	}
	const questionAdded = lastQuestionId !== null && prevLastQuestionId !== null && lastQuestionId !== prevLastQuestionId;
	if (questionAdded) {
		// 仅当用户未主动向上逃逸且视口在底部时才自动吸底；若用户在部分消息阶段已向上翻阅，完整消息加载完坚决不拉回底部
		return { shouldScroll: !escaped && nearBottom, reason: "question_added" };
	}
	const initialLoad = prevLastQuestionId === null && lastQuestionId !== null;
	if (initialLoad) {
		return { shouldScroll: !escaped && nearBottom, reason: "initial_load" };
	}
	return { shouldScroll: false, reason: "none" };
}

/**
 * 判定在滚动时是否应当提前触发更早历史消息的静默预加载。
 *
 * 核心准则（水库双缓冲模型）：
 *   - 用户向上移动浏览历史中（isMovingUp=true）；
 *   - 当前视口已离开底部、进入倒数第二页/上半部预警水位线（scrollTop <= threshold）；
 *   - 且仍有更早历史未下发（hasEarlier=true）；
 *   - 提前在后台把下一页历史无感拉取并无缝前插，彻底消除滚到顶部撞墙等待感。
 */
export function shouldPreloadEarlier(args: {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	hasEarlier: boolean;
	isMovingUp: boolean;
}): boolean {
	const { scrollTop, scrollHeight, clientHeight, hasEarlier, isMovingUp } = args;
	if (!hasEarlier || !isMovingUp) return false;
	// 动态水位线：至少提前 2 屏视口高度（约 1200px~1600px）或总滚动高度的前 50%
	const threshold = Math.max(clientHeight * 2, scrollHeight * 0.5, 800);
	return scrollTop <= threshold;
}
