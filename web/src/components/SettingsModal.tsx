import { useEffect, useRef, useState } from "react";
import {
	FiBox,
	FiCpu,
	FiEye,
	FiFileText,
	FiMessageSquare,
	FiPackage,
	FiPlus,
	FiRefreshCw,
	FiSettings,
	FiSliders,
	FiTerminal,
	FiTrash2,
	FiX,
	FiZap,
} from "react-icons/fi";
import { CopyButton } from "./copy-button";
import { PluginSettingsForm } from "./PluginSettingsForm";
import type { ClientMessage, CommandDef, UiExtensionInfo, UiPluginInfo, UiSettingsState, UiSkillInfo } from "../types";
import { randomUuid } from "../uuid";
import { useT } from "../i18n";

/** Minimal terminal-tab bridge (same shape SCMPanel uses). */
interface SettingsTerminalBridge {
	create: (meta: {
		id: string;
		conversationId: string;
		title: string;
		cwd: string;
		cols: number;
		rows: number;
		running: boolean;
		exitCode: number | null;
		command?: CommandDef;
	}) => void;
	restart: (id: string) => void;
	select: (id: string) => void;
}

interface SettingsModalProps {
	chat: {
		settings: UiSettingsState | null;
		plugins: UiPluginInfo[];
		/** DSH engine: <dataDir>/dsh-patches user patch files. */
		dshPatches: { patchDir: string; files: { name: string; path: string; size: number; mtimeMs: number }[] } | null;
		/** Engine id ("pi" | "dsh") — dsh-only sections render when set. */
		engine?: string;
		terminals: {
			id: string;
			title: string;
			conversationId: string;
			running: boolean;
			exitCode: number | null;
			command?: CommandDef;
		}[];
		state?: { cwd: string; conversationId: string } | null;
		activeConversationId?: string | null;
	};
	send: (msg: ClientMessage) => boolean;
	terminal: SettingsTerminalBridge;
	/** Switch the top-level view to the terminal (uninstall runs there). */
	onSwitchToTerminal: () => void;
	onClose: () => void;
}

/** A row with an enable/disable switch (skill / extension). */
/**
 * 「？」悬浮提示：长解释默认不占版面，hover / 键盘聚焦时浮出全文。
 * 靠近视口右缘时自动翻转气泡方向（.flip → 向左展开），避免弹窗超出
 * 容器/窗口被裁掉。
 */
/** 文件大小人类可读（设置面板 DSH 补丁列表用）。 */
function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function HintTip({ text }: { text: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [flip, setFlip] = useState(false);
	// 气泡最大 320px；右侧剩余空间不足就向左展开。
	const updateFlip = () => {
		const rect = ref.current?.getBoundingClientRect();
		if (rect) setFlip(window.innerWidth - rect.right < 340);
	};
	return (
		<span
			ref={ref}
			className={`set-tip${flip ? " flip" : ""}`}
			tabIndex={0}
			aria-label={text}
			onMouseEnter={updateFlip}
			onFocus={updateFlip}
		>
			?
			<span className="set-tip-bubble" role="tooltip">
				{text}
			</span>
		</span>
	);
}

function ToggleRow({
	title,
	subtitle,
	tip,
	enabled,
	onToggle,
	action,
}: {
	title: string;
	subtitle?: string;
	/** 长解释走「？」悬浮提示，不再平铺（subtitle 与 tip 二选一）。 */
	tip?: string;
	enabled: boolean;
	onToggle: () => void;
	/** Optional extra control rendered left of the switch (e.g. uninstall). */
	action?: React.ReactNode;
}) {
	const t = useT();
	return (
		<div className="set-row">
			<div className="set-row-info">
				<div className="set-row-name">
					{title}
					{tip && <HintTip text={tip} />}
				</div>
				{subtitle && <div className="set-row-desc">{subtitle}</div>}
			</div>
			{action}
			<button
				type="button"
				className={`set-switch ${enabled ? "on" : ""}`}
				role="switch"
				aria-checked={enabled}
				title={enabled ? t("settingsEnabled") : t("settingsDisabled")}
				onClick={onToggle}
			>
				<span className="set-switch-knob" />
			</button>
		</div>
	);
}

/** 设置弹窗的左侧分组导航（一次只显示一个区块，消灭长滚动）。 */
type SettingsTab =
	"prompt" | "terminal" | "display" | "skills" | "extensions" | "plugins" | "review" | "vision" | "presets";

export function SettingsModal({ chat, send, terminal, onSwitchToTerminal, onClose }: SettingsModalProps) {
	const t = useT();
	const settings = chat.settings;
	// DSH 引擎：无 pi 扩展/技能体系与视觉桥概念 —— 隐藏对应分区/改占位说明。
	const isDsh = chat.engine === "dsh";
	// 当前左侧导航选中的分组。
	const [tab, setTab] = useState<SettingsTab>("prompt");
	// 内容滚动容器：切换分组后回到顶部（各组高度不同，停留旧滚动位置会像没切换）。
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		bodyRef.current?.scrollTo({ top: 0 });
	}, [tab]);
	// DSH 引擎：打开插件分组时拉一次用户 patch 列表（pi 引擎忽略该消息）。
	useEffect(() => {
		if (tab === "plugins" && chat.engine === "dsh") {
			send({ type: "dsh_patches_list" });
		}
	}, [tab, chat.engine, send]);

	// Prompt draft — local while typing; re-synced from the server on each push
	// UNLESS the textarea is focused (an echo must not clobber mid-edit text).
	const [promptDraft, setPromptDraft] = useState("");
	const [promptMode, setPromptMode] = useState<"append" | "replace">("append");
	const promptFocus = useRef(false);
	// Vision-bridge prompt draft — same local-edit/re-sync pattern as above.
	const [vbPromptDraft, setVbPromptDraft] = useState("");
	const [vbPromptMode, setVbPromptMode] = useState<"append" | "replace">("append");
	const vbPromptFocus = useRef(false);
	// Goal-review prompt is an independent draft: it does not change the main
	// agent system prompt and is only used by the isolated reviewer.
	const [reviewPromptDraft, setReviewPromptDraft] = useState("");
	const reviewPromptFocus = useRef(false);
	const [presetName, setPresetName] = useState("");
	// Read-only viewer for the FULL system prompt actually in effect.
	const [showFullPrompt, setShowFullPrompt] = useState(false);
	// Two-step uninstall confirm: which extension id is awaiting confirmation.
	const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
	// Two-step uninstall confirm for UI plugins (<dataDir>/plugins).
	const [confirmUiUninstall, setConfirmUiUninstall] = useState<string | null>(null);

	useEffect(() => {
		if (!settings) return;
		setPromptMode(settings.promptMode);
		if (promptFocus.current) return;
		// append: show the user's own text; replace: prefill the built-in
		// default prompt so the user sees exactly what they would replace.
		setPromptDraft(
			promptMode === "append" || settings.customSystemPrompt
				? settings.customSystemPrompt
				: settings.defaultSystemPrompt || "",
		);
		setVbPromptMode(settings.visionBridgePromptMode);
		if (vbPromptFocus.current) return;
		setVbPromptDraft(
			vbPromptMode === "append" || settings.visionBridgePrompt
				? settings.visionBridgePrompt
				: settings.visionBridgeDefaultPrompt || "",
		);
		if (!reviewPromptFocus.current) setReviewPromptDraft(settings.reviewPrompt);
	}, [settings, promptMode, vbPromptMode]);

	const [idleMsDraft, setIdleMsDraft] = useState<string>(String(settings?.terminalBashIdleMs ?? 15000));
	useEffect(() => {
		setIdleMsDraft(String(settings?.terminalBashIdleMs ?? 15000));
	}, [settings?.terminalBashIdleMs]);

	if (!settings) return null;

	const tabs: {
		id: SettingsTab;
		icon: React.ReactNode;
		label: string;
		/** 有计数徽标（与各区块标题里的 set-count 同源）。 */
		count?: number;
	}[] = [
		{ id: "prompt", icon: <FiFileText />, label: t("settingsSystemPrompt") },
		{ id: "terminal", icon: <FiTerminal />, label: t("settingsTerminalTools") },
		{ id: "display", icon: <FiMessageSquare />, label: t("settingsMessageDisplay") },
		{ id: "skills", icon: <FiCpu />, label: t("settingsSkills"), count: settings.skills.length },
		{ id: "extensions", icon: <FiPackage />, label: t("settingsExtensions"), count: settings.extensions.length },
		{ id: "plugins", icon: <FiBox />, label: t("settingsUiPlugins"), count: chat.plugins.length },
		{ id: "review", icon: <FiZap />, label: t("settingsReview"), count: settings.reviewSkills.length },
		// DSH：无视觉桥概念（真图片直通 vision 模型），隐藏该分区。
		...(isDsh ? [] : [{ id: "vision" as const, icon: <FiEye />, label: t("settingsVisionBridge") }]),
		{ id: "presets", icon: <FiSliders />, label: t("settingsPresets"), count: settings.presets.length },
	];

	const disabledSkills = new Set(settings.disabledSkills);
	const disabledExts = new Set(settings.disabledExtensions);

	const setPartial = (patch: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
	}) => send({ type: "set_settings", ...patch });

	const toggleSkill = (s: UiSkillInfo) => {
		const next = new Set(disabledSkills);
		if (next.has(s.name)) next.delete(s.name);
		else next.add(s.name);
		setPartial({ disabledSkills: [...next] });
	};

	const disabledPlugins = new Set(settings.disabledPlugins ?? []);
	const togglePlugin = (p: UiPluginInfo) => {
		const next = new Set(disabledPlugins);
		if (next.has(p.id)) next.delete(p.id);
		else next.add(p.id);
		setPartial({ disabledPlugins: [...next] });
	};

	const toggleExtension = (e: UiExtensionInfo) => {
		const next = new Set(disabledExts);
		if (next.has(e.id)) next.delete(e.id);
		else next.add(e.id);
		setPartial({ disabledExtensions: [...next] });
	};

	/** Run a maintenance command (extension uninstall / UI-plugin install or
	 *  uninstall) in a VISIBLE terminal tab (same reuse pattern as SCM write
	 *  ops) so the user sees exactly what happened. On exit the App watcher
	 *  sends extensions_reload / plugins_reload to re-discover the lists. */
	const runTerminalCommand = (title: string, command: string) => {
		const cmd: CommandDef = {
			name: title,
			command,
			cwd: "${pwd}",
		};
		let targetId: string;
		const existing = chat.terminals.find((tm) => tm.title === title);
		if (existing) {
			terminal.restart(existing.id);
			send({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
			targetId = existing.id;
		} else {
			targetId = randomUuid();
			terminal.create({
				id: targetId,
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		terminal.select(targetId);
		onSwitchToTerminal();
		onClose();
	};

	/** Uninstall a `pi install`-ed package: run `pi remove npm:<pkg>` in a
	 *  visible terminal tab (see runTerminalCommand). */
	const runUninstall = (pkgName: string) => {
		setConfirmUninstall(null);
		runTerminalCommand(`${t("uninstallTitle")} ${pkgName}`, `pi remove npm:${pkgName}`);
	};

	/** Uninstall a UI plugin: delete <dataDir>/plugins/<id>/ via the CLI.
	 *  plugins_reload after the tab exits re-scans the dir. */
	const runUiPluginUninstall = (id: string) => {
		setConfirmUiUninstall(null);
		runTerminalCommand(`${t("uninstallTitle")} ${id}`, `pi-web-ui uninstall ${id}`);
	};

	/** Update a UI plugin from its recorded install source (.pi-source.json):
	 *  re-run the same install command with --force (config.json survives). */
	const runUiPluginUpdate = (id: string, source: string) => {
		runTerminalCommand(`${t("pluginUpdate")} ${id}`, `pi-web-ui install ${source} --name ${id} --force`);
	};

	const toggleReviewSkill = (s: UiSkillInfo) => {
		const disabled = new Set(settings.reviewSkills.filter((x) => !x.enabled).map((x) => x.name));
		if (disabled.has(s.name)) disabled.delete(s.name);
		else disabled.add(s.name);
		setPartial({ reviewDisabledSkills: [...disabled] });
	};

	const savePrompt = () => {
		// In replace mode, a draft identical to the built-in default means the
		// user didn't actually modify it — store empty so the server falls back
		// to the default (and switching to append later never duplicates it).
		const text =
			promptMode === "replace" && settings.defaultSystemPrompt && promptDraft === settings.defaultSystemPrompt
				? ""
				: promptDraft;
		setPartial({ promptMode, customSystemPrompt: text });
	};

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" aria-label={t("close")} onClick={onClose}>
					<FiX />
				</button>
				<div className="modal-head">
					<FiSettings className="modal-head-icon" />
					<h2>{t("settingsTitle")}</h2>
					{/* 长说明收起为「？」悬浮提示，不再平铺占版面 */}
					<HintTip text={t("settingsDesc")} />
				</div>

				{/* Scrollable body — head above and the actions bar below stay
				    fixed; only these sections scroll. */}
				<div className="settings-layout">
					<nav className="settings-rail" aria-label={t("settingsTitle")}>
						{tabs.map((tb) => (
							<button
								key={tb.id}
								type="button"
								className={`settings-tab${tab === tb.id ? " active" : ""}`}
								aria-current={tab === tb.id ? "true" : undefined}
								title={tb.label}
								onClick={() => setTab(tb.id)}
							>
								<span className="settings-tab-icon">{tb.icon}</span>
								<span className="settings-tab-label">{tb.label}</span>
								{tb.count !== undefined && <span className="set-count">{tb.count}</span>}
							</button>
						))}
					</nav>
					<div className="modal-body" ref={bodyRef}>
						{/* ---- system prompt -------------------------------------------- */}
						{tab === "prompt" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiZap className="set-section-icon" />
									{t("settingsSystemPrompt")}
								</div>
								<div className="set-mode-row">
									<label className="set-field-label">{t("settingsPromptMode")}</label>
									<select
										className="set-select"
										value={promptMode}
										onChange={(e) => {
											const mode = e.target.value as "append" | "replace";
											setPromptMode(mode);
											setPartial({ promptMode: mode });
										}}
									>
										<option value="append">{t("promptModeAppend")}</option>
										<option value="replace">{t("promptModeReplace")}</option>
									</select>
									<HintTip text={promptMode === "append" ? t("promptAppendHint") : t("promptReplaceHint")} />
								</div>
								<textarea
									className="set-prompt-input"
									rows={6}
									placeholder={t("promptPlaceholder")}
									value={promptDraft}
									onFocus={() => (promptFocus.current = true)}
									onBlur={() => {
										promptFocus.current = false;
										savePrompt();
									}}
									onChange={(e) => setPromptDraft(e.target.value)}
								/>
								<button
									type="button"
									className="set-view-prompt-btn"
									aria-expanded={showFullPrompt}
									onClick={() => setShowFullPrompt((v) => !v)}
								>
									{t("settingsViewPrompt")} {showFullPrompt ? "▴" : "▾"}
								</button>
								{showFullPrompt && (
									<div className="set-prompt-view">
										<div className="set-prompt-view-head">
											<span>{t("settingsViewPromptHint")}</span>
											<CopyButton text={settings.effectiveSystemPrompt} />
										</div>
										{settings.effectiveSystemPrompt ? (
											<pre className="set-prompt-view-text">{settings.effectiveSystemPrompt}</pre>
										) : (
											<p className="set-empty">{t("settingsViewPromptEmpty")}</p>
										)}
									</div>
								)}
							</div>
						)}

						{/* ---- terminal tools ------------------------------------------ */}
						{tab === "terminal" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiTerminal className="set-section-icon" />
									{t("settingsTerminalTools")}
								</div>
								<ToggleRow
									title={t("terminalToolsEnabled")}
									tip={t("settingsTerminalToolsDesc")}
									enabled={settings.terminalToolsEnabled}
									onToggle={() => setPartial({ terminalToolsEnabled: !settings.terminalToolsEnabled })}
								/>
								{!settings.terminalToolsEnabled && <p className="set-hint">{t("terminalToolsOffHint")}</p>}
								<ToggleRow
									title={t("terminalBashTakeover")}
									tip={t("terminalBashTakeoverDesc")}
									enabled={settings.terminalBash}
									onToggle={() => setPartial({ terminalBash: !settings.terminalBash })}
								/>
								{settings.terminalBash && (
									<div className="set-field">
										<label className="set-field-label" htmlFor="tb-idle-ms">
											{t("terminalBashIdleMs")}
										</label>
										<input
											id="tb-idle-ms"
											className="set-input"
											type="number"
											min={0}
											step={1000}
											value={idleMsDraft}
											onChange={(e) => setIdleMsDraft(e.target.value)}
											onBlur={() => {
												const n = Math.max(0, Math.floor(Number(idleMsDraft) || 0));
												setIdleMsDraft(String(n));
												if (n !== settings.terminalBashIdleMs) {
													setPartial({ terminalBashIdleMs: n });
												}
											}}
										/>
									</div>
								)}
							</div>
						)}

						{/* ---- message display ----------------------------------------- */}
						{tab === "display" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiMessageSquare className="set-section-icon" />
									{t("settingsMessageDisplay")}
								</div>
								<ToggleRow
									title={t("thinkingWrap")}
									tip={t("thinkingWrapDesc")}
									enabled={settings.thinkingWrap ?? true}
									onToggle={() => setPartial({ thinkingWrap: !(settings.thinkingWrap ?? true) })}
								/>
								<ToggleRow
									title={t("toolsWrap")}
									tip={t("toolsWrapDesc")}
									enabled={settings.toolsWrap ?? true}
									onToggle={() => setPartial({ toolsWrap: !(settings.toolsWrap ?? true) })}
								/>
							</div>
						)}

						{/* ---- skills --------------------------------------------------- */}
						{tab === "skills" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiCpu className="set-section-icon" />
									{t("settingsSkills")}
									<span className="set-count">{settings.skills.length}</span>
								</div>
								{settings.skills.length === 0 ? (
									<p className="set-empty">{isDsh ? t("dshSkillsNote") : t("noSkills")}</p>
								) : (
									<div className="set-list">
										{settings.skills.map((s) => (
											<ToggleRow
												key={s.name}
												title={s.name}
												subtitle={s.description}
												enabled={s.enabled}
												onToggle={() => toggleSkill(s)}
											/>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- extensions ------------------------------------------------ */}
						{tab === "extensions" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiPackage className="set-section-icon" />
									{t("settingsExtensions")}
									<span className="set-count">{settings.extensions.length}</span>
								</div>
								{settings.extensions.length === 0 ? (
									<p className="set-empty">{isDsh ? t("dshExtensionsNote") : t("noExtensions")}</p>
								) : (
									<div className="set-list">
										{settings.extensions.map((e) => {
											const pkgName = e.id.startsWith("npm:") ? e.id.slice(4) : null;
											return (
												<ToggleRow
													key={e.id}
													title={e.name}
													subtitle={e.path}
													enabled={e.enabled}
													onToggle={() => toggleExtension(e)}
													action={
														pkgName ? (
															confirmUninstall === e.id ? (
																<button
																	type="button"
																	className="set-uninstall confirm"
																	title={t("uninstallConfirmHint")}
																	onClick={() => runUninstall(pkgName)}
																>
																	{t("uninstallConfirm")}
																</button>
															) : (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("uninstallHint")}
																	onClick={() => setConfirmUninstall(e.id)}
																>
																	<FiTrash2 />
																	{t("uninstallExt")}
																</button>
															)
														) : undefined
													}
												/>
											);
										})}
									</div>
								)}
							</div>
						)}

						{/* ---- UI plugins（<dataDir>/plugins，纯 UI 隐藏） ----------------- */}
						{tab === "plugins" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiBox className="set-section-icon" />
									{t("settingsUiPlugins")}
									<span className="set-count">{chat.plugins.length}</span>
								</div>
								{chat.plugins.length === 0 ? (
									<p className="set-empty">{t("noUiPlugins")}</p>
								) : (
									<div className="set-list">
										{chat.plugins.map((p) => (
											<>
												<ToggleRow
													key={p.id}
													title={`${p.icon ? `${p.icon} ` : ""}${p.name}`}
													subtitle={
														(p.error
															? `${p.id} · ${p.error}`
															: p.source
																? `${p.id} · ${p.source}`
																: `${p.id} · ${t("uiPluginNoSource")}`) +
														(p.permissions?.length ? ` · ${t("uiPluginPerms")}: ${p.permissions.join(", ")}` : "")
													}
													enabled={!disabledPlugins.has(p.id) && !p.error}
													onToggle={() => !p.error && togglePlugin(p)}
													action={
														<div className="set-row-actions">
															{p.source && (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("pluginUpdateHint")}
																	onClick={() => runUiPluginUpdate(p.id, p.source!)}
																>
																	<FiRefreshCw />
																	{t("pluginUpdate")}
																</button>
															)}
															{confirmUiUninstall === p.id ? (
																<button
																	type="button"
																	className="set-uninstall confirm"
																	title={t("pluginUninstallHint")}
																	onClick={() => runUiPluginUninstall(p.id)}
																>
																	{t("uninstallConfirm")}
																</button>
															) : (
																<button
																	type="button"
																	className="set-uninstall"
																	title={t("pluginUninstallHint")}
																	onClick={() => setConfirmUiUninstall(p.id)}
																>
																	<FiTrash2 />
																	{t("uninstallExt")}
																</button>
															)}
														</div>
													}
												/>
												{/* 声明式设置：manifest settings schema → 自动渲染表单 */}
												{p.settingsSchema && p.settingsSchema.length > 0 && (
													<PluginSettingsForm plugin={p} send={send} />
												)}
											</>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- DSH 用户补丁（<dataDir>/dsh-patches，仅 dsh 引擎） ---------- */}
						{tab === "plugins" && chat.engine === "dsh" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiBox className="set-section-icon" />
									{t("dshPatches")}
									<HintTip text={t("dshPatchesDesc")} />
									<span className="set-count">{chat.dshPatches?.files.length ?? 0}</span>
									<button
										type="button"
										className="set-uninstall"
										title={t("dshPatchesRescanHint")}
										onClick={() => send({ type: "dsh_patches_rescan" })}
									>
										<FiRefreshCw />
										{t("dshPatchesRescan")}
									</button>
								</div>
								{(chat.dshPatches?.files.length ?? 0) === 0 ? (
									<p className="set-empty">{t("dshPatchesEmpty")}</p>
								) : (
									<div className="set-list">
										{chat.dshPatches!.files.map((f) => (
											<div className="set-row" key={f.name}>
												<div className="set-row-info">
													<div className="set-row-name">{f.name}</div>
													<div className="set-row-desc">
														{formatBytes(f.size)} · {new Date(f.mtimeMs).toLocaleString()}
													</div>
												</div>
											</div>
										))}
									</div>
								)}
								<p className="set-hint">
									{t("dshPatchesPath")} {chat.dshPatches?.patchDir ?? ""}
								</p>
							</div>
						)}

						{/* ---- goal review ----------------------------------------------- */}
						{tab === "review" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiZap className="set-section-icon" />
									{t("settingsReview")}
									<HintTip text={t("settingsReviewDesc")} />
									<span className="set-count">{settings.reviewSkills.length}</span>
								</div>
								{isDsh && <p className="set-hint">{t("dshReviewPromptNote")}</p>}
								<textarea
									className="set-prompt-input"
									rows={5}
									placeholder={t("reviewPromptPlaceholder")}
									value={reviewPromptDraft}
									onFocus={() => (reviewPromptFocus.current = true)}
									onBlur={() => {
										reviewPromptFocus.current = false;
										setPartial({ reviewPrompt: reviewPromptDraft });
									}}
									onChange={(e) => setReviewPromptDraft(e.target.value)}
								/>
								<div className="set-field-label">{t("settingsReviewSkills")}</div>
								{settings.reviewSkills.length === 0 ? (
									<p className="set-empty">{t("noSkills")}</p>
								) : (
									<div className="set-list">
										{settings.reviewSkills.map((s) => (
											<ToggleRow
												key={`review-${s.name}`}
												title={s.name}
												subtitle={s.description}
												enabled={s.enabled}
												onToggle={() => toggleReviewSkill(s)}
											/>
										))}
									</div>
								)}
							</div>
						)}

						{/* ---- vision bridge ---------------------------------------------- */}
						{tab === "vision" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiEye className="set-section-icon" />
									{t("settingsVisionBridge")}
								</div>
								<ToggleRow
									title={t("visionBridgeEnabled")}
									tip={t("settingsVisionBridgeDesc")}
									enabled={settings.visionBridgeEnabled}
									onToggle={() => setPartial({ visionBridgeEnabled: !settings.visionBridgeEnabled })}
								/>
								{!settings.visionBridgeEnabled && <p className="set-hint">{t("visionBridgeOffHint")}</p>}
								{settings.visionBridgeEnabled && (
									<div className="set-mode-row">
										<label className="set-field-label">{t("visionBridgeModel")}</label>
										<select
											className="set-select"
											value={settings.visionBridgeModel ?? ""}
											onChange={(e) => setPartial({ visionBridgeModel: e.target.value || null })}
										>
											<option value="">{t("visionBridgeAuto")}</option>
											{settings.visionModels.map((m) => (
												<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
													{m.label}
												</option>
											))}
										</select>
									</div>
								)}
								{settings.visionBridgeEnabled && (
									<div className="set-mode-row">
										<label className="set-field-label">{t("visionBridgePromptMode")}</label>
										<select
											className="set-select"
											value={vbPromptMode}
											onChange={(e) => {
												const mode = e.target.value as "append" | "replace";
												setVbPromptMode(mode);
												setPartial({ visionBridgePromptMode: mode });
											}}
										>
											<option value="append">{t("promptModeAppend")}</option>
											<option value="replace">{t("promptModeReplace")}</option>
										</select>
									</div>
								)}
								{settings.visionBridgeEnabled && (
									<textarea
										className="set-prompt-input"
										rows={4}
										placeholder={t("visionBridgePromptPlaceholder")}
										value={vbPromptDraft}
										onFocus={() => (vbPromptFocus.current = true)}
										onBlur={() => {
											vbPromptFocus.current = false;
											// Same contract as the system prompt: an unmodified copy of
											// the built-in default is stored as empty (use default).
											const text =
												vbPromptMode === "replace" &&
												settings.visionBridgeDefaultPrompt &&
												vbPromptDraft === settings.visionBridgeDefaultPrompt
													? ""
													: vbPromptDraft;
											setPartial({
												visionBridgePromptMode: vbPromptMode,
												visionBridgePrompt: text,
											});
										}}
										onChange={(e) => setVbPromptDraft(e.target.value)}
									/>
								)}
								{settings.visionBridgeEnabled &&
									(settings.visionModels.length === 0 ? (
										<p className="set-hint">{t("visionBridgeNoModels")}</p>
									) : (
										<p className="set-hint">
											{t("visionBridgeCurrent", {
												model: settings.visionBridgeModel ?? t("visionBridgeAuto"),
											})}
										</p>
									))}
							</div>
						)}

						{tab === "presets" && (
							<div className="set-section">
								<div className="set-section-title">
									<FiSettings className="set-section-icon" />
									{t("settingsPresets")}
									<span className="set-count">{settings.presets.length}</span>
								</div>
								<div className="set-preset-save">
									<input
										className="set-input"
										placeholder={t("presetNamePlaceholder")}
										value={presetName}
										onChange={(e) => setPresetName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && presetName.trim()) {
												send({ type: "save_preset", name: presetName.trim() });
												setPresetName("");
											}
										}}
									/>
									<button
										type="button"
										className="set-save-btn"
										disabled={!presetName.trim()}
										onClick={() => {
											send({ type: "save_preset", name: presetName.trim() });
											setPresetName("");
										}}
									>
										<FiPlus /> {t("saveAsPreset")}
									</button>
								</div>
								{settings.presets.length === 0 ? (
									<p className="set-empty">{t("noPresets")}</p>
								) : (
									<div className="set-list">
										{settings.presets.map((p) => (
											<div className="set-row" key={p.name}>
												<div className="set-row-info">
													<div className="set-row-name">{p.name}</div>
													<div className="set-row-desc">
														{p.promptMode === "replace" ? t("promptModeReplace") : t("promptModeAppend")}
														{p.disabledSkills.length > 0 && ` · ${t("settingsSkills")} ${p.disabledSkills.length}`}
														{p.disabledExtensions.length > 0 &&
															` · ${t("settingsExtensions")} ${p.disabledExtensions.length}`}
													</div>
												</div>
												<div className="set-row-actions">
													<button
														type="button"
														className="dd-refresh"
														onClick={() => send({ type: "apply_preset", name: p.name })}
													>
														{t("applyPreset")}
													</button>
													<button
														type="button"
														className="set-icon-btn danger"
														title={t("deletePreset")}
														onClick={() => send({ type: "delete_preset", name: p.name })}
													>
														<FiTrash2 />
													</button>
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				<div className="modal-actions">
					<button type="button" className="dd-refresh" onClick={onClose}>
						{t("close")}
					</button>
				</div>
			</div>
		</div>
	);
}
