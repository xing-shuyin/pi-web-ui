import { useState, useRef } from "react";
import { FiAperture, FiCheck, FiDownload, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import { appSend, useAppGlobals, useEngineStatuses } from "../app-globals";
import { useI18n } from "../i18n";
import type { EngineId } from "../types";
import { Dropdown } from "./Dropdown";

/**
 * 智能体引擎元数据规格：支持未来无缝扩展 N 个引擎（如 Claude Code、自定义引擎等）。
 */
export interface EngineMeta {
	id: string;
	/** 显示名称多语言键 */
	titleKey:
		| "settingsEnginePiTitle"
		| "settingsEngineDshTitle"
		| "settingsEngineClaudeTitle"
		| "settingsEngineCodexTitle"
		| "settingsEngineDurableTitle";
	/** 简短徽标标签 */
	badge: string;
	/** 特色定位标签（如「完整生态」「极速补丁」「通用驱动」「持久自愈」） */
	tagKey: "engineTagFull" | "engineTagFast" | "engineTagUniversal" | "engineTagDurable";
	/** 描述说明翻译键 */
	descKey:
		| "settingsEnginePiDesc"
		| "settingsEngineDshDesc"
		| "settingsEngineClaudeDesc"
		| "settingsEngineCodexDesc"
		| "settingsEngineDurableDesc";
	/** 样式色彩类 */
	colorClass: string;
	/** 对应的全局 npm 包名（如 "@deepseek-ai/dsh"） */
	packageName?: string;
	/** 全局安装执行命令（如 "npm i -g @deepseek-ai/dsh"） */
	installCommand?: string;
}

/**
 * 支持的智能体引擎列表（单源可扩展名录）。
 * 后续引入新引擎只需在此追加一条定义。
 */
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
	/** 下拉展开方向："down"（顶栏用）、"up"（底栏用）、"left"（右侧栏用）、"right"（左侧栏用） */
	direction?: "down" | "up" | "left" | "right";
	/** 对齐方向 */
	align?: "left" | "right";
	/** 附加样式类 */
	className?: string;
	/** 显示的自定义文案（优先于默认引擎名） */
	label?: string;
	/** 是否渲染尾部 caret 箭头（默认 false） */
	caret?: boolean;
	/** 当前所在栏 */
	bar?: "top" | "bottom" | "left" | "right";
	/** 是否将下拉菜单 portal 到 document.body（脱离父级 overflow 截断与包含块约束，底栏与侧边栏默认开启） */
	portal?: boolean;
}

export function EnginePicker({ direction, align, className, label, caret = false, bar, portal }: EnginePickerProps) {
	const { engine } = useAppGlobals();
	const engines = useEngineStatuses();
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);

	// 侧边栏向视口内侧弹出：左侧栏向右、右侧栏向左；底栏向上；顶栏向下
	const effectiveDirection: "down" | "up" | "left" | "right" =
		direction ?? (bar === "left" ? "right" : bar === "right" ? "left" : bar === "bottom" ? "up" : "down");
	// 侧边栏和底栏带有 overflow 截断与包含块约束，必须 portal 到 body 防止菜单被裁切；若未指定则默认底栏/侧栏开启
	const effectivePortal = portal ?? (bar === "left" || bar === "right" || bar === "bottom");

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen) {
			// 展开下拉时自动请求服务端复查引擎安装状态，确保后台最新安装秒级感知
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
						// pi 原生捆绑引擎恒可用，其余引擎按服务端探测结果判断是否安装
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
								// 未安装时不可切换，点击直接引导安装终端
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
