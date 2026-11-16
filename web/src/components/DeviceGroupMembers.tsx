import { useEffect, useState } from "react";
import { FiAtSign, FiExternalLink, FiMonitor } from "react-icons/fi";
import { referenceGroupMember } from "../group-member-reference";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { openDeviceAccess } from "../device-access";
import { useT } from "../i18n";

type Member = { id: string; deviceId: string; name: string; online?: boolean };
export function DeviceGroupMembers({ botIds, roomId }: { botIds: string[]; roomId?: string }) {
	const t = useT();
	const [data, setData] = useState<{ bots: Member[]; hubUrl: string; deviceId?: string } | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let stopped = false;
		let controller: AbortController;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			controller = new AbortController();
			try {
				const read = async (path: string) => {
					const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
						credentials: "same-origin",
						signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
					});
					if (!response.ok) throw new Error(t("deviceGroupMembers.loadFailed"));
					return response.json();
				};
				const [status, bots] = await Promise.all([read("chat-status"), read("bots")]);
				if (!status.hubUrl || !Array.isArray(bots.bots)) throw new Error(t("deviceGroupMembers.invalidBinding"));
				if (!stopped) {
					setData({ hubUrl: status.hubUrl, deviceId: status.deviceId, bots: bots.bots });
					setError("");
				}
			} catch (cause) {
				if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				controller.abort();
				if (!stopped) timer = setTimeout(poll, 15000);
			}
		}
		void poll();
		return () => {
			stopped = true;
			controller?.abort();
			clearTimeout(timer);
		};
	}, [t]);
	async function open(member: Member, desktop: boolean) {
		if (!data || busy) return;
		setBusy(true);
		try {
			await openDeviceAccess(member.deviceId, data.hubUrl, desktop, t, false, member.name);
			setError("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="dg-side-members">
			{error && (
				<div className="dg-side-error" role="alert">
					{error}
				</div>
			)}
			{!data && !error && <div className="dg-side-empty">{t("loading")}</div>}
			{botIds.length === 0 && <div className="dg-side-empty">{t("deviceGroupMembers.empty")}</div>}
			{data &&
				botIds.map((id) => {
					const member = data.bots.find((bot) => bot.id === id);
					return (
						<div className="dg-side-member" key={id}>
							<div className="dg-side-member-name" title={member?.name || id}>
								<span>{member?.name || id}</span>
								<small>{member?.online ? t("deviceHubOnline") : t("deviceHubOffline")}</small>
								{roomId && member && (
									<button
										type="button"
										className="dg-side-toggle"
										title={t("deviceGroupMembers.reference")}
										aria-label={`${t("deviceGroupMembers.reference")} · ${member.name}`}
										onClick={() => referenceGroupMember(roomId, member)}
									>
										<FiAtSign aria-hidden />
									</button>
								)}
								{member?.deviceId && data.deviceId && member.deviceId !== data.deviceId && (
									<div className="dg-side-member-actions">
										<button
											type="button"
											className="dg-side-toggle"
											title={t("deviceDirectory.remoteDesktop")}
											aria-label={t("deviceDirectory.remoteDesktop")}
											disabled={busy || !member?.deviceId}
											onClick={() => member && void open(member, true)}
										>
											<FiMonitor aria-hidden />
										</button>
										<button
											type="button"
											className="dg-side-toggle"
											title={t("deviceGroupMembers.openDevice")}
											aria-label={t("deviceGroupMembers.openDevice")}
											disabled={busy || !member?.deviceId}
											onClick={() => member && void open(member, false)}
										>
											<FiExternalLink aria-hidden />
										</button>
									</div>
								)}
							</div>
						</div>
					);
				})}
		</div>
	);
}
