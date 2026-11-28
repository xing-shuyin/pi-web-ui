import { useState, type MouseEvent } from "react";
import { FiAperture, FiCpu, FiDownload, FiRefreshCw, FiTerminal, FiTrash2 } from "react-icons/fi";
import { ENGINE_CATALOG } from "../../../../server/engine-catalog";
import { appSend } from "../../app-globals";
import { useT } from "../../i18n";
import type { EngineId, EngineStatus, UiSettingsState } from "../../types";
import { SUPPORTED_ENGINES } from "../EnginePicker";
import { HintTip } from "../HintTip";
import { ToggleRow } from "./ToggleRow";

/** 设置页「模型与引擎」Tab：管理引擎切换/安装/更新/卸载、模型管理入口与原生 CLI 模型继承。 */
export function ModelsTab({
	engine,
	engines,
	isClaude,
	isCodex,
	isDsh,
	nativeCliInheritModel,
	onPatchInheritModel,
	onOpenManageModels,
	onRunTerminalCommand,
}: {
	engine: string;
	engines: EngineStatus[];
	isClaude: boolean;
	isCodex: boolean;
	isDsh: boolean;
	nativeCliInheritModel?: UiSettingsState["nativeCliInheritModel"];
	onPatchInheritModel: (next: UiSettingsState["nativeCliInheritModel"]) => void;
	onOpenManageModels?: () => void;
	onRunTerminalCommand: (title: string, command: string) => void;
}) {
	const t = useT();
	const [confirmEngineUninstallId, setConfirmEngineUninstallId] = useState<string | null>(null);

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiAperture className="set-section-icon" />
				{t("settingsEngineSection")}
				<HintTip text={t("settingsEngineHint")} />
			</div>
			<div className="set-mode-row" role="radiogroup" aria-label={t("settingsEngineSection")}>
				{SUPPORTED_ENGINES.map((item) => {
					const isSelected = item.id === engine;
					const status = engines.find((e) => e.id === item.id);
					const isInstalled = item.id === "pi" || (status ? status.installed : false);
					const isUpdating = Boolean(status?.updating);
					const isUninstalling = Boolean(status?.uninstalling);
					const hasUpdate = Boolean(isInstalled && status?.hasUpdate && status?.latestVersion);
					const showUpdate = hasUpdate || isUpdating;
					const canUninstall = item.id !== "pi" && isInstalled;

					const handleInstall = (e: MouseEvent) => {
						e.stopPropagation();
						if (item.installCommand) {
							onRunTerminalCommand(t("installEngineTabTitle", { name: item.badge }), item.installCommand);
						}
					};

					const handleUpdate = (e: MouseEvent) => {
						e.stopPropagation();
						if (isUpdating || isUninstalling) return;
						appSend({ type: "update_engine", engineId: item.id });
					};

					const handleUninstall = (e: MouseEvent) => {
						e.stopPropagation();
						if (isUninstalling || isUpdating) return;
						if (isSelected) return;
						if (confirmEngineUninstallId === item.id) {
							setConfirmEngineUninstallId(null);
							appSend({ type: "uninstall_engine", engineId: item.id });
						} else {
							setConfirmEngineUninstallId(item.id);
						}
					};

					return (
						<button
							key={item.id}
							type="button"
							role="radio"
							aria-checked={isSelected}
							data-testid={`engine-switch-${item.id}`}
							title={!isInstalled ? t("engineInstallTip") : undefined}
							className={`set-mode-btn${isSelected ? " active" : ""}${!isInstalled ? " uninstalled" : ""}`}
							onClick={() => {
								if (!isInstalled) {
									if (item.installCommand) {
										onRunTerminalCommand(t("installEngineTabTitle", { name: item.badge }), item.installCommand);
									}
									return;
								}
								if (!isSelected) appSend({ type: "switch_engine", engine: item.id as EngineId });
							}}
						>
							<div
								className="set-mode-title"
								style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}
							>
								<div style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
									{t(item.titleKey) !== item.badge ? (
										<>
											<span>{t(item.titleKey)}</span>
											<span className={`engine-badge ${item.colorClass}`}>{item.badge}</span>
										</>
									) : (
										<span className={`engine-badge ${item.colorClass}`}>{item.badge}</span>
									)}
									{!isInstalled ? (
										<span className="engine-picker-item-tag uninstalled" style={{ marginLeft: 4 }}>
											{t("engineNotInstalled")}
										</span>
									) : isUninstalling ? (
										<span className="engine-picker-item-tag uninstalling" style={{ marginLeft: 4 }}>
											{t("engineUninstalling")}
										</span>
									) : isUpdating ? (
										<span className="engine-picker-item-tag update-available" style={{ marginLeft: 4 }}>
											{t("engineUpdating")}
										</span>
									) : null}
								</div>
								<div style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
									{!isInstalled && item.installCommand && (
										<button
											type="button"
											className="engine-picker-install-btn"
											title={t("engineInstallTip")}
											onClick={handleInstall}
										>
											<FiDownload className="engine-install-icon" />
											<span>{t("engineInstall")}</span>
										</button>
									)}
									{showUpdate && (
										<button
											type="button"
											className="engine-picker-update-btn"
											disabled={isUpdating || isUninstalling}
											title={
												isUpdating
													? t("engineUpdating")
													: t("engineUpdateTip", {
															current: status?.version ?? "",
															latest: status?.latestVersion ?? "",
														})
											}
											onClick={handleUpdate}
										>
											<FiRefreshCw className={`engine-update-icon${isUpdating ? " spinning" : ""}`} />
											<span>{isUpdating ? t("engineUpdating") : t("engineUpdate")}</span>
										</button>
									)}
									{canUninstall && (
										<button
											type="button"
											data-testid={`settings-engine-uninstall-${item.id}`}
											className={`engine-picker-uninstall-btn${confirmEngineUninstallId === item.id ? " confirm" : ""}`}
											disabled={isUninstalling || isUpdating || isSelected}
											title={
												isSelected
													? t("engineActiveNoUninstall")
													: isUninstalling
														? t("engineUninstalling")
														: confirmEngineUninstallId === item.id
															? t("engineUninstallConfirm")
															: t("engineUninstallTip")
											}
											onClick={handleUninstall}
										>
											<FiTrash2 className="engine-uninstall-icon" />
											<span>
												{isUninstalling
													? t("engineUninstalling")
													: confirmEngineUninstallId === item.id
														? t("engineUninstallConfirm")
														: t("engineUninstall")}
											</span>
										</button>
									)}
								</div>
							</div>
							<div className="set-mode-desc">{t(item.descKey)}</div>
						</button>
					);
				})}
			</div>

			<div className="set-section-title" style={{ marginTop: 20 }}>
				<FiCpu className="set-section-icon" />
				{t("settingsModelsAndProviders")}
				<HintTip text={t("settingsModelsDesc")} />
			</div>
			<p className="set-desc" style={{ marginTop: 4, marginBottom: 12 }}>
				{isCodex
					? t("engineCodexModelDesc")
					: isClaude
						? t("engineClaudeModelDesc")
						: isDsh
							? t("engineDshModelDesc")
							: t("enginePiModelDesc")}
			</p>

			{onOpenManageModels && (
				<div className="set-block" style={{ marginTop: 8 }}>
					<div className="set-row">
						<div>
							<div className="set-label">{t("manageModelsAndProviders")}</div>
							<div className="set-desc">{t("manageModelsAndProvidersHint")}</div>
						</div>
						<button
							type="button"
							className="set-btn accent"
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								padding: "6px 14px",
								flexShrink: 0,
							}}
							onClick={onOpenManageModels}
						>
							<FiCpu />
							<span>{t("openModelManager")}</span>
						</button>
					</div>
				</div>
			)}
			<div className="set-section-title">
				<FiTerminal className="set-section-icon" />
				{t("nativeCliModelSettings")}
				<HintTip text={t("nativeCliModelSettingsDesc")} />
			</div>
			{Object.values(ENGINE_CATALOG)
				.filter((item) => item.cliCommand)
				.map((item) => (
					<ToggleRow
						key={item.id}
						title={t("nativeCliInheritModel", { name: item.name })}
						tip={item.cliModelArgs ? t("nativeCliModelSettingsDesc") : t("nativeCliModelUnsupported")}
						disabled={!item.cliModelArgs}
						enabled={Boolean(item.cliModelArgs && nativeCliInheritModel?.[item.id])}
						onToggle={() =>
							onPatchInheritModel({
								...nativeCliInheritModel,
								[item.id]: !nativeCliInheritModel?.[item.id],
							})
						}
					/>
				))}
		</div>
	);
}
