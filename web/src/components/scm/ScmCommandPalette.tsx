import { useEffect, useMemo, useRef, useState } from "react";
import { FiSearch } from "react-icons/fi";
import { useEscapeKey } from "../../shortcut-stack";
import { useOverlayZIndex } from "../../overlay-stack";
import type { ScmPaletteAction } from "../../scm-palette-actions";

/**
 * Git 操作面板：替代原先「更多」菜单里十几项平铺按钮。
 *
 * 只负责“搜索 + 键盘选择 + 分组渲染”，动作从 `buildScmPaletteActions` 进来（纯数据），
 * 这样禁用条件、分组、badge 都能在单测里核对，不用渲染 React。
 */
export interface ScmCommandPaletteLabels {
	title: string;
	placeholder: string;
	empty: string;
	move: string;
	run: string;
	close: string;
	count: (n: number) => string;
}

interface Props {
	open: boolean;
	onClose: () => void;
	labels: ScmCommandPaletteLabels;
	actions: ScmPaletteAction[];
}

function matches(action: ScmPaletteAction, query: string): boolean {
	if (!query) return true;
	const hay = `${action.label} ${action.hint ?? ""} ${action.group} ${action.id}`.toLowerCase();
	return hay.includes(query);
}

export function ScmCommandPalette({ open, onClose, labels, actions }: Props) {
	const zIndex = useOverlayZIndex(open);
	const [query, setQuery] = useState("");
	const [cursor, setCursor] = useState(0);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	useEscapeKey(onClose, open);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setCursor(0);
		const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
		return () => window.clearTimeout(timer);
	}, [open]);

	const normalized = query.trim().toLowerCase();
	const rows = useMemo(() => actions.filter((a) => matches(a, normalized)), [actions, normalized]);

	// 过滤 / 状态变化后游标落到第一条可执行项：不让 Enter 落在灰掉的行上。
	useEffect(() => {
		const first = rows.findIndex((r) => !r.disabled);
		setCursor(first < 0 ? 0 : first);
	}, [rows]);

	const groups = useMemo(() => {
		const order: string[] = [];
		const map = new Map<string, { action: ScmPaletteAction; index: number }[]>();
		rows.forEach((action, index) => {
			if (!map.has(action.group)) {
				map.set(action.group, []);
				order.push(action.group);
			}
			map.get(action.group)?.push({ action, index });
		});
		return order.map((group) => ({ group, items: map.get(group) ?? [] }));
	}, [rows]);

	useEffect(() => {
		if (!open) return;
		const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
		el?.scrollIntoView({ block: "nearest" });
	}, [cursor, open]);

	if (!open) return null;

	const run = (action: ScmPaletteAction | undefined) => {
		if (!action || action.disabled) return;
		onClose();
		action.run();
	};

	const step = (delta: number) => {
		if (rows.length === 0) return;
		setCursor((prev) => {
			let next = prev;
			for (let i = 0; i < rows.length; i++) {
				next += delta;
				if (next < 0) next = rows.length - 1;
				if (next >= rows.length) next = 0;
				if (!rows[next].disabled) return next;
			}
			return prev;
		});
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			step(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			step(-1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			run(rows[cursor]);
		}
	};

	return (
		<div
			className="scm-pal-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={labels.title}
			style={{ zIndex }}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
			onKeyDown={onKeyDown}
		>
			<div className="scm-pal">
				<div className="scm-pal-head">
					<FiSearch aria-hidden="true" />
					<input
						ref={inputRef}
						value={query}
						placeholder={labels.placeholder}
						aria-label={labels.placeholder}
						onChange={(e) => setQuery(e.target.value)}
						autoComplete="off"
						spellCheck={false}
					/>
					<span className="scm-pal-kbd">Esc</span>
				</div>
				<div className="scm-pal-list" ref={listRef} role="listbox" aria-label={labels.title}>
					{rows.length === 0 ? (
						<div className="scm-pal-empty">{labels.empty}</div>
					) : (
						groups.map((group) => (
							<div key={group.group} className="scm-pal-group">
								<div className="scm-pal-group-title">{group.group}</div>
								{group.items.map(({ action, index }) => (
									<button
										key={action.id}
										type="button"
										role="option"
										aria-selected={index === cursor}
										data-idx={index}
										disabled={action.disabled}
										className={`scm-pal-row${index === cursor ? " on" : ""}${
											action.tone === "danger" ? " danger" : ""
										}`}
										onMouseMove={() => setCursor(index)}
										onClick={() => run(action)}
										title={action.hint ?? action.label}
									>
										<span className="scm-pal-row-main">
											<span className="scm-pal-row-label">{action.label}</span>
											{action.hint && <span className="scm-pal-row-hint">{action.hint}</span>}
										</span>
										{action.badge && <span className="scm-pal-badge">{action.badge}</span>}
									</button>
								))}
							</div>
						))
					)}
				</div>
				<div className="scm-pal-foot">
					<span>
						<span className="scm-pal-kbd">↑</span>
						<span className="scm-pal-kbd">↓</span>
						{labels.move}
					</span>
					<span>
						<span className="scm-pal-kbd">⏎</span>
						{labels.run}
					</span>
					<span>
						<span className="scm-pal-kbd">Esc</span>
						{labels.close}
					</span>
					<span className="scm-pal-count">{labels.count(rows.length)}</span>
				</div>
			</div>
		</div>
	);
}
