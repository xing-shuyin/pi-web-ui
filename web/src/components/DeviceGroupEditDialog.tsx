import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiX } from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";

type Bot = {
	id: string;
	name: string;
	deviceId?: string;
	deviceName?: string;
	enabled: boolean;
	online?: boolean;
};
type RoomDetail = {
	id: string;
	name: string;
	botIds: string[];
	primaryBotId?: string;
	router?: { enabled?: boolean };
	scope?: "local" | "shared";
};

const DEVICE_GROUPS_CHANGED = "pi-web-ui:device-groups-changed";

async function api<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		const err = new Error(
			typeof (data as { error?: unknown }).error === "string" && (data as { error: string }).error
				? (data as { error: string }).error
				: `Request failed (${response.status})`,
		);
		(err as { status?: number }).status = response.status;
		(err as { code?: string }).code =
			typeof (data as { code?: unknown }).code === "string" ? (data as { code: string }).code : "";
		throw err;
	}
	return data as T;
}

/**
 * 独立编辑弹窗（像新建群组一样，不跳设备中心）。
 * 编辑自带管理成员：名称 + 成员一次保存。
 * 保存规则：成员全是本机 → 存本机；含其他设备 → 经设备中心存为共享群组。
 */
export function DeviceGroupEditDialog({
	roomId,
	onClose,
	onSaved,
}: {
	roomId: string;
	onClose: () => void;
	onSaved?: (roomId: string) => void;
}) {
	const t = useT();
	useEscapeKey(onClose);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [bots, setBots] = useState<Bot[]>([]);
	const [localIds, setLocalIds] = useState<Set<string>>(new Set());
	const [sharedAvailable, setSharedAvailable] = useState(false);
	const [scope, setScope] = useState<"local" | "shared">("local");
	const [routerEnabled, setRouterEnabled] = useState(false);
	const [editName, setEditName] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	const [primary, setPrimary] = useState("");
	const [busy, setBusy] = useState(false);
	const generation = useRef(0);

	useEffect(() => {
		const token = ++generation.current;
		const controller = new AbortController();
		const valid = () => generation.current === token && !controller.signal.aborted;
		(async () => {
			try {
				const [localBots, sharedBots] = await Promise.all([
					api<{ bots: Bot[] }>("bots", controller.signal).catch(() => ({ bots: [] as Bot[] })),
					api<{ bots: Bot[] }>("shared-bots", controller.signal)
						.then((d) => ({ ...d, ok: true as const }))
						.catch(() => ({ bots: [] as Bot[], ok: false as const })),
				]);
				if (!valid()) return;
				const locals = Array.isArray(localBots.bots) ? localBots.bots : [];
				const remotes = Array.isArray(sharedBots.bots) ? sharedBots.bots : [];
				setSharedAvailable(Boolean((sharedBots as { ok?: boolean }).ok) && remotes.length > 0);
				setLocalIds(new Set(locals.map((b) => b.id)));
				const merged = new Map<string, Bot>();
				for (const b of locals) merged.set(b.id, b);
				for (const b of remotes) if (!merged.has(b.id)) merged.set(b.id, b);
				setBots([...merged.values()]);

				let detail: RoomDetail | null = null;
				let foundScope: "local" | "shared" = "local";
				try {
					const local = await api<{ room: RoomDetail }>(`rooms/${encodeURIComponent(roomId)}`, controller.signal);
					detail = local.room;
					foundScope = "local";
				} catch (err) {
					if ((err as { status?: number }).status !== 404) throw err;
					const shared = await api<{ room: RoomDetail }>(
						`shared-rooms/${encodeURIComponent(roomId)}`,
						controller.signal,
					);
					detail = shared.room;
					foundScope = "shared";
				}
				if (!valid() || !detail) return;
				setScope(detail.scope === "shared" ? "shared" : foundScope);
				setRouterEnabled(Boolean(detail.router?.enabled));
				setEditName(detail.name ?? "");
				setSelected([...(detail.botIds ?? [])]);
				setPrimary(detail.primaryBotId ?? "");
				setError("");
			} catch (cause) {
				if (valid()) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (valid()) setLoading(false);
			}
		})();
		return () => {
			controller.abort();
		};
	}, [roomId]);

	const allLocal = selected.every((id) => localIds.has(id));
	const target: "local" | "shared" = allLocal ? "local" : "shared";
	const willMigrate = !loading && !error && target !== scope;

	async function save() {
		if (busy || loading) return;
		const name = editName.trim();
		if (!name || selected.length === 0) return;
		if (target === "shared" && !sharedAvailable && scope !== "shared") {
			setError(t("deviceGroupManagerNoBots"));
			return;
		}
		setBusy(true);
		setError("");
		const controller = new AbortController();
		try {
			const prefix = target === "shared" ? "shared-rooms" : "rooms";
			if (target === scope) {
				if (name) {
					await api(`${prefix}/${encodeURIComponent(roomId)}/rename`, controller.signal, { name });
				}
				const result = await api<{ room: RoomDetail }>(
					`${prefix}/${encodeURIComponent(roomId)}/members`,
					controller.signal,
					{
						botIds: selected,
						primaryBotId: selected.includes(primary) ? primary : null,
					},
				);
				const nextId = result.room?.id ?? roomId;
				window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
				onSaved?.(nextId);
				onClose();
			} else {
				// 跨本机/共享迁移：新作用域建群 + 删除旧群（历史不保留）。
				const created = await api<{ room: RoomDetail }>(prefix, controller.signal, {
					name,
					botIds: selected,
					...(selected.includes(primary) ? { primaryBotId: primary } : {}),
				});
				const nextId = created.room?.id;
				if (!nextId) throw new Error(t("deviceGroupsFailed"));
				const oldPrefix = scope === "shared" ? "shared-rooms" : "rooms";
				await api(`${oldPrefix}/${encodeURIComponent(roomId)}/delete`, controller.signal, {});
				window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
				onSaved?.(nextId);
				onClose();
			}
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	return createPortal(
		<div className="modal-backdrop" onClick={() => !busy && onClose()}>
			<div
				className="dc-card device-group-create-dialog"
				role="dialog"
				aria-modal="true"
				aria-label={`${t("edit")} · ${editName || roomId}`}
				onClick={(event) => event.stopPropagation()}
				style={{ minWidth: "min(480px, 92vw)" }}
			>
				<div className="dg-heading" style={{ marginBottom: "12px" }}>
					<h3>
						{t("edit")} · {editName || roomId}
						{scope === "shared" ? ` · ${t("deviceGroupManagerSharedSuffix")}` : ""}
					</h3>
					<button type="button" className="dc-button" onClick={onClose} disabled={busy}>
						<FiX aria-hidden />
						{t("close")}
					</button>
				</div>
				{loading && <p role="status">{t("loading")}</p>}
				{error && (
					<p className="dc-error" role="alert">
						{error}
					</p>
				)}
				{!loading && (
					<>
						<div className="dc-field" style={{ marginBottom: "12px" }}>
							<label htmlFor="dg-edit-name">{t("deviceGroupManagerNameLabel")}</label>
							<input
								id="dg-edit-name"
								type="text"
								maxLength={80}
								value={editName}
								onChange={(e) => setEditName(e.target.value)}
								disabled={busy}
								placeholder={t("deviceGroupManagerRenamePlaceholder")}
								style={{
									width: "100%",
									background: "var(--bg-elev)",
									border: "1px solid var(--border)",
									borderRadius: "6px",
									padding: "6px 10px",
									color: "var(--text)",
									fontSize: "13px",
								}}
							/>
						</div>
						<div style={{ marginBottom: "12px" }}>
							<label style={{ display: "block", marginBottom: "6px", fontSize: "12px", color: "var(--text-dim)" }}>
								{t("deviceGroupManagerSelectMembers")}
							</label>
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									gap: "6px",
									maxHeight: "220px",
									overflowY: "auto",
									border: "1px solid var(--border)",
									borderRadius: "6px",
									padding: "8px",
									background: "var(--bg-elev)",
								}}
							>
								{bots.length === 0 ? (
									<p style={{ margin: 0, fontSize: "12px", color: "var(--text-faint)" }}>
										{t("deviceGroupManagerNoBots")}
									</p>
								) : (
									bots.map((bot) => (
										<label
											key={bot.id}
											style={{
												display: "flex",
												alignItems: "center",
												gap: "8px",
												cursor: "pointer",
												fontSize: "12px",
											}}
										>
											<input
												type="checkbox"
												checked={selected.includes(bot.id)}
												disabled={busy}
												onChange={(e) => {
													setSelected((prev) =>
														e.target.checked ? [...prev, bot.id] : prev.filter((id) => id !== bot.id),
													);
												}}
											/>
											<span>
												<strong>{bot.name}</strong>
												<small style={{ color: "var(--text-faint)", marginInlineStart: "6px" }}>
													{bot.deviceName ?? (localIds.has(bot.id) ? "" : (bot.deviceId ?? ""))}
													{bot.online !== undefined
														? ` · ${bot.online ? t("deviceHubOnline") : t("deviceHubOffline")}`
														: ""}
													{!bot.enabled ? t("deviceGroupManagerDisabledSuffix") : ""}
													{!localIds.has(bot.id) ? ` · ${t("deviceGroupManagerSharedSuffix")}` : ""}
												</small>
											</span>
										</label>
									))
								)}
							</div>
						</div>
						{!routerEnabled && (
							<div className="dc-field" style={{ marginBottom: "16px" }}>
								<label htmlFor="dg-edit-primary">{t("deviceGroupManagerLegacyPrimary")}</label>
								<select
									id="dg-edit-primary"
									value={selected.includes(primary) ? primary : ""}
									onChange={(e) => setPrimary(e.target.value)}
									disabled={busy}
									style={{
										width: "100%",
										background: "var(--bg-elev)",
										border: "1px solid var(--border)",
										borderRadius: "6px",
										padding: "6px 10px",
										color: "var(--text)",
										fontSize: "13px",
									}}
								>
									<option value="">{t("deviceGroupManagerNoPrimary")}</option>
									{bots
										.filter((bot) => selected.includes(bot.id))
										.map((bot) => (
											<option key={bot.id} value={bot.id}>
												{bot.name}
											</option>
										))}
								</select>
							</div>
						)}
						{willMigrate && (
							<p className="dc-notice" role="status">
								{target === "shared"
									? t("deviceGroupManagerMigrateToSharedHint")
									: t("deviceGroupManagerMigrateToLocalHint")}
							</p>
						)}
						<div className="dc-actions">
							<button
								type="button"
								className="dc-button is-primary"
								disabled={busy || !editName.trim() || selected.length === 0}
								onClick={() => void save()}
							>
								<FiCheck aria-hidden />
								{busy ? t("saving") : t("deviceGroupManagerSaveMembers")}
							</button>
							<button type="button" className="dc-button" onClick={onClose} disabled={busy}>
								{t("cancel")}
							</button>
						</div>
					</>
				)}
			</div>
		</div>,
		document.body,
	);
}
