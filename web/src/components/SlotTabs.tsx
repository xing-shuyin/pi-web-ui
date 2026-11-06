import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { JSX } from "react";
import { PluginIcon } from "../plugin-icon";
import { PluginPage } from "./PluginPage";
import type { UiPluginInfo } from "../types";
import type { UiSlotEntry } from "../ui-slots";

export interface SlotTab {
	id: string;
	label: string;
	icon?: string;
	iconSvg?: string;
	element?: ReactNode;
	hint?: string;
	pluginPage?: { plugin: UiPluginInfo; entry: UiSlotEntry };
}

interface SlotTabsProps {
	storageKey: string;
	tabs: SlotTab[];
	epoch: number;
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void;
	extra?: ReactNode;
	className?: string;
}

function tabStorageKey(storageKey: string): string {
	return `pi-web-ui:${storageKey}:tab`;
}

function loadActiveId(storageKey: string, tabs: SlotTab[]): string | null {
	try {
		const raw = localStorage.getItem(tabStorageKey(storageKey));
		if (!raw) return null;
		return tabs.some((x) => x.id === raw) ? raw : null;
	} catch {
		return null;
	}
}

function saveActiveId(storageKey: string, id: string): void {
	try {
		localStorage.setItem(tabStorageKey(storageKey), id);
	} catch {}
}

function isGlyphIcon(icon: string): boolean {
	return icon.length > 0 && !/[a-z]/i.test(icon);
}

function labelOf(tab: SlotTab): string {
	if (tab.label) return tab.label;
	const page = tab.pluginPage;
	return page?.entry.label || page?.plugin.name || tab.id;
}

export function SlotTabs({ storageKey, tabs, epoch, send, extra, className }: SlotTabsProps): JSX.Element | null {
	const baseId = useId();
	const [activeId, setActiveId] = useState<string>(() => loadActiveId(storageKey, tabs) ?? tabs[0]?.id ?? "");
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const savedRef = useRef<string>("");

	const index = tabs.findIndex((x) => x.id === activeId);
	const active = index >= 0 ? tabs[index] : tabs[0];
	const activeIndex = active ? tabs.indexOf(active) : -1;

	useEffect(() => {
		if (!active) return;
		if (activeId !== active.id) setActiveId(active.id);
		const key = `${storageKey}:${active.id}`;
		if (savedRef.current !== key) {
			savedRef.current = key;
			saveActiveId(storageKey, active.id);
		}
	}, [active, activeId, storageKey]);

	const selectTab = (tab: SlotTab): void => {
		setActiveId(tab.id);
		savedRef.current = `${storageKey}:${tab.id}`;
		saveActiveId(storageKey, tab.id);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
		const count = tabs.length;
		let next = -1;
		if (e.key === "ArrowRight") next = (i + 1) % count;
		else if (e.key === "ArrowLeft") next = (i - 1 + count) % count;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = count - 1;
		else return;
		const target = tabs[next];
		if (!target) return;
		e.preventDefault();
		selectTab(target);
		tabRefs.current[next]?.focus();
	};

	if (!active) return null;

	const panelId = `${baseId}-panel-${activeIndex}`;
	const cls = className ? `slot-tabs ${className}` : "slot-tabs";
	return (
		<div className={cls}>
			<div className="slot-tabs-bar" role="tablist">
				{tabs.map((tab, i) => {
					const selected = i === activeIndex;
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							id={`${baseId}-tab-${i}`}
							className={selected ? "slot-tab active" : "slot-tab"}
							title={tab.hint ?? labelOf(tab)}
							aria-selected={selected}
							aria-controls={`${baseId}-panel-${i}`}
							tabIndex={selected ? 0 : -1}
							ref={(node) => {
								tabRefs.current[i] = node;
							}}
							onClick={() => selectTab(tab)}
							onKeyDown={(e) => onKeyDown(e, i)}
						>
							{tab.iconSvg ? (
								<PluginIcon iconSvg={tab.iconSvg} className="slot-tab-icon" />
							) : tab.icon && isGlyphIcon(tab.icon) ? (
								<span className="slot-tab-icon">{tab.icon}</span>
							) : null}
							<span className="slot-tab-label">{labelOf(tab)}</span>
						</button>
					);
				})}
				{extra ? <div className="slot-tabs-extra">{extra}</div> : null}
			</div>
			<div className="slot-tabs-body" id={panelId} role="tabpanel" aria-labelledby={`${baseId}-tab-${activeIndex}`}>
				{active.pluginPage ? (
					<PluginPage plugin={active.pluginPage.plugin} epoch={epoch} send={send} />
				) : (
					(active.element ?? null)
				)}
			</div>
		</div>
	);
}
