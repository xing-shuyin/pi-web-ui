import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "./Markdown";
import { formatSize } from "../format-bytes";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import { useOverlayZIndex } from "../overlay-stack";
import { getDesktopPlatform } from "../desktop";
import { desktopReleasesUrl, type DesktopUpdaterController } from "../desktop-updater";
import type { MessageKey } from "../i18n/catalog";
import type { UpdateAllItem } from "../use-chat";
import { componentActionable, type UpdateAxis, type UpdateAxisAction, type UpdateCenter } from "../update-verdict";
import { runtimeErrorKey, shellErrorKey } from "../update-error-keys";
import "./update-center.css";

/**
 * 更新中心（居中模态；窄屏是底部抽屉）。
 *
 * 与旧的下拉面板的区别只有两点，但都很关键：
 * 1. **只有一个结论**：顶部那句话 + 主按钮来自 `update-verdict.ts` 的 `resolveUpdateCenter()`，
 *    顶栏 chip / badge 也读同一份结果，所以不会再出现「顶栏说有 1 个更新、面板说已是最新」。
 * 2. **一条通道一张卡**：应用 / 运行时（= pi-web-ui 本体）/ Web 界面（非桌面壳）/ pi 引擎。
 *    没有下一步的项（最新、安装包自带）不出按钮，只出状态，避免把「看起来禁用」当成功能。
 */

export interface UpdateModalProps {
	open: boolean;
	onClose: () => void;
	center: UpdateCenter;
	inDesktopShell: boolean;
	updater: DesktopUpdaterController;
	updatesAll: UpdateAllItem[] | null;
	/** 有对话正在跑：安装并重启会打断它。 */
	busy: boolean;
	/** 非桌面壳：可选，用来提示「刚发布的版本」。 */
	latestPublishedAt?: string | null;
	/** 系统服务名（有值时 footer 出「重启服务」）。 */
	serviceName: string | null;
	restarting: boolean;
	onRestartService: () => void;
	/** 交给终端执行的 npm 更新（组件 / Web 界面 / 引擎都用这一条通道）。 */
	onRunNpmUpdate: (items: UpdateAllItem[], titleKey: MessageKey, titleVars?: Record<string, string | number>) => void;
	/** 非桌面壳：向服务端再查一次 npm。 */
	onCheckNpm: () => void;
	/** 全量组件重查。 */
	onCheckAll: () => void;
	/** pi 引擎的运行态（随包自带 / 装了更新的全局 pi）。 */
	updatesSdk: { running: string; bundledInUse: boolean; newerInstalled: string | null } | null;
}

const PI_CORE_PACKAGE = "@earendil-works/pi-coding-agent";

const AXIS_STATE_KEYS = {
	idle: "updatesStateIdle",
	checking: "updatesStateChecking",
	available: "updatesStateAvailable",
	downloading: "updatesStateDownloading",
	ready: "updatesStateReady",
	applying: "updatesStateApplying",
	latest: "updatesStateLatest",
	error: "updatesStateError",
	manual: "updatesStateManual",
	bundled: "updateDesktopRuntimeBundled",
	disabled: "updatesStateDisabled",
} as const satisfies Record<UpdateAxis["state"], MessageKey>;

const ACTION_LABEL = {
	check: "updateDesktopCheck",
	"check-runtime": "updateDesktopRuntimeCheck",
	download: "updateDesktopDownload",
	"download-runtime": "updateDesktopRuntimeDownload",
	cancel: "updateDesktopCancel",
	"cancel-runtime": "updateDesktopCancel",
	install: "updateDesktopInstall",
	"install-runtime": "updateDesktopRuntimeRestart",
	manual: "updateDesktopManual",
	npm: "updateBtn",
} as const satisfies Record<UpdateAxisAction, MessageKey>;

const KIND_KEYS = {
	webui: "kindWebUi",
	"pi-core": "kindPiCore",
	engine: "kindEngine",
	package: "kindPackage",
	"git-extension": "kindGitExtension",
	plugin: "kindPlugin",
} as const satisfies Record<UpdateAllItem["kind"], MessageKey>;

/** git 扩展的版本里常带 ` (sha)`；列表只看人能读的那一段。 */
function shortVersion(value: string | null | undefined): string {
	return (value ?? "").replace(/ \([0-9a-f]{7}\)$/, "");
}

function itemLabel(item: UpdateAllItem): string {
	return item.kind === "git-extension" && item.source ? item.source : item.name;
}

function agoFor(checkedAt: number | null | undefined, now = Date.now()): { key: MessageKey; vars?: { n: number } } {
	if (!checkedAt) return { key: "updatesAgoJustNow" };
	const minutes = Math.max(0, Math.round((now - checkedAt) / 60_000));
	if (minutes < 1) return { key: "updatesAgoJustNow" };
	if (minutes < 60) return { key: "updatesAgoMinutes", vars: { n: minutes } };
	const hours = Math.round(minutes / 60);
	if (hours < 24) return { key: "updatesAgoHours", vars: { n: hours } };
	return { key: "updatesAgoDays", vars: { n: Math.round(hours / 24) } };
}

const TONE_ICON: Record<UpdateCenter["tone"], string> = {
	warn: "↓",
	ok: "✓",
	err: "!",
	muted: "↓",
};

/** 壳轴的「更多选项」：忽略版本 / 恢复提醒 / 退出并安装本地 MSI（win32）。 */
function ShellExtras({
	axis,
	desktop,
	updater,
	inDesktopShell,
	msiLeaving,
	setMsiLeaving,
	setMsiError,
	msiError,
}: {
	axis: UpdateAxis;
	desktop: DesktopUpdaterController["state"];
	updater: DesktopUpdaterController;
	inDesktopShell: boolean;
	msiLeaving: boolean;
	setMsiLeaving: (value: boolean) => void;
	setMsiError: (value: string | null) => void;
	msiError: string | null;
}) {
	const t = useT();
	if (!inDesktopShell) return null;
	const skipped = desktop?.targetVersion !== null && desktop?.targetVersion === desktop?.skippedVersion;
	const canSkip = axis.state === "available" && Boolean(desktop?.targetVersion);
	const canMsi = getDesktopPlatform() === "win32" && typeof updater.installLocalMsi === "function";
	if (!canSkip && !canMsi && !skipped) return null;
	return (
		<details className="uc-fold">
			<summary>{t("updatesMoreOptions")}</summary>
			<div className="uc-rows">
				{skipped && desktop?.targetVersion ? (
					<div className="uc-row">
						<span className="uc-row-name">{t("updateDesktopSkipped", { version: desktop.targetVersion })}</span>
						<button type="button" className="uc-btn sm" onClick={() => updater.skip(null)}>
							{t("updateDesktopUnskip")}
						</button>
					</div>
				) : null}
				{canSkip && axis.target ? (
					<div className="uc-row">
						<span className="uc-row-name">{t("updateDesktopSkip")}</span>
						<button type="button" className="uc-btn sm" onClick={() => updater.skip(axis.target)}>
							{t("updateDesktopSkip")}
						</button>
					</div>
				) : null}
				{canMsi ? (
					<div className="uc-row">
						<span className="uc-row-name">{t("msiQuitInstallButton")}</span>
						<button
							type="button"
							className="uc-btn sm"
							disabled={msiLeaving}
							onClick={async () => {
								if (!window.confirm(t("msiQuitInstallConfirm"))) return;
								setMsiError(null);
								const result = await updater.installLocalMsi!();
								if (result.cancelled) return;
								if (result.ok) {
									setMsiLeaving(true);
									return;
								}
								setMsiError(result.error ?? "unknown error");
							}}
						>
							{t("msiQuitInstallButton")}
						</button>
					</div>
				) : null}
				{msiLeaving ? <div className="uc-hint">{t("msiQuitInstallRunning")}</div> : null}
				{msiError ? <div className="uc-error">{t("msiQuitInstallFailed", { error: msiError })}</div> : null}
			</div>
		</details>
	);
}

export function UpdateModal({
	open,
	onClose,
	center,
	inDesktopShell,
	updater,
	updatesAll,
	busy,
	serviceName,
	restarting,
	onRestartService,
	onRunNpmUpdate,
	onCheckNpm,
	onCheckAll,
	latestPublishedAt = null,
	updatesSdk = null,
}: UpdateModalProps) {
	const t = useT();
	const zIndex = useOverlayZIndex(open);
	const [msiLeaving, setMsiLeaving] = useState(false);
	const [msiError, setMsiError] = useState<string | null>(null);
	useEscapeKey(onClose, open);

	// 打开弹窗时若壳还在等启动 15s 延迟（phase === "idle"），立即触发一次检查，不必干等
	useEffect(() => {
		if (!open || !inDesktopShell) return;
		if (updater.state?.mode === "auto" && updater.state.phase === "idle") {
			void updater.check({ manual: false });
		}
	}, [open, inDesktopShell, updater.state?.mode, updater.state?.phase]);

	if (!open) return null;

	const desktop = updater.state;
	const checkedAt = center.axes.find((axis) => axis.checkedAt)?.checkedAt ?? null;
	const ago = agoFor(checkedAt);
	const notes = desktop?.notes ?? [];

	const coreItem = (): UpdateAllItem =>
		updatesAll?.find((item) => item.kind === "pi-core") ?? {
			name: PI_CORE_PACKAGE,
			kind: "pi-core",
			current: "",
			latest: null,
			upToDate: false,
		};

	const run = (action: UpdateAxisAction, axis?: UpdateAxis) => {
		switch (action) {
			case "check":
				if (inDesktopShell && axis?.id !== "runtime") updater.check({ manual: true });
				else onCheckNpm();
				return;
			case "check-runtime":
				updater.check({ manual: true, channel: "runtime" });
				return;
			case "download":
				updater.download();
				return;
			case "download-runtime":
				updater.download("runtime");
				return;
			case "cancel":
				updater.cancel();
				return;
			case "cancel-runtime":
				updater.cancel("runtime");
				return;
			case "install":
				updater.quitAndInstall();
				return;
			case "install-runtime":
				updater.applyRuntime();
				return;
			case "manual":
				window.open(desktopReleasesUrl(desktop?.targetVersion ?? null), "_blank", "noopener,noreferrer");
				return;
			case "npm": {
				if (axis?.id === "core") {
					const item = coreItem();
					const hasRow = updatesAll?.some((entry) => entry.kind === "pi-core") ?? false;
					onRunNpmUpdate([item], hasRow ? "updatePkgTabTitle" : "installGlobalEngineTabTitle", {
						name: item.name,
					});
					return;
				}
				if (axis?.id === "webui" || axis?.id === "runtime") {
					const item = updatesAll?.find((entry) => entry.kind === "webui") ?? {
						name: "keel-agent",
						kind: "webui" as const,
						current: axis.current ?? "",
						latest: axis.target,
						upToDate: false,
					};
					onRunNpmUpdate([item], "updateTabTitle");
					return;
				}
				const actionable = center.components.filter(componentActionable);
				if (actionable.length > 0) onRunNpmUpdate(actionable, "updateAllTabTitle");
				return;
			}
		}
	};

	const actionLabel = (axis: UpdateAxis, action: UpdateAxisAction): MessageKey => {
		if (action === "check" && axis.state === "error") return "updateDesktopRetry";
		// 引擎轴的 npm 动作有两种语义：清单里没这条（只是机器上装了更新的全局 pi）→ 「安装全局引擎」。
		if (action === "npm" && axis.id === "core" && !updatesAll?.some((item) => item.kind === "pi-core"))
			return "installGlobalEngineBtn";
		return ACTION_LABEL[action];
	};

	const primary = center.primary;
	/** 轴的一句人话补充：同一套 i18n key 不因换了弹窗而丢弃。 */
	const axisHint = (axis: UpdateAxis): string | null => {
		if (axis.id === "shell") {
			if (axis.state === "checking") return t("updateDesktopChecking");
			if (axis.state === "available")
				return [
					t("updateDesktopAvailable", { version: axis.target ?? "" }),
					desktop && desktop.releasesBehind > 1 ? t("updateDesktopBehind", { n: desktop.releasesBehind }) : null,
				]
					.filter(Boolean)
					.join(" · ");
			if (axis.state === "ready") return `${t("updateDesktopDownloaded")} ${t("updateDesktopAutoInstall")}`;
			if (axis.state === "latest") return t("updateDesktopUpToDate", { version: axis.current ?? "" });
			if (axis.state === "manual") {
				const reason = desktop?.modeReason;
				return reason === "dev"
					? t("updateDesktopReasonDev")
					: reason === "portable"
						? t("updateDesktopReasonPortable")
						: reason === "no-feed"
							? t("updateDesktopReasonNoFeed")
							: reason === "forced"
								? t("updateDesktopReasonForced")
								: t("updateDesktopReasonNoFeed");
			}
			return null;
		}
		if (axis.id === "runtime") {
			if (axis.state === "bundled") return t("updateDesktopRuntimeDisabled");
			if (axis.state === "disabled") return t("updateDesktopRuntimeDisabled");
			if (axis.state === "checking") return t("updateDesktopRuntimeChecking");
			if (axis.state === "available") return t("updateDesktopRuntimeAvailable", { version: axis.target ?? "" });
			if (axis.state === "ready") return t("updateDesktopRuntimeStaged", { version: axis.target ?? "" });
			if (axis.state === "applying") return t("updateDesktopRuntimeApplying");
			if (axis.state === "latest")
				return desktop?.runtime?.phase === "done"
					? t("updateDesktopRuntimeDone", { version: axis.current ?? "" })
					: t("updateDesktopRuntimeUpToDate");
			return null;
		}
		if (axis.id === "webui" && axis.state === "available") {
			const justPublished =
				latestPublishedAt && Date.now() - new Date(latestPublishedAt).getTime() < 30 * 60_000
					? t("updateJustPublished", { version: axis.target ?? "" })
					: null;
			return [justPublished, t("updateTerminalHint")].filter(Boolean).join(" · ");
		}
		if (axis.id === "core" && axis.error) return t("piCoreUndetected");
		if (axis.id === "core") {
			const split =
				updatesSdk?.newerInstalled != null
					? `${t("piCoreSplitRun", { running: updatesSdk.running })} · ${t("piSdkSplitNote", {
							running: updatesSdk.running,
							installed: updatesSdk.newerInstalled,
						})}`
					: null;
			// 「随包自带」只在清单里没有 pi-core 行、或那条行确实旧了时才提醒：
			// 有行而且已是最新时不该再嗡一声（旧面板的 bundledRelevant 语义）。
			const coreRow = updatesAll?.find((item) => item.kind === "pi-core");
			const bundled =
				updatesSdk?.bundledInUse && (!coreRow || !coreRow.upToDate)
					? t("piSdkBundledNote", { running: updatesSdk.running })
					: null;
			return [split, bundled].filter(Boolean).join(" · ") || null;
		}
		return null;
	};
	const renderAxis = (axis: UpdateAxis) => {
		const downloading = axis.state === "downloading";
		const errorText =
			axis.state === "error"
				? t(axis.id === "runtime" ? runtimeErrorKey(axis.errorCode) : shellErrorKey(axis.errorCode), {
						error: axis.error ?? "",
					})
				: null;
		const pillKey = AXIS_STATE_KEYS[axis.state];
		const pillTone = axis.tone === "muted" ? "muted" : axis.tone;
		const action = axis.action;
		return (
			<li key={axis.id} className={`uc-axis tone-${axis.tone}`}>
				<div>
					<div className="uc-axis-head">
						<span className="uc-axis-name">{t(axis.labelKey)}</span>
						<span className={`uc-pill tone-${pillTone}`}>{t(pillKey)}</span>
					</div>
					<div className="uc-axis-note">{t(axis.noteKey)}</div>
					{axisHint(axis) ? <div className="uc-hint">{axisHint(axis)}</div> : null}
				</div>
				<div className="uc-axis-act">
					<span className="uc-vers">
						{axis.current ? (axis.target ? `${axis.current} → ` : axis.current) : "—"}
						{axis.target ? <span className="uc-vers-target">{axis.target}</span> : null}
					</span>
					{action ? (
						<button
							type="button"
							className={`uc-btn sm${action === "download" || action === "download-runtime" || action === "install" || action === "install-runtime" || action === "npm" ? " primary" : ""}`}
							onClick={() => run(action, axis)}
						>
							{t(actionLabel(axis, action))}
						</button>
					) : null}
				</div>
				{downloading ? (
					<div className="uc-axis-progress">
						<div
							className="uc-bar"
							role="progressbar"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={axis.percent}
						>
							<i style={{ width: `${axis.percent}%` }} />
						</div>
						<div className="uc-bar-meta">
							<span>
								{t("updateDesktopDownloadProgress", {
									percent: axis.percent,
									done: formatSize(axis.transferred),
									total: axis.total > 0 ? formatSize(axis.total) : "—",
								})}
							</span>
							{axis.bytesPerSecond > 0 ? (
								<span>{t("updateDesktopSpeed", { rate: formatSize(axis.bytesPerSecond) })}</span>
							) : null}
						</div>
					</div>
				) : null}
				{errorText ? <div className="uc-error">{errorText}</div> : null}
				{axis.id === "shell" && axis.state === "ready" && busy ? (
					<div className="uc-hint">{t("updateDesktopBusy")}</div>
				) : null}
				{axis.id === "shell" ? (
					<ShellExtras
						axis={axis}
						desktop={desktop}
						updater={updater}
						inDesktopShell={inDesktopShell}
						msiLeaving={msiLeaving}
						setMsiLeaving={setMsiLeaving}
						setMsiError={setMsiError}
						msiError={msiError}
					/>
				) : null}
			</li>
		);
	};

	return createPortal(
		<div
			className="uc-backdrop"
			style={{ zIndex }}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="uc-sheet" role="dialog" aria-modal="true" aria-label={t("update")}>
				<div className="uc-grab" />
				<header className="uc-head">
					<div className="uc-head-main">
						<h2 className="uc-title">{t("update")}</h2>
						<p className="uc-sub">
							{t("updateDesktopCurrent")} v{center.axes[0]?.current ?? "—"} ·{" "}
							{t("updatesCheckedAgo", { ago: t(ago.key, ago.vars) })}
							{center.axes[0]?.target ? ` · ${t("updateDesktopLatest")} v${center.axes[0].target}` : ""}
						</p>
					</div>
					<button type="button" className="uc-icon-btn" aria-label={t("close")} onClick={onClose}>
						✕
					</button>
				</header>

				<div className="uc-body">
					{inDesktopShell && !updater.bridge ? <div className="uc-hint">{t("updateDesktopNoBridge")}</div> : null}
					<div className={`uc-verdict tone-${center.tone}`}>
						<div className="uc-verdict-ico" aria-hidden="true">
							{TONE_ICON[center.tone]}
						</div>
						<div className="uc-verdict-text">
							<strong className="uc-verdict-title">{t(center.titleKey, center.titleVars)}</strong>
							<span className="uc-verdict-detail">
								{t(center.subKey, { ...center.subVars, ago: t(ago.key, ago.vars) })}
							</span>
						</div>
						<div className="uc-verdict-actions">
							{/* 主按钮已经是「取消下载」时不再摆第二个取消；否则给一个「关闭」。 */}
							{primary?.action === "cancel" || primary?.action === "cancel-runtime" ? null : (
								<button type="button" className="uc-btn ghost" onClick={onClose}>
									{t("close")}
								</button>
							)}
							{primary ? (
								<button
									type="button"
									className="uc-btn primary"
									onClick={() =>
										run(
											primary.action,
											center.axes.find((axis) => axis.id === primary.axisId),
										)
									}
								>
									{t(primary.key, primary.vars)}
								</button>
							) : null}
						</div>
					</div>

					<ul className="uc-axes">{center.axes.map(renderAxis)}</ul>

					<details className="uc-fold" open={center.pendingCount > 0}>
						<summary>
							{center.components.length === 0
								? t("updatesComponentsTitle")
								: center.components.some(componentActionable)
									? `${t("updatesAllTitle")} · ${t("updatesComponentsCount", { n: center.components.filter(componentActionable).length })}`
									: t("updatesComponentsLatest")}
						</summary>
						<div className="uc-rows">
							{center.components.length === 0 ? (
								<div className="uc-empty">{t("updatesNoComponents")}</div>
							) : (
								center.components.map((item) => {
									const actionable = componentActionable(item);
									return (
										<div className="uc-row" key={`${item.kind}:${item.name}`}>
											<span className="uc-row-name" title={item.name}>
												{itemLabel(item)}
											</span>
											<span className="uc-pill plain">{t(KIND_KEYS[item.kind])}</span>
											<span className="uc-row-vers">
												{item.error
													? t("updateCheckFailed")
													: item.upToDate || !item.latest
														? shortVersion(item.current)
														: `${shortVersion(item.current)} → ${shortVersion(item.latest)}`}
											</span>
											{actionable ? (
												<button
													type="button"
													className="uc-btn sm"
													onClick={() => onRunNpmUpdate([item], "updatePkgTabTitle", { name: itemLabel(item) })}
												>
													{t("updateBtn")}
												</button>
											) : (
												<span className={`uc-pill tone-${item.error ? "err" : item.upToDate ? "ok" : "muted"}`}>
													{item.error
														? t("updatesStateError")
														: item.upToDate
															? t("updatesStateLatest")
															: t("updatesStateChecking")}
												</span>
											)}
										</div>
									);
								})
							)}
							{center.components.filter(componentActionable).length > 1 ? (
								<div className="uc-row">
									<span className="uc-row-name">{t("updatesAllTitle")}</span>
									<button
										type="button"
										className="uc-btn sm primary"
										onClick={() => onRunNpmUpdate(center.components.filter(componentActionable), "updateAllTabTitle")}
									>
										{t("updateAllBtn")}
									</button>
								</div>
							) : null}
						</div>
					</details>

					{notes.length > 0 ? (
						<details className="uc-fold">
							<summary>{t("updateDesktopNotes", { n: notes.length })}</summary>
							<div className="uc-notes-body">
								{notes.map((note) => (
									<section key={`${note.version}:${note.markdown.slice(0, 32)}`}>
										{note.version ? <h4>v{note.version}</h4> : null}
										<Markdown text={note.markdown} disableMath />
									</section>
								))}
								{desktop?.notesCut ? <div className="uc-hint">{t("updateDesktopNotesCut")}</div> : null}
							</div>
						</details>
					) : null}
				</div>

				<footer className="uc-foot">
					<span className="uc-foot-spacer" />
					<button type="button" className="uc-link" onClick={onCheckAll}>
						{t("updatesAllRefresh")}
					</button>
					{serviceName ? (
						<button
							type="button"
							className="uc-btn sm"
							disabled={restarting}
							title={t("restartServiceTip", { name: serviceName })}
							onClick={onRestartService}
						>
							{restarting ? t("restartingService") : t("restartService")}
						</button>
					) : null}
				</footer>
			</div>
		</div>,
		document.body,
	);
}
