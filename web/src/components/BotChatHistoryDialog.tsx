import { useCallback, useEffect, useState } from "react";
import { appSend } from "../app-globals";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { useOverlayZIndex } from "../overlay-stack";

/**
 * 一个 Bot 的历史私聊。
 *
 * 点 Bot 行默认只回到最近一份（这是「同一个私聊」的语义）；右键「新开对话」之后，
 * 旧记录仍在 `bot-sessions/<botId>/` 里，这个面板把它们列出来。打开走既有的
 * `switch_session`（服务端会按转录锚点重建 Bot 绑定），不是另造一条通道。
 */

type SessionRow = {
	path: string;
	title?: string;
	updatedAt: number;
	bytes: number;
};

async function fetchSessions(botId: string): Promise<SessionRow[]> {
	const response = await fetch(
		withToken(appUrl(`/api/device-center/local-bots/${encodeURIComponent(botId)}/sessions`)),
		{ credentials: "same-origin", signal: AbortSignal.timeout(20_000) },
	);
	const data = (await response.json().catch(() => ({}))) as { sessions?: SessionRow[]; error?: string };
	if (!response.ok) throw new Error(data.error || String(response.status));
	return data.sessions ?? [];
}

function formatTime(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export function BotChatHistoryDialog({
	botId,
	botName,
	onClose,
}: {
	botId: string;
	botName: string;
	onClose: () => void;
}) {
	const t = useT();
	const [rows, setRows] = useState<SessionRow[] | null>(null);
	const [error, setError] = useState("");
	const zIndex = useOverlayZIndex();
	useEscapeKey(onClose);

	const load = useCallback(async () => {
		try {
			setRows(await fetchSessions(botId));
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [botId]);

	useEffect(() => {
		void load();
	}, [load]);

	const open = (row: SessionRow) => {
		appSend({ type: "switch_session", path: row.path });
		onClose();
	};

	return (
		<div
			className="lp-memory-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={t("agentBotsHistoryTitle", { name: botName })}
			style={{ zIndex }}
		>
			<div className="lp-memory-dialog lp-bot-history">
				<header className="lp-memory-head">
					<strong>{t("agentBotsHistoryTitle", { name: botName })}</strong>
					<button type="button" onClick={onClose}>
						{t("agentBotsHistoryClose")}
					</button>
				</header>
				{error && (
					<p className="lp-memory-error" role="alert">
						{t("agentBotsHistoryFailed")}：{error}
					</p>
				)}
				{rows === null && !error && <p className="lp-memory-empty">{t("agentBotsLoading")}</p>}
				{rows && rows.length === 0 && <p className="lp-memory-empty">{t("agentBotsHistoryEmpty")}</p>}
				{rows && rows.length > 0 && (
					<ul className="lp-bot-history-list">
						{rows.map((row) => (
							<li key={row.path} className="lp-bot-history-row">
								<div className="lp-bot-history-text">
									<span className="lp-bot-history-title">{row.title?.trim() || t("agentBotsHistoryUntitled")}</span>
									<span className="lp-bot-history-meta">
										{t("agentBotsHistoryUpdated", { date: formatTime(row.updatedAt) })}
									</span>
								</div>
								<button type="button" onClick={() => open(row)}>
									{t("agentBotsHistoryOpen")}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
