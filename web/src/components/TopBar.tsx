import { useState } from "react";
import {
	FiDownload,
	FiFolder,
	FiGithub,
	FiGlobe,
	FiMenu,
	FiMessageSquare,
	FiMoreHorizontal,
	FiPlus,
	FiSquare,
	FiTerminal,
	FiVolume2,
} from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { Dropdown, DropdownItem } from "./Dropdown";
import { ModelThinking } from "./ModelThinking";
import { SoundSettingsPanel } from "./SoundSettings";
import type { SoundKind, SoundSettings } from "../sounds";
import { useI18n, type Locale } from "../i18n";

interface TopBarProps {
	chat: ChatState;
	send: (
		msg:
			| { type: "abort" }
			| { type: "list_models" }
			| { type: "set_model"; modelId: string }
			| { type: "set_thinking"; level: string }
			| { type: "new_chat" }
			| { type: "list_models_config" }
			| { type: "check_update" }
			| { type: "update_app" },
	) => boolean;
	view: "chat" | "terminal";
	onViewChange: (view: "chat" | "terminal") => void;
	/** Open a side panel as a mobile drawer ("left" = history, "right" = files). */
	onOpenPanel: (side: "left" | "right") => void;
	/** Open the custom model config panel. */
	onManageModels: () => void;
	/** Sound notification settings + change handler (owned by App). */
	sound: SoundSettings;
	onSoundChange: (settings: SoundSettings) => void;
	onSoundPreview: (kind: SoundKind) => void;
}

export function TopBar({
	chat,
	send,
	view,
	onViewChange,
	onOpenPanel,
	onManageModels,
	sound,
	onSoundChange,
	onSoundPreview,
}: TopBarProps) {
	const { locale, setLocale, t } = useI18n();
	const state = chat.state;
	const [soundOpen, setSoundOpen] = useState(false);
	const [langOpen, setLangOpen] = useState(false);
	const [updateOpen, setUpdateOpen] = useState(false);
	const [moreOpen, setMoreOpen] = useState(false);
	/** Two-step arm before 立即更新 actually runs npm i -g. */
	const [updateArmed, setUpdateArmed] = useState(false);
	/** Brief hint shown when 中断 is clicked while nothing is running. */
	const [idleTip, setIdleTip] = useState(false);

	const LANGUAGES: { value: Locale; label: string }[] = [
		{ value: "zh", label: t("langZh") },
		{ value: "en", label: t("langEn") },
	];

	const connLabel = chat.ready
		? t("connected")
		: chat.status === "closed"
			? t("reconnecting")
			: t("connecting");
	const connClass = chat.ready ? "ok" : "busy";

	// Shared by the desktop update dropdown and the mobile "⋯" panel.
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
				{chat.update?.pendingRestart && (
					<div className="dd-note ok">{t("updateSuccess")}</div>
				)}
				{chat.update &&
					!chat.update.pendingRestart &&
					chat.update.upToDate && (
						<div className="dd-note ok">{t("upToDate")}</div>
					)}
				{chat.update &&
					!chat.update.pendingRestart &&
					!chat.update.upToDate &&
					chat.update.latest && (
						<div className="dd-note warn">
							{t("updateAvailable", { version: chat.update.latest })}
						</div>
					)}
				{chat.update?.latestPublishedAt &&
					Date.now() - new Date(chat.update.latestPublishedAt).getTime() <
						30 * 60_000 && (
						<div className="dd-note warn">
							{t("updateJustPublished", {
								version: chat.update.latest ?? "",
							})}
						</div>
					)}
				{chat.updateResult && !chat.updateResult.ok && (
					<div className="dd-note err">
						{t("updateFailed", { detail: chat.updateResult.detail })}
					</div>
				)}
				{chat.update?.pendingRestart && (
					<div className="dd-note">{t("restartHint")}</div>
				)}
			</div>
			<div className="dd-actions">
				<button
					type="button"
					className="dd-refresh"
					onClick={() => send({ type: "check_update" })}
				>
					{chat.update === null ? t("checkingUpdate") : t("checkUpdate")}
				</button>
				{chat.update &&
					!chat.update.pendingRestart &&
					!chat.update.upToDate &&
					chat.update.latest && (
						<button
							type="button"
							className={`dd-refresh accent ${updateArmed ? "armed" : ""}`}
							onClick={() => {
								if (!updateArmed) {
									setUpdateArmed(true);
									return;
								}
								setUpdateArmed(false);
								setUpdateOpen(false);
								setMoreOpen(false);
								send({ type: "update_app" });
							}}
						>
							{updateArmed ? t("confirmUpdate") : t("updateNow")}
						</button>
					)}
			</div>
		</>
	);

	return (
		<header className="topbar">
			<div className="brand">
				<button
					type="button"
					className="panel-toggle"
					title={t("openHistory")}
					onClick={() => onOpenPanel("left")}
				>
					<FiMenu />
				</button>
				<span className="brand-logo">π</span>
				<span className="brand-name">pi-web-ui</span>
				<span className={`conn-dot ${connClass}`} title={connLabel} />
				<span className="conn-label">{connLabel}</span>
			</div>

			<div className="topbar-actions">
				{/* Global interrupt — ALWAYS visible so a hung run can be stopped at
				    any moment, even when the input bar is scrolled off screen.
				    Red/solid while a run is streaming; grey outline when idle
				    (clicking then is a no-op server-side, with a brief hint). */}
				<button
					type="button"
					className={`btn interrupt${state?.isStreaming ? " active" : ""}`}
					data-tip={t("interruptTip")}
					onClick={() => {
						send({ type: "abort" });
						if (!state?.isStreaming) {
							setIdleTip(true);
							setTimeout(() => setIdleTip(false), 2000);
						}
					}}
				>
					<FiSquare />
					<span>{t("interrupt")}</span>
					{idleTip && <span className="interrupt-idle-tip">{t("interruptIdle")}</span>}
				</button>
				<div
					className="view-switch"
					role="tablist"
					aria-label={t("viewSwitch")}
				>
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
				</div>

				{/* Desktop toolbar — hidden on mobile (model/thinking move into the
				    input row; sound/lang/update/github fold into "⋯" below). */}
				<div className="topbar-desktop">
					<ModelThinking
						chat={chat}
						send={send}
						onManageModels={onManageModels}
					/>

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
						<SoundSettingsPanel
							settings={sound}
							onChange={onSoundChange}
							onPreview={onSoundPreview}
						/>
					</Dropdown>

					<Dropdown
						trigger={
							<>
								<FiGlobe />
								<span className="chip-sub">
									{locale === "zh" ? t("langZh") : "EN"}
								</span>
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
								<FiDownload />
								<span className="chip-sub">v{chat.update?.current ?? "…"}</span>
								{chat.update &&
									!chat.update.upToDate &&
									!chat.update.pendingRestart && (
										<span
											className="update-dot"
											title={t("updateAvailable", {
												version: chat.update.latest ?? "",
											})}
										/>
									)}
							</>
						}
						open={updateOpen}
						onOpenChange={(v) => {
							setUpdateOpen(v);
							setUpdateArmed(false);
							if (v) send({ type: "check_update" });
						}}
						fit
					>
						<div className="dd-header">{t("update")}</div>
						{renderUpdateBody()}
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
								{chat.update &&
									!chat.update.upToDate &&
									!chat.update.pendingRestart && (
										<span className="update-dot" />
									)}
							</>
						}
						open={moreOpen}
						onOpenChange={(v) => {
							setMoreOpen(v);
							setUpdateArmed(false);
							if (v) send({ type: "check_update" });
						}}
					>
						<div className="dd-header">{t("sound")}</div>
						<SoundSettingsPanel
							settings={sound}
							onChange={onSoundChange}
							onPreview={onSoundPreview}
						/>
						<div className="dd-header">{t("language")}</div>
						{LANGUAGES.map((l) => (
							<DropdownItem
								key={l.value}
								active={locale === l.value}
								onClick={() => setLocale(l.value)}
							>
								{l.label}
							</DropdownItem>
						))}
						<div className="dd-header">{t("update")}</div>
						{renderUpdateBody()}
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

				<button
					type="button"
					className="panel-toggle"
					title={t("openFiles")}
					onClick={() => onOpenPanel("right")}
				>
					<FiFolder />
				</button>
			</div>
		</header>
	);
}
