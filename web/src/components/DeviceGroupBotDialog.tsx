import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { LocalBots } from "./LocalBots";
import { DEVICE_GROUPS_CHANGED, deviceGroupRequest, type SidebarDeviceGroup } from "./DeviceGroupSection";

type Bot = { id: string; name: string; enabled: boolean; deviceName?: string };
export function DeviceGroupBotDialog({ room, onClose }: { room: SidebarDeviceGroup; onClose: () => void }) {
	const t = useT();
	const [bots, setBots] = useState<Bot[]>([]);
	const [members, setMembers] = useState(room.botIds);
	const [selected, setSelected] = useState<string[]>([]);
	const [creating, setCreating] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [refresh, setRefresh] = useState(0);
	const mutation = useRef<AbortController | null>(null);
	const close = () => {
		if (!busy && !creating) onClose();
	};
	useEscapeKey(close);
	useEffect(() => () => mutation.current?.abort(), []);
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		void Promise.all([
			deviceGroupRequest<{ bots: Bot[] }>("bots", controller.signal),
			deviceGroupRequest<{ room: SidebarDeviceGroup }>(`rooms/${encodeURIComponent(room.id)}`, controller.signal),
		])
			.then(([data, detail]) => {
				if (controller.signal.aborted) return;
				setBots(data.bots);
				setMembers(detail.room.botIds);
			})
			.catch((cause) => {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [room.id, refresh]);
	async function add(ids: string[]) {
		if (mutation.current) return;
		const controller = new AbortController();
		mutation.current = controller;
		setBusy(true);
		setError("");
		try {
			const path = `rooms/${encodeURIComponent(room.id)}`;
			const latest = await deviceGroupRequest<{ room: SidebarDeviceGroup }>(path, controller.signal);
			if (controller.signal.aborted) return;
			await deviceGroupRequest(`${path}/members`, controller.signal, {
				botIds: [...new Set([...latest.room.botIds, ...ids])],
			});
			if (controller.signal.aborted) return;
			window.dispatchEvent(new CustomEvent(DEVICE_GROUPS_CHANGED));
			onClose();
		} catch (cause) {
			if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			mutation.current = null;
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	return createPortal(
		<div className="modal-backdrop" onClick={close}>
			<div
				className="device-group-bot-dialog"
				role="dialog"
				aria-modal="true"
				aria-label={t("deviceGroupSectionAddOrCreateBot")}
				onClick={(event) => event.stopPropagation()}
			>
				<div className="dg-heading">
					<h2>
						{t("deviceGroupSectionAddBot")} · {room.name}
					</h2>
					<button type="button" className="dc-button" disabled={busy || creating} onClick={close}>
						{t("close")}
					</button>
				</div>
				{error && (
					<p className="dc-notice is-error" role="alert">
						{error}
					</p>
				)}
				<p>{t("deviceGroupBotDialogLead")}</p>
				{loading ? (
					<p>{t("loading")}</p>
				) : (
					<div className="dg-bot-choices">
						{bots
							.filter((bot) => bot.enabled && !members.includes(bot.id))
							.map((bot) => (
								<label className="dg-bot-choice" key={bot.id}>
									<input
										type="checkbox"
										disabled={busy || creating}
										checked={selected.includes(bot.id)}
										onChange={(event) =>
											setSelected((old) =>
												event.target.checked ? [...old, bot.id] : old.filter((id) => id !== bot.id),
											)
										}
									/>
									<span>
										{bot.name}
										{bot.deviceName && <small>{bot.deviceName}</small>}
									</span>
								</label>
							))}
						{!bots.some((bot) => bot.enabled && !members.includes(bot.id)) && <p>{t("deviceGroupBotDialogEmpty")}</p>}
					</div>
				)}
				<div className="dc-actions">
					<button
						type="button"
						className="dc-button"
						disabled={busy || creating}
						onClick={() => {
							setCreating(true);
							setError("");
						}}
					>
						{t("deviceGroupsCreateBot")}
					</button>
					<button
						type="button"
						className="dc-button"
						disabled={loading || busy || creating || !selected.length}
						onClick={() => void add(selected)}
					>
						{busy ? t("deviceGroupBotDialogAdding") : t("deviceGroupBotDialogAddToGroup")}
					</button>
				</div>
				{creating && (
					<LocalBots
						createOnly
						onCancel={() => setCreating(false)}
						onCreated={(bot, synced) => {
							setCreating(false);
							setRefresh((old) => old + 1);
							if (!synced || !bot.enabled) {
								setError(t("deviceGroupBotDialogSaved"));
								return;
							}
							void add([bot.id]);
						}}
					/>
				)}
			</div>
		</div>,
		document.body,
	);
}
