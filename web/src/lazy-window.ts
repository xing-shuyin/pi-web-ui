export interface WinRect {
	id: string;
	top: number;
	bottom: number;
}

interface WindowPlan {
	show: string[];
	hide: string[];
	shrinkAbove: number;
}

export function planWindow(
	items: readonly WinRect[],
	mountViewport: { top: number; bottom: number },
	always: ReadonlySet<string>,
	hidden: ReadonlySet<string>,
	unmountViewport?: { top: number; bottom: number },
): WindowPlan {
	const unmountVp = unmountViewport ?? mountViewport;
	const show: string[] = [];
	const hide: string[] = [];
	let shrinkAbove = 0;
	for (const it of items) {
		if (always.has(it.id)) continue;
		const isMounted = !hidden.has(it.id);
		if (!isMounted) {
			const shouldMount = it.top < mountViewport.bottom && it.bottom > mountViewport.top;
			if (shouldMount) {
				show.push(it.id);
			}
		} else {
			const inUnmountZone = it.top < unmountVp.bottom && it.bottom > unmountVp.top;
			if (!inUnmountZone) {
				hide.push(it.id);
				if (it.bottom <= unmountVp.top) shrinkAbove += it.bottom - it.top;
			}
		}
	}
	return { show, hide, shrinkAbove };
}

export function applyPlan(prev: ReadonlySet<string>, plan: WindowPlan): Set<string> {
	if (plan.show.length === 0 && plan.hide.length === 0) return prev as Set<string>;
	const next = new Set(prev);
	for (const id of plan.show) next.delete(id);
	for (const id of plan.hide) next.add(id);
	return next;
}

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

export function estimateMessageHeight(role: string, customType?: string): number {
	switch (role) {
		case "user":
			return 72;
		case "assistant":
			return 280;
		case "toolResult":
			return 8;
		case "custom":
			return customType === "file" ? 96 : 72;
		default:
			return 60;
	}
}

export interface HeightEntry {
	h: number;
	len: number;
}

const FP_KEYS = ["text", "thinking", "argumentsText", "output", "command"] as const;

interface FingerprintBlock {
	type?: string;
	text?: string;
	thinking?: string;
	argumentsText?: string;
	output?: string;
	command?: string;
}

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

export function getPlaceholderHeight(
	id: string,
	fingerprint: number,
	cache: ReadonlyMap<string, HeightEntry>,
	estimate: number,
): number {
	const e = cache.get(id);
	return e && e.len === fingerprint ? e.h : estimate;
}
