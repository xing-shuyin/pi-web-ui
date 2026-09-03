import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FiChevronDown, FiChevronUp, FiX } from "react-icons/fi";
import type { UiMessage } from "../types";
import { useT } from "../i18n";
import { collectFoldedHits, type FoldedResultMessage } from "../search-folded";

/**
 * 会话内搜索栏（Ctrl+F / Cmd+F，浏览器 find 风格）。
 *
 * - 已渲染消息命中以 **DOM 实际渲染文本为准**：markdown 渲染、折叠的思考/工具卡、
 *   bash 命令行美化输出等都会让「序列化消息文本」与「页面文本」不一致，
 *   按序列化文本索引的 occurrence 序号会指错区间（跳过去却不知道高亮了什么、
 *   计数里出现 DOM 上根本不存在的命中）。直接收集渲染后的文本区间，
 *   计数 / 导航 / 高亮三者天然一致，跳转一定落在真实可见的文本上。
 * - **折叠的旧消息（CollapsedMessage 摘要行）全文不在 DOM**：搜索期间把它们
 *   全部展开太重，改用「按需展开」——折叠层按消息数据做序列化索引（见
 *   search-folded.ts，字段与展开后的 DOM 渲染对齐），命中计入总数；导航到
 *   折叠命中时只展开那一条消息（onExpand），展开后同一语义位置 {msgId, k}
 *   从折叠命中转成 DOM 命中，精确定位 + 滚动到词。
 * - 高亮走 **CSS Custom Highlight API**（CSS.highlights + ::highlight()）：
 *   直接在 DOM 文本节点上建 Range，不侵入 react-markdown 渲染树；
 *   不支持的浏览器自动降级为只跳转不内联高亮（滚动仍然可靠）。
 * - 跳转 = 把下一个命中区间设为 active 高亮，并按命中词矩形精确居中滚动
 *   （横纵两个方向，见 scrollRangeIntoView —— 工具参数的超长单行只在水平
 *   溢出，纵向「已可见」也绝不能跳过容器）；流式更新时不抢用户滚动。
 */

/** 一条命中：渲染在 DOM 里（可高亮/滚动），或折叠层（需先展开这条消息）。 */
type SearchHit = { kind: "dom"; range: Range; msgId: string; k: number } | { kind: "folded"; msgId: string; k: number };

/** 语义位置：消息 id + 消息内第 k 次出现。展开不改变它 → 展开后能找回同一命中。 */
interface HitKey {
	msgId: string;
	k: number;
}

interface SearchBarProps {
	/** 消息滚动容器（.messages）——Range 收集与滚动都在其子树内。 */
	containerRef: RefObject<HTMLDivElement | null>;
	/** 消息集（作为依赖）：新消息 / 内容更新时重新收集命中区间。 */
	messages: readonly UiMessage[];
	/** 当前折叠为摘要行的消息 id（Map 里没有 = 已渲染）。 */
	collapsedIds: ReadonlySet<string>;
	/** toolCallId → toolResult 消息：折叠消息的搜索结果并入宿主 toolCall 卡。 */
	toolResults: ReadonlyMap<string, UiMessage>;
	/** 只展开一条折叠消息（按需，绝不全部展开）。 */
	onExpand: (id: string) => void;
	/** 搜索跳转即将程序性滚动消息列表：通知宿主让位「贴底吸回」机制
	 *  （用户贴底时展开折叠消息会被 MutationObserver 吸回底部，覆盖跳转）。 */
	onProgrammaticScroll?: () => void;
	open: boolean;
	onClose: () => void;
}

/** 在容器子树里收集所有包含 query 的文本区间（大小写不敏感，节点内匹配，文档序）。
 *  跳过搜索栏自身与折叠摘要行（后者由折叠层索引负责，避免双重计数）。 */
function collectRanges(root: HTMLElement, query: string): Range[] {
	const all: Range[] = [];
	const needle = query.toLowerCase();
	if (!needle) return all;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const el = node.parentElement;
			// 跳过搜索栏自身，避免高亮输入框里的查询文本
			if (!el || el.closest(".search-bar")) return NodeFilter.FILTER_REJECT;
			// 折叠摘要行的命中走折叠层（collectFoldedHits），展开后转 DOM 命中
			if (el.closest(".msg-collapsed")) return NodeFilter.FILTER_REJECT;
			return (node.textContent ?? "").toLowerCase().includes(needle)
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_SKIP;
		},
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const lower = (node.textContent ?? "").toLowerCase();
		// 只收消息气泡内的文本（[data-msg-id]），壳层文案（回到底部等）不参与命中
		if (!node.parentElement?.closest("[data-msg-id]")) continue;
		let idx = lower.indexOf(needle);
		while (idx !== -1) {
			const r = document.createRange();
			r.setStart(node, idx);
			r.setEnd(node, idx + needle.length);
			all.push(r);
			idx = lower.indexOf(needle, idx + needle.length);
		}
	}
	return all;
}

/** 合并已渲染（DOM）与折叠层的命中，按消息顺序排成全局文档序。 */
function collectAllHits(
	wrap: HTMLElement,
	query: string,
	messages: readonly UiMessage[],
	collapsedIds: ReadonlySet<string>,
	toolResults: ReadonlyMap<string, UiMessage>,
): SearchHit[] {
	const foldedCounts = collectFoldedHits(
		messages,
		collapsedIds,
		query,
		toolResults as ReadonlyMap<string, FoldedResultMessage>,
	);
	// DOM 命中按消息分组（外层的 collectRanges 本身是文档序）
	const domByMsg = new Map<string, Range[]>();
	for (const r of collectRanges(wrap, query)) {
		const node = r.startContainer.parentElement?.closest<HTMLElement>("[data-msg-id]");
		if (!node?.dataset.msgId) continue;
		const arr = domByMsg.get(node.dataset.msgId);
		if (arr) arr.push(r);
		else domByMsg.set(node.dataset.msgId, [r]);
	}
	const hits: SearchHit[] = [];
	for (const m of messages) {
		const dr = domByMsg.get(m.id);
		if (dr) {
			for (let k = 0; k < dr.length; k++) {
				hits.push({ kind: "dom", range: dr[k], msgId: m.id, k });
			}
		}
		const n = foldedCounts.get(m.id);
		if (n) {
			for (let k = 0; k < n; k++) hits.push({ kind: "folded", msgId: m.id, k });
		}
	}
	return hits;
}

function hitIndexOf(hits: SearchHit[], key: HitKey): number {
	return hits.findIndex((h) => h.msgId === key.msgId && h.k === key.k);
}

function setHighlight(name: string, ranges: Range[]) {
	const css = CSS as unknown as { highlights?: Map<string, unknown> };
	if (!css.highlights) return;
	if (ranges.length === 0) {
		css.highlights.delete(name);
		return;
	}
	// Highlight 构造器在旧 lib.dom 里没有类型，运行时按特性检测使用。
	const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
	if (Ctor) css.highlights.set(name, new Ctor(...ranges));
}

/** 从命中节点向容器方向收集带滚动的祖先（内 → 外）。 */
function collectScrollers(start: HTMLElement | null, end: HTMLElement): HTMLElement[] {
	const out: HTMLElement[] = [];
	let el = start;
	while (el && el !== end) {
		const cs = getComputedStyle(el);
		if (
			/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX) &&
			(el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
		) {
			out.push(el);
		}
		el = el.parentElement;
	}
	return out;
}

/** 命中词先在各内层滚动容器（tool 参数 / tool 输出 / bash 输出等自带滚动条的区域）
 *  里逐级居中——横纵两个方向都要滚：超长单行（ask_user_question 的 JSON 参数、
 *  bash 长行输出，white-space: pre 不换行）只在水平方向溢出，纵向“已可见”时
 *  绝不能跳过容器，否则词的 scrollLeft 永远停在 0、词被裁在视野外看不见。
 *  最内层先滚，reflow 后外层拿到更新后的坐标，最后再滚外层消息容器。
 *  保证「搜索到了」就一定看得见；区间已可见则不打扰。 */
function scrollRangeIntoView(wrap: HTMLElement, range: Range) {
	const start = range.startContainer.parentElement as HTMLElement | null;
	for (const s of collectScrollers(start, wrap)) {
		const rr = range.getBoundingClientRect();
		const sr = s.getBoundingClientRect();
		if (rr.height <= 0 || rr.width <= 0) return;
		if (!(rr.top >= sr.top + 4 && rr.bottom <= sr.bottom - 4)) {
			s.scrollTop += rr.top - sr.top - (s.clientHeight - rr.height) / 2;
		}
		if (!(rr.left >= sr.left + 4 && rr.right <= sr.right - 4)) {
			s.scrollLeft += rr.left - sr.left - (s.clientWidth - rr.width) / 2;
		}
	}
	const rr = range.getBoundingClientRect();
	const wr = wrap.getBoundingClientRect();
	if (rr.height <= 0 || rr.width <= 0) return;
	// 外层消息容器：横纵都完整可见（留 6px 余量）才不打扰，避免相邻命中抖动
	const vVisible = rr.top >= wr.top + 6 && rr.bottom <= wr.bottom - 6;
	const hVisible = rr.left >= wr.left + 6 && rr.right <= wr.right - 6;
	if (vVisible && hVisible) return;
	if (!vVisible) wrap.scrollTop += rr.top - wr.top - (wr.height - rr.height) / 2;
	if (!hVisible) {
		wrap.scrollLeft += rr.left - wr.left - (wr.width - rr.width) / 2;
	}
}

export function SearchBar({
	containerRef,
	messages,
	collapsedIds,
	toolResults,
	onExpand,
	onProgrammaticScroll,
	open,
	onClose,
}: SearchBarProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	/** 语义位置（消息 id + 消息内第 k 次出现）——折叠展开后据此找回同一命中。 */
	const [activeKey, setActiveKey] = useState<HitKey | null>(null);
	/** 命中总数（rAF 内更新，驱动计数显示与 step 取模）。 */
	const [total, setTotal] = useState(0);
	const [, setActiveIdx] = useState(0);
	const deferredQuery = useDeferredValue(query);
	const q = open ? deferredQuery.trim() : "";

	// refs 镜像最新值，供 rAF 回调读取而不重建 effect
	const activeKeyRef = useRef<HitKey | null>(null);
	activeKeyRef.current = activeKey;
	/** 本帧收集到的命中序列（step / 计数显示读它）。 */
	const hitsRef = useRef<SearchHit[]>([]);
	/** 上次 rAF 结束时的 active 语义位置、命中种类与查询 —— 区分「用户主动导航/
	 *  换查询」和「内容被动更新（流式/新快照）」：前者滚动 + 触发折叠展开，
	 *  后者只刷新高亮、绝不抢滚动。 */
	const lastActiveRef = useRef<{ key: HitKey | null; kind?: string }>({
		key: null,
	});
	const lastQueryRef = useRef("");

	// 打开时聚焦输入框；若消息区有选中文本则预填
	useEffect(() => {
		if (!open) return;
		setActiveKey(null);
		requestAnimationFrame(() => inputRef.current?.select());
	}, [open]);

	// 打开期间拦截 Esc 关闭
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open, onClose]);

	// 关闭/卸载/清空时清理高亮
	useEffect(() => {
		if (!open) {
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
		}
		return () => {
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
		};
	}, [open]);

	// 收集命中 + 设置 active 高亮 + 滚动 + 按需展开折叠命中。
	// **activeKey 必须进依赖**：每次 prev/next 都重跑这一段，高亮与滚动才会
	// 跟着「下一个」移动。滚动只在「用户导航、换了查询、或折叠命中展开后转
	// 成 DOM 命中」时发生；流式更新消息内容时（messages 引用变化）只重收集/
	// 重高亮，避免视图被反复拽走。
	useLayoutEffect(() => {
		const clear = () => {
			setTotal(0);
			setActiveKey(null);
			setActiveIdx(0);
			hitsRef.current = [];
			setHighlight("msg-search", []);
			setHighlight("msg-search-active", []);
			lastActiveRef.current = { key: null };
			lastQueryRef.current = "";
		};
		if (!open || !q) {
			clear();
			return;
		}
		const wrap = containerRef.current;
		if (!wrap) return;
		let cancelled = false;
		let raf = 0;
		raf = requestAnimationFrame(() => {
			if (cancelled) return;
			const hits = collectAllHits(wrap, q, messages, collapsedIds, toolResults);
			hitsRef.current = hits;
			const n = hits.length;
			setTotal(n);
			if (n === 0) {
				setActiveKey(null);
				setActiveIdx(0);
				setHighlight("msg-search", []);
				setHighlight("msg-search-active", []);
				lastActiveRef.current = { key: null };
				lastQueryRef.current = q;
				return;
			}
			// 按当前语义位置找回序号；找不到（换查询/清空）则取第一个。
			// 若 key 的消息还在但第 k 次出现因展开后 DOM 与序列化计数不一致而
			// 越界（markdown 转义等），按 k 钳位到该消息内最近的一个命中——绝不
			// 弹回全局第一个（会打转）也不落到该消息最后一个（拽回原位）。
			const key = activeKeyRef.current;
			let idx: number;
			if (key) {
				idx = hitIndexOf(hits, key);
				if (idx === -1) {
					const same: number[] = [];
					for (let j = 0; j < hits.length; j++) {
						if (hits[j].msgId === key.msgId) same.push(j);
					}
					if (same.length > 0) {
						const at = Math.min(key.k, same.length - 1);
						idx = same[at];
					} else {
						idx = 0;
					}
				}
			} else {
				idx = 0;
			}
			if (idx < 0) idx = 0;
			if (idx >= n) idx = n - 1;
			// 值相等时绝不 setState（新对象引用会触发 re-render → effect 重跑 →
			// rAF 风暴，把滚动机会全部吞掉）。
			if (!key || key.msgId !== hits[idx].msgId || key.k !== hits[idx].k) {
				setActiveKey({ msgId: hits[idx].msgId, k: hits[idx].k });
			}
			setActiveIdx(idx);
			const hit = hits[idx];
			const last = lastActiveRef.current;
			// 用户主动动作 = 语义位置变了、查询变了、或折叠命中展开后转成 DOM 命中
			const userMoved =
				last.key?.msgId !== hit.msgId ||
				last.key?.k !== hit.k ||
				(last.kind === "folded" && hit.kind === "dom") ||
				q !== lastQueryRef.current;
			lastActiveRef.current = { key: { msgId: hit.msgId, k: hit.k }, kind: hit.kind };
			lastQueryRef.current = q;

			// 非 DOM 命中全部预高亮（折叠层命中没有 Range，只高亮 DOM 部分）
			const allRanges = hits
				.filter((h): h is Extract<SearchHit, { kind: "dom" }> => h.kind === "dom")
				.map((h) => h.range);
			setHighlight("msg-search", allRanges);

			if (hit.kind === "folded") {
				// 词还没进 DOM：只展开这条消息，不滚动。下一轮 collapsedIds 变化后
				// effect 重跑，同一语义位置转成 DOM 命中再精确滚动定位。
				setHighlight("msg-search-active", []);
				if (userMoved) onExpand(hit.msgId);
				return;
			}
			setHighlight("msg-search-active", [hit.range]);
			if (userMoved) {
				onProgrammaticScroll?.();
				scrollRangeIntoView(wrap, hit.range);
			}
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
		};
	}, [open, q, messages, containerRef, activeKey, collapsedIds, toolResults, onExpand, onProgrammaticScroll]);

	const step = useCallback((dir: 1 | -1) => {
		const hits = hitsRef.current;
		const n = hits.length;
		if (n === 0) return;
		const key = activeKeyRef.current;
		const cur = key ? hitIndexOf(hits, key) : 0;
		const nextKey = hits[(cur + dir + n) % n];
		setActiveKey(nextKey.kind === "dom" || nextKey.kind === "folded" ? { msgId: nextKey.msgId, k: nextKey.k } : null);
	}, []);

	if (!open) return null;
	const shownIdx = activeKey
		? (() => {
				const i = hitIndexOf(hitsRef.current, activeKey);
				return i === -1 ? 0 : i;
			})()
		: 0;
	return (
		<div className="search-bar" role="search">
			<input
				ref={inputRef}
				className="search-input"
				type="text"
				value={query}
				placeholder={t("searchPlaceholder")}
				onChange={(e) => {
					setQuery(e.target.value);
					// 不在这里重置 activeKey：新查询的旧 key 在 hitIndexOf 里自然检索
					// 失败后回落第一个命中；手动置 null 会让逐字输入时每个字符都
					// 重新激活 idx=0，配合 rAF 风暴吞掉初始滚动（见上方 setActiveKey
					// 的值比较守卫）。
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						step(e.shiftKey ? -1 : 1);
					}
				}}
			/>
			<span className={`search-count ${total === 0 ? "empty" : ""}`}>
				{total === 0 ? t("searchNoResults") : `${Math.min(shownIdx + 1, total)}/${total}`}
			</span>
			<button
				type="button"
				className="search-btn"
				title={t("searchPrev")}
				disabled={total === 0}
				onClick={() => step(-1)}
			>
				<FiChevronUp />
			</button>
			<button
				type="button"
				className="search-btn"
				title={t("searchNext")}
				disabled={total === 0}
				onClick={() => step(1)}
			>
				<FiChevronDown />
			</button>
			<button type="button" className="search-btn" title={t("searchClose")} onClick={onClose}>
				<FiX />
			</button>
		</div>
	);
}
