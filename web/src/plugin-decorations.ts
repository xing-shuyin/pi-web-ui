import { useEffect, useMemo } from "react";
import type { UiPluginInfo } from "./types";
import {
	compileChatDecorations,
	findDecorationMatches,
	planDecorationRanges,
	type ChatDecorationSource,
	type CompiledChatDecoration,
} from "../../shared/chat-decorations.js";

// 聊天正文装饰（issue #956 评论里的「内置输出正则」诉求）的渲染层。
// 宿主统一执行：插件只在 manifest 里声明 `chatDecorations`，不写代码、不拿 DOM 权限。
//
// 为什么是 CSS Custom Highlight API 而不是包一层 <span>：正文由 React/ReactMarkdown 渲染且流式
// 反复重写，拆文本节点会和它抢 DOM；Highlight 只是 Range + `::highlight()`，DOM 结构零改动，
// 复制 / 搜索 / 导出 / TTS 也都读不到任何变化。

/** 正文作用域契约：宿主只装饰 `[data-chat-transcript]` 里的 `.md`，插件页 / 笔记等 markdown 不受影响。 */
export const CHAT_TRANSCRIPT_ATTR = "data-chat-transcript";

const SKIP_SELECTOR = "pre, code, kbd, samp, script, style, textarea, .codeblock";
const BLOCK_SELECTOR = "p, li, blockquote, td, th, h1, h2, h3, h4, h5, h6";
const STYLE_ATTR = "data-pi-chat-decorations";
/** 每帧最多花在扫描上的时间：超了就把剩下的根留到下一帧，长会话不卡输入。 */
const FRAME_BUDGET_MS = 6;
const MAX_RANGES_PER_ROOT = 20_000;

interface HighlightLike {
	add(range: Range): void;
	delete(range: Range): void;
}

type HighlightCtor = new () => HighlightLike;

interface HighlightRegistryLike {
	set(name: string, highlight: HighlightLike): void;
	delete(name: string): void;
}

function highlightApi(): { ctor: HighlightCtor; registry: HighlightRegistryLike } | null {
	if (typeof window === "undefined" || typeof CSS === "undefined") return null;
	const ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
	const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
	if (typeof ctor !== "function" || !registry) return null;
	return { ctor, registry };
}

function collectBlocks(root: Element): Element[] {
	const all = root.querySelectorAll(BLOCK_SELECTOR);
	if (all.length === 0) return [root];
	const out: Element[] = [];
	for (const block of all) {
		if (block.closest(SKIP_SELECTOR)) continue;
		// 嵌套块（li > p）只扫最内层，避免同一段文字被两条规则重复命中。
		if (block.querySelector(BLOCK_SELECTOR) && block.tagName !== "BLOCKQUOTE") continue;
		out.push(block);
	}
	return out;
}

/** 一个块里的全部文本节点（跳过代码），顺序即文本顺序。 */
function collectTextNodes(block: Element, doc: Document): Text[] {
	const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
		acceptNode(node): number {
			if (node.nodeType === Node.ELEMENT_NODE) {
				return (node as Element).matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
	return nodes;
}

export interface ChatDecorationsMount {
	/** 立刻扫一遍（测试 / 强制刷新用；正常路径由 rAF 合批驱动）。 */
	flush(): void;
	dispose(): void;
}

/**
 * 把编译好的规则挂到窗口上：一个 `<style>` + 每规则一个 `Highlight`，MutationObserver 合批重扫。
 * 调用方负责在规则变化 / 卸载时 `dispose()`。
 */
export function mountChatDecorations(
	rules: readonly CompiledChatDecoration[],
	options: { doc?: Document } = {},
): ChatDecorationsMount {
	const doc = options.doc ?? (typeof document === "undefined" ? null : document);
	const api = highlightApi();
	if (!doc || rules.length === 0 || !api) return { flush() {}, dispose() {} };

	const styleEl = doc.createElement("style");
	styleEl.setAttribute(STYLE_ATTR, "");
	styleEl.textContent = rules.map((r) => `::highlight(${r.name}){${r.declarations}}`).join("\n");
	doc.head.appendChild(styleEl);

	const highlights = new Map<string, HighlightLike>();
	for (const rule of rules) {
		const highlight = new api.ctor();
		api.registry.set(rule.name, highlight);
		highlights.set(rule.name, highlight);
	}

	/** 每个正文根当前挂着的 Range（换行/重扫前统一回收，避免旧节点泄漏）。 */
	const rangesByRoot = new Map<Element, Range[]>();
	const dirty = new Set<Element>();
	let raf = 0;
	let disposed = false;

	const transcriptOf = (node: Node): Element[] => {
		const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
		if (!el) return [];
		const own = el.closest(`[${CHAT_TRANSCRIPT_ATTR}]`);
		if (own) return [own];
		return el.querySelectorAll ? [...el.querySelectorAll(`[${CHAT_TRANSCRIPT_ATTR}]`)] : [];
	};

	/** 被整颗移除的正文根（切会话 / 关抽屉）：必须主动回收 Range，否则旧节点会被 Range 钉住不释放。 */
	const transcriptsIn = (node: Node): Element[] => {
		if (node.nodeType !== Node.ELEMENT_NODE) return [];
		const el = node as Element;
		const out: Element[] = el.matches(`[${CHAT_TRANSCRIPT_ATTR}]`) ? [el] : [];
		for (const found of el.querySelectorAll(`[${CHAT_TRANSCRIPT_ATTR}]`)) out.push(found);
		return out;
	};

	const dropRanges = (root: Element) => {
		const old = rangesByRoot.get(root);
		if (!old) return;
		for (const highlight of highlights.values()) for (const range of old) highlight.delete(range);
		rangesByRoot.delete(root);
	};

	const scanRoot = (root: Element) => {
		dropRanges(root);
		if (!root.isConnected) return;
		const fresh: Range[] = [];
		// 只扫正文块：答案与用户消息都是 `.md`（`Markdown` / `StreamMarkdown` 同位），
		// 没包在 `.md` 里的东西（按钮、空状态文案）不参与装饰。
		const bodies = root.querySelectorAll(".md");
		const targets = bodies.length > 0 ? [...bodies] : [];
		for (const target of targets) {
			// scope：消息角色挂在整条消息的根上（`Message` 的 `data-role`），按正文体算一次即可。
			const role = target.closest("[data-role]")?.getAttribute("data-role") ?? "";
			const scoped = rules.filter((rule) => rule.scope === "all" || rule.scope === role);
			if (scoped.length === 0) continue;
			for (const block of collectBlocks(target)) {
				if (fresh.length > MAX_RANGES_PER_ROOT) break;
				const nodes = collectTextNodes(block, doc);
				if (nodes.length === 0) continue;
				let text = "";
				const lengths: number[] = [];
				for (const node of nodes) {
					lengths.push(node.data.length);
					text += node.data;
				}
				for (const rule of scoped) {
					const highlight = highlights.get(rule.name);
					if (!highlight) continue;
					for (const planned of planDecorationRanges(lengths, findDecorationMatches(text, rule.regex))) {
						const from = nodes[planned.fromNode];
						const to = nodes[planned.toNode];
						if (!from || !to) continue;
						const range = doc.createRange();
						range.setStart(from, planned.fromOffset);
						range.setEnd(to, planned.toOffset);
						highlight.add(range);
						fresh.push(range);
					}
				}
			}
		}
		rangesByRoot.set(root, fresh);
	};

	/** 取一个待扫描根：边扫边删，避免快照数组（也避免在遍历中改 Set）。 */
	const takeDirty = (): Element | null => {
		const next = dirty.values().next();
		if (next.done) return null;
		dirty.delete(next.value);
		return next.value;
	};

	const flush = () => {
		raf = 0;
		if (disposed) return;
		const started = Date.now();
		while (dirty.size > 0) {
			// 没扫完的留给下一帧，而不是一次性把主线程占死。
			if (Date.now() - started > FRAME_BUDGET_MS) {
				schedule();
				return;
			}
			const root = takeDirty();
			if (!root) return;
			scanRoot(root);
		}
	};

	const schedule = () => {
		if (disposed || raf) return;
		raf = requestAnimationFrame(flush);
	};

	const markDirty = (root: Element) => {
		if (disposed) return;
		dirty.add(root);
		schedule();
	};

	const observer = new MutationObserver((records) => {
		for (const record of records) {
			for (const root of transcriptOf(record.target)) markDirty(root);
			for (const added of record.addedNodes) for (const root of transcriptOf(added)) markDirty(root);
			for (const removed of record.removedNodes) for (const root of transcriptsIn(removed)) dropRanges(root);
		}
	});
	observer.observe(doc.body, { childList: true, characterData: true, subtree: true });

	for (const root of doc.querySelectorAll(`[${CHAT_TRANSCRIPT_ATTR}]`)) markDirty(root);

	return {
		flush() {
			if (disposed) return;
			if (raf) {
				cancelAnimationFrame(raf);
				raf = 0;
			}
			while (dirty.size > 0) {
				const root = takeDirty();
				if (!root) return;
				scanRoot(root);
			}
			// 已挂载的根也重扫一遍：不依赖 MutationObserver 的微任务时机，测试/强制刷新才确定。
			for (const root of Array.from(rangesByRoot.keys())) scanRoot(root);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			observer.disconnect();
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
			dirty.clear();
			for (const name of highlights.keys()) api.registry.delete(name);
			highlights.clear();
			rangesByRoot.clear();
			styleEl.remove();
		},
	};
}

function toSource(plugin: UiPluginInfo): ChatDecorationSource {
	return {
		pluginId: plugin.id,
		permissions: plugin.permissions,
		decorations: plugin.chatDecorations,
		settingsSchema: plugin.settingsSchema,
		settingsValues: plugin.settingsValues,
	};
}

/**
 * App 里调一次：插件清单（已过滤掉被禁用的）变化时重新编译并重挂。
 * 纯展示能力，不读会话状态，也不进协议。
 */
export function useChatDecorations(plugins: readonly UiPluginInfo[] | undefined): void {
	const compiled = useMemo(() => compileChatDecorations((plugins ?? []).map(toSource)), [plugins]);
	useEffect(() => {
		for (const message of compiled.diagnostics) console.warn("[chat-decorations]", message);
	}, [compiled]);
	useEffect(() => {
		if (compiled.rules.length === 0) return;
		const mount = mountChatDecorations(compiled.rules);
		return () => mount.dispose();
	}, [compiled]);
}
