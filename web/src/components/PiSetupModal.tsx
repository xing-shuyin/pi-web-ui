import { useEffect, useState } from "react";
import { FiCpu, FiRefreshCw, FiX } from "react-icons/fi";
import type { ProviderOAuthFlowState, ProviderStatus } from "../types";
import { useT } from "../i18n";
import { appSend, useIsManaged } from "../app-globals";
import { isDesktopShell } from "../desktop";
import { ProviderOAuthControls, type ProviderOAuthResultView } from "./ProviderOAuthControls";

interface PiSetupModalProps {
	piConfigured: boolean;
	piAgentInstalled: boolean;
	providers: ProviderStatus[];
	providerOAuthFlows: ProviderOAuthFlowState[];
	providerOAuthResults: Record<string, ProviderOAuthResultView>;
	installResult: { ok: boolean; detail: string } | null;
	onClose: () => void;
}

export function PiSetupModal({
	piConfigured,
	piAgentInstalled,
	providers,
	providerOAuthFlows,
	providerOAuthResults,
	installResult,
	onClose,
}: PiSetupModalProps) {
	const t = useT();
	const isDesktop = isDesktopShell();
	const managed = useIsManaged();
	const [installing, setInstalling] = useState(false);
	const [provider, setProvider] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		appSend({ type: "list_providers" });
		appSend({ type: "list_provider_oauth_flows" });
	}, []);

	useEffect(() => {
		if (piConfigured) onClose();
	}, [piConfigured, onClose]);

	useEffect(() => {
		if (installResult) setInstalling(false);
	}, [installResult]);

	useEffect(() => {
		if (!provider && providers.length > 0) {
			setProvider(providers.find((p) => !p.configured)?.id ?? providers[0].id);
		}
	}, [providers, provider]);

	const doInstall = () => {
		if (installing) return;
		setInstalling(true);
		appSend({ type: "install_pi_agent" });
	};

	const saveKey = () => {
		if (!apiKey.trim() || saving) return;
		setSaving(true);
		appSend({
			type: "set_provider_api_key",
			provider: provider.trim(),
			apiKey: apiKey.trim(),
		});
		setTimeout(() => setSaving(false), 3000);
	};

	const recheck = () => {
		appSend({ type: "get_state" });
		appSend({ type: "list_providers" });
	};

	const selected = providers.find((p) => p.id === provider);
	const installFailed = installResult !== null && !installResult.ok;

	return (
		<div className="modal-backdrop">
			<div className="modal setup-modal">
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					<FiX />
				</button>
				<div className="modal-head">
					<FiCpu className="modal-head-icon" />
					<h2>{t("setupTitle")}</h2>
				</div>
				<p className="modal-desc">{t("setupDesc")}</p>

				{installFailed ? (
					<div className="setup-failed">
						<div className="setup-done">{t("installFailed")}</div>
						<pre className="setup-detail">{installResult.detail}</pre>
						<div className="setup-actions">
							<button type="button" className="btn primary" disabled={installing} onClick={doInstall}>
								{t("retryInstall")}
							</button>
							<button type="button" className="btn" onClick={onClose}>
								{t("skip")}
							</button>
						</div>
					</div>
				) : piAgentInstalled || installResult?.ok || isDesktop ? (
					<div className="setup-key-form">
						<div className="setup-done">{installResult?.ok ? t("installDone") : t("cliReadyHint")}</div>
						<label className="field">
							<span className="field-label">{t("provider")}</span>
							<select value={provider} onChange={(e) => setProvider(e.target.value)}>
								{providers.length === 0 && <option value="">{t("loading")}</option>}
								{providers.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}（{p.id}）{p.configured ? ` · ${t("configured")}` : ""}
									</option>
								))}
							</select>
							{selected?.configured && <div className="field-hint">{t("providerKeyReady")}</div>}
						</label>
						{selected?.supportsOAuth && (
							<ProviderOAuthControls
								provider={selected}
								flow={providerOAuthFlows.find((flow) => flow.provider === selected.id)}
								result={providerOAuthResults[selected.id]}
							/>
						)}
						{selected?.supportsApiKey && (
							<label className="field">
								<span className="field-label">{t("apiKey")}</span>
								<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
							</label>
						)}
						<div className="setup-actions">
							{selected?.supportsApiKey && (
								<button
									type="button"
									className="btn primary"
									disabled={!apiKey.trim() || saving || !provider}
									onClick={saveKey}
								>
									{saving ? t("saving") : t("saveAndStart")}
								</button>
							)}
							<button type="button" className="btn" onClick={recheck}>
								<FiRefreshCw /> {t("recheck")}
							</button>
						</div>
					</div>
				) : managed ? (
					<div className="setup-actions">
						<div className="setup-done">{t("updatesManaged")}</div>
						<button type="button" className="btn" onClick={onClose}>
							{t("skip")}
						</button>
					</div>
				) : (
					<div className="setup-actions">
						<button type="button" className="btn primary" disabled={installing} onClick={doInstall}>
							{installing ? t("installing") : t("autoInstall")}
						</button>
						<button type="button" className="btn" onClick={onClose}>
							{t("skip")}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
