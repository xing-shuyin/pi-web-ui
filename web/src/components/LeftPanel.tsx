import { memo, useEffect, useState, useCallback } from "react";
import {
	FiCheck,
	FiChevronDown,
	FiChevronUp,
	FiChevronsLeft,
	FiEdit2,
	FiFolder,
	FiMessageSquare,
	FiTrash2,
	FiX,
} from "react-icons/fi";
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
			| { type: "delete_session"; path: string }
			| { type: "rename_session"; path: string; name: string }
			| { type: "rename_conversation"; id: string; name: string }
			| { type: "dismiss_conversation"; id: string },
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

const LS_COLLAPSE_PROJECTS = "pi-web-ui:lp-collapse-projects";
const LS_COLLAPSE_CONVS = "pi-web-ui:lp-collapse-convs";
const LS_COLLAPSE_SESSIONS = "pi-web-ui:lp-collapse-sessions";

function useCollapsed(key: string, defaultCollapsed = false): [boolean, () => void] {
	const [collapsed, setCollapsed] = useState(() => {
		try {
			const v = localStorage.getItem(key);
			if (v === "1") return true;
			if (v === "0") return false;
		} catch {}
		return defaultCollapsed;
	});
	const toggle = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(key, next ? "1" : "0");
			} catch {}
			return next;
		});
	}, [key]);
	return [collapsed, toggle];
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
	const [confirmDel, setConfirmDel] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [collapseProjects, toggleProjects] = useCollapsed(LS_COLLAPSE_PROJECTS, false);
	const [collapseConvs, toggleConvs] = useCollapsed(LS_COLLAPSE_CONVS, false);
	const [collapseSessions, toggleSessions] = useCollapsed(LS_COLLAPSE_SESSIONS, false);

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

	const delButton = (key: string, hint: string, confirmHint: string, onConfirm: () => void, icon?: React.ReactNode) => {
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
				{armed ? <FiCheck /> : (icon ?? <FiTrash2 />)}
			</button>
		);
	};

	const sectionHeader = (title: string, collapsed: boolean, onToggle: () => void, count?: number) => (
		<button
			type="button"
			className="lp-section-title panel-section-title"
			onClick={onToggle}
			title={collapsed ? t("expandSection") : t("collapseSection")}
		>
			<span className="lp-section-title-text">
				{title}
				{count !== undefined ? ` (${count})` : ""}
			</span>
			<span className="lp-section-chevron">{collapsed ? <FiChevronDown /> : <FiChevronUp />}</span>
		</button>
	);

	// At least one section expanded check done via CSS flex, but we still render headers always.

	return (
		<aside className="panel panel-left lp-panel">
			{collapsible && onToggleCollapse && (
				<button type="button" className="panel-collapse-btn" title={t("collapsePanel")} onClick={onToggleCollapse}>
					<FiChevronsLeft />
				</button>
			)}
			{/* Recent projects — collapsible, flex share */}
			{projects.length > 0 && (
				<div className={`lp-section panel-projects ${collapseProjects ? "collapsed" : ""}`}>
					{sectionHeader(t("recentProjects"), collapseProjects, toggleProjects, projects.length)}
					{!collapseProjects && (
						<div className="lp-section-body projects-scroll">
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
					)}
				</div>
			)}

			{/* Running conversations — collapsible, flex share. Hidden when empty to keep old layout expectations. */}
			{conversations.length > 0 && (
				<div className={`lp-section lp-section-convs panel-convs ${collapseConvs ? "collapsed" : ""}`}>
					{sectionHeader(t("runningConversations"), collapseConvs, toggleConvs, conversations.length)}
					{!collapseConvs && (
						<div className="lp-section-body convs-scroll">
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
											<div
												className="lp-row"
												key={c.id}
												onMouseLeave={() => setConfirmDel((k) => (k === `conv:${c.id}` ? null : k))}
											>
												<button
													type="button"
													className={`session-item ${active ? "active" : ""}`}
													title={`${c.title}${g.isCurrent ? "" : ` — ${g.cwd}`}`}
													onClick={() => {
														if (!active) send({ type: "switch_conversation", id: c.id });
													}}
												>
													<FiMessageSquare className="session-icon" />
													<span className="session-info">
														{renaming === `conv:${c.id}` ? (
															<input
																autoFocus
																className="session-rename-input"
																value={renameDraft}
																placeholder={t("renameSessionPlaceholder")}
																onClick={(e) => e.stopPropagation()}
																onChange={(e) => setRenameDraft(e.target.value)}
																onKeyDown={(e) => {
																	e.stopPropagation();
																	if (e.key === "Enter" && !e.nativeEvent.isComposing) {
																		const name = renameDraft.trim();
																		if (name) send({ type: "rename_conversation", id: c.id, name });
																		setRenaming(null);
																	} else if (e.key === "Escape") {
																		setRenaming(null);
																	}
																}}
																onBlur={() => setRenaming(null)}
															/>
														) : (
															<span className="session-title">
																{c.isSubagent && <span className="subagent-badge">{t("subagentBadge")}</span>}
																{c.title}
															</span>
														)}
														{renaming === `conv:${c.id}` ? null : (
															<span className="session-sub">
																{active ? t("current") : t("messageCount", { n: c.messageCount })}
															</span>
														)}
													</span>
													{c.isStreaming && <span className="conv-streaming" title={t("streaming")} />}
												</button>
												<button
													type="button"
													className="lp-del lp-rename"
													title={t("renameSession")}
													onClick={(e) => {
														e.stopPropagation();
														setConfirmDel(null);
														setRenameDraft(c.title);
														setRenaming(`conv:${c.id}`);
													}}
												>
													<FiEdit2 />
												</button>
												{!c.isStreaming &&
													!active &&
													delButton(
														`conv:${c.id}`,
														t("dismissConversation"),
														t("dismissConversationConfirm"),
														() => send({ type: "dismiss_conversation", id: c.id }),
														<FiX />,
													)}
												{c.isStreaming && (
													<span
														className="lp-row-stalled"
														title={t("streaming")}
														style={{ position: "absolute", right: 28, top: "50%", transform: "translateY(-50%)" }}
													/>
												)}
											</div>
										);
									})}
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{/* History sessions — collapsible, flex share, takes remaining */}
			<div className={`lp-section lp-section-sessions panel-sessions ${collapseSessions ? "collapsed" : ""}`}>
				{sectionHeader(t("historySessions"), collapseSessions, toggleSessions, sessions.length)}
				{!collapseSessions && (
					<div className="lp-section-body sessions-scroll">
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
											if (renaming) return;
											if (!active) send({ type: "switch_session", path: s.path });
										}}
									>
										<FiMessageSquare className="session-icon" />
										<span className="session-info">
											{renaming === s.path ? (
												<input
													autoFocus
													className="session-rename-input"
													value={renameDraft}
													placeholder={t("renameSessionPlaceholder")}
													onClick={(e) => e.stopPropagation()}
													onChange={(e) => setRenameDraft(e.target.value)}
													onKeyDown={(e) => {
														e.stopPropagation();
														if (e.key === "Enter" && !e.nativeEvent.isComposing) {
															const name = renameDraft.trim();
															if (name) send({ type: "rename_session", path: s.path, name });
															setRenaming(null);
														} else if (e.key === "Escape") {
															setRenaming(null);
														}
													}}
													onBlur={() => setRenaming(null)}
												/>
											) : (
												<span className="session-title">{displayName(s)}</span>
											)}
											{renaming === s.path ? null : (
												<span className="session-sub">
													{active ? t("current") : t("messageCount", { n: s.messageCount })}
													{s.source === "tui" && (
														<span className="session-src" title={t("tuiTip")}>
															TUI
														</span>
													)}
												</span>
											)}
										</span>
										<span className="session-time">{formatModified(s.modified)}</span>
									</button>
									<button
										type="button"
										className="lp-del lp-rename"
										title={t("renameSession")}
										onClick={(e) => {
											e.stopPropagation();
											setConfirmDel(null);
											setRenameDraft(s.name ?? "");
											setRenaming(s.path);
										}}
									>
										<FiEdit2 />
									</button>
									{delButton(`sess:${s.path}`, t("deleteSession"), t("deleteSessionConfirm"), () =>
										send({ type: "delete_session", path: s.path }),
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</aside>
	);
});
