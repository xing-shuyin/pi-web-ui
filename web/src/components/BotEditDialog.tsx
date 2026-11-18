import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { useOverlayZIndex } from "../overlay-stack";
import { LocalBots, type Bot } from "./LocalBots";
import "./agent-bots.css";

/**
 * 「编辑 Bot」的就地弹窗——不再切到设备中心。
 *
 * 编辑器仍然只有一份（`LocalBots editBot`）：这里只负责「按 id 取到这个 Bot → 挂载编辑器」。
 * 先取完整 Bot 而不是拿左栏 `bot-panel` 的投影拼一份：投影没有 `systemPrompt/tools/...`，
 * 拼出来的表单一旦保存就会把没显示的字段清空。读取走既有的 `GET /local-bots/:id`（单源）。
 */
async function fetchBot(botId: string, signal: AbortSignal): Promise<Bot> {
	const response = await fetch(withToken(appUrl(`/api/device-center/local-bots/${encodeURIComponent(botId)}`)), {
		credentials: "same-origin",
		signal,
	});
	const data = (await response.json().catch(() => ({}))) as { bot?: Bot; error?: string };
	if (!response.ok || !data.bot) throw new Error(data.error || String(response.status));
	return data.bot;
}

export function BotEditDialog({ botId, onClose }: { botId: string; onClose: () => void }) {
	const t = useT();
	const zIndex = useOverlayZIndex();
	const [bot, setBot] = useState<Bot | null>(null);
	const [error, setError] = useState("");
	// 编辑器打开后 Esc 交给编辑器自己处理（保存中要拦），这里只管加载/错误页。
	useEscapeKey(onClose, !bot);

	useEffect(() => {
		const current = new AbortController();
		setBot(null);
		setError("");
		void fetchBot(botId, current.signal)
			.then((value) => {
				if (!current.signal.aborted) setBot(value);
			})
			.catch((cause) => {
				if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => current.abort();
	}, [botId]);

	// 取到 Bot 之后才挂编辑器：编辑器的初值来自这份完整数据（含 revision），不能空表单顶上。
	if (bot) return createPortal(<LocalBots editBot={bot} onCancel={onClose} onFinished={onClose} />, document.body);

	return createPortal(
		<div
			className="lp-memory-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={t("agentBotsMenuEdit")}
			style={{ zIndex }}
		>
			<div className="lp-memory-dialog">
				<header className="lp-memory-head">
					<strong>{t("agentBotsMenuEdit")}</strong>
					<button type="button" onClick={onClose}>
						{t("agentBotsMemoryClose")}
					</button>
				</header>
				{error ? (
					<p className="lp-memory-error" role="alert">
						{t("agentBotsFailed")}：{error}
					</p>
				) : (
					<p className="lp-memory-empty">{t("agentBotsLoading")}</p>
				)}
			</div>
		</div>,
		document.body,
	);
}
