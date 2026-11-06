import { Fragment, type ReactNode } from "react";
import { SlotErrorBoundary } from "./components/SlotErrorBoundary";
import type { UiSlotEntry } from "./ui-slots";

export function renderSlotToolbar(
	entries: UiSlotEntry[] | undefined,
	onUiAction: ((item: UiSlotEntry, value?: string) => void) | undefined,
) {
	if (!entries || entries.length === 0) return null;
	return (
		<span className="slot-toolbar">
			{entries.map((entry, i) => (
				<SlotErrorBoundary
					key={`${entry.id}#${i}`}
					label={entry.label || entry.id}
					slot={entry.slot}
					entryId={entry.id}
				>
					{renderSlotEntry(entry, i, onUiAction)}
				</SlotErrorBoundary>
			))}
		</span>
	);
}

function renderSlotEntry(
	entry: UiSlotEntry,
	i: number,
	onUiAction: ((item: UiSlotEntry, value?: string) => void) | undefined,
) {
	const key = `${entry.id}#${i}`;
	const label = entry.label || entry.id;
	const tip = entry.hint || label;
	if (entry.kind === "divider") return <span key={key} className="slot-divider" aria-hidden="true" />;
	if (entry.kind === "badge")
		return (
			<span key={key} className="slot-badge" title={tip}>
				{entry.badge ?? label}
			</span>
		);
	if (entry.kind === "toggle")
		return (
			<button
				key={key}
				type="button"
				className={`slot-btn${entry.checked ? " on" : ""}`}
				title={tip}
				aria-label={label}
				aria-pressed={!!entry.checked}
				onClick={() => onUiAction?.(entry)}
			>
				{entry.icon ? <span aria-hidden>{entry.icon}</span> : null}
				<span>{label}</span>
			</button>
		);
	if (entry.kind === "progress")
		return (
			<span key={key} className="slot-progress" title={`${tip} ${entry.progress ?? 0}%`}>
				<progress value={entry.progress ?? 0} max={100} />
			</span>
		);
	if (entry.kind === "input")
		return (
			<input
				key={`${key}:${entry.value ?? ""}`}
				className="slot-input"
				defaultValue={entry.value ?? ""}
				placeholder={label}
				title={tip}
				aria-label={label}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.nativeEvent.isComposing)
						onUiAction?.(entry, (e.target as HTMLInputElement).value);
				}}
			/>
		);
	if (entry.kind === "select" && entry.options?.length)
		return (
			<select
				key={key}
				className="slot-select"
				title={tip}
				aria-label={label}
				value={entry.options.some((o) => o.value === entry.value) ? (entry.value as string) : entry.options[0]!.value}
				onChange={(e) => onUiAction?.(entry, e.target.value)}
			>
				{entry.options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		);
	return (
		<button
			key={key}
			type="button"
			className="slot-btn"
			title={tip}
			aria-label={label}
			onClick={() => onUiAction?.(entry)}
		>
			{entry.icon ? <span aria-hidden>{entry.icon}</span> : null}
			<span>{label}</span>
		</button>
	);
}

export function renderMergedToolbar(
	entries: UiSlotEntry[],
	hostNodes: Record<string, ReactNode>,
	onUiAction: ((item: UiSlotEntry, value?: string) => void) | undefined,
) {
	const out: ReactNode[] = [];
	let run: UiSlotEntry[] = [];
	let visible = false;
	const flush = (key: string) => {
		if (run.length === 0) return;
		visible = true;
		out.push(
			<span key={key} className="slot-toolbar">
				{run.map((e, i) => (
					<SlotErrorBoundary key={`${e.id}#${i}`} label={e.label || e.id} slot={e.slot} entryId={e.id}>
						{renderSlotEntry(e, i, onUiAction)}
					</SlotErrorBoundary>
				))}
			</span>,
		);
		run = [];
	};
	entries.forEach((e, i) => {
		if (e.source === "host") {
			flush(`gap${i}`);
			const node = hostNodes[e.id] ?? null;
			if (node) visible = true;
			out.push(<Fragment key={e.id}>{node}</Fragment>);
		} else {
			run.push(e);
		}
	});
	flush("tail");
	if (!visible) return null;
	return <>{out}</>;
}
