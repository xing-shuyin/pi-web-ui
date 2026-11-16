import { useEffect, useState } from "react";
import { FiCheck, FiEdit2, FiExternalLink, FiMonitor, FiRefreshCw, FiX } from "react-icons/fi";
import { appUrl } from "../base-url";
import { openDeviceAccess } from "../device-access";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import { DevicePanel } from "./DevicePanel";

export type Device = { id: string; name: string; remark?: string | null; online: boolean; alias?: string };

/** 设备在 hub 上的访问地址；协议不合法（含账号密码等）时不给入口。 */
function deviceTarget(hubUrl: string, deviceId: string): string | undefined {
	try {
		const base = new URL(hubUrl);
		if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return;
		return new URL(`/device/${encodeURIComponent(deviceId)}`, base).href;
	} catch {
		return;
	}
}

export function DeviceDirectory({
	hubUrl,
	currentDeviceId,
	onRemarkUpdated,
	onAfterOpen,
	variant = "page",
	mobile = false,
}: {
	hubUrl: string;
	currentDeviceId: string;
	onRemarkUpdated?: (deviceId: string, remark: string) => void;
	/** 成功打开某台设备后回调（手机抽屉用它收起自己）。 */
	onAfterOpen?: () => void;
	/** `page` = 设备中心整页卡片；`panel` = 左上角浮层 / 手机抽屉的紧凑列表。 */
	variant?: "page" | "panel";
	/** 触控布局（抽屉）：行 56px、44px 触控块、行内显示设备 ID。 */
	mobile?: boolean;
}) {
	const t = useT();
	const [devices, setDevices] = useState<Device[]>([]);
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [remarkInput, setRemarkInput] = useState("");
	const [savingId, setSavingId] = useState<string | null>(null);
	useEffect(() => {
		let stopped = false;
		let controller: AbortController | undefined;
		let timer: ReturnType<typeof setTimeout>;
		async function load() {
			controller = new AbortController();
			try {
				const response = await fetch(withToken(appUrl("/api/device-center/devices")), {
					signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
					credentials: "same-origin",
				});
				if (!response.ok)
					throw new Error(response.status === 409 ? t("deviceDirectory.pairAgain") : t("deviceDirectory.loadFailed"));
				const data = await response.json();
				if (!Array.isArray(data.devices)) throw new Error(t("deviceDirectory.invalidList"));
				if (!stopped) {
					setDevices(data.devices);
					setError("");
				}
			} catch (cause) {
				if (!stopped) {
					setDevices([]);
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			} finally {
				if (!stopped) timer = setTimeout(load, 5000);
			}
		}
		void load();
		return () => {
			stopped = true;
			controller?.abort();
			clearTimeout(timer);
		};
	}, [hubUrl, currentDeviceId, refresh, t]);
	async function openDevice(event: React.MouseEvent<HTMLElement>, id: string, desktop = false) {
		event.preventDefault();
		try {
			await openDeviceAccess(id, hubUrl, desktop, t, false, devices.find((device) => device.id === id)?.name);
			setError("");
			onAfterOpen?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}
	async function saveRemark(deviceId: string, text: string): Promise<boolean> {
		setSavingId(deviceId);
		const trimmed = text.trim();
		try {
			const response = await fetch(
				withToken(appUrl(`/api/device-center/devices/${encodeURIComponent(deviceId)}/remark`)),
				{
					method: "POST",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ remark: trimmed }),
				},
			);
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.error || t("deviceDirectory.saveRemarkFailed"));
			}
			setDevices((prev) => prev.map((d) => (d.id === deviceId ? { ...d, remark: trimmed || undefined } : d)));
			setEditingId(null);
			setError("");
			onRemarkUpdated?.(deviceId, trimmed);
			window.dispatchEvent(
				new CustomEvent("pi-web-ui:device-remark-updated", {
					detail: { deviceId, remark: trimmed || undefined },
				}),
			);
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setSavingId(null);
		}
	}

	if (variant === "panel")
		return (
			<DevicePanel
				devices={devices}
				error={error}
				currentDeviceId={currentDeviceId}
				targetOf={(deviceId) => deviceTarget(hubUrl, deviceId)}
				onOpen={openDevice}
				onRemark={saveRemark}
				onRefresh={() => setRefresh((n) => n + 1)}
				mobile={mobile}
			/>
		);

	return (
		<section className="dc-card" aria-label={t("deviceDirectory.allDevices")}>
			<div className="dc-card-header">
				<span className="dc-icon">
					<FiMonitor aria-hidden />
				</span>
				<div>
					<h2>
						{t("deviceDirectory.allDevices")} · {devices.length}
					</h2>
					<p>{t("deviceDirectory.intro")}</p>
				</div>
				<button
					type="button"
					className="dc-icon-button"
					aria-label={t("deviceDirectory.refresh")}
					onClick={() => setRefresh((n) => n + 1)}
				>
					<FiRefreshCw />
				</button>
			</div>
			{error && (
				<p className="dc-notice is-error" role="alert">
					{error}
				</p>
			)}
			<div className="dd-list">
				{devices.map((device) => {
					const hasRemark = Boolean(device.remark?.trim());
					const displayName = hasRemark ? device.remark!.trim() : device.name;
					const isEditing = editingId === device.id;
					return (
						<div className="dd-device" key={device.id} style={isEditing ? { flexWrap: "wrap" } : undefined}>
							<span className="dc-device-icon">
								<FiMonitor aria-hidden />
							</span>
							<div className="dd-identity">
								<strong>{displayName}</strong>
								<span>
									{hasRemark ? `${device.name} · ` : ""}
									{device.id === currentDeviceId ? t("deviceDirectory.thisDevice") : device.id}
								</span>
							</div>
							<span className={`dc-status ${device.online ? "is-online" : "is-offline"}`}>
								{device.online ? t("deviceHubOnline") : t("deviceHubOffline")}
							</span>
							<div className="dc-actions">
								<button
									type="button"
									className="dc-button"
									title={hasRemark ? t("deviceDirectory.editRemark") : t("deviceDirectory.setRemark")}
									onClick={() => {
										if (isEditing) {
											setEditingId(null);
										} else {
											setEditingId(device.id);
											setRemarkInput(device.remark ?? "");
										}
									}}
								>
									<FiEdit2 aria-hidden />
									{hasRemark ? t("deviceDirectory.editRemark") : t("deviceDirectory.setRemark")}
								</button>
								{deviceTarget(hubUrl, device.id) && (
									<>
										<a
											className="dc-button"
											href={deviceTarget(hubUrl, device.id)}
											target="_blank"
											rel="noopener noreferrer"
											onClick={(event) => void openDevice(event, device.id)}
										>
											<FiExternalLink aria-hidden />
											{t("deviceDirectory.openDevice")}
										</a>
										<a
											className="dc-button"
											href={`${deviceTarget(hubUrl, device.id)}/desktop`}
											target="_blank"
											rel="noopener noreferrer"
											onClick={(event) => void openDevice(event, device.id, true)}
										>
											<FiMonitor aria-hidden />
											{t("deviceDirectory.remoteDesktop")}
										</a>
									</>
								)}
							</div>
							{isEditing && (
								<form
									className="dd-remark-form"
									style={{
										display: "flex",
										alignItems: "center",
										gap: "8px",
										width: "100%",
										paddingTop: "8px",
										paddingBottom: "4px",
									}}
									onSubmit={(event) => {
										event.preventDefault();
										void saveRemark(device.id, remarkInput);
									}}
								>
									<input
										type="text"
										maxLength={80}
										autoFocus
										disabled={savingId === device.id}
										placeholder={t("deviceDirectory.remarkPlaceholder")}
										value={remarkInput}
										onChange={(event) => setRemarkInput(event.target.value)}
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
									<button type="submit" className="dc-button is-primary" disabled={savingId === device.id}>
										<FiCheck aria-hidden />
										{savingId === device.id ? t("saving") : t("save")}
									</button>
									<button
										type="button"
										className="dc-button"
										disabled={savingId === device.id}
										onClick={() => setEditingId(null)}
									>
										<FiX aria-hidden />
										{t("cancel")}
									</button>
								</form>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}
