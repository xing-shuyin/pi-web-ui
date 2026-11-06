import { useEffect, useRef, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { isZhLocale, useI18n } from "../i18n";

export interface GroupRouterConfig {
	enabled: boolean;
	deviceId: string;
	model: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	tools: ("reply" | "dispatch" | "work_items")[];
}
interface RouterDevice {
	id: string;
	name: string;
	online?: boolean;
}
interface RouterModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
}
const emptyConfig: GroupRouterConfig = {
	enabled: false,
	deviceId: "",
	model: "",
	thinkingLevel: "off",
	tools: ["reply", "dispatch", "work_items"],
};

async function routerRequest<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
	const response = await fetch(withToken(appUrl(`/api/device-center/${path}`)), {
		method: body ? "POST" : "GET",
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
		credentials: "same-origin",
		...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
	return data;
}

export function GroupRouterSettings({
	roomId,
	router,
	disabled = false,
	onSaved,
}: {
	roomId: string;
	router?: GroupRouterConfig;
	disabled?: boolean;
	onSaved(): void;
}) {
	const zh = isZhLocale(useI18n().locale);
	const [draft, setDraft] = useState<GroupRouterConfig>(router ?? emptyConfig);
	const [devices, setDevices] = useState<RouterDevice[]>([]);
	const [localDeviceId, setLocalDeviceId] = useState("");
	const [models, setModels] = useState<RouterModel[]>([]);
	const [verifiedDeviceId, setVerifiedDeviceId] = useState("");
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [catalogError, setCatalogError] = useState("");
	const [notice, setNotice] = useState("");
	const [refresh, setRefresh] = useState(0);
	const operation = useRef<AbortController | null>(null);
	const savedConfig = JSON.stringify(router ?? emptyConfig);
	useEffect(() => {
		setDraft(JSON.parse(savedConfig));
		setNotice("");
	}, [roomId, savedConfig]);
	useEffect(() => {
		const controller = new AbortController();
		operation.current = controller;
		setBusy(false);
		setError("");
		setDevices([]);
		setLocalDeviceId("");
		void Promise.all([
			routerRequest<{ devices: RouterDevice[] }>("devices", controller.signal),
			routerRequest<{ deviceId: string }>("chat-status", controller.signal),
		])
			.then(([directory, local]) => {
				if (controller.signal.aborted) return;
				setDevices(directory.devices ?? []);
				setLocalDeviceId(local.deviceId);
			})
			.catch((cause) => {
				if (!controller.signal.aborted) setError(String(cause.message));
			});
		return () => controller.abort();
	}, [roomId]);
	useEffect(() => {
		const controller = new AbortController();
		setModels([]);
		setVerifiedDeviceId("");
		setCatalogError("");
		setLoading(!!draft.deviceId);
		if (draft.deviceId) {
			void routerRequest<{ deviceId: string; models: RouterModel[] }>(
				`router-models?deviceId=${encodeURIComponent(draft.deviceId)}`,
				controller.signal,
			)
				.then((data) => {
					if (controller.signal.aborted) return;
					if (data.deviceId !== draft.deviceId || !Array.isArray(data.models))
						throw new Error(zh ? "模型目录与所选设备不匹配" : "Model catalog does not match the selected device");
					setModels(data.models);
					setVerifiedDeviceId(data.deviceId);
				})
				.catch((cause) => {
					if (!controller.signal.aborted) setCatalogError(String(cause.message));
				})
				.finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
		}
		return () => controller.abort();
	}, [draft.deviceId, roomId, refresh, zh]);
	const selectedDevice = devices.find((device) => device.id === draft.deviceId);
	const selectedModel =
		verifiedDeviceId === draft.deviceId
			? models.find((model) => `${model.provider}/${model.id}` === draft.model)
			: undefined;
	const valid = !!draft.deviceId && !!selectedModel && selectedDevice?.online !== false;
	const canSave =
		valid || (!draft.enabled && !!router?.model && draft.deviceId === router.deviceId && draft.model === router.model);
	async function save() {
		const controller = operation.current;
		if (!controller || controller.signal.aborted || busy || disabled || !canSave) return;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await routerRequest(`rooms/${encodeURIComponent(roomId)}`, controller.signal, { router: draft });
			if (controller.signal.aborted) return;
			onSaved();
			window.dispatchEvent(new CustomEvent("pi-web-ui:device-groups-changed"));
			setNotice(zh ? "群组 Router 配置已保存" : "Group Router settings saved");
		} catch (cause) {
			if (!controller.signal.aborted) setError((cause as Error).message);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}
	return (
		<section
			className="dc-bot-editor-body"
			style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere" }}
			aria-label={zh ? "群组 AI Router" : "Group AI Router"}
		>
			<p className="dc-bot-section-intro">
				{zh
					? "群组 AI 是独立的中心 Router，负责理解消息与调度；Bot 只执行任务。Router 的模型、思考与工具独立配置。"
					: "The group AI is an independent central Router that understands messages and coordinates work. Bots execute tasks. Its model, thinking and tools are configured separately."}
			</p>
			<p role="status">
				{router?.enabled
					? zh
						? "已启用"
						: "Enabled"
					: zh
						? "未启用 · 沿用原主 Bot 协作"
						: "Disabled · using legacy primary Bot routing"}{" "}
				{router?.enabled && ` · ${router.deviceId} · ${router.model} · ${router.thinkingLevel}`}
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<fieldset className="dc-bot-section" disabled={disabled || busy}>
					<legend>{zh ? "独立 Router 配置" : "Independent Router settings"}</legend>
					<label className="dc-bot-enabled">
						<input
							type="checkbox"
							role="switch"
							checked={draft.enabled}
							onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
						/>
						{zh ? "启用群组 AI Router" : "Enable group AI Router"}
					</label>
					<label className="dc-field field">
						{zh ? "运行设备" : "Run on device"}
						<select
							value={draft.deviceId}
							onChange={(event) => {
								setDraft({ ...draft, deviceId: event.target.value, model: "" });
								setNotice("");
							}}
						>
							<option value="">{zh ? "选择设备" : "Select device"}</option>
							{draft.deviceId && !selectedDevice && <option value={draft.deviceId}>{draft.deviceId}</option>}
							{devices.map((device) => (
								<option key={device.id} value={device.id}>
									{device.name} · {device.id}
									{device.id === localDeviceId ? (zh ? " · 本机" : " · Local") : zh ? " · 远程" : " · Remote"}
									{device.online === false ? (zh ? " · 离线" : " · Offline") : ""}
								</option>
							))}
						</select>
					</label>
					<label className="dc-field field">
						{zh ? "该设备的模型" : "Model on this device"}
						<select
							value={selectedModel ? draft.model : ""}
							disabled={!draft.deviceId || loading}
							onChange={(event) => setDraft({ ...draft, model: event.target.value })}
						>
							<option value="">
								{loading ? (zh ? "正在验证设备模型…" : "Checking device models…") : zh ? "选择模型" : "Select model"}
							</option>
							{models.map((model) => (
								<option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
									{model.name ?? model.id} · {model.provider}/{model.id}
								</option>
							))}
						</select>
					</label>
					<label className="dc-field">
						{zh
							? "或输入完整模型 ID（需在所选设备验证）"
							: "Or enter a full model ID (verified on the selected device)"}
						<input
							value={draft.model}
							placeholder="provider/modelId"
							onChange={(event) => setDraft({ ...draft, model: event.target.value.trim() })}
						/>
					</label>
					<button
						type="button"
						className="btn"
						disabled={!draft.deviceId || loading}
						onClick={() => setRefresh((n) => n + 1)}
					>
						{zh ? "重新验证模型目录" : "Recheck model catalog"}
					</button>
					{catalogError && (
						<p className="dc-bot-error" role="alert">
							{catalogError}
						</p>
					)}
					{draft.deviceId && !loading && !valid && (
						<p role="status">
							{zh
								? "所选设备必须在线，且模型须存在于该设备目录中，才能启用。不会自动选择其他模型。"
								: "Enabling requires an online device and a model in its catalog. No alternative model is selected automatically."}
						</p>
					)}
					{selectedModel && (
						<p role="status">
							{zh ? "模型已在所选设备验证" : "Model verified on the selected device"} · {draft.model}
						</p>
					)}
					<label className="dc-field field">
						{zh ? "思考级别" : "Thinking level"}
						<select
							value={draft.thinkingLevel}
							onChange={(event) =>
								setDraft({ ...draft, thinkingLevel: event.target.value as GroupRouterConfig["thinkingLevel"] })
							}
						>
							{(["off", "minimal", "low", "medium", "high", "xhigh"] as const).map((level, index) => (
								<option key={level} value={level}>
									{zh ? ["关闭", "最少", "低", "中", "高", "极高"][index] : level}
								</option>
							))}
						</select>
					</label>
					<fieldset className="dc-bot-section">
						<legend>
							{zh ? "Router 工具（独立于 Bot 执行工具）" : "Router tools (separate from Bot execution tools)"}
						</legend>
						{(["reply", "dispatch", "work_items"] as const).map((tool, index) => (
							<label key={tool} className="dc-bot-enabled">
								<input
									type="checkbox"
									role="switch"
									checked={draft.tools.includes(tool)}
									onChange={(event) =>
										setDraft({
											...draft,
											tools: event.target.checked
												? [...draft.tools, tool]
												: draft.tools.filter((value) => value !== tool),
										})
									}
								/>{" "}
								{zh
									? ["回复群聊", "派发任务", "管理工单"][index]
									: ["Reply to group", "Dispatch tasks", "Manage work items"][index]}
							</label>
						))}
					</fieldset>
					<button type="submit" className="btn primary" disabled={!canSave}>
						{busy ? (zh ? "保存中…" : "Saving…") : zh ? "保存 Router 配置" : "Save Router settings"}
					</button>
				</fieldset>
			</form>
			{error && (
				<p className="dc-bot-error" role="alert">
					{error}
				</p>
			)}
			{notice && <p role="status">{notice}</p>}
		</section>
	);
}
