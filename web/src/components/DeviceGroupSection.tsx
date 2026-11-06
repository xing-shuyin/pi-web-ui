import { useEffect, useRef, useState } from "react";
import { FiChevronDown, FiChevronUp, FiPlus, FiUsers } from "react-icons/fi";
import { appUrl } from "../base-url";
import { DeviceGroupMembers } from "./DeviceGroupMembers";
import { DeviceGroupBotDialog } from "./DeviceGroupBotDialog";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";
import { openContextMenu } from "../context-menu-state";
import type { UiSlotEntry } from "../ui-slots";
import { hostEntryIcon } from "../host-icon";

export type SidebarDeviceGroup = { id: string; name: string; botIds: string[] };
export const DEVICE_GROUPS_CHANGED = "pi-web-ui:device-groups-changed";
const words = {
	zh: {
		groups: "群组",
		create: "建群",
		rename: "重命名",
		members: "管理成员",
		clear: "清空消息",
		delete: "删除群组",
		confirmClear: "确定清空群组“{name}”的全部消息和历史任务记录？此操作无法撤销，群组和成员将保留。",
		save: "保存",
		cancel: "取消",
		empty: "还没有群组",
		loading: "加载中…",
		expand: "展开群组",
		collapse: "折叠群组",
		bind: "请先在设备设置中绑定本机，旧版绑定请重新绑定。",
		settings: "打开设备中心",
		failed: "群组请求失败，请重试。",
		retry: "重试",
		forbidden: "无法访问群组，请检查本机访问权限。",
		running: "群内仍有排队或运行中的任务，请等待任务结束后再操作。",
		confirm: "确定删除群组“{name}”？",
		name: "群名称",
	},
	en: {
		groups: "Groups",
		create: "Create group",
		rename: "Rename",
		members: "Manage members",
		clear: "Clear messages",
		delete: "Delete group",
		confirmClear:
			"Clear all messages and task history in “{name}”? This cannot be undone. The group and members will be kept.",
		save: "Save",
		cancel: "Cancel",
		empty: "No groups yet",
		loading: "Loading…",
		expand: "Expand groups",
		collapse: "Collapse groups",
		bind: "Bind this computer in device settings first. Older bindings must be renewed.",
		settings: "Open device center",
		failed: "Group request failed. Please retry.",
		retry: "Retry",
		forbidden: "Group access denied. Check local access permissions.",
		running: "This group has queued or running tasks. Wait for them to finish before making this change.",
		confirm: "Delete group “{name}”?",
		name: "Group name",
	},
};

export class DeviceGroupRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(`Device group request failed (${status})`);
	}
}

export async function deviceGroupRequest<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		...(body === undefined
			? {}
			: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new DeviceGroupRequestError(response.status, typeof data?.code === "string" ? data.code : "");
	return data as T;
}

export function deviceGroupErrorKind(error: unknown): "bind" | "running" | "forbidden" | "failed" {
	if (!(error instanceof DeviceGroupRequestError)) return "failed";
	if (["NOT_PAIRED", "REPAIR_REQUIRED", "DEVICE_CHANGED"].includes(error.code)) return "bind";
	if (["ROOM_BUSY", "ROOM_RUNNING", "TASKS_RUNNING", "ACTIVE_TASKS"].includes(error.code)) return "running";
	if (error.status === 403) return "forbidden";
	return "failed";
}

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
	hideHeader = false,
	onRoomCountChange,
}: {
	active?: boolean;
	entry?: UiSlotEntry;
	selectedRoomId?: string | null;
	flex?: number;
	onCollapsedChange?: (collapsed: boolean) => void;
	hideHeader?: boolean;
	onRoomCountChange?: (count: number) => void;
}) {
	const { locale } = useI18n();
	const w = words[isZhLocale(locale) ? "zh" : "en"];
	const title = entry?.labelExplicit ? entry.label : w.groups;
	const [collapsed, setCollapsed] = useState(false);
	const [addingBots, setAddingBots] = useState<SidebarDeviceGroup | null>(null);
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
				const status = await deviceGroupRequest<{ hubUrl?: string; deviceId?: string }>("chat-status", signal);
				confirmedBound = !!(status.hubUrl && status.deviceId);
				if (!confirmedBound) return [];
				const result = await deviceGroupRequest<{ rooms: SidebarDeviceGroup[] }>("rooms", signal);
				if (!Array.isArray(result.rooms)) throw new Error("Invalid rooms response");
				return result.rooms;
			},
			(next) => {
				setBound(confirmedBound);
				setRooms(next);
				onRoomCountChange?.(next.length);
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
		if (action === "delete" && !window.confirm(w.confirm.replace("{name}", room.name))) return;
		if (action === "clear" && !window.confirm(w.confirmClear.replace("{name}", room.name))) return;
		const controller = new AbortController();
		mutationRef.current = controller;
		setBusy(true);
		setError(null);
		try {
			await deviceGroupRequest(
				`rooms/${encodeURIComponent(room.id)}/${action}`,
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
		const entries: UiSlotEntry[] = (["rename", "members", "clear", "delete"] as const).map((action, order) => ({
			id: `host:device-group-${action}`,
			slot: "contextmenu.project",
			source: "host",
			label: w[action],
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
				} else if (entry.action === "members") openGroup({ roomId: room.id, manage: true });
				else if (entry.action === "clear" || entry.action === "delete") void mutate(room, entry.action);
			},
		});
	};

	if (bound === false || (bound === null && loading)) return null;

	const body = (
		<div className="lp-section-body dg-side-body">
			{error && (
				<div className="dg-side-error" role="status">
					{w[error]}
					{error === "bind" ? (
						<button type="button" className="dc-button" onClick={() => openGroup({})}>
							{w.settings}
						</button>
					) : (
						<button type="button" className="dc-button" onClick={() => refreshRef.current?.refresh()}>
							{w.retry}
						</button>
					)}
				</div>
			)}
			{!error && rooms.length === 0 && <div className="dg-side-empty">{loading ? w.loading : w.empty}</div>}
			{rooms.map((room) => (
				<div key={room.id} className="dg-side-item">
					<div className="dg-side-heading">
						<button
							type="button"
							className="dg-side-toggle"
							aria-expanded={expandedRooms.has(room.id)}
							aria-label={`${room.name} · ${isZhLocale(locale) ? "成员" : "Members"}`}
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
							<span className="dg-side-name">{room.name}</span>
						</div>
						<button
							type="button"
							className="dg-side-toggle"
							aria-label={`${room.name} · ${isZhLocale(locale) ? "添加 Bot" : "Add Bot"}`}
							title={isZhLocale(locale) ? "添加或新建 Bot" : "Add or create Bot"}
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
								aria-label={w.name}
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
								{w.save}
							</button>
							<button type="button" className="dc-button" disabled={busy} onClick={() => setRenaming(null)}>
								{w.cancel}
							</button>
						</form>
					)}
				</div>
			))}
		</div>
	);

	if (hideHeader) {
		return (
			<section
				className="lp-section dg-side-section"
				aria-label={title}
				style={flex !== undefined ? { flex: `${flex} 1 0px` } : undefined}
			>
				{body}
				{addingBots && <DeviceGroupBotDialog room={addingBots} onClose={() => setAddingBots(null)} />}
			</section>
		);
	}

	return (
		<section
			className={`lp-section dg-side-section ${collapsed ? "collapsed" : ""}`}
			aria-label={title}
			style={!collapsed && flex !== undefined ? { flex: `${flex} 1 0px` } : undefined}
		>
			<div className="lp-section-header">
				<button
					type="button"
					className="lp-section-title panel-section-title"
					aria-expanded={!collapsed}
					title={collapsed ? w.expand : w.collapse}
					onClick={() => setCollapsed(!collapsed)}
				>
					<span className="lp-section-title-text">
						{entry && hostEntryIcon(entry)} {title} ({rooms.length})
					</span>
					<span className="lp-section-chevron">{collapsed ? <FiChevronDown /> : <FiChevronUp />}</span>
				</button>
				<div className="lp-section-actions">
					<button
						type="button"
						className="lp-section-action"
						title={w.create}
						aria-label={w.create}
						onClick={() => openGroup({ create: true })}
					>
						<FiPlus />
					</button>
				</div>
			</div>
			{!collapsed && body}
			{addingBots && <DeviceGroupBotDialog room={addingBots} onClose={() => setAddingBots(null)} />}
		</section>
	);
}
