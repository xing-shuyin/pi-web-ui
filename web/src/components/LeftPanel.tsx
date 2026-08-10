import { FiFolder, FiMessageSquare } from "react-icons/fi";
import type { SessionSummary } from "../types";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";

interface LeftPanelProps {
	chat: ChatState;
	send: (
		msg:
			| { type: "new_chat" }
			| { type: "list_sessions" }
			| { type: "list_projects" }
			| { type: "switch_session"; path: string }
			| { type: "switch_conversation"; id: string }
			| { type: "set_cwd"; path: string },
	) => boolean;
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

export function LeftPanel({ chat, send }: LeftPanelProps) {
	const t = useT();
	const currentFile = chat.state?.sessionFile;
	const currentCwd = chat.state?.cwd;
	const sessions = chat.sessions;
	const projects = chat.projects;

	const displayName = (s: SessionSummary): string => {
		const title = s.name || s.firstMessage.trim();
		return title.length > 0 ? title : t("emptyChat");
	};

	const projectName = (path: string): string =>
		path.split(/[\\/]/).pop() || path;

	return (
		<aside className="panel panel-left">
			{projects.length > 0 && (
				<div className="panel-projects">
					<div className="panel-section-title">{t("recentProjects")}</div>
					<div className="projects-scroll">
						{projects.map((p) => {
							const active = currentCwd === p.path;
							return (
								<button
									type="button"
									key={p.path}
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
									<span className="project-time">
										{formatModified(p.lastUsed)}
									</span>
								</button>
							);
						})}
					</div>
				</div>
			)}
			{chat.conversations.length > 0 && (
				<div className="panel-convs">
					<div className="panel-section-title">{t("runningConversations")}</div>
					{chat.conversations.map((c) => {
						const active = chat.activeConversationId === c.id;
						return (
							<button
								type="button"
								key={c.id}
								className={`session-item ${active ? "active" : ""}`}
								title={c.title}
								onClick={() => {
									if (!active) send({ type: "switch_conversation", id: c.id });
								}}
							>
								<FiMessageSquare className="session-icon" />
								<span className="session-info">
									<span className="session-title">{c.title}</span>
									<span className="session-sub">
										{active
											? t("current")
											: t("messageCount", { n: c.messageCount })}
									</span>
								</span>
								{c.isStreaming && (
									<span className="conv-streaming" title={t("streaming")} />
								)}
							</button>
						);
					})}
					<div className="panel-section-divider" />
				</div>
			)}
			<div className="panel-sessions">
				<div className="panel-section-title">{t("historySessions")}</div>
				<div className="sessions-scroll">
					{sessions.length === 0 && (
						<div className="panel-empty">{t("noHistory")}</div>
					)}
					{sessions.map((s) => {
						const active = currentFile === s.path;
						return (
							<button
								type="button"
								key={s.path}
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
										{active
											? t("current")
											: t("messageCount", { n: s.messageCount })}
										{s.source === "tui" && (
											<span className="session-src" title={t("tuiTip")}>
												TUI
											</span>
										)}
									</span>
								</span>
								<span className="session-time">
									{formatModified(s.modified)}
								</span>
							</button>
						);
					})}
				</div>
			</div>
		</aside>
	);
}
