import { useEffect, useRef, useState } from "react";
import type { LocalBot } from "../../../server/device-center/bots";
import type { GroupDevice } from "../device-group-messages";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";

async function localRequest(path: string, signal: AbortSignal, body?: object) {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		signal,
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
	return data;
}

export function GroupBotPresets({
	bots,
	preferredBotId,
	onSaved,
}: {
	bots: GroupDevice[];
	preferredBotId?: string;
	onSaved(): void;
}) {
	const t = useT();
	const [selected, setSelected] = useState(preferredBotId ?? bots[0]?.id ?? "");
	const [bot, setBot] = useState<LocalBot | null>(null);
	const [deviceId, setDeviceId] = useState("");
	const [preset, setPreset] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [refresh, setRefresh] = useState(0);
	const operation = useRef<AbortController | null>(null);
	useEffect(() => {
		if (!selected && bots.length) setSelected(preferredBotId ?? bots[0].id);
	}, [selected, bots, preferredBotId]);
	const target = bots.find((item) => item.id === selected);
	const remote = !!deviceId && !!target?.deviceId && target.deviceId !== deviceId;
	useEffect(() => {
		const controller = new AbortController();
		operation.current = controller;
		setBusy(false);
		setBot(null);
		setStatus("");
		void (async () => {
			const identity = await localRequest("chat-status", controller.signal);
			setDeviceId(identity.deviceId ?? "");
			if (!selected) return;
			if (target?.deviceId && identity.deviceId !== target.deviceId) return;
			const data = await localRequest(`local-bots/${encodeURIComponent(selected)}`, controller.signal);
			if (!controller.signal.aborted) setBot(data.bot);
		})().catch((error) => {
			if (!controller.signal.aborted) setStatus(error.message);
		});
		return () => controller.abort();
	}, [selected, target?.deviceId, refresh]);
	async function save() {
		const controller = operation.current;
		if (!bot || remote || !preset.trim() || !controller || controller.signal.aborted) return;
		setBusy(true);
		setStatus("");
		try {
			const data = await localRequest(`local-bots/${encodeURIComponent(bot.id)}/preset`, controller.signal, {
				revision: bot.revision,
				preset: JSON.parse(preset),
			});
			if (controller.signal.aborted) return;
			setBot(data.bot);
			onSaved();
			setStatus(
				t(data.synced ? "groupBotPresets.saved" : "groupBotPresets.savedHubPending", {
					rev: data.bot.revision,
				}),
			);
		} catch (error) {
			if (!controller.signal.aborted) setStatus((error as Error).message);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	return (
		<details className="group-ecosystem-panel">
			<summary>{t("groupBotPresets.title")}</summary>
			<label>
				Bot
				<select value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
					<option value="">{t("groupBotPresets.selectBot")}</option>
					{bots.map((item) => (
						<option key={item.id} value={item.id}>
							{item.name}
						</option>
					))}
				</select>
			</label>
			<p>{t("groupBotPresets.editHint")}</p>
			{remote && <p role="status">{t("groupBotPresets.remoteHint")}</p>}
			{bot && !remote && (
				<>
					<p>
						{bot.name} · v{bot.revision} · {bot.cwd}
					</p>
					<p>
						{t("localBotModel")}:{" "}
						{bot.model ? `${bot.model.provider}/${bot.model.modelId}` : t("groupBotPresets.deviceDefault")}
					</p>
					<p>
						{t("groupBotPresets.authorizedTools")}: {bot.tools.join(", ") || t("extensionInventory.none")}
					</p>
					<label>
						{t("groupBotPresets.presetJsonLabel")}
						<textarea
							rows={6}
							value={preset}
							onChange={(event) => setPreset(event.target.value)}
							placeholder={'{"systemPrompt":"…"}'}
						/>
					</label>
					<p>{t("groupBotPresets.presetFieldsHint")}</p>
					<button className="btn" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
						{t("groupBotPresets.reload")}
					</button>
					<button className="btn primary" disabled={busy || !preset.trim()} onClick={() => void save()}>
						{t("groupBotPresets.saveRevision", { rev: bot.revision })}
					</button>
				</>
			)}
			{status && <p role="status">{status}</p>}
		</details>
	);
}
