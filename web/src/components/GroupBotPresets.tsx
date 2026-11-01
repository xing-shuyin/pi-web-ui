import { useEffect, useRef, useState } from "react";
import type { LocalBot } from "../../../server/device-center/bots";
import type { GroupDevice } from "../device-group-messages";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";

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
	const zh = isZhLocale(useI18n().locale);
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
				`${zh ? "已保存新版本" : "Saved revision"} v${data.bot.revision}${data.synced ? "" : zh ? "；Hub同步待重试" : "; Hub sync pending"}`,
			);
		} catch (error) {
			if (!controller.signal.aborted) setStatus((error as Error).message);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	return (
		<details className="group-ecosystem-panel">
			<summary>{zh ? "Bot 配置与预设" : "Bot configuration and presets"}</summary>
			<label>
				Bot
				<select value={selected} disabled={busy} onChange={(event) => setSelected(event.target.value)}>
					<option value="">{zh ? "选择 Bot" : "Select Bot"}</option>
					{bots.map((item) => (
						<option key={item.id} value={item.id}>
							{item.name}
						</option>
					))}
				</select>
			</label>
			<p>
				{zh
					? "仅编辑本机 Bot。保存创建新 revision；忙碌的 Bot 会拒绝修改，在途任务不热改。"
					: "Edit local Bots only. Saving creates a new revision. Busy Bots reject edits; in-flight tasks retain their configuration."}
			</p>
			{remote && (
				<p role="status">
					{zh
						? "此 Bot 在远程设备。请在该设备的本机界面读取和保存配置。"
						: "This Bot belongs to a remote device. Read and save its configuration in that device's local UI."}
				</p>
			)}
			{bot && !remote && (
				<>
					<p>
						{bot.name} · v{bot.revision} · {bot.cwd}
					</p>
					<p>
						{zh ? "模型" : "Model"}:{" "}
						{bot.model ? `${bot.model.provider}/${bot.model.modelId}` : zh ? "跟随设备默认" : "Device default"}
					</p>
					<p>
						{zh ? "已授权工具" : "Authorized tools"}: {bot.tools.join(", ") || (zh ? "无" : "None")}
					</p>
					<label>
						{zh ? "可选预设 JSON（仅填写要修改的字段）" : "Optional preset JSON (include only fields to change)"}
						<textarea
							rows={6}
							value={preset}
							onChange={(event) => setPreset(event.target.value)}
							placeholder={'{"systemPrompt":"…"}'}
						/>
					</label>
					<p>
						{zh
							? "允许字段：model、tools、skills、mcpServers、systemPrompt。省略字段保留当前值；工具、技能、MCP及模型须在本机目录中可用。"
							: "Allowed fields: model, tools, skills, mcpServers, systemPrompt. Omitted fields retain current values. Tools, skills, MCP and models must be available locally."}
					</p>
					<button className="btn" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
						{zh ? "重新读取配置" : "Reload configuration"}
					</button>
					<button className="btn primary" disabled={busy || !preset.trim()} onClick={() => void save()}>
						{zh ? `保存为新 revision（基于 v${bot.revision}）` : `Save new revision (based on v${bot.revision})`}
					</button>
				</>
			)}
			{status && <p role="status">{status}</p>}
		</details>
	);
}
