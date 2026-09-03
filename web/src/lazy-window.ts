/**
 * 消息列表惰性窗口化的纯函数部分（零 React 依赖，可单测）。
 *
 * 策略：最近段全量渲染的 DOM 成本随消息体积增长（一条大 tool 输出 / 长代码块
 * 就是几千节点）。这里不引入绝对定位虚拟滚动，而是「惰性挂载 + 高度占位」：
 * 视口（含上下 rootMargin 缓冲带）之外的重型消息替换为固定高度的占位 div，
 * 滚动临近时再换回真实内容，并在同一帧内做 scrollTop 补偿防止跳动。
 * 占位 div 保留 data-msg-id，问题导航 / 跳转 / flash 的 DOM 查询不受影响。
 */

/** 单条消息相对视口的包围盒（容器坐标系即可，任意一致坐标系都行）。 */
export interface WinRect {
	id: string;
	top: number;
	bottom: number;
}

export interface WindowPlan {
	/** 应从隐藏恢复为真实渲染的消息 id。 */
	show: string[];
	/** 应替换为占位符的消息 id。 */
	hide: string[];
	/**
	 * 隐藏「完全位于视口上方」的新增隐藏项导致的内容总高度收缩量：
	 * 提交后需 scrollTop -= shrinkAbove 才能保持可视内容不动。
	 */
	shrinkAbove: number;
}

/**
 * 计算本轮窗口计划。只输出**变化**：已在隐藏集合里的不可见项不再重复输出
 * （避免 rAF 连续两帧之间重复累计 shrinkAbove），保持 always 集合里的项不动。
 *
 * @param items    当前所有受管消息的矩形（通常来自 getBoundingClientRect）
 * @param viewport 含缓冲带的视口区间 {top, bottom}（与 items 同一坐标系）
 * @param always   永不占位（始终真实渲染）的消息 id
 * @param hidden   当前已处于占位状态的消息 id
 */
export function planWindow(
	items: readonly WinRect[],
	viewport: { top: number; bottom: number },
	always: ReadonlySet<string>,
	hidden: ReadonlySet<string>,
): WindowPlan {
	const show: string[] = [];
	const hide: string[] = [];
	let shrinkAbove = 0;
	for (const it of items) {
		if (always.has(it.id)) continue;
		const visible = it.top < viewport.bottom && it.bottom > viewport.top;
		if (visible) {
			if (hidden.has(it.id)) show.push(it.id);
		} else if (!hidden.has(it.id)) {
			hide.push(it.id);
			// 完全在视口上方的项被收起后，下方内容整体上移——需要回滚 scrollTop。
			if (it.bottom <= viewport.top) shrinkAbove += it.bottom - it.top;
		}
	}
	return { show, hide, shrinkAbove };
}

/** 把窗口计划应用到隐藏集合（纯函数：不变则原引用返回，便于跳过重渲染）。 */
export function applyPlan(prev: ReadonlySet<string>, plan: WindowPlan): Set<string> {
	if (plan.show.length === 0 && plan.hide.length === 0) return prev as Set<string>;
	const next = new Set(prev);
	for (const id of plan.show) next.delete(id);
	for (const id of plan.hide) next.add(id);
	return next;
}

/**
 * 底部常驻区选取：从末尾向前累计高度（实测优先，缺省估算），超过预算即停。
 * 纯按条数常驻会被单条巨型消息（大 tool 输出 / 长代码块）撑穿——那正是
 * 本模块要优化的对象；按高度预算保证常驻区始终有界。
 */
export function pickAlways(
	msgs: readonly { id: string; role: string; customType?: string }[],
	heights: ReadonlyMap<string, number>,
	budget: number,
): Set<string> {
	const out = new Set<string>();
	let acc = 0;
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (i < msgs.length - 1 && acc >= budget) break;
		const m = msgs[i];
		out.add(m.id);
		acc += heights.get(m.id) ?? estimateMessageHeight(m.role, m.customType);
	}
	return out;
}

/**
 * 从未被渲染过的消息没有实测高度，按角色给一个粗估占位高度。
 * 只求量级正确（首次向上滚动不跳太多）；一旦真实渲染过，测量值会覆盖估算值。
 */
export function estimateMessageHeight(role: string, customType?: string): number {
	switch (role) {
		case "user":
			return 72;
		case "assistant":
			return 280;
		case "toolResult":
			return 8; // 内容折叠进 toolCall 卡片，本体近乎零高
		case "custom":
			return customType === "file" ? 96 : 72;
		default:
			return 60;
	}
}

/** 实测高度缓存条目：高度 + 记录时的内容指纹。指纹不匹配（消息被编辑）时
 *  该条目视为失效——占位回退到角色估算，直到新内容再次实测。 */
export interface HeightEntry {
	h: number;
	len: number;
}

/** 指纹参与计算的字符串字段（各 content block 的主文本）。 */
const FP_KEYS = ["text", "thinking", "argumentsText", "output", "command"] as const;

/** 指纹输入：各 content block 只取已知文本字段，结构宽松避免耦合协议类型。 */
export interface FingerprintBlock {
	type?: string;
	text?: string;
	thinking?: string;
	argumentsText?: string;
	output?: string;
	command?: string;
}

/** 便宜的内容指纹：各 block 主文本长度之和（图片记 1）。编辑必然改变某个
 *  文本长度从而改变指纹——O(block 数) 遍历，不哈希整条消息。 */
export function contentFingerprint(m: { content: readonly FingerprintBlock[] }): number {
	let n = 0;
	for (const b of m.content) {
		if (b.type === "image") n += 1;
		for (const k of FP_KEYS) {
			const v = b[k];
			if (typeof v === "string") n += v.length;
		}
	}
	return n;
}

/** 占位高度来源：同 id 且内容指纹未变的实测值优先，否则角色估算。
 *
 *  这是「滚轮接近底部时底部不断后退」缺陷（v0.34 懒窗口化诊断缺陷 #1）的
 *  修复点：换回真实内容时按实测高度入缓存，再换回占位时取同一实测值 ⇒
 *  swap 高度中性 ⇒ 页面不再在滚轮接近路径下持续长高。从未实测的消息仍用
 *  估算——首次接近是一次性成本。 */
export function getPlaceholderHeight(
	id: string,
	fingerprint: number,
	cache: ReadonlyMap<string, HeightEntry>,
	estimate: number,
): number {
	const e = cache.get(id);
	return e && e.len === fingerprint ? e.h : estimate;
}
