import { useEffect, useRef, useState } from "react";
import { HubLink } from "./HubLink";
import { appUrl } from "../base-url";
import { withToken } from "../auth-token";
import { useT } from "../i18n";
import type { createPluginHostApi } from "../plugin-host";
import {
	buildHubDeploymentPrompt,
	HUB_DEPLOYMENT_GUIDE_PAGE_URL,
	remoteHubSetup,
	type RemoteHubSetupInput,
	isLocalSetupOrigin,
	validateHubSetup,
	type DeviceCenterSetupInfo,
} from "../device-center-setup";

export function DeviceCenterSetup({
	onConnect,
	initialHubUrl = "",
}: {
	onConnect: (url: string) => void;
	initialHubUrl?: string;
}) {
	const t = useT();
	const [existingUrl, setExistingUrl] = useState(initialHubUrl);
	const [detail, setDetail] = useState("");
	const [assistBusy, setAssistBusy] = useState(false);
	const [assistError, setAssistError] = useState(false);
	const assistPending = useRef(false);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [mode, setMode] = useState<"connect" | "create" | null>(null);
	const [target, setTarget] = useState<"current" | "remote">("current");
	const [info, setInfo] = useState<DeviceCenterSetupInfo | null>(null);
	const [host, setHost] = useState("127.0.0.1");
	const [port, setPort] = useState("8790");
	const [publicUrl, setPublicUrl] = useState("http://127.0.0.1:8790");
	const [remote, setRemote] = useState<RemoteHubSetupInput>({
		server: "",
		sshPort: 22,
		username: "root",
		auth: "password",
		port: 8790,
		domain: "",
		https: false,
	});
	const remoteInput = remoteHubSetup(remote);
	const [busy, setBusy] = useState(false);
	const [updating, setUpdating] = useState(false);
	const [updateResult, setUpdateResult] = useState<string | null>(null);
	const [error, setError] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [metadataError, setMetadataError] = useState(false);
	const [result, setResult] = useState<{ publicUrl: string; output: string } | null>(null);
	const controller = useRef<AbortController | null>(null);
	const locked = useRef(false);
	const local = isLocalSetupOrigin(window.location.origin);
	useEffect(() => () => controller.current?.abort(), []);
	const load = async () => {
		if (locked.current) return;
		controller.current?.abort();
		const request = new AbortController();
		controller.current = request;
		setError(false);
		setLoaded(false);
		setMetadataError(false);
		try {
			const response = await fetch(withToken(appUrl("/api/device-center/setup")), {
				credentials: "same-origin",
				signal: request.signal,
			});
			if (!response.ok) throw new Error();
			const data = (await response.json()) as DeviceCenterSetupInfo;
			if (
				!data ||
				typeof data.platform !== "string" ||
				typeof data.nodeVersion !== "string" ||
				typeof data.dataDir !== "string" ||
				typeof data.cliPath !== "string" ||
				!validateHubSetup({ host: "127.0.0.1", port: data.defaultPort, publicUrl: data.defaultPublicUrl })
			)
				throw new Error();
			if (request.signal.aborted) return;
			setInfo(data);
			if (data.installation?.installed) {
				setHost(data.installation.host ?? "127.0.0.1");
				setPort(String(data.installation.port));
				setPublicUrl(data.installation.publicUrl ?? "");
				setExistingUrl(data.installation.publicUrl ?? "");
			} else if (!info) {
				setPort(String(data.defaultPort));
				setPublicUrl(data.defaultPublicUrl);
			}
		} catch {
			if (!request.signal.aborted) {
				setError(true);
				setMetadataError(true);
			}
		} finally {
			if (!request.signal.aborted) setLoaded(true);
		}
	};
	const install = async () => {
		const input = { host, port: Number(port), publicUrl };
		if (
			locked.current ||
			!local ||
			!info ||
			!loaded ||
			metadataError ||
			info.busy ||
			info.installation?.installed ||
			!validateHubSetup(input)
		)
			return;
		locked.current = true;
		controller.current?.abort();
		setBusy(true);
		setError(false);
		setDetail("");
		const request = new AbortController();
		controller.current = request;
		try {
			const response = await fetch(withToken(appUrl("/api/device-center/setup")), {
				credentials: "same-origin",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...input, allowRegistration: true }),
				signal: request.signal,
			});
			if (response.status === 409) {
				setInfo((previous) => (previous ? { ...previous, busy: true } : previous));
				locked.current = false;
				setBusy(false);
				await load();
				return;
			}
			if (!response.ok) {
				const failure = await response.json().catch(() => ({}));
				throw new Error(typeof failure.error === "string" ? failure.error.slice(0, 4096) : `HTTP ${response.status}`);
			}
			const data = (await response.json()) as { publicUrl: string; output: string };
			if (!validateHubSetup({ ...input, publicUrl: data.publicUrl }) || typeof data.output !== "string")
				throw new Error();
			if (!request.signal.aborted) setResult(data);
		} catch (cause) {
			if (!request.signal.aborted) {
				setError(true);
				setDetail(cause instanceof Error ? cause.message.slice(0, 4096) : "");
			}
		} finally {
			locked.current = false;
			if (!request.signal.aborted) setBusy(false);
		}
	};
	const updateHub = async () => {
		if (locked.current || !local || !info || !loaded || metadataError || info.busy || busy || updating) return;
		locked.current = true;
		controller.current?.abort();
		setUpdating(true);
		setError(false);
		setDetail("");
		setUpdateResult(null);
		const request = new AbortController();
		controller.current = request;
		try {
			const response = await fetch(withToken(appUrl("/api/device-center/setup/update")), {
				credentials: "same-origin",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: request.signal,
			});
			if (!response.ok) {
				const failure = await response.json().catch(() => ({}));
				throw new Error(typeof failure.error === "string" ? failure.error.slice(0, 4096) : `HTTP ${response.status}`);
			}
			const data = (await response.json()) as { success: boolean; output: string };
			if (!request.signal.aborted) {
				setUpdateResult(data.output || t("deviceSetupUpdateSuccess"));
				await load();
			}
		} catch (cause) {
			if (!request.signal.aborted) {
				setError(true);
				setDetail(cause instanceof Error ? cause.message.slice(0, 4096) : "");
			}
		} finally {
			locked.current = false;
			if (!request.signal.aborted) setUpdating(false);
		}
	};
	const installation = info?.installation;
	const installed = !!installation?.installed;
	const healthy = installed && installation.running && installation.owned;
	const input = target === "remote" ? remoteInput : { host, port: Number(port), publicUrl };
	const valid = !!input && validateHubSetup(input);
	const assist = () => {
		if (!valid || !input || assistPending.current) return;
		assistPending.current = true;
		setAssistBusy(true);
		setAssistError(false);
		const complete = (ok: boolean) => {
			assistPending.current = false;
			if (!mounted.current) return;
			setAssistBusy(false);
			setAssistError(!ok);
		};
		const api = (window as unknown as { __piWebUiHost?: ReturnType<typeof createPluginHostApi> }).__piWebUiHost;
		try {
			if (
				!api?.startChat({
					newChat: true,
					prompt: buildHubDeploymentPrompt(input, info, target, target === "remote" ? remote : undefined),
					onResult: complete,
				})
			)
				complete(false);
		} catch {
			complete(false);
		}
	};
	return (
		<section className="dc-onboarding">
			<h3>{t("deviceSetupWelcome")}</h3>
			<p>{t("deviceSetupIntro")}</p>
			<div className="dc-actions">
				<button
					className="dc-button"
					disabled={busy}
					aria-pressed={mode === "connect"}
					onClick={() => setMode("connect")}
				>
					{t("deviceSetupConnect")}
				</button>
				<button
					className="dc-button"
					disabled={busy}
					aria-pressed={mode === "create"}
					onClick={() => {
						setMode("create");
						if (!info && local) void load();
					}}
				>
					{t("deviceSetupCreate")}
				</button>
			</div>
			{mode === "connect" && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						onConnect(existingUrl.trim());
					}}
				>
					<label className="dc-field">
						<span>{t("deviceHubHubUrl")}</span>
						<input
							type="url"
							required
							maxLength={2048}
							value={existingUrl}
							onChange={(e) => setExistingUrl(e.target.value)}
							placeholder="https://hub.example.com"
						/>
					</label>
					<button
						className="dc-button is-primary"
						disabled={!validateHubSetup({ host: "localhost", port: 8790, publicUrl: existingUrl.trim() })}
					>
						{t("deviceSetupPair")}
					</button>
				</form>
			)}
			{mode === "create" && (
				<>
					<label className="dc-field">
						<span>{t("deviceSetupTarget")}</span>
						<select disabled={busy} value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
							<option value="current">{t("deviceSetupCurrent")}</option>
							<option value="remote">{t("deviceSetupRemote")}</option>
						</select>
					</label>
					<>
						<p>{t(target === "current" ? "deviceSetupCurrentHint" : "deviceSetupRemoteHint")}</p>
						{target === "current" && (
							<div className="dc-setup-plan">
								<strong>{t("deviceSetupPlan")}</strong>
								<p>{t("deviceSetupPlanHint")}</p>
								{info && (
									<dl>
										<dt>{t("deviceSetupEnvironment")}</dt>
										<dd>
											{info.platform} · Node {info.nodeVersion}
										</dd>
										<dt>{t("deviceSetupDataDir")}</dt>
										<dd>{info.dataDir}</dd>
										<dt>{t("deviceSetupCli")}</dt>
										<dd>{info.cliPath}</dd>
									</dl>
								)}
								{!local && <p role="status">{t("deviceSetupLocalOnly")}</p>}
								<p>{t("deviceSetupBackground")}</p>
								{installed && (
									<div role="status">
										<h4>{t(healthy ? "deviceSetupRestored" : "deviceSetupUnhealthy")}</h4>
										<p>{installation.publicUrl}</p>
										{healthy && valid && installation.publicUrl ? (
											<div className="dc-actions">
												<HubLink href={installation.publicUrl}>{t("deviceHubOpenHub")}</HubLink>
												<button className="dc-button" onClick={() => onConnect(installation.publicUrl!)}>
													{t("deviceSetupPair")}
												</button>
												{local && (
													<button className="dc-button" disabled={busy || updating} onClick={() => void updateHub()}>
														{t(updating ? "deviceSetupUpdating" : "deviceSetupUpdate")}
													</button>
												)}
											</div>
										) : (
											<>
												<p>{t("deviceSetupRecovery")}</p>
												<pre className="dc-setup-output">{"pi-web-ui hub status --json\npi-web-ui hub --help"}</pre>
												{local && (
													<button
														className="dc-button is-primary"
														disabled={busy || updating}
														onClick={() => void updateHub()}
													>
														{t(updating ? "deviceSetupUpdating" : "deviceSetupUpdate")}
													</button>
												)}
											</>
										)}
										{updateResult && <pre className="dc-setup-output">{updateResult.slice(0, 16000)}</pre>}
									</div>
								)}
								{info?.busy && <p role="status">{t("deviceSetupBusy")}</p>}
								{local && (
									<button className="dc-button" disabled={busy || !loaded} onClick={() => void load()}>
										{t(loaded ? "deviceSetupRetry" : "deviceHubWorking")}
									</button>
								)}
							</div>
						)}
						{target === "remote" ? (
							<>
								<div className="dc-setup-fields">
									<label className="dc-field">
										<span>{t("deviceSetupServer")}</span>
										<input
											autoComplete="off"
											maxLength={253}
											placeholder="203.0.113.10"
											value={remote.server}
											onChange={(e) => setRemote({ ...remote, server: e.target.value.trim() })}
										/>
									</label>
									<label className="dc-field">
										<span>{t("deviceSetupSshPort")}</span>
										<input
											type="number"
											min={1}
											max={65535}
											value={remote.sshPort}
											onChange={(e) => setRemote({ ...remote, sshPort: Number(e.target.value) })}
										/>
									</label>
									<label className="dc-field">
										<span>{t("deviceSetupUsername")}</span>
										<input
											autoComplete="off"
											maxLength={64}
											value={remote.username}
											onChange={(e) => setRemote({ ...remote, username: e.target.value })}
										/>
									</label>
									<label className="dc-field">
										<span>{t("deviceSetupAuth")}</span>
										<select
											value={remote.auth}
											onChange={(e) => setRemote({ ...remote, auth: e.target.value as RemoteHubSetupInput["auth"] })}
										>
											<option value="password">{t("deviceSetupAuthPassword")}</option>
											<option value="key">{t("deviceSetupAuthKey")}</option>
											<option value="existing">{t("deviceSetupAuthExisting")}</option>
										</select>
									</label>
									<label className="dc-field">
										<span>{t("deviceSetupServicePort")}</span>
										<input
											type="number"
											min={1024}
											max={65535}
											value={remote.port}
											onChange={(e) => setRemote({ ...remote, port: Number(e.target.value) })}
										/>
									</label>
								</div>
								<p>{t("deviceSetupCredentialHint")}</p>
								<details>
									<summary>{t("deviceSetupOptionalTls")}</summary>
									<label className="dc-field">
										<span>{t("deviceSetupDomain")}</span>
										<input
											maxLength={253}
											placeholder="hub.example.com"
											value={remote.domain}
											onChange={(e) => setRemote({ ...remote, domain: e.target.value.trim() })}
										/>
									</label>
									<label>
										<input
											type="checkbox"
											checked={remote.https}
											onChange={(e) => setRemote({ ...remote, https: e.target.checked })}
										/>{" "}
										{t("deviceSetupEnableHttps")}
									</label>
									<p>{t("deviceSetupTlsHint")}</p>
								</details>
								<p>
									<strong>{t("deviceSetupPreview")}</strong> {remoteInput?.publicUrl ?? t("deviceSetupPreviewEmpty")}
								</p>
								<div className="dc-setup-plan">
									<strong>{t("deviceSetupUserActions")}</strong>
									<p>
										{t("deviceSetupCloudPorts").replace("{ports}", remote.https ? "443 / 80" : String(remote.port))}
									</p>
									<p>{t("deviceSetupSourceScope")}</p>
									<p>{t("deviceSetupAfterStart")}</p>
								</div>
								<a href={HUB_DEPLOYMENT_GUIDE_PAGE_URL} target="_blank" rel="noopener noreferrer">
									{t("deviceSetupGuide")}
								</a>
							</>
						) : (
							<>
								<div className="dc-setup-fields">
									<label className="dc-field">
										<span>{t("deviceSetupHost")}</span>
										<input
											disabled={busy || !!result}
											maxLength={253}
											value={host}
											onChange={(e) => setHost(e.target.value)}
										/>
									</label>
									<label className="dc-field">
										<span>{t("deviceSetupPort")}</span>
										<input
											disabled={busy || !!result}
											type="number"
											min={1024}
											max={65535}
											value={port}
											onChange={(e) => setPort(e.target.value)}
										/>
									</label>
									<label className="dc-field">
										<span>{t("deviceHubHubUrl")}</span>
										<input
											disabled={busy || !!result}
											maxLength={2048}
											value={publicUrl}
											onChange={(e) => setPublicUrl(e.target.value)}
										/>
									</label>
								</div>
								<p className="dc-setup-warning">{t("deviceSetupReachable")}</p>
							</>
						)}
						<p>{t("deviceSetupRegistration")}</p>
						{!valid && <p role="alert">{t(target === "remote" ? "deviceSetupRemoteInvalid" : "deviceSetupInvalid")}</p>}
						<div className="dc-actions">
							{target === "current" && !result && !installed && (
								<button
									className="dc-button is-primary"
									disabled={busy || !local || !info || !loaded || metadataError || !!info.busy || !valid}
									onClick={() => void install()}
								>
									{t(busy ? "deviceSetupInstalling" : "deviceSetupInstall")}
								</button>
							)}
							<button className="dc-button" disabled={busy || assistBusy || !valid} onClick={assist}>
								{t(target === "remote" ? "deviceSetupStartAi" : "deviceSetupAi")}
							</button>
						</div>
						<p>{t("deviceSetupAiHint")}</p>
						{assistBusy && <p role="status">{t("deviceSetupAiCreating")}</p>}
						{assistError && <p role="alert">{t("deviceSetupAiFailed")}</p>}
					</>
				</>
			)}
			{error && (
				<div role="alert">
					<p>{t("deviceSetupFailed")}</p>
					{detail && <pre className="dc-setup-output">{detail}</pre>}
				</div>
			)}
			{result && (
				<div role="status">
					<h4>{t("deviceSetupSuccess")}</h4>
					<pre className="dc-setup-output">{result.output.slice(0, 16000)}</pre>
					<div className="dc-actions">
						<HubLink href={result.publicUrl}>{t("deviceHubOpenHub")}</HubLink>
						<button className="dc-button is-primary" onClick={() => onConnect(result.publicUrl)}>
							{t("deviceSetupPair")}
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
