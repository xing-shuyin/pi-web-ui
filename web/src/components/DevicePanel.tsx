import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	FiCheck,
	FiChevronRight,
	FiCopy,
	FiEdit2,
	FiMonitor,
	FiMoreHorizontal,
	FiRefreshCw,
	FiX,
} from "react-icons/fi";
import { isZhLocale, useI18n } from "../i18n";
import { useOverlayZIndex } from "../overlay-stack";
import { useEscapeKey } from "../shortcut-stack";
import { useFloatingPanel } from "../use-floating-panel";
import type { Device } from "./DeviceDirectory";

/** 下拉刷新的原始位移阈值（像素）；视觉拉伸只取一半，最多 56px。 */
const PULL_TRIGGER = 84;
const PULL_MAX = 56;
/** 触屏长按进入备注编辑的时长。 */
const LONG_PRESS_MS = 480;

export type DevicePanelProps = {
	devices: Device[];
	error: string;
	currentDeviceId: string;
	/** 由 hubUrl 推出的设备访问地址；拿不到就不渲染入口。 */
	targetOf: (deviceId: string) => string | undefined;
	onOpen: (event: React.MouseEvent<HTMLElement>, deviceId: string, desktop?: boolean) => void;
	onRemark: (deviceId: string, text: string) => Promise<boolean>;
	onRefresh: () => void;
	/** 触控布局：抽屉 + 56px 行 + 44px 触控块 + 行内次行 + 底部备注条。 */
	mobile: boolean;
};

/** 备注优先作为显示名（与行内展示一致）。 */
function displayNameOf(device: Device): string {
	return device.remark?.trim() ? device.remark.trim() : device.name;
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 8) : id;
}

async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* 继续走兜底 */
	}
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * 设备浮层的内容体（桌面浮层与手机抽屉共用）：
 * 一行一台设备 = 一个可点区域（打开设备）+ 行尾「远程桌面」和「⋯」两个常显动作。
 * 高频动作不进菜单；备注用行内编辑（手机是抽屉底部编辑条，长按也能直接进）。
 */
export function DevicePanel({
	devices,
	error,
	currentDeviceId,
	targetOf,
	onOpen,
	onRemark,
	onRefresh,
	mobile,
}: DevicePanelProps) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [menu, setMenu] = useState<{ device: Device; anchor: HTMLElement } | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [spinning, setSpinning] = useState(false);
	const [pull, setPull] = useState(0);
	const [pullReady, setPullReady] = useState(false);
	const [localError, setLocalError] = useState("");

	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pressStart = useRef<{ x: number; y: number } | null>(null);
	const suppressClickUntil = useRef(0);
	const refreshRef = useRef(onRefresh);
	const pulledRef = useRef(0);

	useEffect(() => {
		refreshRef.current = onRefresh;
	}, [onRefresh]);

	function handleRefresh() {
		setSpinning(true);
		refreshRef.current();
		window.setTimeout(() => setSpinning(false), 900);
	}

	// 菜单必须 portal 到 body + fixed：否则会被 .dp-scroll / 浮层的 overflow 截断
	const menuZIndex = useOverlayZIndex(!!menu);
	const menuPanel = useFloatingPanel({
		open: !!menu,
		anchor: menu?.anchor ?? null,
		align: "right",
		gap: 4,
		onClose: () => setMenu(null),
	});

	// Escape 先退编辑态，再轮到外层浮层/抽屉关闭（叠栈按注册顺序取最上层）
	useEscapeKey(() => {
		setEditingId(null);
		return true;
	}, !!editingId);

	// 备注编辑：桌面行内输入框，手机抽屉底部编辑条
	useEffect(() => {
		if (!editingId) return;
		const el = inputRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, [editingId]);

	// 触屏：列表内下拉刷新（只在滚动到顶部时接管，位移超过阈值才触发）
	useEffect(() => {
		const el = scrollRef.current;
		if (!el || !mobile) return;
		let startY = 0;
		let pulling = false;
		const onStart = (event: TouchEvent) => {
			if (el.scrollTop > 0 || event.touches.length !== 1) return;
			startY = event.touches[0].clientY;
			pulling = true;
			pulledRef.current = 0;
		};
		const onMove = (event: TouchEvent) => {
			if (!pulling) return;
			const distance = event.touches[0].clientY - startY;
			if (distance <= 0) {
				pulledRef.current = 0;
				setPull(0);
				setPullReady(false);
				return;
			}
			if (el.scrollTop > 0) {
				pulling = false;
				pulledRef.current = 0;
				setPull(0);
				setPullReady(false);
				return;
			}
			pulledRef.current = distance;
			setPull(Math.min(PULL_MAX, distance * 0.5));
			setPullReady(distance >= PULL_TRIGGER);
			if (distance > 8 && event.cancelable) event.preventDefault();
		};
		const onEnd = () => {
			if (!pulling) return;
			pulling = false;
			const reached = pulledRef.current >= PULL_TRIGGER;
			pulledRef.current = 0;
			setPull(0);
			setPullReady(false);
			if (reached) handleRefresh();
		};
		el.addEventListener("touchstart", onStart, { passive: true });
		el.addEventListener("touchmove", onMove, { passive: false });
		el.addEventListener("touchend", onEnd);
		el.addEventListener("touchcancel", onEnd);
		return () => {
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", onEnd);
			el.removeEventListener("touchcancel", onEnd);
		};
	}, [mobile]);

	function clearPress() {
		if (pressTimer.current) {
			clearTimeout(pressTimer.current);
			pressTimer.current = null;
		}
		pressStart.current = null;
	}

	function startEdit(device: Device) {
		setMenu(null);
		setLocalError("");
		setEditingId(device.id);
		setDraft(device.remark ?? "");
	}

	async function commitEdit(device: Device, text: string) {
		if (saving) return;
		setSaving(true);
		const ok = await onRemark(device.id, text.trim());
		setSaving(false);
		if (ok) {
			setEditingId(null);
			setDraft("");
		} else {
			inputRef.current?.focus();
		}
	}

	function onRowPointerDown(event: React.PointerEvent<HTMLLIElement>, device: Device) {
		if (!mobile) return;
		if (event.target instanceof Element && event.target.closest("button")) return;
		clearPress();
		pressStart.current = { x: event.clientX, y: event.clientY };
		pressTimer.current = setTimeout(() => {
			pressTimer.current = null;
			suppressClickUntil.current = Date.now() + 900;
			navigator.vibrate?.(8);
			startEdit(device);
		}, LONG_PRESS_MS);
	}

	function onRowPointerMove(event: React.PointerEvent<HTMLLIElement>) {
		const start = pressStart.current;
		if (!start) return;
		if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 10) clearPress();
	}

	const editingDevice = editingId ? devices.find((device) => device.id === editingId) : undefined;
	const notice = localError || error;

	return (
		<div className={`dp-panel${mobile ? " is-mobile" : ""}`}>
			<div className="dp-head">
				<span className="dp-title">{zh ? "设备" : "Devices"}</span>
				<span className="dp-count">{devices.length}</span>
				<span className="dp-spacer" />
				<button
					type="button"
					className={`dp-icon dp-refresh${spinning ? " is-spinning" : ""}`}
					aria-label={zh ? "刷新设备" : "Refresh devices"}
					title={zh ? "刷新设备（手机上也可下拉刷新）" : "Refresh (or pull down on touch)"}
					onClick={handleRefresh}
				>
					<FiRefreshCw aria-hidden />
				</button>
			</div>

			{notice && (
				<p className="dp-notice" role="alert">
					{notice}
				</p>
			)}

			<div className="dp-scroll" ref={scrollRef}>
				<div className="dp-pull" style={{ height: pull }} aria-hidden={pull === 0}>
					{pull > 0 && (
						<span className="dp-pull-text">
							{pullReady ? (zh ? "松手刷新" : "Release to refresh") : zh ? "下拉刷新" : "Pull to refresh"}
						</span>
					)}
				</div>
				<ul className="dp-list">
					{devices.length === 0 && (
						<li className="dp-empty">{zh ? "同一账号下暂无其它设备" : "No other devices yet"}</li>
					)}
					{devices.map((device) => {
						const hasRemark = Boolean(device.remark?.trim());
						const displayName = hasRemark ? device.remark!.trim() : device.name;
						const isSelf = device.id === currentDeviceId;
						const isEditing = editingId === device.id;
						const menuOpen = menu?.device.id === device.id;
						const target = targetOf(device.id);
						const meta = [shortId(device.id), device.online ? "" : zh ? "离线" : "Offline"].filter(Boolean).join(" · ");
						return (
							<li
								key={device.id}
								className={`dp-row${device.online ? "" : " is-off"}${isEditing ? " is-editing" : ""}`}
								onPointerDown={(event) => onRowPointerDown(event, device)}
								onPointerMove={onRowPointerMove}
								onPointerUp={clearPress}
								onPointerCancel={clearPress}
								onPointerLeave={clearPress}
							>
								<span className={`dp-dot${device.online ? " is-on" : ""}`} aria-hidden />
								{target && (
									<a
										className="dp-hit"
										href={target}
										target="_blank"
										rel="noopener noreferrer"
										aria-label={`${zh ? "打开设备" : "Open device"} ${displayName}${device.online ? "" : zh ? "（离线）" : " (offline)"}`}
										title={`${displayName} · ${device.id}`}
										onClick={(event) => {
											if (Date.now() < suppressClickUntil.current) {
												event.preventDefault();
												return;
											}
											onOpen(event, device.id);
										}}
									/>
								)}
								<span className="dp-main">
									<span className="dp-name">
										<strong title={displayName}>{displayName}</strong>
										{isSelf && <em className="dp-tag">{zh ? "本机" : "This"}</em>}
									</span>
									{isEditing && !mobile ? (
										<input
											ref={inputRef}
											className="dp-input"
											type="text"
											maxLength={80}
											value={draft}
											disabled={saving}
											placeholder={zh ? "输入备注（留空清除）" : "Remark (blank to clear)"}
											onChange={(event) => setDraft(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === "Enter") {
													event.preventDefault();
													void commitEdit(device, draft);
												}
												if (event.key === "Escape") {
													event.preventDefault();
													setEditingId(null);
												}
											}}
											onBlur={() => setEditingId(null)}
										/>
									) : (
										<span className="dp-sub" title={device.id}>
											{meta}
										</span>
									)}
								</span>
								<span className="dp-actions">
									{isEditing && !mobile ? (
										<>
											<button
												type="button"
												className="dp-icon"
												aria-label={zh ? "保存备注" : "Save remark"}
												disabled={saving}
												onMouseDown={(event) => event.preventDefault()}
												onClick={() => void commitEdit(device, draft)}
											>
												<FiCheck aria-hidden />
											</button>
											<button
												type="button"
												className="dp-icon"
												aria-label={zh ? "取消" : "Cancel"}
												disabled={saving}
												onMouseDown={(event) => event.preventDefault()}
												onClick={() => setEditingId(null)}
											>
												<FiX aria-hidden />
											</button>
										</>
									) : (
										<>
											<button
												type="button"
												className="dp-icon"
												aria-label={zh ? "远程桌面" : "Remote desktop"}
												title={zh ? "远程桌面" : "Remote desktop"}
												onClick={(event) => {
													clearPress();
													onOpen(event, device.id, true);
												}}
											>
												<FiMonitor aria-hidden />
											</button>
											<button
												type="button"
												className="dp-icon"
												aria-label={zh ? "更多操作" : "More actions"}
												aria-haspopup="menu"
												aria-expanded={menuOpen}
												onClick={(event) => {
													clearPress();
													setLocalError("");
													setCopiedId(null);
													const anchor = event.currentTarget;
													setMenu((current) => (current?.device.id === device.id ? null : { device, anchor }));
												}}
											>
												<FiMoreHorizontal aria-hidden />
											</button>
										</>
									)}
								</span>
								<FiChevronRight className="dp-chev" aria-hidden />
							</li>
						);
					})}
				</ul>
			</div>

			{menu &&
				createPortal(
					<div
						ref={menuPanel.panelRef}
						style={{ ...menuPanel.style, zIndex: menuZIndex }}
						className="dp-menu"
						role="menu"
						aria-label={displayNameOf(menu.device)}
					>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								startEdit(menu.device);
							}}
						>
							<FiEdit2 aria-hidden />
							{menu.device.remark?.trim() ? (zh ? "修改备注" : "Edit remark") : zh ? "设置备注" : "Set remark"}
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								const { device } = menu;
								void copyText(device.id).then((ok) => {
									if (!ok) {
										setLocalError(zh ? "复制失败，请手动选择设备 ID。" : "Copy failed.");
										setMenu(null);
										return;
									}
									setCopiedId(device.id);
									setTimeout(() => {
										setCopiedId((current) => (current === device.id ? null : current));
										setMenu(null);
									}, 900);
								});
							}}
						>
							{copiedId === menu.device.id ? <FiCheck aria-hidden /> : <FiCopy aria-hidden />}
							{copiedId === menu.device.id ? (zh ? "已复制" : "Copied") : zh ? "复制设备 ID" : "Copy device ID"}
						</button>
					</div>,
					document.body,
				)}

			{editingDevice && mobile && (
				<form
					className="dp-editbar"
					onSubmit={(event) => {
						event.preventDefault();
						void commitEdit(editingDevice, draft);
					}}
				>
					<input
						ref={inputRef}
						className="dp-editbar-input"
						type="text"
						maxLength={80}
						value={draft}
						disabled={saving}
						aria-label={zh ? "设备备注" : "Device remark"}
						placeholder={
							zh
								? `给「${editingDevice.remark?.trim() || editingDevice.name}」写备注（留空清除）`
								: "Device remark (blank to clear)"
						}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								setEditingId(null);
							}
						}}
					/>
					<button type="submit" className="dp-save" disabled={saving}>
						{saving ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
					</button>
					<button
						type="button"
						className="dp-icon dp-cancel"
						aria-label={zh ? "取消" : "Cancel"}
						disabled={saving}
						onClick={() => setEditingId(null)}
					>
						<FiX aria-hidden />
					</button>
				</form>
			)}
		</div>
	);
}
