import { Fragment, useState, type ReactNode } from "react";
import type { ChatState } from "../use-chat";
import { appSend, useAppField } from "../app-globals";
import type { UiSlotEntry } from "../ui-slots";
import { ProjectPicker } from "./ProjectPicker.js";
import { BarItem, type ViewName } from "./BarItem";

interface FooterBarProps {
	bottombarItems?: import("../ui-slots").UiSlotEntry[];
	onUiAction?: (item: import("../ui-slots").UiSlotEntry, value?: string) => void;
	chat: ChatState;
	onOpenSettings?: () => void;
	onViewChange?: (view: ViewName) => void;
	onCreateCli?: (cwd?: string) => void;
	onOpenGlobalSearch?: () => void;
	onOpenBgTasks?: () => void;
}

const FALLBACK_BOTTOMBAR: { id: string; align: "start" | "end" }[] = [
	{ id: "host:conn", align: "start" },
	{ id: "host:engine", align: "start" },
	{ id: "host:ctx", align: "start" },
	{ id: "host:cost", align: "start" },
	{ id: "host:cache", align: "start" },
	{ id: "host:msg-count", align: "start" },
	{ id: "host:plugin-status", align: "start" },
	{ id: "host:status-delegate", align: "start" },
	{ id: "host:working", align: "start" },
	{ id: "host:host-metrics", align: "end" },
	{ id: "host:cwd", align: "end" },
];

export function FooterBar({
	chat,
	bottombarItems,
	onUiAction,
	onOpenSettings,
	onViewChange,
	onCreateCli,
	onOpenGlobalSearch,
	onOpenBgTasks,
}: FooterBarProps) {
	const workspaceRoots = useAppField("workspaceRoots");
	const state = chat.state;
	const [editing, setEditing] = useState(false);

	if (!state) return null;

	const entries: { id: string; entry: UiSlotEntry | null; fallbackAlign: "start" | "end" }[] = bottombarItems
		? bottombarItems.map((e) => ({ id: e.id, entry: e, fallbackAlign: "start" as const }))
		: FALLBACK_BOTTOMBAR.map(({ id, align }) => ({ id, entry: null, fallbackAlign: align }));
	const leftItems: { key: string; node: ReactNode }[] = [];
	const centerItems: { key: string; node: ReactNode }[] = [];
	const rightItems: { key: string; node: ReactNode }[] = [];

	for (const { id, entry, fallbackAlign } of entries) {
		if (entry?.hidden) continue;
		const actualEntry: UiSlotEntry = entry ?? {
			id,
			slot: "bottombar",
			source: "host",
			label: id.slice("host:".length),
			kind: "action",
			order: 100,
			align: fallbackAlign,
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		};

		const node = (
			<BarItem
				entry={actualEntry}
				bar="bottom"
				chat={chat}
				view={undefined}
				onViewChange={onViewChange}
				onCreateCli={onCreateCli}
				onOpenSettings={onOpenSettings}
				onOpenGlobalSearch={onOpenGlobalSearch}
				onOpenBgTasks={onOpenBgTasks}
				onOpenProjectPicker={() => setEditing(true)}
				isProjectPickerOpen={editing}
				onUiAction={onUiAction}
			/>
		);

		if (!node) continue;
		const zone = actualEntry.align ?? fallbackAlign;
		if (zone === "end") {
			rightItems.push({ key: id, node });
		} else if (zone === "center") {
			centerItems.push({ key: id, node });
		} else {
			leftItems.push({ key: id, node });
		}
	}

	const renderGroup = (groupItems: { key: string; node: ReactNode }[]) =>
		groupItems.map((it) => <Fragment key={it.key}>{it.node}</Fragment>);

	return (
		<footer className="statusbar">
			<div className="statusbar-left">{renderGroup(leftItems)}</div>
			{centerItems.length > 0 && <div className="statusbar-center">{renderGroup(centerItems)}</div>}
			<div className="statusbar-right">{renderGroup(rightItems)}</div>
			{editing && (
				<ProjectPicker
					open
					currentCwd={state.cwd}
					pathCompletions={chat.pathCompletions}
					workspaceRoots={workspaceRoots}
					onClose={() => setEditing(false)}
					onSelectDirectory={(p) => {
						if (p && p !== state.cwd) appSend({ type: "set_cwd", path: p });
						setEditing(false);
					}}
					mode="folder"
				/>
			)}
		</footer>
	);
}
