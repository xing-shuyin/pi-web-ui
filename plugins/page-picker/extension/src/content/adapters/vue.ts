/// <reference lib="dom" />

import type { SourceRef } from "../../shared/contract.js";

interface VueOptions {
	__file?: string;
	name?: string;
	__name?: string;
	_componentTag?: string;
}

interface VueInstanceLike {
	type?: VueOptions;
	$options?: VueOptions;
	parent?: VueInstanceLike | null;
}

export function vueSource(el: Element): SourceRef | undefined {
	const target = el as unknown as Record<string, unknown>;
	const inst = (target.__vueParentComponent ?? target.__vue__) as VueInstanceLike | undefined;
	if (!inst || typeof inst !== "object") return undefined;

	let node: VueInstanceLike | null = inst;
	let hops = 0;
	while (node && hops < 20) {
		const options = node.type ?? node.$options;
		const file = normalizeVueFile(options?.__file);
		if (file) {
			const name = options?.name || options?.__name || options?._componentTag || "";
			const chain = vueChain(inst);
			return {
				kind: "vue",
				file,
				...(name ? { component: name } : {}),
				...(chain ? { chain } : {}),
			};
		}
		node = node.parent ?? null;
		hops++;
	}
	return undefined;
}

function normalizeVueFile(raw: string | undefined): string | undefined {
	if (!raw || typeof raw !== "string") return undefined;
	const cleaned = raw.replace(/[?#].*$/, "").trim();
	return cleaned || undefined;
}

function vueChain(inst: VueInstanceLike): string[] | undefined {
	const names: string[] = [];
	let node: VueInstanceLike | null = inst;
	let hops = 0;
	while (node && hops < 20 && names.length < 5) {
		const options = node.type ?? node.$options;
		const name = options?.name || options?.__name || "";
		if (name && !names.includes(name)) names.push(name);
		node = node.parent ?? null;
		hops++;
	}
	return names.length > 1 ? names : undefined;
}
