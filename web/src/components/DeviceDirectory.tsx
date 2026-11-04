import { useEffect, useState } from "react";
import { FiCheck, FiEdit2, FiExternalLink, FiMonitor, FiRefreshCw, FiX } from "react-icons/fi";
import { appUrl } from "../base-url";
import { openDeviceAccess } from "../device-access";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";

export type Device = { id: string; name: string; remark?: string | null; online: boolean; alias?: string };
export function DeviceDirectory({
	hubUrl,
	currentDeviceId,
	onRemarkUpdated,
}: {
	hubUrl: string;
	currentDeviceId: string;
	onRemarkUpdated?: (deviceId: string, remark: string) => void;
}) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
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
					throw new Error(
						response.status === 409
							? zh
								? "请重新绑定本机以读取设备列表。"
								: "Pair this computer again to read the device list."
							: zh
								? "无法读取设备列表，请重试。"
								: "Could not load devices. Try again.",
					);
				const data = await response.json();
				if (!Array.isArray(data.devices)) throw new Error(zh ? "设备列表格式异常。" : "Invalid device list.");
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
	}, [hubUrl, currentDeviceId, refresh, zh]);
	function target(id: string): string | undefined {
		try {
			const base = new URL(hubUrl);
			if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return;
			return new URL(`/device/${encodeURIComponent(id)}`, base).href;
		} catch {
			return;
		}
	}
	async function openDevice(event: React.MouseEvent<HTMLAnchorElement>, id: string, desktop = false) {
		event.preventDefault();
		try {
			await openDeviceAccess(id, hubUrl, desktop, zh);
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}
	async function saveRemark(deviceId: string, text: string) {
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
				throw new Error(data.error || (zh ? "保存备注失败" : "Failed to save remark"));
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
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSavingId(null);
		}
	}
	return (
		<section className="dc-card" aria-label={zh ? "所有设备" : "All devices"}>
			<div className="dc-card-header">
				<span className="dc-icon">
					<FiMonitor aria-hidden />
				</span>
				<div>
					<h2>
						{zh ? "所有设备" : "All devices"} · {devices.length}
					</h2>
					<p>
						{zh
							? "同一账号下的设备，使用本机绑定授权直接访问。"
							: "Devices in your account. Access is authorized through this computer's pairing."}
					</p>
				</div>
				<button
					type="button"
					className="dc-icon-button"
					aria-label={zh ? "刷新设备" : "Refresh devices"}
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
									{device.id === currentDeviceId ? (zh ? "本机" : "This device") : device.id}
								</span>
							</div>
							<span className={`dc-status ${device.online ? "is-online" : "is-offline"}`}>
								{device.online ? (zh ? "在线" : "Online") : zh ? "离线" : "Offline"}
							</span>
							<div className="dc-actions">
								<button
									type="button"
									className="dc-button"
									title={zh ? (hasRemark ? "修改备注" : "设置备注") : hasRemark ? "Edit remark" : "Set remark"}
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
									{zh ? (hasRemark ? "修改备注" : "设置备注") : hasRemark ? "Edit remark" : "Set remark"}
								</button>
								{target(device.id) && (
									<>
										<a
											className="dc-button"
											href={target(device.id)}
											target="_blank"
											rel="noopener noreferrer"
											onClick={(event) => void openDevice(event, device.id)}
										>
											<FiExternalLink aria-hidden />
											{zh ? "打开设备" : "Open device"}
										</a>
										<a
											className="dc-button"
											href={`${target(device.id)}/desktop`}
											target="_blank"
											rel="noopener noreferrer"
											onClick={(event) => void openDevice(event, device.id, true)}
										>
											<FiMonitor aria-hidden />
											{zh ? "远程桌面" : "Remote desktop"}
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
										placeholder={zh ? "输入设备备注（留空清除）" : "Device remark (leave blank to clear)"}
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
										{savingId === device.id ? (zh ? "保存中…" : "Saving…") : zh ? "保存" : "Save"}
									</button>
									<button
										type="button"
										className="dc-button"
										disabled={savingId === device.id}
										onClick={() => setEditingId(null)}
									>
										<FiX aria-hidden />
										{zh ? "取消" : "Cancel"}
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
