import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FiMonitor } from "react-icons/fi";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import {
	closeDesktopAccess,
	getDesktopAccess,
	openDeviceAccess,
	setDesktopMode,
	subscribeDesktopAccess,
	type DesktopAccess,
} from "../device-access";
import type { ActiveGroupState } from "../group-active-context";
import { groupDesktops, type GroupDesktop } from "../group-desktop";
import { isZhLocale, useI18n, useT } from "../i18n";
import { DesktopPreviewFrame as PreviewFrame } from "./DesktopPreviewFrame";
import type { Device } from "./DeviceDirectory";

type Directory = { hubUrl: string; deviceId?: string; devices: Device[] };

export function GroupDesktopPreview({ group, visible }: { group: ActiveGroupState; visible: boolean }) {
	const t = useT();
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const access = useSyncExternalStore(subscribeDesktopAccess, getDesktopAccess);
	const seenAccess = useRef(access?.revision);
	const [directory, setDirectory] = useState<Directory>();
	const [error, setError] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [collapsed, setCollapsed] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [foreground, setForeground] = useState(!document.hidden);
	const active = visible && foreground && !collapsed && !group.disabled;
	const members = (group.detail?.bots ?? []).filter((bot) => group.detail?.room.botIds.includes(bot.id));
	const targets = groupDesktops(group.detail, directory?.devices ?? []);
	const shown = selected ? targets.filter((target) => target.members.some((bot) => bot.id === selected)) : targets;

	useEffect(() => {
		const changed = () => setForeground(!document.hidden);
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	}, []);
	useEffect(() => {
		if (!active) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			try {
				const read = async (path: string) => {
					const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
						credentials: "same-origin",
						signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
					});
					if (!response.ok) throw new Error("Group desktop directory unavailable");
					return response.json();
				};
				const [status, list] = await Promise.all([read("chat-status"), read("devices")]);
				if (typeof status.hubUrl !== "string" || !Array.isArray(list.devices)) throw new Error("Invalid directory");
				const devices = list.devices.filter(
					(device: Device) =>
						device &&
						typeof device.id === "string" &&
						typeof device.name === "string" &&
						typeof device.online === "boolean" &&
						(device.remark == null || typeof device.remark === "string"),
				);
				if (!controller.signal.aborted) {
					setDirectory({ hubUrl: status.hubUrl, deviceId: status.deviceId, devices });
					setError(false);
				}
			} catch {
				if (!controller.signal.aborted) setError(true);
			} finally {
				if (!controller.signal.aborted) timer = setTimeout(poll, 15000);
			}
		}
		void poll();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [active, attempt]);
	useEffect(() => {
		if (!access || access.revision === seenAccess.current || !group.detail) return;
		seenAccess.current = access.revision;
		if (access.groupId) return;
		const hosted = members.filter((member) => member.deviceId === access.id);
		const member = hosted.find((item) => item.name === access.name) ?? hosted[0];
		if (member) setSelected(member.id);
	}, [access, group.detail, members]);
	useEffect(() => {
		if (selected && !members.some((bot) => bot.id === selected && bot.deviceId)) setSelected(null);
		if (access?.groupId === group.roomId && !targets.some((target) => target.id === access.id))
			closeDesktopAccess(access);
	}, [selected, members, targets, access, group.roomId]);
	useEffect(
		() => () => {
			const current = getDesktopAccess();
			if (current?.groupId === group.roomId) closeDesktopAccess(current);
		},
		[group.roomId],
	);
	function select(id: string | null) {
		setSelected(id);
		if (access?.groupId === group.roomId && access.mode === "live") setDesktopMode(access, "preview");
	}
	async function open(target: GroupDesktop) {
		if (!directory || !target.online || group.disabled) return;
		try {
			await openDeviceAccess(target.id, directory.hubUrl, true, zh, false, target.name, {
				mode: "live",
				local: target.id === directory.deviceId,
				groupId: group.roomId,
			});
		} catch {
			setError(true);
		}
	}
	return (
		<section className="desktop-preview group-desktop" aria-label={t("desktop.groupTitle")}>
			<div className="desktop-preview-heading">
				<strong title={group.detail?.room.name}>{t("desktop.groupTitle")}</strong>
				<button
					type="button"
					className="btn"
					aria-label={t(collapsed ? "desktop.expand" : "desktop.collapse")}
					onClick={() => setCollapsed(!collapsed)}
				>
					{collapsed ? "+" : "−"}
				</button>
			</div>
			{!collapsed && (
				<>
					{error && (
						<div className="remote-desktop-error" role="status">
							{t("desktop.devicesUnavailable")}{" "}
							<button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>
								{t("desktop.retry")}
							</button>
						</div>
					)}
					{!directory && !error && (
						<p className="group-desktop-empty" role="status">
							{t("loading")}
						</p>
					)}
					{directory && (
						<div className={`group-desktop-grid${selected || targets.length === 1 ? " is-single" : ""}`}>
							{shown.map((target) => (
								<GroupDesktopCard
									key={target.id}
									target={target}
									active={active}
									directory={directory}
									zh={zh}
									selected={selected}
									access={access}
									onOpen={() => void open(target)}
								/>
							))}
							{!shown.length && <p className="group-desktop-empty">{t("desktop.noDevices")}</p>}
						</div>
					)}
					<div className="group-desktop-members" role="group" aria-label={t("desktop.groupMembers")}>
						<button type="button" className="btn" aria-pressed={selected === null} onClick={() => select(null)}>
							{t("desktop.groupAll")}
						</button>
						{members.map((member) => (
							<button
								key={member.id}
								type="button"
								className="btn"
								aria-pressed={selected === member.id}
								disabled={!member.deviceId}
								title={member.deviceId ? member.name : t("desktop.groupNoDevice")}
								aria-label={t("desktop.groupSelect", { name: member.name })}
								onClick={() => select(member.id)}
							>
								{member.name}
							</button>
						))}
					</div>
				</>
			)}
		</section>
	);
}

function GroupDesktopCard({
	target,
	active,
	directory,
	zh,
	selected,
	access,
	onOpen,
}: {
	target: GroupDesktop;
	active: boolean;
	directory: Directory;
	zh: boolean;
	selected: string | null;
	access: DesktopAccess | null;
	onOpen: () => void;
}) {
	const t = useT();
	const element = useRef<HTMLElement>(null);
	const [intersecting, setIntersecting] = useState(false);
	useEffect(() => {
		if (!element.current) return;
		const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting), { threshold: 0.01 });
		observer.observe(element.current);
		return () => observer.disconnect();
	}, []);
	const operating = access?.id === target.id && access.mode === "live";
	const names = target.members
		.filter((bot) => !selected || bot.id === selected)
		.map((bot) => bot.name)
		.join(" · ");
	const preview: DesktopAccess = {
		id: target.id,
		hubUrl: directory.hubUrl,
		name: target.name,
		zh,
		revision: 0,
		mode: "preview",
		local: directory.deviceId === target.id,
	};
	return (
		<article className="group-desktop-card" ref={element} aria-label={target.name}>
			<div className="group-desktop-card-heading">
				<strong title={names}>{names}</strong>
				<span title={target.name}>{target.name}</span>
			</div>
			{operating ? (
				<div className="group-desktop-placeholder">
					<span>{t("desktop.operating")}</span>
					<button type="button" className="btn" onClick={() => setDesktopMode(access, "preview")}>
						{t("desktop.back")}
					</button>
				</div>
			) : !target.online ? (
				<div className="group-desktop-placeholder">
					<FiMonitor aria-hidden />
					<span>{t("deviceHubOffline")}</span>
				</div>
			) : active && intersecting ? (
				<PreviewFrame
					access={preview}
					active
					collapsed={false}
					height={selected ? 220 : 120}
					onOpen={onOpen}
					label={names}
				/>
			) : (
				<div className="group-desktop-placeholder">
					<FiMonitor aria-hidden />
					<span>{t("desktop.paused")}</span>
				</div>
			)}
		</article>
	);
}
