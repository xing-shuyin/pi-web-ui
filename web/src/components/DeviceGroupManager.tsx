import { useEffect, useRef, useState } from "react";
import { FiCheck, FiEdit2, FiMessageSquare, FiPlus, FiRefreshCw, FiTrash2, FiUsers, FiX } from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
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
	const { locale } = useI18n();
	const zh = isZhLocale(locale);

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
			setNotice(zh ? "群聊创建成功" : "Group created successfully");
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	function startManageMembers(room: Room) {
		setManagingRoomId(room.id);
		setMemberBotIds([...room.botIds]);
		setMemberPrimaryBotId(room.primaryBotId ?? "");
		setRenamingRoomId(null);
		setCreating(false);
		setError("");
		setNotice("");
	}

	async function handleSaveMembers(roomId: string) {
		if (busy) return;
		setBusy(true);
		setError("");
		setNotice("");
		const controller = startMutation();
		try {
			const expectedPrimary = memberBotIds.includes(memberPrimaryBotId) ? memberPrimaryBotId : null;
			const result = await groupApi<{ room: Room }>(`rooms/${encodeURIComponent(roomId)}/members`, controller.signal, {
				botIds: memberBotIds,
				primaryBotId: expectedPrimary,
			});
			if (controller.signal.aborted) return;
			setRooms((prev) => prev.map((r) => (r.id === roomId ? result.room : r)));
			setManagingRoomId(null);
			setNotice(zh ? "成员设置已保存" : "Members updated successfully");
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
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
			setNotice(zh ? "群聊名称已更新" : "Group renamed successfully");
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	async function handleDelete(room: Room) {
		if (busy) return;
		if (!window.confirm(zh ? `确定删除群聊“${room.name}”？` : `Are you sure you want to delete "${room.name}"?`)) {
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
			if (managingRoomId === room.id) setManagingRoomId(null);
			if (renamingRoomId === room.id) setRenamingRoomId(null);
			setNotice(zh ? "群聊已删除" : "Group deleted successfully");
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}

	return (
		<section className="dc-card" aria-label={zh ? "群聊列表" : "Group list"}>
			<div className="dc-card-header">
				<span className="dc-icon">
					<FiUsers aria-hidden />
				</span>
				<div>
					<h2>
						{zh ? "群聊列表" : "Group List"} · {rooms.length}
					</h2>
					<p>
						{zh
							? "管理群聊与成员 Bot，在此配置协作群组或直接进入聊天。"
							: "Manage groups and member Bots. Configure collaboration groups or open chats here."}
					</p>
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
						{zh ? "新建群聊" : "Create Group"}
					</button>
					<button
						type="button"
						className="dc-icon-button"
						aria-label={zh ? "刷新群聊" : "Refresh groups"}
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
						<h3>{zh ? "新建群聊" : "Create Group"}</h3>
						<button type="button" className="dc-button" onClick={() => setCreating(false)} disabled={busy}>
							<FiX aria-hidden />
							{zh ? "关闭" : "Close"}
						</button>
					</div>

					<div className="dc-field" style={{ marginBottom: "12px" }}>
						<label htmlFor="dg-manager-new-name">{zh ? "群名称" : "Group Name"}</label>
						<input
							id="dg-manager-new-name"
							type="text"
							required
							maxLength={80}
							value={createName}
							placeholder={zh ? "输入群名称，如：研发协作群" : "Enter group name"}
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
							{zh ? "选择成员 Bot" : "Select Member Bots"}
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
									{zh ? "暂无可用 Bot，请先创建 Bot。" : "No Bots available. Please create a Bot first."}
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
												{bot.online ? (zh ? "在线" : "Online") : zh ? "离线" : "Offline"}
												{!bot.enabled ? (zh ? " · 已禁用" : " · Disabled") : ""}
											</small>
										</span>
									</label>
								))
							)}
						</div>
					</div>

					{createBotIds.length > 0 && (
						<div className="dc-field" style={{ marginBottom: "16px" }}>
							<label htmlFor="dg-manager-new-primary">
								{zh ? "原主 Bot（Router 未启用时）" : "Legacy primary Bot (when Router is disabled)"}
							</label>
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
								<option value="">{zh ? "不设置（需 @ Bot）" : "None (mention a Bot)"}</option>
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
							{busy ? (zh ? "创建中…" : "Creating…") : zh ? "创建群聊" : "Create"}
						</button>
						<button type="button" className="dc-button" onClick={() => setCreating(false)} disabled={busy}>
							{zh ? "取消" : "Cancel"}
						</button>
					</div>
				</form>
			)}

			{managingRoomId && (
				<div
					className="dc-card"
					style={{ marginBottom: "16px", background: "var(--bg)", border: "1px solid var(--border)" }}
				>
					<div className="dg-heading" style={{ marginBottom: "12px" }}>
						<h3>
							{zh ? "管理成员" : "Manage Members"} · {rooms.find((r) => r.id === managingRoomId)?.name}
						</h3>
						<button type="button" className="dc-button" onClick={() => setManagingRoomId(null)} disabled={busy}>
							<FiX aria-hidden />
							{zh ? "关闭" : "Close"}
						</button>
					</div>

					<div style={{ marginBottom: "12px" }}>
						<label style={{ display: "block", marginBottom: "6px", fontSize: "12px", color: "var(--text-dim)" }}>
							{zh ? "选择成员 Bot" : "Select Member Bots"}
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
									{zh ? "暂无可用 Bot" : "No Bots available"}
								</p>
							) : (
								bots.map((bot) => (
									<label
										key={bot.id}
										style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "12px" }}
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
												{bot.online ? (zh ? "在线" : "Online") : zh ? "离线" : "Offline"}
												{!bot.enabled ? (zh ? " · 已禁用" : " · Disabled") : ""}
											</small>
										</span>
									</label>
								))
							)}
						</div>
					</div>

					{!rooms.find((room) => room.id === managingRoomId)?.router?.enabled && (
						<div className="dc-field" style={{ marginBottom: "16px" }}>
							<label htmlFor="dg-manager-edit-primary">
								{zh ? "原主 Bot（Router 未启用时）" : "Legacy primary Bot (when Router is disabled)"}
							</label>
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
								<option value="">{zh ? "不设置（需 @ Bot）" : "None (mention a Bot)"}</option>
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
							disabled={busy}
							onClick={() => void handleSaveMembers(managingRoomId)}
						>
							<FiCheck aria-hidden />
							{busy ? (zh ? "保存中…" : "Saving…") : zh ? "保存成员设置" : "Save Members"}
						</button>
						<button type="button" className="dc-button" onClick={() => setManagingRoomId(null)} disabled={busy}>
							{zh ? "取消" : "Cancel"}
						</button>
					</div>
				</div>
			)}

			{loading && <p role="status">{zh ? "加载中…" : "Loading…"}</p>}

			{!loading && rooms.length === 0 && (
				<p style={{ color: "var(--text-faint)", fontSize: "13px", padding: "12px 0" }}>
					{zh
						? "还没有群聊，点击上方“新建群聊”开始协作。"
						: "No groups yet. Click 'Create Group' above to get started."}
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
										{zh
											? `${room.botIds.length} 个 Bot${
													memberBots.length ? `: ${memberBots.map((b) => b.name).join(", ")}` : ""
												}`
											: `${room.botIds.length} Bots${
													memberBots.length ? `: ${memberBots.map((b) => b.name).join(", ")}` : ""
												}`}
									</span>
									{room.router?.enabled && (
										<span>
											AI Router · {room.router.deviceId} · {room.router.model} · {room.router.thinkingLevel}
										</span>
									)}
									{!room.router?.enabled && primaryBot && (
										<span style={{ color: "var(--accent)" }}>
											{zh ? `[主 Bot: ${primaryBot.name}]` : `[Primary: ${primaryBot.name}]`}
										</span>
									)}
								</span>
							</div>

							<div className="dc-actions">
								<button
									type="button"
									className="dc-button is-primary"
									title={zh ? "打开聊天" : "Open chat"}
									onClick={() => openChat(room.id)}
								>
									<FiMessageSquare aria-hidden />
									{zh ? "打开聊天" : "Open chat"}
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
									{zh ? "工单与运行" : "Work items & runs"}
								</button>
								<button
									type="button"
									className="dc-button"
									title={zh ? "管理成员" : "Manage members"}
									onClick={() => startManageMembers(room)}
								>
									<FiUsers aria-hidden />
									{zh ? "管理成员" : "Members"}
								</button>
								<button
									type="button"
									className="dc-button"
									title={zh ? "重命名" : "Rename"}
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
									{zh ? "重命名" : "Rename"}
								</button>
								<button
									type="button"
									className="dc-button is-danger"
									title={zh ? "删除群聊" : "Delete group"}
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
										placeholder={zh ? "输入新群名称" : "Enter new name"}
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
										{zh ? "保存" : "Save"}
									</button>
									<button type="button" className="dc-button" disabled={busy} onClick={() => setRenamingRoomId(null)}>
										<FiX aria-hidden />
										{zh ? "取消" : "Cancel"}
									</button>
								</form>
							)}
						</div>
					);
				})}
			</div>
			{selectedRoom && selectedPanel && (
				<section className="dc-card" aria-label={zh ? "群组设置" : "Group settings"}>
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
								{zh ? "工单与运行" : "Work items & runs"}
							</button>
							<button type="button" className="dc-button" onClick={() => setSelectedPanel(null)}>
								<FiX aria-hidden />
								{zh ? "关闭" : "Close"}
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
