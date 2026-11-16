import { useCallback, useEffect, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { useOverlayZIndex } from "../overlay-stack";

/**
 * 一个 Bot 的记忆查看/整理面板（人侧）。
 *
 * 与 Bot 自己的 `memory` 工具共用同一套存储和校验：这里能看到每条记忆的来源、置信度、命中次数，
 * 也能遗忘、晋升、手动整理、导出 Markdown。导出是"用户拥有自己的数据"的落地。
 */

type MemoryEntry = {
	id: string;
	scope: string;
	summary: string;
	text: string;
	kind: string;
	confidence: string;
	resident?: boolean;
	source: string;
	sourceId: string;
	hits: number;
	createdAt: number;
	lastUsedAt?: number;
};

type MemorySnapshot = {
	scopes: { scope: string; entries: number; resident: number }[];
	entries: MemoryEntry[];
};

async function call<T>(path: string, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/local-bots/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal: AbortSignal.timeout(20_000),
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
	if (!response.ok) throw new Error(data.error || data.code || String(response.status));
	return data;
}

export function BotMemoryDialog({ botId, botName, onClose }: { botId: string; botName: string; onClose: () => void }) {
	const t = useT();
	const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const zIndex = useOverlayZIndex();
	useEscapeKey(onClose);

	const load = useCallback(async () => {
		try {
			setSnapshot(await call<MemorySnapshot>(`${encodeURIComponent(botId)}/memory`));
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [botId]);

	useEffect(() => {
		void load();
	}, [load]);

	const act = useCallback(
		async (label: string, run: () => Promise<unknown>) => {
			setBusy(true);
			setNotice("");
			try {
				await run();
				setNotice(label);
				await load();
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setBusy(false);
			}
		},
		[load],
	);

	const exportBundle = useCallback(async () => {
		setBusy(true);
		try {
			const data = await call<{ bundle: unknown }>(`${encodeURIComponent(botId)}/home`);
			const blob = new Blob([JSON.stringify(data.bundle, null, 2)], { type: "application/json;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			const slug = botName
				.replace(/[^\w.-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40);
			anchor.download = `${slug || "bot"}-home.json`;
			anchor.click();
			URL.revokeObjectURL(url);
			setNotice(t("botMemory.exportedBundle"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}, [botId, botName, t]);

	const exportMemory = useCallback(async () => {
		setBusy(true);
		try {
			const data = await call<{ markdown: string }>(`${encodeURIComponent(botId)}/memory/export`);
			const blob = new Blob([data.markdown], { type: "text/markdown;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			const slug = botName
				.replace(/[^\w.-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40);
			anchor.download = `${slug || "bot"}-memory.md`;
			anchor.click();
			URL.revokeObjectURL(url);
			setNotice(t("botMemory.exportedMarkdown"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}, [botId, botName, t]);

	return (
		<div
			className="lp-memory-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label={t("botMemory.title")}
			style={{ zIndex }}
		>
			<div className="lp-memory-dialog">
				<header className="lp-memory-head">
					<div>
						<strong>{t("botMemory.titleNamed", { name: botName })}</strong>
						<p className="lp-memory-sub">{t("botMemory.subtitle")}</p>
					</div>
					<div className="lp-memory-head-actions">
						<button
							type="button"
							disabled={busy}
							onClick={() =>
								void act(t("botMemory.compacted"), () => call(`${encodeURIComponent(botId)}/memory/compact`, {}))
							}
						>
							{t("botMemory.compact")}
						</button>
						<button type="button" disabled={busy} onClick={() => void exportMemory()}>
							{t("botMemory.export")}
						</button>
						<button type="button" disabled={busy} onClick={() => void exportBundle()}>
							{t("botMemory.bundle")}
						</button>
						<button type="button" onClick={onClose}>
							{t("close")}
						</button>
					</div>
				</header>
				{notice && <p className="lp-memory-notice">{notice}</p>}
				{error && <p className="lp-memory-error">{error}</p>}
				{snapshot && snapshot.scopes.length > 0 && (
					<p className="lp-memory-scopes">
						{snapshot.scopes.map((row) => (
							<span key={row.scope} className="lp-memory-scope">
								{row.scope} · {row.entries}
								{row.resident ? ` (${t("botMemory.residentCount", { count: row.resident })})` : ""}
							</span>
						))}
					</p>
				)}
				<div className="lp-memory-list">
					{snapshot && snapshot.entries.length === 0 && <p className="lp-memory-empty">{t("botMemory.empty")}</p>}
					{(snapshot?.entries ?? []).map((entry) => (
						<article key={entry.id} className="lp-memory-entry">
							<div className="lp-memory-entry-head">
								<span className="lp-memory-scope">{entry.scope}</span>
								<span className="lp-memory-badge">{entry.confidence}</span>
								{entry.resident && <span className="lp-memory-badge is-resident">{t("botMemory.resident")}</span>}
								<span className="lp-memory-meta">
									{entry.source}:{entry.sourceId} · {t("botMemory.hits")} {entry.hits}
								</span>
							</div>
							<p className="lp-memory-text">{entry.text}</p>
							<div className="lp-memory-entry-actions">
								{!entry.resident && (
									<button
										type="button"
										disabled={busy}
										onClick={() =>
											void act(t("botMemory.promoted"), () =>
												call(`${encodeURIComponent(botId)}/memory/promote`, { id: entry.id }),
											)
										}
									>
										{t("botMemory.promote")}
									</button>
								)}
								<button
									type="button"
									disabled={busy}
									onClick={() =>
										void act(t("botMemory.forgotten"), () =>
											call(`${encodeURIComponent(botId)}/memory/forget`, { id: entry.id }),
										)
									}
								>
									{t("botMemory.forget")}
								</button>
							</div>
						</article>
					))}
				</div>
			</div>
		</div>
	);
}
