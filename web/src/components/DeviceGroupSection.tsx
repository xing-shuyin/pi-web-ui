import { useEffect, useRef, useState } from "react";
import { FiChevronDown, FiChevronUp, FiPlus, FiUsers } from "react-icons/fi";
import { appUrl } from "../base-url";
import { DeviceGroupMembers } from "./DeviceGroupMembers";
import { DeviceGroupBotDialog } from "./DeviceGroupBotDialog";
import { DeviceGroupEditDialog } from "./DeviceGroupEditDialog";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { openContextMenu } from "../context-menu-state";
import type { UiSlotEntry } from "../ui-slots";
import { hostEntryIcon } from "../host-icon";

export type SidebarDeviceGroup = { id: string; name: string; botIds: string[]; scope?: "local" | "shared" };
export const DEVICE_GROUPS_CHANGED = "pi-web-ui:device-groups-changed";
const ACTION_LABELS = {
	rename: "deviceGroupManagerRename",
	edit: "edit",
	clear: "deviceGroupSectionClearMessages",
	delete: "deviceGroupSectionDeleteGroup",
} as const;

const ERROR_LABELS = {
	bind: "deviceGroupSectionBind",
	running: "deviceGroupSectionRunning",
	forbidden: "deviceGroupSectionForbidden",
	failed: "deviceGroupSectionFailed",
} as const;

export class DeviceGroupRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		/**
		 * 本地接口（目前只有 `bot-drafts`）明确允许展示的原因文本；Hub 上游的 `error` 永远不会落到这里。
		 * 见 `server/device-center/local.ts` 的 `draftDetail`。
		 */
		readonly detail = "",
	) {
		super(`Device group request failed (${status})`);
	}
}

/** 只有本地草案接口会写 `detail`：路径写死，避免把 Hub 上游文本读上来。 */
const DETAIL_PATHS = ["bot-drafts"];

/** 普通设备中心请求的默认超时。 */
const DEVICE_REQUEST_TIMEOUT_MS = 15_000;
/**
 * 起草/确认草案要等一次真实模型调用（服务端上限 90s），15s 会先把客户端超时掉：
 * 界面报"失败"，服务端其实还在跑。这里给足余量，且只对 `bot-drafts` 生效。
 */
export const BOT_DRAFT_REQUEST_TIMEOUT_MS = 120_000;

function mayCarryDetail(path: string): boolean {
	return DETAIL_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export async function deviceGroupRequest<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		signal: AbortSignal.any([
			signal,
			AbortSignal.timeout(mayCarryDetail(path) ? BOT_DRAFT_REQUEST_TIMEOUT_MS : DEVICE_REQUEST_TIMEOUT_MS),
		]),
		...(body === undefined
			? {}
			: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		const detail = mayCarryDetail(path) && typeof data?.detail === "string" ? data.detail.trim() : "";
		throw new DeviceGroupRequestError(response.status, typeof data?.code === "string" ? data.code : "", detail);
	}
	return data as T;
}

export function deviceGroupErrorKind(error: unknown): "bind" | "running" | "forbidden" | "failed" {
	if (!(error instanceof DeviceGroupRequestError)) return "failed";
	if (["NOT_PAIRED", "REPAIR_REQUIRED", "DEVICE_CHANGED"].includes(error.code)) return "bind";
	if (["ROOM_BUSY", "ROOM_RUNNING", "TASKS_RUNNING", "ACTIVE_TASKS"].includes(error.code)) return "running";
	if (error.status === 403) return "forbidden";
	return "failed";
}

/** `chat-status` 投影：配对身份（`hubUrl`/`deviceId`）与“房间能不能列”（`roomsReady`，本机引擎永远 true）。 */
type ChatStatus = { hubUrl?: string; deviceId?: string; roomsReady?: boolean };

export function createDeviceGroupRefresh(
	load: (signal: AbortSignal) => Promise<SidebarDeviceGroup[]>,
	onResult: (rooms: SidebarDeviceGroup[]) => void,
	onError: (error: unknown) => void,
) {
	let controller: AbortController | undefined;
	let generation = 0;
	let queued = false;
	let stopped = false;
	const refresh = () => {
		if (stopped) return;
		const current = ++generation;
		if (controller) {
			queued = true;
			return;
		}
		const request = new AbortController();
		controller = request;
		void load(request.signal)
			.then(
				(rooms) => {
					if (!stopped && current === generation) onResult(rooms);
				},
				(error) => {
					if (!stopped && current === generation && !request.signal.aborted) onError(error);
				},
			)
			.finally(() => {
				controller = undefined;
				if (queued && !stopped) {
					queued = false;
					refresh();
				}
			});
	};
	return {
		refresh,
		pause: () => {
			generation++;
			queued = false;
			controller?.abort();
		},
		stop: () => {
			stopped = true;
			generation++;
			queued = false;
			controller?.abort();
		},
	};
}

function openGroup(detail: { roomId?: string; create?: boolean; manage?: boolean }) {
	window.dispatchEvent(new CustomEvent("pi-web-ui:device-group-open", { detail }));
}

export function DeviceGroupSection({
	active = true,
	entry,
	selectedRoomId,
	flex,
	onCollapsedChange,
	hideWhenEmpty = false,
	autoHeight = false,
}: {
	active?: boolean;
	entry?: UiSlotEntry;
	selectedRoomId?: string | null;
	flex?: number;
	onCollapsedChange?: (collapsed: boolean) => void;
	/** 一条群组都没有时不占位（建群入口在「智能体」标题行）。 */
	hideWhenEmpty?: boolean;
	/** 与智能体、项目树同层排开：按内容高度排布，超出时自身滚动，不参与弹性分配。 */
	autoHeight?: boolean;
}) {
	const t = useT();
	const title = entry?.labelExplicit ? entry.label : t("deviceGroups");
	const [collapsed, setCollapsed] = useState(false);
	const [addingBots, setAddingBots] = useState<SidebarDeviceGroup | null>(null);
	const [editingRoom, setEditingRoom] = useState<SidebarDeviceGroup | null>(null);
	const [expandedRooms, setExpandedRooms] = useState<Set<string>>(() => new Set());
	useEffect(() => onCollapsedChange?.(collapsed), [collapsed, onCollapsedChange]);
	const [rooms, setRooms] = useState<SidebarDeviceGroup[]>([]);
	const [bound, setBound] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<ReturnType<typeof deviceGroupErrorKind> | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const refreshRef = useRef<ReturnType<typeof createDeviceGroupRefresh> | null>(null);
	const mutationRef = useRef<AbortController | null>(null);
	const mounted = useRef(false);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			mutationRef.current?.abort();
		};
	}, []);

	useEffect(() => {
		if (!active) return;
		let confirmedBound = false;
		const poll = createDeviceGroupRefresh(
			async (signal) => {
				const status = await deviceGroupRequest<ChatStatus>("chat-status", signal);
				// 房间引擎在本机：不再要求“已配对远端 Hub”才去拉列表（旧 Hub 也能列本地房间）。
				confirmedBound = status.roomsReady === true || !!(status.hubUrl && status.deviceId);
				if (!confirmedBound) return [];
				const [local, shared] = await Promise.all([
					deviceGroupRequest<{ rooms: SidebarDeviceGroup[] }>("rooms", signal),
					// 共享群组：未配对（409）或远端不可达时视为空，不挡本机列表。
					deviceGroupRequest<{ rooms: SidebarDeviceGroup[] }>("shared-rooms", signal).catch(() => ({
						rooms: [] as SidebarDeviceGroup[],
					})),
				]);
				if (!Array.isArray(local.rooms)) throw new Error("Invalid rooms response");
				const seen = new Set<string>();
				const merged: SidebarDeviceGroup[] = [];
				for (const room of local.rooms) {
					seen.add(room.id);
					merged.push(room.scope ? room : { ...room, scope: "local" as const });
				}
				for (const room of Array.isArray(shared.rooms) ? shared.rooms : []) {
					if (seen.has(room.id)) continue;
					seen.add(room.id);
					merged.push(room.scope ? room : { ...room, scope: "shared" as const });
				}
				return merged;
			},
			(next) => {
				setBound(confirmedBound);
				setRooms(next);
				setError(null);
				setLoading(false);
			},
			(err) => {
				setError(deviceGroupErrorKind(err));
				setLoading(false);
			},
		);
		refreshRef.current = poll;
		const refresh = () => {
			if (!document.hidden) poll.refresh();
		};
		const visibility = () => {
			if (document.hidden) poll.pause();
			else refresh();
		};
		refresh();
		const timer = window.setInterval(refresh, 15_000);
		window.addEventListener(DEVICE_GROUPS_CHANGED, refresh);
		document.addEventListener("visibilitychange", visibility);
		return () => {
			poll.stop();
			refreshRef.current = null;
			window.clearInterval(timer);
			window.removeEventListener(DEVICE_GROUPS_CHANGED, refresh);
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [active]);

	const mutate = async (room: SidebarDeviceGroup, action: "rename" | "clear" | "delete") => {
		if (mutationRef.current) return;
		if (action === "delete" && !window.confirm(t("deviceGroupSectionConfirmDelete", { name: room.name }))) return;
		if (action === "clear" && !window.confirm(t("deviceGroupSectionConfirmClear", { name: room.name }))) return;
		const controller = new AbortController();
		mutationRef.current = controller;
		setBusy(true);
		setError(null);
		try {
			// 后端对 rooms/:id* 有共享回退，直连本地前缀即可；显式共享前缀少一次 404。
			const prefix = room.scope === "shared" ? "shared-rooms" : "rooms";
			await deviceGroupRequest(
				`${prefix}/${encodeURIComponent(room.id)}/${action}`,
				controller.signal,
				action === "rename" ? { name: name.trim() } : {},
			);
			if (!mounted.current || controller.signal.aborted) return;
			setRenaming(null);
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
		} catch (err) {
			if (mounted.current && !controller.signal.aborted) setError(deviceGroupErrorKind(err));
		} finally {
			mutationRef.current = null;
			if (mounted.current) setBusy(false);
		}
	};

	const menu = (event: React.MouseEvent, room: SidebarDeviceGroup) => {
		event.preventDefault();
		event.stopPropagation();
		const entries: UiSlotEntry[] = (["rename", "edit", "clear", "delete"] as const).map((action, order) => ({
			id: `host:device-group-${action}`,
			slot: "contextmenu.project",
			source: "host",
			label: t(ACTION_LABELS[action]),
			kind: "action",
			action,
			order,
			align: "start",
			hidden: false,
			userOverrides: [],
			arrangedBy: [],
		}));
		openContextMenu({
			x: event.clientX,
			y: event.clientY,
			slot: "contextmenu.project",
			target: { id: room.id, kind: "device-group", label: room.name },
			entries,
			onHostAction: (entry) => {
				if (mutationRef.current) return;
				if (entry.action === "rename") {
					setRenaming(room.id);
					setName(room.name);
				} else if (entry.action === "edit") setEditingRoom(room);
				else if (entry.action === "clear" || entry.action === "delete") void mutate(room, entry.action);
			},
		});
	};

	if (bound === false || (bound === null && loading)) return null;
	// 空群组不占位：左栏要的是“有就显示”，不让空态挤着下面的项目树。
	if (hideWhenEmpty && rooms.length === 0 && !error) return null;

	const body = (
		<div className="lp-section-body dg-side-body">
			{error && (
				<div className="dg-side-error" role="status">
					{t(ERROR_LABELS[error])}
					{error === "bind" ? (
						<button type="button" className="dc-button" onClick={() => openGroup({})}>
							{t("deviceGroupSectionOpenDeviceCenter")}
						</button>
					) : (
						<button type="button" className="dc-button" onClick={() => refreshRef.current?.refresh()}>
							{t("retryNow")}
						</button>
					)}
				</div>
			)}
			{!error && rooms.length === 0 && (
				<div className="dg-side-empty">{loading ? t("loading") : t("deviceGroupSectionEmpty")}</div>
			)}
			{rooms.map((room) => (
				<div key={room.id} className="dg-side-item">
					<div className="dg-side-heading">
						<button
							type="button"
							className="dg-side-toggle"
							aria-expanded={expandedRooms.has(room.id)}
							aria-label={`${room.name} · ${t("deviceGroupSectionMembers")}`}
							onClick={() =>
								setExpandedRooms((previous) => {
									const next = new Set(previous);
									if (next.has(room.id)) next.delete(room.id);
									else next.add(room.id);
									return next;
								})
							}
						>
							{expandedRooms.has(room.id) ? <FiChevronUp /> : <FiChevronDown />}
						</button>
						<div
							role="button"
							tabIndex={0}
							className={`dg-side-row${selectedRoomId === room.id ? " is-selected" : ""}`}
							aria-current={selectedRoomId === room.id ? "page" : undefined}
							title={room.name}
							onClick={() => openGroup({ roomId: room.id })}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									openGroup({ roomId: room.id });
								}
							}}
							onContextMenu={(event) => menu(event, room)}
						>
							<FiUsers />
							<span className="dg-side-name">
								{room.name}
								{room.scope === "shared" && (
									<small style={{ marginInlineStart: 6, opacity: 0.75 }}>{t("deviceGroupManagerSharedSuffix")}</small>
								)}
							</span>
						</div>
						<button
							type="button"
							className="dg-side-toggle"
							aria-label={`${room.name} · ${t("deviceGroupSectionAddBot")}`}
							title={t("deviceGroupSectionAddOrCreateBot")}
							onClick={() => setAddingBots(room)}
						>
							<FiPlus />
						</button>
					</div>
					{expandedRooms.has(room.id) && <DeviceGroupMembers botIds={room.botIds} roomId={room.id} />}
					{renaming === room.id && (
						<form
							className="dg-side-rename"
							onSubmit={(event) => {
								event.preventDefault();
								if (name.trim()) void mutate(room, "rename");
							}}
						>
							<input
								className="dc-input"
								aria-label={t("deviceGroupManagerNameLabel")}
								value={name}
								maxLength={120}
								autoFocus
								disabled={busy}
								onChange={(event) => setName(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Escape") setRenaming(null);
								}}
							/>
							<button type="submit" className="dc-button" disabled={busy || !name.trim()}>
								{t("save")}
							</button>
							<button type="button" className="dc-button" disabled={busy} onClick={() => setRenaming(null)}>
								{t("cancel")}
							</button>
						</form>
					)}
				</div>
			))}
		</div>
	);

	return (
		<section
			className={`lp-section dg-side-section${collapsed ? " collapsed" : ""}${autoHeight ? " lp-section-auto" : ""}`}
			aria-label={title}
			style={!collapsed && flex !== undefined ? { flex: `${flex} 1 0px` } : undefined}
		>
			<div className="lp-section-header">
				<button
					type="button"
					className="lp-section-title panel-section-title"
					aria-expanded={!collapsed}
					title={collapsed ? t("deviceGroupSectionExpand") : t("deviceGroupSectionCollapse")}
					onClick={() => setCollapsed(!collapsed)}
				>
					<span className="lp-section-title-text lp-section-title-chip">
						{entry && hostEntryIcon(entry)}
						<span>{title}</span>
						<span className="lp-section-count">({rooms.length})</span>
					</span>
					<span className="lp-section-chevron">{collapsed ? <FiChevronDown /> : <FiChevronUp />}</span>
				</button>
				<div className="lp-section-actions">
					<button
						type="button"
						className="lp-section-action"
						title={t("deviceGroupsCreate")}
						aria-label={t("deviceGroupsCreate")}
						onClick={() => openGroup({ create: true })}
					>
						<FiPlus />
					</button>
				</div>
			</div>
			{!collapsed && body}
			{addingBots && <DeviceGroupBotDialog room={addingBots} onClose={() => setAddingBots(null)} />}
			{editingRoom && <DeviceGroupEditDialog roomId={editingRoom.id} onClose={() => setEditingRoom(null)} />}
		</section>
	);
}
