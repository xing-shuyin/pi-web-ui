import { useState, useRef } from "react";
import { FiAperture, FiCheck, FiDownload, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import { appSend, useAppGlobals, useEngineStatuses } from "../app-globals";
import { useI18n } from "../i18n";
import type { EngineId } from "../types";
import { Dropdown } from "./Dropdown";

export interface EngineMeta {
	id: string;
	titleKey:
		| "settingsEnginePiTitle"
		| "settingsEngineDshTitle"
		| "settingsEngineClaudeTitle"
		| "settingsEngineCodexTitle"
		| "settingsEngineDurableTitle";
	badge: string;
	tagKey: "engineTagFull" | "engineTagFast" | "engineTagUniversal" | "engineTagDurable";
	descKey:
		| "settingsEnginePiDesc"
		| "settingsEngineDshDesc"
		| "settingsEngineClaudeDesc"
		| "settingsEngineCodexDesc"
		| "settingsEngineDurableDesc";
	colorClass: string;
	packageName?: string;
	installCommand?: string;
}

export const SUPPORTED_ENGINES: EngineMeta[] = [
	{
		id: "pi",
		titleKey: "settingsEnginePiTitle",
		badge: "PI",
		tagKey: "engineTagFull",
		descKey: "settingsEnginePiDesc",
		colorClass: "engine-pi",
		packageName: "@earendil-works/pi-coding-agent",
		installCommand: "npm i -g @earendil-works/pi-coding-agent",
	},
	{
		id: "dsh",
		titleKey: "settingsEngineDshTitle",
		badge: "DSH",
		tagKey: "engineTagFast",
		descKey: "settingsEngineDshDesc",
		colorClass: "engine-dsh",
		packageName: "@deepseek-ai/dsh",
		installCommand: "npm i -g @deepseek-ai/dsh",
	},
	{
		id: "claude",
		titleKey: "settingsEngineClaudeTitle",
		badge: "CLAUDE",
		tagKey: "engineTagUniversal",
		descKey: "settingsEngineClaudeDesc",
		colorClass: "engine-claude",
		packageName: "@anthropic-ai/claude-code",
		installCommand: "npm i -g @anthropic-ai/claude-code",
	},
	{
		id: "codex",
		titleKey: "settingsEngineCodexTitle",
		badge: "CODEX",
		tagKey: "engineTagUniversal",
		descKey: "settingsEngineCodexDesc",
		colorClass: "engine-codex",
		packageName: "@openai/codex",
		installCommand: "npm i -g @openai/codex",
	},
	{
		id: "durable",
		titleKey: "settingsEngineDurableTitle",
		badge: "DURABLE",
		tagKey: "engineTagDurable",
		descKey: "settingsEngineDurableDesc",
		colorClass: "engine-durable",
		packageName: "@earendil-works/pi-durable",
		installCommand: "npm i -g @earendil-works/pi-durable",
	},
];

interface EnginePickerProps {
	direction?: "down" | "up" | "left" | "right";
	align?: "left" | "right";
	className?: string;
	label?: string;
	caret?: boolean;
	bar?: "top" | "bottom" | "left" | "right";
	portal?: boolean;
}

export function EnginePicker({ direction, align, className, label, caret = false, bar, portal }: EnginePickerProps) {
	const { engine } = useAppGlobals();
	const engines = useEngineStatuses();
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);

	const effectiveDirection: "down" | "up" | "left" | "right" =
		direction ?? (bar === "left" ? "right" : bar === "right" ? "left" : bar === "bottom" ? "up" : "down");
	const effectivePortal = portal ?? (bar === "left" || bar === "right" || bar === "bottom");

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen) {
			appSend({ type: "check_engines" });
		} else {
			setConfirmUninstallId(null);
		}
		setOpen(nextOpen);
	};

	const activeEngine = SUPPORTED_ENGINES.find((e) => e.id === engine) ?? {
		id: engine,
		titleKey: "settingsEnginePiTitle" as const,
		badge: engine.toUpperCase(),
		tagKey: "engineTagFull" as const,
		descKey: "settingsEnginePiDesc" as const,
		colorClass: `engine-${engine}`,
	};
	const activeName = t(activeEngine.titleKey);

	const trigger = (
		<>
			<FiAperture className="bar-item-icon engine-picker-icon" />
			{label ? (
				<>
					<span className="chip-sub bar-item-text engine-picker-name">{label}</span>
					<span className={`engine-badge bar-item-text ${activeEngine.colorClass}`}>{activeEngine.badge}</span>
				</>
			) : (
				<span className={`engine-badge bar-item-text ${activeEngine.colorClass}`}>{activeEngine.badge}</span>
			)}
		</>
	);

	return (
		<div
			ref={wrapRef}
			className={`engine-picker-wrap ${activeEngine.colorClass} ${className ?? ""}`}
			data-bar-item="host:engine"
		>
			<Dropdown
				trigger={trigger}
				open={open}
				onOpenChange={handleOpenChange}
				direction={effectiveDirection}
				align={align ?? (bar === "right" ? "right" : "left")}
				fit
				caret={caret}
				portal={effectivePortal}
				triggerClassName={`bar-item chip engine-picker-btn ${activeEngine.colorClass}`}
				menuClassName="engine-picker-menu"
				tip={`${t("engineBadge")}: ${label ?? activeName} — ${t("engineSwitchTip")}`}
			>
				<div className="engine-picker-header">
					<div className="engine-picker-title">
						<FiAperture />
						<span>{t("settingsEngineSection")}</span>
					</div>
					<div className="engine-picker-subtitle">{t("enginePickerDesc")}</div>
				</div>

				<div className="engine-picker-list" role="menu">
					{SUPPORTED_ENGINES.map((item) => {
						const isSelected = item.id === engine;
						const status = engines.find((e) => e.id === item.id);
						const isInstalled = item.id === "pi" || (status ? status.installed : false);
						const isUpdating = Boolean(status?.updating);
						const isUninstalling = Boolean(status?.uninstalling);
						const hasUpdate = Boolean(isInstalled && status?.hasUpdate && status?.latestVersion);
						const showUpdate = hasUpdate || isUpdating;
						const canUninstall = item.id !== "pi" && isInstalled;

						const handleInstall = (e: React.MouseEvent) => {
							e.stopPropagation();
							setOpen(false);
							if (item.installCommand) {
								window.dispatchEvent(
									new CustomEvent("pi-web-ui:plugin-run-command", {
										detail: {
											title: t("installEngineTabTitle", { name: item.badge }),
											command: item.installCommand,
										},
									}),
								);
							}
						};

						const handleUpdate = (e: React.MouseEvent) => {
							e.stopPropagation();
							if (isUpdating || isUninstalling) return;
							setOpen(false);
							appSend({ type: "update_engine", engineId: item.id });
						};

						const handleUninstall = (e: React.MouseEvent) => {
							e.stopPropagation();
							if (isUninstalling || isUpdating) return;
							if (isSelected) return;
							if (confirmUninstallId === item.id) {
								setConfirmUninstallId(null);
								appSend({ type: "uninstall_engine", engineId: item.id });
							} else {
								setConfirmUninstallId(item.id);
							}
						};

						const handleSelect = () => {
							if (!isInstalled) {
								setOpen(false);
								if (item.installCommand) {
									window.dispatchEvent(
										new CustomEvent("pi-web-ui:plugin-run-command", {
											detail: {
												title: t("installEngineTabTitle", { name: item.badge }),
												command: item.installCommand,
											},
										}),
									);
								}
								return;
							}
							setOpen(false);
							if (!isSelected) {
								appSend({ type: "switch_engine", engine: item.id as EngineId });
							}
						};

						return (
							<div
								key={item.id}
								role="menuitem"
								tabIndex={0}
								title={!isInstalled ? t("engineInstallTip") : undefined}
								className={`engine-picker-item ${item.colorClass}${isSelected ? " active" : ""}${!isInstalled ? " uninstalled" : ""}`}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										handleSelect();
									}
								}}
								onClick={handleSelect}
							>
								<div className="engine-picker-item-head">
									<FiAperture className="engine-picker-item-icon" />
									<span className={`engine-badge ${item.colorClass}`}>{item.badge}</span>
									{t(item.titleKey) !== item.badge && (
										<span className="engine-picker-item-name">{t(item.titleKey)}</span>
									)}
									<span
										className={`engine-picker-item-tag${
											!isInstalled
												? " uninstalled"
												: isUninstalling
													? " uninstalling"
													: isUpdating || hasUpdate
														? " update-available"
														: ""
										}`}
										title={
											hasUpdate
												? t("engineUpdateTip", {
														current: status?.version ?? "",
														latest: status?.latestVersion ?? "",
													})
												: undefined
										}
									>
										{!isInstalled
											? t("engineNotInstalled")
											: isUninstalling
												? t("engineUninstalling")
												: isUpdating
													? t("engineUpdating")
													: hasUpdate
														? t("engineUpdateAvailable")
														: t(item.tagKey)}
									</span>
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
											data-testid={`engine-uninstall-${item.id}`}
											className={`engine-picker-uninstall-btn${confirmUninstallId === item.id ? " confirm" : ""}`}
											disabled={isUninstalling || isUpdating || isSelected}
											title={
												isSelected
													? t("engineActiveNoUninstall")
													: isUninstalling
														? t("engineUninstalling")
														: confirmUninstallId === item.id
															? t("engineUninstallConfirm")
															: t("engineUninstallTip")
											}
											onClick={handleUninstall}
										>
											<FiTrash2 className="engine-uninstall-icon" />
											<span>
												{isUninstalling
													? t("engineUninstalling")
													: confirmUninstallId === item.id
														? t("engineUninstallConfirm")
														: t("engineUninstall")}
											</span>
										</button>
									)}
									{isSelected && <FiCheck className="engine-picker-check" />}
								</div>
								<div className="engine-picker-item-desc">{t(item.descKey)}</div>
							</div>
						);
					})}
				</div>
			</Dropdown>
		</div>
	);
}
