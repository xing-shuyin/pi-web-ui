import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FiChevronDown, FiChevronUp, FiX } from "react-icons/fi";
import type { UiMessage } from "../types";
import { useT } from "../i18n";
import { collectFoldedHits, type FoldedResultMessage } from "../search-folded";

type SearchHit = { kind: "dom"; range: Range; msgId: string; k: number } | { kind: "folded"; msgId: string; k: number };

interface HitKey {
	msgId: string;
	k: number;
}

interface SearchBarProps {
	containerRef: RefObject<HTMLDivElement | null>;
	messages: readonly UiMessage[];
	collapsedIds: ReadonlySet<string>;
	toolResults: ReadonlyMap<string, UiMessage>;
	onExpand: (id: string) => void;
	onProgrammaticScroll?: () => void;
	open: boolean;
	onClose: () => void;
}

function collectRanges(root: HTMLElement, query: string): Range[] {
	const all: Range[] = [];
	const needle = query.toLowerCase();
	if (!needle) return all;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const el = node.parentElement;
			if (!el || el.closest(".search-bar")) return NodeFilter.FILTER_REJECT;
			if (el.closest(".msg-collapsed")) return NodeFilter.FILTER_REJECT;
			return (node.textContent ?? "").toLowerCase().includes(needle)
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_SKIP;
		},
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const lower = (node.textContent ?? "").toLowerCase();
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
	const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
	if (Ctor) css.highlights.set(name, new Ctor(...ranges));
}

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
	const [activeKey, setActiveKey] = useState<HitKey | null>(null);
	const [total, setTotal] = useState(0);
	const [, setActiveIdx] = useState(0);
	const deferredQuery = useDeferredValue(query);
	const q = open ? deferredQuery.trim() : "";

	const activeKeyRef = useRef<HitKey | null>(null);
	activeKeyRef.current = activeKey;
	const hitsRef = useRef<SearchHit[]>([]);
	const lastActiveRef = useRef<{ key: HitKey | null; kind?: string }>({
		key: null,
	});
	const lastQueryRef = useRef("");

	useEffect(() => {
		if (!open) return;
		setActiveKey(null);
		requestAnimationFrame(() => inputRef.current?.select());
	}, [open]);

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
			if (!key || key.msgId !== hits[idx].msgId || key.k !== hits[idx].k) {
				setActiveKey({ msgId: hits[idx].msgId, k: hits[idx].k });
			}
			setActiveIdx(idx);
			const hit = hits[idx];
			const last = lastActiveRef.current;
			const userMoved =
				last.key?.msgId !== hit.msgId ||
				last.key?.k !== hit.k ||
				(last.kind === "folded" && hit.kind === "dom") ||
				q !== lastQueryRef.current;
			lastActiveRef.current = { key: { msgId: hit.msgId, k: hit.k }, kind: hit.kind };
			lastQueryRef.current = q;

			const allRanges = hits
				.filter((h): h is Extract<SearchHit, { kind: "dom" }> => h.kind === "dom")
				.map((h) => h.range);
			setHighlight("msg-search", allRanges);

			if (hit.kind === "folded") {
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
