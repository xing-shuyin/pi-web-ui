import { useState } from "react";
import {
	FiDownload,
	FiFolder,
	FiGitBranch,
	FiGithub,
	FiGlobe,
	FiMenu,
	FiMessageSquare,
	FiMoreHorizontal,
	FiSearch,
	FiSun,
	FiPlus,
	FiSettings,
	FiLayers,
	FiTerminal,
	FiVolume2,
} from "react-icons/fi";
import type { ChatState, UpdateAllItem } from "../use-chat";
import type { ClientMessage, CommandDef } from "../types";
import { buildUpdateCommand } from "../update-command";
import { randomUuid } from "../uuid";
import { Dropdown, DropdownItem } from "./Dropdown";
import { SoundSettingsPanel } from "./SoundSettings";
import type { SoundKind, SoundSettings } from "../sounds";
import { useI18n, type Locale } from "../i18n";

interface TopBarProps {
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	/** Minimal terminal-tab bridge (same shape SCMPanel uses) — updates run there. */
	terminal: {
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
	};
	view: "chat" | "terminal" | "git" | `plugin:${string}`;
	onViewChange: (view: "chat" | "terminal" | "git" | `plugin:${string}`) => void;
	/** Installed optional plugins (<dataDir>/plugins) — one view tab each. */
	plugins: { id: string; name: string; icon?: string; description?: string; error?: string }[];
	/** Open a side panel as a mobile drawer ("left" = history, "right" = files). */
	onOpenPanel: (side: "left" | "right") => void;
	/** Open the settings panel (system prompt / skills / extensions / presets). */
	onOpenSettings: () => void;
	/** Open the background-task panel (AI-started servers — stop individually or all). */
	onOpenBgTasks: () => void;
	/** Open the global search panel (sessions / projects / workspace files). */
	onOpenGlobalSearch: () => void;
	/** Sound notification settings + change handler (owned by App). */
	sound: SoundSettings;
	onSoundChange: (settings: SoundSettings) => void;
	onSoundPreview: (kind: SoundKind) => void;
	/** Theme list + current selection + switch handler (owned by App). */
	themes: { id: string; name: string; builtin: boolean }[];
	theme: string | null;
	onThemeChange: (id: string | null) => void;
}

export function TopBar({
	chat,
	send,
	terminal,
	view,
	plugins,
	onViewChange,
	onOpenPanel,
	onOpenSettings,
	onOpenBgTasks,
	onOpenGlobalSearch,
	sound,
	onSoundChange,
	onSoundPreview,
	themes,
	theme,
	onThemeChange,
}: TopBarProps) {
	const { locale, setLocale, t } = useI18n();
	const [soundOpen, setSoundOpen] = useState(false);
	const [langOpen, setLangOpen] = useState(false);
	const [themeOpen, setThemeOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);

	const LANGUAGES: { value: Locale; label: string }[] = [
		{ value: "zh", label: t("langZh") },
		{ value: "en", label: t("langEn") },
	];

	const connLabel = chat.ready ? t("connected") : chat.status === "closed" ? t("reconnecting") : t("connecting");
	const connClass = chat.ready ? "ok" : "busy";

	/** Run `npm i -g pi-web-ui@latest` in a visible terminal tab (SCM-style):
	 *  reuse the tab with the same title, otherwise create one; switch to the
	 *  terminal view so the user watches the install live. */
	const runUpdate = () => {
		if (!chat.ready) return;
		const title = t("updateTabTitle");
		const cmd: CommandDef = {
			name: title,
			command: "npm i -g pi-web-ui@latest",
			cwd: "${pwd}",
		};
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
		} else {
			terminal.create({
				id: randomUuid(),
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
		setUpdateOpen(false);
		setMoreOpen(false);
		onViewChange("terminal");
	};

	/** Run the right update command for one or more components in a visible
	 *  terminal tab (same SCM-style pattern as the self-update above): pi
	 *  extensions go through `pi update npm:<name>` (they live under
	 *  <agentDir>/npm), everything globally installed via `npm i -g`.
	 *  Multi-target runs are chained with `;` so one failing step never
	 *  blocks the rest. Reuses the tab with the same title, else creates one. */
	const runPkgUpdate = (items: UpdateAllItem[], title: string) => {
		if (!chat.ready || items.length === 0) return;
		const cmd: CommandDef = {
			name: title,
			command: buildUpdateCommand(items),
			cwd: "${pwd}",
		};
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
		} else {
			terminal.create({
				id: randomUuid(),
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
		setUpdateOpen(false);
		setMoreOpen(false);
		onViewChange("terminal");
	};

	// Shared by the desktop update dropdown and the mobile "⋯" panel.
	const allUpdates = chat.updatesAll ?? [];
	// Pure errors don't count as "updates" — they're shown as failed rows.
	const updatesCount = allUpdates.filter((i) => !i.upToDate && !i.error).length;
	// Packages (+ the pi core) with a real newer version — targets of the
	// per-row and "update all" buttons. The web UI itself is excluded: it has
	// its own dedicated update flow above the all-components section.
	const updatable = allUpdates.filter((i) => !i.upToDate && !i.error && i.kind !== "webui");
	const renderAllUpdatesBody = () => (
		<div className="dd-updates-all">
			<div className="dd-header">{t("updatesAllTitle")}</div>
			{chat.updatesAll === null ? (
				<div className="dd-note">{t("checkingUpdate")}</div>
			) : allUpdates.length === 0 ? (
				<div className="dd-note">{t("updatesAllUpToDate")}</div>
			) : (
				<ul className="dd-all-list">
					{allUpdates.map((item) => (
						<li
							key={`${item.kind}:${item.name}`}
							className={`dd-all-item${item.error ? " err" : item.upToDate ? "" : " warn"}`}
						>
							<span className="dd-all-name" title={item.name}>
								{item.name}
							</span>
							<span className="dd-all-kind">
								{item.kind === "webui" ? t("kindWebUi") : item.kind === "pi-core" ? t("kindPiCore") : t("kindPackage")}
							</span>
							<span className="dd-all-vers">
								{item.error ? (
									t("updateCheckFailed")
								) : item.upToDate ? (
									`v${item.current}`
								) : (
									<>
										v{item.current} → v{item.latest}
									</>
								)}
							</span>
							{item.kind !== "webui" && !item.upToDate && !item.error && (
								<button
									type="button"
									className="dd-update-btn"
									onClick={() => runPkgUpdate([item], t("updatePkgTabTitle", { name: item.name }))}
								>
									{t("updateBtn")}
								</button>
							)}
						</li>
					))}
				</ul>
			)}
			<div className="dd-actions">
				{updatable.length > 0 && (
					<button
						type="button"
						className="dd-refresh accent"
						style={{ flex: 1 }}
						onClick={() => runPkgUpdate(updatable, t("updateAllTabTitle"))}
					>
						{t("updateAllBtn")}
					</button>
				)}
				<button
					type="button"
					className="dd-refresh"
					style={updatable.length > 0 ? { flex: 1 } : undefined}
					onClick={() => send({ type: "check_updates_all", force: true })}
				>
					{t("updatesAllRefresh")}
				</button>
			</div>
		</div>
	);
	const renderUpdateBody = () => (
		<>
			<div className="dd-update">
				<div className="dd-row">
					<span>{t("currentVersion")}</span>
					<b>v{chat.update?.current ?? "…"}</b>
				</div>
				<div className="dd-row">
					<span>{t("latestVersion")}</span>
					<b>
						{chat.update === null
							? t("checkingUpdate")
							: chat.update.error
								? chat.update.error
								: chat.update.latest
									? `v${chat.update.latest}`
									: t("checkingUpdate")}
					</b>
				</div>
				{chat.update && chat.update.upToDate && <div className="dd-note ok">{t("upToDate")}</div>}
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<div className="dd-note warn">{t("updateAvailable", { version: chat.update.latest })}</div>
				)}
				{chat.update?.latestPublishedAt &&
					Date.now() - new Date(chat.update.latestPublishedAt).getTime() < 30 * 60_000 && (
						<div className="dd-note warn">
							{t("updateJustPublished", {
								version: chat.update.latest ?? "",
							})}
						</div>
					)}
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<div className="dd-note">{t("updateTerminalHint")}</div>
				)}
			</div>
			<div className="dd-actions">
				<button type="button" className="dd-refresh" onClick={() => send({ type: "check_update" })}>
					{chat.update === null ? t("checkingUpdate") : t("checkUpdate")}
				</button>
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<button type="button" className="dd-refresh accent" onClick={runUpdate}>
						{t("updateNow")}
					</button>
				)}
			</div>
		</>
	);

	return (
		<header className="topbar">
			<div className="brand">
				<button type="button" className="panel-toggle" title={t("openHistory")} onClick={() => onOpenPanel("left")}>
					<FiMenu />
				</button>
				<span className="brand-logo">π</span>
				<span className="brand-name">pi-web-ui</span>
				<span className={`conn-dot ${connClass}`} title={connLabel} />
				<span className="conn-label">{connLabel}</span>
			</div>

			<div className="topbar-actions">
				<div className="view-switch" role="tablist" aria-label={t("viewSwitch")}>
					<button
						type="button"
						role="tab"
						aria-selected={view === "chat"}
						className={view === "chat" ? "active" : ""}
						onClick={() => onViewChange("chat")}
					>
						<FiMessageSquare />
						<span>{t("chat")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={view === "terminal"}
						className={view === "terminal" ? "active" : ""}
						onClick={() => onViewChange("terminal")}
					>
						<FiTerminal />
						<span>{t("terminal")}</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={view === "git"}
						className={view === "git" ? "active" : ""}
						onClick={() => onViewChange("git")}
					>
						<FiGitBranch />
						<span>{t("scmTab")}</span>
					</button>
					{plugins.map((p) => {
						const tip = p.error ? `${p.name}: ${p.error}` : p.description ? `${p.name} — ${p.description}` : p.name;
						return (
							<button
								key={p.id}
								type="button"
								role="tab"
								aria-selected={view === `plugin:${p.id}`}
								className={`plugin-tab${view === `plugin:${p.id}` ? " active" : ""}${p.error ? " broken" : ""}`}
								title={tip}
								onClick={() => onViewChange(`plugin:${p.id}`)}
							>
								{p.icon ? <span aria-hidden>{p.icon}</span> : null}
								<span>{p.name}</span>
							</button>
						);
					})}
				</div>

				{/* Desktop toolbar — hidden on mobile (model/thinking move into the
				    input row; sound/lang/update/github fold into "⋯" below). */}
				<div className="topbar-desktop">
					{/* Global search — sessions / projects / workspace files. */}
					<button type="button" className="chip" title={t("searchGlobalTip")} onClick={onOpenGlobalSearch}>
						<FiSearch />
						<span className="chip-sub">{t("searchGlobal")}</span>
					</button>
					{/* Background tasks — AI-started servers still listening. Always shown
					    so the list survives the conversation that started them (badge = count). */}
					<button type="button" className="chip bg-task-chip" data-tip={t("bgTasksTip")} onClick={onOpenBgTasks}>
						<FiLayers />
						<span className="chip-sub">{t("bgTasks")}</span>
						{chat.bgServers.length > 0 && <span className="bg-task-badge">{chat.bgServers.length}</span>}
					</button>

					<button type="button" className="chip" title={t("settingsTitle")} onClick={onOpenSettings}>
						<FiSettings />
						<span className="chip-sub">{t("settings")}</span>
					</button>

					<Dropdown
						trigger={
							<>
								<FiVolume2 />
								<span className="chip-sub">{t("sound")}</span>
							</>
						}
						open={soundOpen}
						onOpenChange={setSoundOpen}
					>
						<SoundSettingsPanel settings={sound} onChange={onSoundChange} onPreview={onSoundPreview} />
					</Dropdown>

					<Dropdown
						trigger={
							<>
								<FiGlobe />
								<span className="chip-sub">{locale === "zh" ? t("langZh") : "EN"}</span>
							</>
						}
						open={langOpen}
						onOpenChange={setLangOpen}
					>
						<div className="dd-header">{t("language")}</div>
						{LANGUAGES.map((l) => (
							<DropdownItem
								key={l.value}
								active={locale === l.value}
								onClick={() => {
									setLocale(l.value);
									setLangOpen(false);
								}}
							>
								{l.label}
							</DropdownItem>
						))}
					</Dropdown>

					<Dropdown
						trigger={
							<>
								<FiSun />
								<span className="chip-sub">{t("theme")}</span>
							</>
						}
						open={themeOpen}
						onOpenChange={setThemeOpen}
					>
						<div className="dd-header">{t("theme")}</div>
						<DropdownItem
							active={theme === null}
							onClick={() => {
								onThemeChange(null);
								setThemeOpen(false);
							}}
						>
							{t("themeDefault")}
						</DropdownItem>
						{themes.map((th) => (
							<DropdownItem
								key={th.id}
								active={theme === th.id}
								onClick={() => {
									onThemeChange(th.id);
									setThemeOpen(false);
								}}
							>
								{th.name}
							</DropdownItem>
						))}
					</Dropdown>

					<Dropdown
						trigger={
							<>
								<FiDownload />
								<span className="chip-sub">v{chat.update?.current ?? "…"}</span>
								{chat.update && !chat.update.upToDate && (
									<span
										className="update-dot"
										title={t("updateAvailable", {
											version: chat.update.latest ?? "",
										})}
									/>
								)}
								{updatesCount > 0 && <span className="update-badge">{t("updatesAllBadge", { n: updatesCount })}</span>}
							</>
						}
						open={updateOpen}
						onOpenChange={(v) => {
							setUpdateOpen(v);
							if (v) {
								send({ type: "check_update" });
								send({ type: "check_updates_all" });
							}
						}}
						fit
					>
						<div className="dd-header">{t("update")}</div>
						{renderUpdateBody()}
						{renderAllUpdatesBody()}
					</Dropdown>

					<a
						className="chip github"
						href="https://github.com/xing-shuyin/pi-web-ui"
						target="_blank"
						rel="noreferrer noopener"
						title={t("githubRepo")}
					>
						<FiGithub />
					</a>
				</div>

				<button
					type="button"
					className="chip newchat"
					data-tip={t("newChatTip")}
					onClick={() => send({ type: "new_chat" })}
				>
					<FiPlus />
					<span>{t("newChat")}</span>
				</button>

				{/* Mobile "⋯" panel — folds sound / language / update / GitHub.
				    Hidden on desktop (each stays its own chip up there). */}
				<div className="topbar-more">
					<Dropdown
						trigger={
							<>
								<FiMoreHorizontal />
								<span className="chip-sub">{t("more")}</span>
								{chat.update && !chat.update.upToDate && <span className="update-dot" />}
							</>
						}
						open={moreOpen}
						onOpenChange={(v) => {
							setMoreOpen(v);
							if (v) {
								send({ type: "check_update" });
								send({ type: "check_updates_all" });
							}
						}}
					>
						<div className="dd-header">{t("sound")}</div>
						<div className="dd-header">{t("settings")}</div>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenSettings();
							}}
						>
							<FiSettings /> {t("settingsTitle")}
						</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenGlobalSearch();
							}}
						>
							<FiSearch /> {t("searchGlobal")}
						</DropdownItem>
						<DropdownItem
							onClick={() => {
								setMoreOpen(false);
								onOpenBgTasks();
							}}
						>
							<FiLayers /> {t("bgTasks")}
							{chat.bgServers.length > 0 && <em className="bg-task-badge">{chat.bgServers.length}</em>}
						</DropdownItem>
						<SoundSettingsPanel settings={sound} onChange={onSoundChange} onPreview={onSoundPreview} />
						<div className="dd-header">{t("language")}</div>
						{LANGUAGES.map((l) => (
							<DropdownItem key={l.value} active={locale === l.value} onClick={() => setLocale(l.value)}>
								{l.label}
							</DropdownItem>
						))}
						<div className="dd-header">{t("theme")}</div>
						<DropdownItem
							active={theme === null}
							onClick={() => {
								onThemeChange(null);
								setMoreOpen(false);
							}}
						>
							{t("themeDefault")}
						</DropdownItem>
						{themes.map((th) => (
							<DropdownItem
								key={th.id}
								active={theme === th.id}
								onClick={() => {
									onThemeChange(th.id);
									setMoreOpen(false);
								}}
							>
								{th.name}
							</DropdownItem>
						))}
						<div className="dd-header">{t("update")}</div>
						{renderUpdateBody()}
						{renderAllUpdatesBody()}
						<a
							className="dd-refresh dd-more-link"
							href="https://github.com/xing-shuyin/pi-web-ui"
							target="_blank"
							rel="noreferrer noopener"
						>
							<FiGithub /> {t("githubRepo")}
						</a>
					</Dropdown>
				</div>

				<button type="button" className="panel-toggle" title={t("openFiles")} onClick={() => onOpenPanel("right")}>
					<FiFolder />
				</button>
			</div>
		</header>
	);
}
