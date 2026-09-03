import { memo, useEffect, useState } from "react";
import { FiCheck, FiChevronsLeft, FiFolder, FiMessageSquare, FiTrash2 } from "react-icons/fi";
import type { ConversationSummary, ProjectSummary, SessionSummary } from "../types";
import type { ConnStatus } from "../use-chat";
import { useT } from "../i18n";

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in, so the shallow-compared memo() below skips
 *  this entire panel during streaming instead of re-reconciling the file tree
 *  and conversation lists on every delta. Add a prop here when adding a chat
 *  field usage — TypeScript enforces it at the call site. */
interface LeftPanelProps {
	ready: boolean;
	status: ConnStatus;
	cwd: string;
	sessionFile: string | null;
	conversations: ConversationSummary[];
	sessions: SessionSummary[];
	projects: ProjectSummary[];
	activeConversationId: string;
	send: (
		msg:
			| { type: "new_chat" }
			| { type: "list_sessions" }
			| { type: "list_projects" }
			| { type: "switch_session"; path: string }
			| { type: "switch_conversation"; id: string }
			| { type: "set_cwd"; path: string }
			| { type: "remove_project"; path: string }
			| { type: "delete_session"; path: string },
	) => boolean;
	/** True while the panel is actually on screen (desktop: always; mobile:
	 *  only while the drawer is open). Drives lazy loading of the session
	 *  list + recent projects — both scan session files on disk. */
	active: boolean;
	/** Desktop: show the collapse button (mobile drawers close via the topbar). */
	collapsible?: boolean;
	/** Fired when the user clicks the collapse button. */
	onToggleCollapse?: () => void;
}

function formatModified(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	if (sameDay) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	}
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface ConvGroup {
	cwd: string;
	isCurrent: boolean;
	convs: ConversationSummary[];
}

/** Group the (now cross-project) running-conversation list by workspace,
 *  current project first, others in stable path order. Lets the left panel
 *  disambiguate same-titled chats across projects and shows where each
 *  background run lives. */
function groupConversations(list: ConversationSummary[], currentCwd: string): ConvGroup[] {
	const byCwd = new Map<string, ConversationSummary[]>();
	for (const c of list) {
		const arr = byCwd.get(c.cwd) ?? [];
		arr.push(c);
		byCwd.set(c.cwd, arr);
	}
	const groups: ConvGroup[] = [...byCwd.entries()].map(([cwd, convs]) => ({
		cwd,
		isCurrent: cwd === currentCwd,
		convs,
	}));
	groups.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
	return groups;
}

export const LeftPanel = memo(function LeftPanel({
	ready,
	status,
	cwd,
	sessionFile,
	conversations,
	sessions,
	projects,
	activeConversationId,
	send,
	active,
	collapsible,
	onToggleCollapse,
}: LeftPanelProps) {
	const t = useT();
	const currentFile = sessionFile;
	const currentCwd = cwd;
	// Two-step delete confirm: which row ("proj:<path>" / "sess:<path>") is
	// awaiting its second click. Mirrors the settings-panel uninstall pattern.
	const [confirmDel, setConfirmDel] = useState<string | null>(null);

	// Lazy load + stale-while-revalidate: (re)fetch whenever the panel is on
	// screen, the connection is ready, or the workspace changed. Old data
	// stays visible while the fresh listing is in flight.
	useEffect(() => {
		if (!active || !ready || status !== "open") return;
		if (!cwd) return;
		send({ type: "list_sessions" });
		send({ type: "list_projects" });
	}, [active, ready, status, cwd, send]);

	const displayName = (s: SessionSummary): string => {
		const title = s.name || s.firstMessage.trim();
		return title.length > 0 ? title : t("emptyChat");
	};

	const projectName = (path: string): string => path.split(/[\\/]/).pop() || path;

	/** Hover-revealed delete button with two-step confirm (the .lp-row wrapper
	 *  positions it; stopPropagation keeps the row click from firing). */
	const delButton = (key: string, hint: string, confirmHint: string, onConfirm: () => void) => {
		const armed = confirmDel === key;
		return (
			<button
				type="button"
				className={`lp-del ${armed ? "confirm" : ""}`}
				title={armed ? confirmHint : hint}
				onClick={(e) => {
					e.stopPropagation();
					if (armed) {
						setConfirmDel(null);
						onConfirm();
					} else {
						setConfirmDel(key);
					}
				}}
			>
				{armed ? <FiCheck /> : <FiTrash2 />}
			</button>
		);
	};

	return (
		<aside className="panel panel-left">
			{collapsible && onToggleCollapse && (
				<button type="button" className="panel-collapse-btn" title={t("collapsePanel")} onClick={onToggleCollapse}>
					<FiChevronsLeft />
				</button>
			)}
			{projects.length > 0 && (
				<div className="panel-projects">
					<div className="panel-section-title">{t("recentProjects")}</div>
					<div className="projects-scroll">
						{projects.map((p) => {
							const active = currentCwd === p.path;
							return (
								<div
									className="lp-row"
									key={p.path}
									onMouseLeave={() => setConfirmDel((k) => (k === `proj:${p.path}` ? null : k))}
								>
									<button
										type="button"
										className={`project-item ${active ? "active" : ""}`}
										title={p.path}
										onClick={() => {
											if (!active) send({ type: "set_cwd", path: p.path });
										}}
									>
										<FiFolder className="project-icon" />
										<span className="project-info">
											<span className="project-name">{projectName(p.path)}</span>
											<span className="project-path">{p.path}</span>
										</span>
										<span className="project-time">{formatModified(p.lastUsed)}</span>
									</button>
									{delButton(`proj:${p.path}`, t("deleteProject"), t("deleteProjectConfirm"), () =>
										send({ type: "remove_project", path: p.path }),
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}
			{conversations.length > 0 && (
				<div className="panel-convs">
					<div className="panel-section-title">{t("runningConversations")}</div>
					{groupConversations(conversations, cwd).map((g) => (
						<div key={g.cwd} className="panel-conv-group">
							{!g.isCurrent && (
								<div className="panel-conv-group-title" title={g.cwd}>
									{projectName(g.cwd)}
								</div>
							)}
							{g.convs.map((c) => {
								const active = activeConversationId === c.id;
								return (
									<button
										type="button"
										key={c.id}
										className={`session-item ${active ? "active" : ""}`}
										title={`${c.title}${g.isCurrent ? "" : ` — ${g.cwd}`}`}
										onClick={() => {
											if (!active) send({ type: "switch_conversation", id: c.id });
										}}
									>
										<FiMessageSquare className="session-icon" />
										<span className="session-info">
											<span className="session-title">{c.title}</span>
											<span className="session-sub">
												{active ? t("current") : t("messageCount", { n: c.messageCount })}
											</span>
										</span>
										{c.isStreaming && <span className="conv-streaming" title={t("streaming")} />}
									</button>
								);
							})}
						</div>
					))}
					<div className="panel-section-divider" />
				</div>
			)}
			<div className="panel-sessions">
				<div className="panel-section-title">{t("historySessions")}</div>
				<div className="sessions-scroll">
					{sessions.length === 0 && <div className="panel-empty">{t("noHistory")}</div>}
					{sessions.map((s) => {
						const active = currentFile === s.path;
						return (
							<div
								className="lp-row"
								key={s.path}
								onMouseLeave={() => setConfirmDel((k) => (k === `sess:${s.path}` ? null : k))}
							>
								<button
									type="button"
									className={`session-item ${active ? "active" : ""}`}
									title={s.path}
									onClick={() => {
										if (!active) send({ type: "switch_session", path: s.path });
									}}
								>
									<FiMessageSquare className="session-icon" />
									<span className="session-info">
										<span className="session-title">{displayName(s)}</span>
										<span className="session-sub">
											{active ? t("current") : t("messageCount", { n: s.messageCount })}
											{s.source === "tui" && (
												<span className="session-src" title={t("tuiTip")}>
													TUI
												</span>
											)}
										</span>
									</span>
									<span className="session-time">{formatModified(s.modified)}</span>
								</button>
								{delButton(`sess:${s.path}`, t("deleteSession"), t("deleteSessionConfirm"), () =>
									send({ type: "delete_session", path: s.path }),
								)}
							</div>
						);
					})}
				</div>
			</div>
		</aside>
	);
});
