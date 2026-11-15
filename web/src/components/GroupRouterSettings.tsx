import { useEffect, useRef, useState } from "react";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type { MessageKey } from "../i18n/catalog";

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
const ROUTER_TOOL_KEYS = {
	reply: "groupRouterToolReply",
	dispatch: "groupRouterToolDispatch",
	work_items: "groupRouterToolWorkItems",
} as const satisfies Record<GroupRouterConfig["tools"][number], MessageKey>;

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
	const t = useT();
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
						throw new Error(t("groupRouterCatalogMismatch"));
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
	}, [draft.deviceId, roomId, refresh, t]);
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
			setNotice(t("groupRouterSaved"));
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
			aria-label={t("groupRouterLabel")}
		>
			<p className="dc-bot-section-intro">{t("groupRouterIntro")}</p>
			<p role="status">
				{router?.enabled ? t("groupRouterStatusEnabled") : t("groupRouterDisabled")}{" "}
				{router?.enabled && ` · ${router.deviceId} · ${router.model} · ${router.thinkingLevel}`}
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<fieldset className="dc-bot-section" disabled={disabled || busy}>
					<legend>{t("groupRouterIndependent")}</legend>
					<label className="dc-bot-enabled">
						<input
							type="checkbox"
							role="switch"
							checked={draft.enabled}
							onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
						/>
						{t("groupRouterEnable")}
					</label>
					<label className="dc-field field">
						{t("groupRouterDevice")}
						<select
							value={draft.deviceId}
							onChange={(event) => {
								setDraft({ ...draft, deviceId: event.target.value, model: "" });
								setNotice("");
							}}
						>
							<option value="">{t("groupRouterSelectDevice")}</option>
							{draft.deviceId && !selectedDevice && <option value={draft.deviceId}>{draft.deviceId}</option>}
							{devices.map((device) => (
								<option key={device.id} value={device.id}>
									{device.name} · {device.id}
									{device.id === localDeviceId ? t("groupRouterLocalSuffix") : t("groupRouterRemoteSuffix")}
									{device.online === false ? t("groupRouterOfflineSuffix") : ""}
								</option>
							))}
						</select>
					</label>
					<label className="dc-field field">
						{t("groupRouterModel")}
						<select
							value={selectedModel ? draft.model : ""}
							disabled={!draft.deviceId || loading}
							onChange={(event) => setDraft({ ...draft, model: event.target.value })}
						>
							<option value="">{loading ? t("groupRouterCheckingModels") : t("groupRouterSelectModel")}</option>
							{models.map((model) => (
								<option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
									{model.name ?? model.id} · {model.provider}/{model.id}
								</option>
							))}
						</select>
					</label>
					<label className="dc-field">
						{t("groupRouterModelPlaceholder")}
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
						{t("groupRouterRecheck")}
					</button>
					{catalogError && (
						<p className="dc-bot-error" role="alert">
							{catalogError}
						</p>
					)}
					{draft.deviceId && !loading && !valid && <p role="status">{t("groupRouterValidationHint")}</p>}
					{selectedModel && (
						<p role="status">
							{t("groupRouterModelVerified")} · {draft.model}
						</p>
					)}
					<label className="dc-field field">
						{t("groupRouterThinking")}
						<select
							value={draft.thinkingLevel}
							onChange={(event) =>
								setDraft({ ...draft, thinkingLevel: event.target.value as GroupRouterConfig["thinkingLevel"] })
							}
						>
							{(["off", "minimal", "low", "medium", "high", "xhigh"] as const).map((level) => (
								<option key={level} value={level}>
									{t(`thinking.${level}`)}
								</option>
							))}
						</select>
					</label>
					<fieldset className="dc-bot-section">
						<legend>{t("groupRouterTools")}</legend>
						{(["reply", "dispatch", "work_items"] as const).map((tool) => (
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
								{t(ROUTER_TOOL_KEYS[tool])}
							</label>
						))}
					</fieldset>
					<button type="submit" className="btn primary" disabled={!canSave}>
						{busy ? t("saving") : t("groupRouterSave")}
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
