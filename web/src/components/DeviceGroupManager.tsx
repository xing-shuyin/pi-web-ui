import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiEdit2, FiMessageSquare, FiPlus, FiRefreshCw, FiTrash2, FiUsers, FiX } from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { GroupRouterSettings, type GroupRouterConfig } from "./GroupRouterSettings";
import { GroupWorkItems } from "./GroupWorkItems";

type Bot = { id: string; name: string; deviceId?: string; enabled: boolean; online?: boolean };
type Room = { id: string; name: string; botIds: string[]; primaryBotId?: string; router?: GroupRouterConfig };

const DEVICE_GROUPS_CHANGED = "pi-web-ui:device-groups-changed";

function openChat(roomId: string) {
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-group-open", { detail: { roomId } }));
}

async function groupApi<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		credentials: "same-origin",
		signal,
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
	return data as T;
}

export function DeviceGroupManager({ bindingKey = "" }: { bindingKey?: string }) {
	return <DeviceGroupManagerContent key={bindingKey} />;
}

function DeviceGroupManagerContent() {
	const t = useT();

	const [rooms, setRooms] = useState<Room[]>([]);
	const [bots, setBots] = useState<Bot[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [refresh, setRefresh] = useState(0);

	const [creating, setCreating] = useState(false);
	const [createName, setCreateName] = useState("");
	const [createBotIds, setCreateBotIds] = useState<string[]>([]);
	const [createPrimaryBotId, setCreatePrimaryBotId] = useState("");

	const [managingRoomId, setManagingRoomId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const [memberBotIds, setMemberBotIds] = useState<string[]>([]);
	const [memberPrimaryBotId, setMemberPrimaryBotId] = useState("");

	const [renamingRoomId, setRenamingRoomId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");

	const [busy, setBusy] = useState(false);

	const [selectedPanel, setSelectedPanel] = useState<{ roomId: string; kind: "router" | "work" } | null>(null);
	const selectedRoom = rooms.find((room) => room.id === selectedPanel?.roomId);
	const generation = useRef(0);
	const listRequest = useRef<AbortController | null>(null);
	const mutation = useRef<AbortController | null>(null);

	function refreshGroups() {
		++generation.current;
		listRequest.current?.abort();
		setRefresh((n) => n + 1);
	}

	function startMutation() {
		mutation.current?.abort();
		const controller = new AbortController();
		mutation.current = controller;
		return controller;
	}

	useEffect(() => () => mutation.current?.abort(), []);

	useEffect(() => {
		const token = ++generation.current;
		const controller = new AbortController();
		listRequest.current = controller;

		async function load() {
			try {
				const [roomData, botData] = await Promise.all([
					groupApi<{ rooms: Room[] }>("rooms", controller.signal),
					groupApi<{ bots: Bot[] }>("bots", controller.signal),
				]);
				if (generation.current !== token || controller.signal.aborted) return;
				const nextRooms = Array.isArray(roomData.rooms) ? roomData.rooms : [];
				setRooms(nextRooms);
				setSelectedPanel((previous) =>
					previous && nextRooms.some((room) => room.id === previous.roomId) ? previous : null,
				);
				setBots(Array.isArray(botData.bots) ? botData.bots : []);
				setError("");
			} catch (cause) {
				if (generation.current === token && !controller.signal.aborted) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			} finally {
				if (generation.current === token && !controller.signal.aborted) {
					setLoading(false);
				}
			}
		}

		void load();

		return () => {
			controller.abort();
		};
	}, [refresh]);

	useEffect(() => {
		const handler = () => refreshGroups();
		window.addEventListener(DEVICE_GROUPS_CHANGED, handler);
		return () => window.removeEventListener(DEVICE_GROUPS_CHANGED, handler);
	}, []);

	async function handleCreateGroup(e: React.FormEvent) {
		e.preventDefault();
		if (!createName.trim() || busy) return;
		setBusy(true);
		setError("");
		setNotice("");
		const controller = startMutation();
		try {
			const expectedPrimary = createBotIds.includes(createPrimaryBotId) ? createPrimaryBotId : "";
			const result = await groupApi<{ room: Room }>("rooms", controller.signal, {
				name: createName.trim(),
				botIds: createBotIds,
				...(expectedPrimary ? { primaryBotId: expectedPrimary } : {}),
			});
			if (controller.signal.aborted) return;
			setRooms((prev) => [...prev.filter((r) => r.id !== result.room.id), result.room]);
			setCreating(false);
			setCreateName("");
			setCreateBotIds([]);
			setCreatePrimaryBotId("");
			setNotice(t("deviceGroupManagerCreateSuccess"));
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	function startManageMembers(room: Room) {
		setManagingRoomId(room.id);
		setEditName(room.name);
		setMemberBotIds([...room.botIds]);
		setMemberPrimaryBotId(room.primaryBotId ?? "");
		setRenamingRoomId(null);
		setCreating(false);
		setError("");
		setNotice("");
	}

	function closeEdit() {
		setManagingRoomId(null);
	}

	/** 编辑弹窗保存：名称 + 成员一次提交，编辑自带管理成员。 */
	async function handleSaveEdit(roomId: string) {
		if (busy) return;
		const room = rooms.find((r) => r.id === roomId);
		if (!room) return;
		const nextName = editName.trim();
		if (!nextName) return;
		setBusy(true);
		setError("");
		setNotice("");
		const controller = startMutation();
		try {
			if (nextName !== room.name) {
				await groupApi(`rooms/${encodeURIComponent(roomId)}/rename`, controller.signal, { name: nextName });
				if (controller.signal.aborted) return;
			}
			const expectedPrimary = memberBotIds.includes(memberPrimaryBotId) ? memberPrimaryBotId : null;
			const result = await groupApi<{ room: Room }>(`rooms/${encodeURIComponent(roomId)}/members`, controller.signal, {
				botIds: memberBotIds,
				primaryBotId: expectedPrimary,
			});
			if (controller.signal.aborted) return;
			// rename 接口不回房间体：以 members 回包为准再补上新名称。
			const merged: Room = { ...result.room, name: nextName };
			setRooms((prev) => prev.map((r) => (r.id === roomId ? merged : r)));
			closeEdit();
			setNotice(t("deviceGroupManagerMembersSaved"));
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	async function handleSaveMembers(roomId: string) {
		return handleSaveEdit(roomId);
	}

	async function handleRename(roomId: string) {
		if (!renameValue.trim() || busy) return;
		setBusy(true);
		setError("");
		setNotice("");
		const controller = startMutation();
		try {
			await groupApi(`rooms/${encodeURIComponent(roomId)}/rename`, controller.signal, {
				name: renameValue.trim(),
			});
			if (controller.signal.aborted) return;
			setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, name: renameValue.trim() } : r)));
			setRenamingRoomId(null);
			setNotice(t("deviceGroupManagerRenameSuccess"));
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	async function handleDelete(room: Room) {
		if (busy) return;
		if (!window.confirm(t("deviceGroupManagerDeleteConfirm", { name: room.name }))) {
			return;
		}
		setBusy(true);
		setError("");
		setNotice("");
		const controller = startMutation();
		try {
			await groupApi(`rooms/${encodeURIComponent(room.id)}/delete`, controller.signal, {});
			if (controller.signal.aborted) return;
			setSelectedPanel((previous) => (previous?.roomId === room.id ? null : previous));
			setRooms((prev) => prev.filter((r) => r.id !== room.id));
			if (managingRoomId === room.id) closeEdit();
			if (renamingRoomId === room.id) setRenamingRoomId(null);
			setNotice(t("deviceGroupManagerDeleteSuccess"));
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	return (
		<section className="dc-card" aria-label={t("deviceGroupManagerTitle")}>
			<div className="dc-card-header">
				<span className="dc-icon">
					<FiUsers aria-hidden />
				</span>
				<div>
					<h2>
						{t("deviceGroupManagerTitle")} · {rooms.length}
					</h2>
					<p>{t("deviceGroupManagerDescription")}</p>
				</div>
				<div className="dc-actions" style={{ marginInlineStart: "auto" }}>
					<button
						type="button"
						className="dc-button is-primary"
						disabled={busy}
						onClick={() => {
							setCreating((v) => !v);
							setManagingRoomId(null);
							setRenamingRoomId(null);
							setCreateName("");
							setCreateBotIds([]);
							setCreatePrimaryBotId("");
						}}
					>
						<FiPlus aria-hidden />
						{t("deviceGroupManagerCreate")}
					</button>
					<button
						type="button"
						className="dc-icon-button"
						aria-label={t("deviceGroupManagerRefresh")}
						onClick={refreshGroups}
					>
						<FiRefreshCw />
					</button>
				</div>
			</div>

			{error && (
				<p className="dc-notice is-error" role="alert">
					{error}
				</p>
			)}
			{notice && (
				<p className="dc-notice is-success" role="status">
					<FiCheck aria-hidden />
					{notice}
				</p>
			)}

			{creating && (
				<form
					className="dc-card"
					style={{ marginBottom: "16px", background: "var(--bg)", border: "1px solid var(--border)" }}
					onSubmit={handleCreateGroup}
				>
					<div className="dg-heading" style={{ marginBottom: "12px" }}>
						<h3>{t("deviceGroupManagerCreate")}</h3>
						<button type="button" className="dc-button" onClick={() => setCreating(false)} disabled={busy}>
							<FiX aria-hidden />
							{t("close")}
						</button>
					</div>

					<div className="dc-field" style={{ marginBottom: "12px" }}>
						<label htmlFor="dg-manager-new-name">{t("deviceGroupManagerNameLabel")}</label>
						<input
							id="dg-manager-new-name"
							type="text"
							required
							maxLength={80}
							value={createName}
							placeholder={t("deviceGroupManagerNamePlaceholder")}
							onChange={(e) => setCreateName(e.target.value)}
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
								maxHeight: "160px",
								overflowY: "auto",
								border: "1px solid var(--border)",
								borderRadius: "6px",
								padding: "8px",
								background: "var(--bg-elev)",
							}}
						>
							{bots.length === 0 ? (
								<p style={{ margin: 0, fontSize: "12px", color: "var(--text-faint)" }}>
									{t("deviceGroupManagerNoBotsCreate")}
								</p>
							) : (
								bots.map((bot) => (
									<label
										key={bot.id}
										style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px" }}
									>
										<input
											type="checkbox"
											checked={createBotIds.includes(bot.id)}
											disabled={busy || !bot.enabled}
											onChange={(e) => {
												setCreateBotIds((prev) =>
													e.target.checked ? [...prev, bot.id] : prev.filter((id) => id !== bot.id),
												);
											}}
										/>
										<span>
											<strong>{bot.name}</strong>
											<small style={{ color: "var(--text-faint)", marginInlineStart: "6px" }}>
												{bot.online ? t("deviceHubOnline") : t("deviceHubOffline")}
												{!bot.enabled ? t("deviceGroupManagerDisabledSuffix") : ""}
											</small>
										</span>
									</label>
								))
							)}
						</div>
					</div>

					{createBotIds.length > 0 && (
						<div className="dc-field" style={{ marginBottom: "16px" }}>
							<label htmlFor="dg-manager-new-primary">{t("deviceGroupManagerLegacyPrimary")}</label>
							<select
								id="dg-manager-new-primary"
								value={createBotIds.includes(createPrimaryBotId) ? createPrimaryBotId : ""}
								onChange={(e) => setCreatePrimaryBotId(e.target.value)}
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
									.filter((bot) => createBotIds.includes(bot.id))
									.map((bot) => (
										<option key={bot.id} value={bot.id}>
											{bot.name}
										</option>
									))}
							</select>
						</div>
					)}

					<div className="dc-actions">
						<button type="submit" className="dc-button is-primary" disabled={busy || !createName.trim()}>
							<FiCheck aria-hidden />
							{busy ? t("deviceGroupManagerCreating") : t("deviceGroupManagerCreateSubmit")}
						</button>
						<button type="button" className="dc-button" onClick={() => setCreating(false)} disabled={busy}>
							{t("cancel")}
						</button>
					</div>
				</form>
			)}

			{(() => {
				const effectiveEditId = managingRoomId;
				if (!effectiveEditId) return null;
				const editingRoom = rooms.find((r) => r.id === effectiveEditId);
				return createPortal(
					<div
						className="modal-backdrop"
						onClick={() => {
							if (!busy) closeEdit();
						}}
					>
						<div
							className="dc-card device-group-create-dialog"
							role="dialog"
							aria-modal="true"
							aria-label={`${t("edit")} · ${editingRoom?.name ?? effectiveEditId}`}
							onClick={(event) => event.stopPropagation()}
							style={{ minWidth: "min(480px, 92vw)" }}
						>
							<div className="dg-heading" style={{ marginBottom: "12px" }}>
								<h3>
									{t("edit")} · {editingRoom?.name ?? effectiveEditId}
								</h3>
								<button type="button" className="dc-button" onClick={() => closeEdit()} disabled={busy}>
									<FiX aria-hidden />
									{t("close")}
								</button>
							</div>
							{!editingRoom ? (
								<p role="status">{t("loading")}</p>
							) : (
								<>
									<div className="dc-field" style={{ marginBottom: "12px" }}>
										<label htmlFor="dg-manager-edit-name">{t("deviceGroupManagerNameLabel")}</label>
										<input
											id="dg-manager-edit-name"
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
										<label
											style={{ display: "block", marginBottom: "6px", fontSize: "12px", color: "var(--text-dim)" }}
										>
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
															checked={memberBotIds.includes(bot.id)}
															disabled={busy}
															onChange={(e) => {
																setMemberBotIds((prev) =>
																	e.target.checked ? [...prev, bot.id] : prev.filter((id) => id !== bot.id),
																);
															}}
														/>
														<span>
															<strong>{bot.name}</strong>
															<small style={{ color: "var(--text-faint)", marginInlineStart: "6px" }}>
																{bot.online ? t("deviceHubOnline") : t("deviceHubOffline")}
																{!bot.enabled ? t("deviceGroupManagerDisabledSuffix") : ""}
															</small>
														</span>
													</label>
												))
											)}
										</div>
									</div>
									{!editingRoom.router?.enabled && (
										<div className="dc-field" style={{ marginBottom: "16px" }}>
											<label htmlFor="dg-manager-edit-primary">{t("deviceGroupManagerLegacyPrimary")}</label>
											<select
												id="dg-manager-edit-primary"
												value={memberBotIds.includes(memberPrimaryBotId) ? memberPrimaryBotId : ""}
												onChange={(e) => setMemberPrimaryBotId(e.target.value)}
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
													.filter((bot) => memberBotIds.includes(bot.id))
													.map((bot) => (
														<option key={bot.id} value={bot.id}>
															{bot.name}
														</option>
													))}
											</select>
										</div>
									)}
									<div className="dc-actions">
										<button
											type="button"
											className="dc-button is-primary"
											disabled={busy || !editName.trim()}
											onClick={() => void handleSaveEdit(effectiveEditId)}
										>
											<FiCheck aria-hidden />
											{busy ? t("saving") : t("deviceGroupManagerSaveMembers")}
										</button>
										<button type="button" className="dc-button" onClick={() => closeEdit()} disabled={busy}>
											{t("cancel")}
										</button>
									</div>
								</>
							)}
						</div>
					</div>,
					document.body,
				);
			})()}

			{loading && <p role="status">{t("loading")}</p>}

			{!loading && rooms.length === 0 && (
				<p style={{ color: "var(--text-faint)", fontSize: "13px", padding: "12px 0" }}>
					{t("deviceGroupManagerEmpty")}
				</p>
			)}

			<div className="dd-list">
				{rooms.map((room) => {
					const isRenaming = renamingRoomId === room.id;
					const memberBots = bots.filter((b) => room.botIds.includes(b.id));
					const primaryBot = bots.find((b) => b.id === room.primaryBotId);

					return (
						<div className="dd-device" key={room.id} style={isRenaming ? { flexWrap: "wrap" } : undefined}>
							<span className="dc-device-icon">
								<FiUsers aria-hidden />
							</span>

							<div className="dd-identity" style={{ flex: 1, minWidth: "200px" }}>
								<strong>{room.name}</strong>
								<span style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
									<span>
										{t("deviceGroupManagerBotCount", {
											count: room.botIds.length,
											members: memberBots.length ? `: ${memberBots.map((b) => b.name).join(", ")}` : "",
										})}
									</span>
									{room.router?.enabled && (
										<span>
											AI Router · {room.router.deviceId} · {room.router.model} · {room.router.thinkingLevel}
										</span>
									)}
									{!room.router?.enabled && primaryBot && (
										<span style={{ color: "var(--accent)" }}>
											{t("deviceGroupManagerPrimaryBadge", { name: primaryBot.name })}
										</span>
									)}
								</span>
							</div>

							<div className="dc-actions">
								<button
									type="button"
									className="dc-button is-primary"
									title={t("deviceGroupManagerOpenChat")}
									onClick={() => openChat(room.id)}
								>
									<FiMessageSquare aria-hidden />
									{t("deviceGroupManagerOpenChat")}
								</button>
								<button
									type="button"
									className="dc-button"
									aria-expanded={selectedPanel?.roomId === room.id && selectedPanel.kind === "router"}
									onClick={() => setSelectedPanel({ roomId: room.id, kind: "router" })}
								>
									AI Router
								</button>
								<button
									type="button"
									className="dc-button"
									aria-expanded={selectedPanel?.roomId === room.id && selectedPanel.kind === "work"}
									onClick={() => setSelectedPanel({ roomId: room.id, kind: "work" })}
								>
									{t("deviceGroupManagerWorkItems")}
								</button>
								<button type="button" className="dc-button" title={t("edit")} onClick={() => startManageMembers(room)}>
									<FiUsers aria-hidden />
									{t("edit")}
								</button>
								<button
									type="button"
									className="dc-button"
									title={t("deviceGroupManagerRename")}
									onClick={() => {
										if (isRenaming) {
											setRenamingRoomId(null);
										} else {
											setRenamingRoomId(room.id);
											setRenameValue(room.name);
										}
									}}
								>
									<FiEdit2 aria-hidden />
									{t("deviceGroupManagerRename")}
								</button>
								<button
									type="button"
									className="dc-button is-danger"
									title={t("deviceGroupManagerDelete")}
									disabled={busy}
									onClick={() => void handleDelete(room)}
								>
									<FiTrash2 aria-hidden />
								</button>
							</div>

							{isRenaming && (
								<form
									style={{
										display: "flex",
										alignItems: "center",
										gap: "8px",
										width: "100%",
										paddingTop: "8px",
										paddingBottom: "4px",
									}}
									onSubmit={(e) => {
										e.preventDefault();
										void handleRename(room.id);
									}}
								>
									<input
										type="text"
										maxLength={80}
										autoFocus
										disabled={busy}
										value={renameValue}
										onChange={(e) => setRenameValue(e.target.value)}
										placeholder={t("deviceGroupManagerRenamePlaceholder")}
										style={{
											flex: 1,
											minWidth: "180px",
											background: "var(--bg)",
											border: "1px solid var(--border)",
											borderRadius: "6px",
											padding: "6px 10px",
											color: "var(--text)",
											fontSize: "12px",
										}}
									/>
									<button type="submit" className="dc-button is-primary" disabled={busy || !renameValue.trim()}>
										<FiCheck aria-hidden />
										{t("save")}
									</button>
									<button type="button" className="dc-button" disabled={busy} onClick={() => setRenamingRoomId(null)}>
										<FiX aria-hidden />
										{t("cancel")}
									</button>
								</form>
							)}
						</div>
					);
				})}
			</div>
			{selectedRoom && selectedPanel && (
				<section className="dc-card" aria-label={t("deviceGroupManagerSettingsAria")}>
					<div className="dg-heading">
						<h3>{selectedRoom.name}</h3>
						<div className="dc-actions">
							<button
								type="button"
								className={`dc-button${selectedPanel.kind === "router" ? " is-primary" : ""}`}
								aria-pressed={selectedPanel.kind === "router"}
								onClick={() => setSelectedPanel({ roomId: selectedRoom.id, kind: "router" })}
							>
								AI Router
							</button>
							<button
								type="button"
								className={`dc-button${selectedPanel.kind === "work" ? " is-primary" : ""}`}
								aria-pressed={selectedPanel.kind === "work"}
								onClick={() => setSelectedPanel({ roomId: selectedRoom.id, kind: "work" })}
							>
								{t("deviceGroupManagerWorkItems")}
							</button>
							<button type="button" className="dc-button" onClick={() => setSelectedPanel(null)}>
								<FiX aria-hidden />
								{t("close")}
							</button>
						</div>
					</div>
					{selectedPanel.kind === "router" ? (
						<GroupRouterSettings
							key={selectedRoom.id}
							roomId={selectedRoom.id}
							router={selectedRoom.router}
							disabled={busy}
							onSaved={refreshGroups}
						/>
					) : (
						<GroupWorkItems key={selectedRoom.id} roomId={selectedRoom.id} disabled={busy} />
					)}
				</section>
			)}
		</section>
	);
}
