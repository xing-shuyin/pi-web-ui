/// <reference lib="dom" />
/**
 * Vue 源码定位：从元素上的组件实例拿 `__file`（Vite + vue 插件在 dev 下注入）。
 *
 * 老实说：Vue 这块**拿不到行号**（实例上只有文件路径，SFC 的行信息在编译后的
 * render 函数里，得靠 sourcemap 才能还原）。所以这里只给文件 + 组件名，
 * 不硬编一个假行号 —— 宁可少给也不要给错的。
 */

import type { SourceRef } from "../../shared/contract.js";

/** 组件选项上我们会用到的字段（Vue 2 用 $options，Vue 3 用 type；合并成一个宽松型避免联合类型取值报错）。 */
interface VueOptions {
	__file?: string;
	name?: string;
	/** <script setup> 自动推导出来的组件名。 */
	__name?: string;
	/** Vue 2 的组件标签名。 */
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

/** `__file` 已是 dev server 路径（/src/components/Foo.vue），只做去查询串的清理。 */
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
