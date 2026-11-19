import { useCallback, useEffect, useMemo, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { useOverlayZIndex } from "../overlay-stack";

/**
 * 一个 Bot 的记忆查看/整理面板（人侧）。
 *
 * 与 Bot 自己的 `memory` 工具共用同一套存储和校验：这里能看到每条记忆的来源、置信度、命中次数、创建日期，
 * 也能遗忘、晋升、手动整理、导出 Markdown。导出是"用户拥有自己的数据"的落地。
 * 晋升分两步：`confidence !== "confirmed"` 的条目要人显式确认（`confirm: true`）才够格进常驻；
 * Bot 自写且命中不足两次的条目连按钮都点不动（服务端同样拒绝），文案直接说明原因。
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

/** 搜索只看界面已有的三段文本，不发请求。 */
function matchesQuery(entry: MemoryEntry, needle: string): boolean {
	if (!needle) return true;
	return [entry.scope, entry.summary, entry.text].some((field) => field.toLowerCase().includes(needle));
}

/** 创建日期：坏数据（0 / NaN）就不显示，不编一个"1970"。 */
function shortDate(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

/** Bot 自写条目要命中 ≥2 次才能晋升；判定与服务端 `bot-memory.ts` 的 trusted 规则一致。 */
function promoteBlocked(entry: MemoryEntry): boolean {
	return entry.source === "bot" && entry.hits < 2;
}

export function BotMemoryDialog({ botId, botName, onClose }: { botId: string; botName: string; onClose: () => void }) {
	const t = useT();
	const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState("");
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

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return (snapshot?.entries ?? []).filter((entry) => matchesQuery(entry, needle));
	}, [snapshot, query]);

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

	// 人侧的晋升：未确认的条目先由这里显式确认（`confirm: true`），已确认的直接晋升。
	const promote = useCallback(
		(entry: MemoryEntry) =>
			act(t("botMemory.promoted"), () =>
				call(
					`${encodeURIComponent(botId)}/memory/promote`,
					entry.confidence === "confirmed" ? { id: entry.id } : { id: entry.id, confirm: true },
				),
			),
		[act, botId, t],
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
			aria-label={t("botMemory.titleNamed", { name: botName })}
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
							{t("botMemory.close")}
						</button>
					</div>
				</header>
				{notice && <p className="lp-memory-notice">{notice}</p>}
				{error && (
					<p className="lp-memory-error" role="alert">
						{error}
					</p>
				)}
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
				<input
					type="search"
					className="lp-memory-search"
					value={query}
					placeholder={t("botMemory.search")}
					aria-label={t("botMemory.search")}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<div className="lp-memory-list">
					{snapshot && snapshot.entries.length === 0 && <p className="lp-memory-empty">{t("botMemory.empty")}</p>}
					{snapshot && snapshot.entries.length > 0 && visible.length === 0 && (
						<p className="lp-memory-empty">{t("botMemory.searchEmpty", { query: query.trim() })}</p>
					)}
					{visible.map((entry) => {
						const created = shortDate(entry.createdAt);
						const blocked = promoteBlocked(entry);
						return (
							<article key={entry.id} className="lp-memory-entry">
								<div className="lp-memory-entry-head">
									<span className="lp-memory-scope">{entry.scope}</span>
									<span className="lp-memory-badge" title={t("botMemory.confidenceTip", { value: entry.confidence })}>
										{entry.confidence}
									</span>
									{entry.resident && <span className="lp-memory-badge is-resident">{t("botMemory.resident")}</span>}
									{created && <span className="lp-memory-meta">{t("botMemory.created", { date: created })}</span>}
									<span className="lp-memory-meta" title={`${entry.source}:${entry.sourceId}`}>
										{entry.source}:{entry.sourceId} · {t("botMemory.hits", { count: entry.hits })}
									</span>
								</div>
								<p className="lp-memory-text">{entry.text}</p>
								<div className="lp-memory-entry-actions">
									{!entry.resident && (
										<button
											type="button"
											disabled={busy || blocked}
											title={blocked ? t("botMemory.promoteBlocked") : undefined}
											onClick={() => void promote(entry)}
										>
											{entry.confidence === "confirmed" ? t("botMemory.promote") : t("botMemory.promoteConfirm")}
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
						);
					})}
				</div>
			</div>
		</div>
	);
}
