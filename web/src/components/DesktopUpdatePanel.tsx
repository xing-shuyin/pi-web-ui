import { useState } from "react";
import { Markdown } from "./Markdown";
import { formatSize } from "../format-bytes";
import { useT } from "../i18n";
import { getDesktopPlatform } from "../desktop";
import { desktopReleasesUrl, type DesktopUpdaterController } from "../desktop-updater";

/**
 * 桌面版的应用内更新面板。
 *
 * 与 npm 那条更新通道分开：桌面版的服务随应用发布，`npm i -g pi-web-ui` 对它无效。
 * 这里只读主进程的更新状态快照（desktop/updater.ts），按「能不能自更新 → 有没有新版 →
 * 下载到什么进度 → 能不能装」四个问题分支，每种失败都给出下一步（重试 / 去下载页换包）。
 */
const ERROR_KEYS = {
	network: "updateDesktopErrNetwork",
	feed: "updateDesktopErrFeed",
	permission: "updateDesktopErrPermission",
	disk: "updateDesktopErrDisk",
	signature: "updateDesktopErrSignature",
	unknown: "updateDesktopErrUnknown",
} as const;

/** 运行时通道的错误码 → 文案（manifest/unsupported/corrupt/busy/health 是 P2 新增的语义）。 */
const RUNTIME_ERROR_KEYS = {
	network: "updateDesktopErrNetwork",
	feed: "updateDesktopErrFeed",
	permission: "updateDesktopErrPermission",
	disk: "updateDesktopErrDisk",
	signature: "updateDesktopErrSignature",
	manifest: "updateDesktopRuntimeErrManifest",
	unsupported: "updateDesktopRuntimeErrUnsupported",
	corrupt: "updateDesktopRuntimeErrCorrupt",
	busy: "updateDesktopRuntimeErrBusy",
	health: "updateDesktopRuntimeErrHealth",
	unknown: "updateDesktopErrUnknown",
} as const;

type RuntimeErrorKey = (typeof RUNTIME_ERROR_KEYS)[keyof typeof RUNTIME_ERROR_KEYS];

function runtimeErrorKey(code: string | null): RuntimeErrorKey {
	return (RUNTIME_ERROR_KEYS as Record<string, RuntimeErrorKey>)[code ?? "unknown"] ?? "updateDesktopErrUnknown";
}

const REASON_KEYS = {
	dev: "updateDesktopReasonDev",
	portable: "updateDesktopReasonPortable",
	"no-feed": "updateDesktopReasonNoFeed",
	forced: "updateDesktopReasonForced",
	ready: null,
} as const;

/**
 * 运行时通道（双层模型的 L2）：壳几个月才动一次，运行时可每版都更。
 * 与壳更新共用一条状态广播，但按钮/文案各走各的——壳装不上的机器（便携版 / 开发态）也能更运行时。
 */
function RuntimeSection({ updater }: { updater: DesktopUpdaterController }) {
	const t = useT();
	const runtime = updater.state?.runtime;
	if (!runtime) return null;
	const rows = (
		<div className="dd-row">
			<span>{t("updateDesktopRuntimeTitle")}</span>
			<b>{runtime.currentVersion ? `v${runtime.currentVersion}` : t("updateDesktopRuntimeBundled")}</b>
		</div>
	);
	if (!runtime.enabled) {
		return (
			<>
				{rows}
				<div className="dd-note">{t("updateDesktopRuntimeDisabled")}</div>
			</>
		);
	}
	const checkButton = (
		<button type="button" className="dd-refresh" onClick={() => updater.check({ manual: true, channel: "runtime" })}>
			{t("updateDesktopRuntimeCheck")}
		</button>
	);
	const progress = (
		<>
			<div
				className="ddu-progress"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={runtime.percent}
			>
				<i style={{ width: `${runtime.percent}%` }} />
			</div>
			<div className="dd-note">
				{t("updateDesktopDownloadProgress", {
					percent: runtime.percent,
					done: formatSize(runtime.transferred),
					total: runtime.total > 0 ? formatSize(runtime.total) : "—",
				})}
			</div>
		</>
	);
	const body = () => {
		switch (runtime.phase) {
			case "checking":
				return <div className="dd-note">{t("updateDesktopRuntimeChecking")}</div>;
			case "available":
				return (
					<>
						<div className="dd-note warn">
							{t("updateDesktopRuntimeAvailable", { version: runtime.targetVersion ?? "" })}
						</div>
						<div className="dd-actions">
							<button type="button" className="dd-refresh accent" onClick={() => updater.download("runtime")}>
								{t("updateDesktopRuntimeDownload")}
							</button>
							{checkButton}
						</div>
					</>
				);
			case "downloading":
				return (
					<>
						{progress}
						<div className="dd-actions">
							<button type="button" className="dd-refresh" onClick={() => updater.cancel("runtime")}>
								{t("updateDesktopCancel")}
							</button>
						</div>
					</>
				);
			case "staged":
				return (
					<>
						<div className="dd-note ok">
							{t("updateDesktopRuntimeStaged", { version: runtime.targetVersion ?? "" })}
						</div>
						<div className="dd-actions">
							<button type="button" className="dd-refresh accent" onClick={() => updater.applyRuntime()}>
								{t("updateDesktopRuntimeRestart")}
							</button>
						</div>
					</>
				);
			case "applying":
				return <div className="dd-note warn">{t("updateDesktopRuntimeApplying")}</div>;
			case "done":
				return (
					<>
						<div className="dd-note ok">{t("updateDesktopRuntimeDone", { version: runtime.currentVersion ?? "" })}</div>
						{checkButton}
					</>
				);
			case "error":
				return (
					<>
						<div className="dd-note err">{t(runtimeErrorKey(runtime.errorCode), { error: runtime.error ?? "" })}</div>
						{checkButton}
					</>
				);
			case "up-to-date":
				return (
					<>
						<div className="dd-note ok">{t("updateDesktopRuntimeUpToDate")}</div>
						{checkButton}
					</>
				);
			default:
				return <>{checkButton}</>;
		}
	};
	return (
		<>
			{rows}
			{body()}
		</>
	);
}

/**
 * MSI 本地安装（FilesInUse 绕行）：仅 win32 + 桌面壳 + 新桥才显示。
 * 二次确认用 window.confirm（与其它危险操作同一范式）；ok 时应用随即退出，
 * 这里只显示「正在退出并安装…」，无需处理返回后的状态。
 */
function MsiQuitInstallSection({ updater }: { updater: DesktopUpdaterController }) {
	const t = useT();
	const [leaving, setLeaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (getDesktopPlatform() !== "win32") return null;
	if (typeof updater.installLocalMsi !== "function") return null;
	if (leaving) return <div className="dd-note warn">{t("msiQuitInstallRunning")}</div>;
	return (
		<>
			<div className="dd-actions">
				<button
					type="button"
					className="dd-refresh"
					onClick={async () => {
						if (!window.confirm(t("msiQuitInstallConfirm"))) return;
						setError(null);
						const result = await updater.installLocalMsi();
						if (result.cancelled) return;
						if (result.ok) {
							setLeaving(true);
							return;
						}
						setError(result.error ?? "unknown error");
					}}
				>
					{t("msiQuitInstallButton")}
				</button>
			</div>
			{error ? <div className="dd-note err">{t("msiQuitInstallFailed", { error })}</div> : null}
		</>
	);
}

export function DesktopUpdatePanel({ updater, busy = false }: { updater: DesktopUpdaterController; busy?: boolean }) {
	const t = useT();
	const state = updater.state;

	if (!updater.bridge) return <div className="dd-note warn">{t("updateDesktopNoBridge")}</div>;
	// 快照还没回来：给一句「正在检查」，别让面板空白。
	if (!state) return <div className="dd-note">{t("updateDesktopChecking")}</div>;

	const releasesUrl = state.targetVersion ? desktopReleasesUrl(state.targetVersion) : desktopReleasesUrl(null);
	const manualLink = (
		<a className="dd-refresh dd-more-link" href={releasesUrl} target="_blank" rel="noreferrer noopener">
			{t("updateDesktopManual")}
		</a>
	);
	const versionRows = (
		<>
			<div className="dd-row">
				<span>{t("updateDesktopCurrent")}</span>
				<b>v{state.currentVersion}</b>
			</div>
			{state.targetVersion ? (
				<div className="dd-row">
					<span>{t("updateDesktopLatest")}</span>
					<b>v{state.targetVersion}</b>
				</div>
			) : null}
		</>
	);
	const actionError = updater.actionError ? <div className="dd-note err">{updater.actionError}</div> : null;
	const skipped = state.targetVersion !== null && state.targetVersion === state.skippedVersion;

	if (state.mode === "manual") {
		const reasonKey = REASON_KEYS[state.modeReason];
		return (
			<div className="ddu">
				{versionRows}
				<div className="dd-note warn">{reasonKey ? t(reasonKey) : t("updateDesktopNoBridge")}</div>
				{manualLink}
				{actionError}
				<MsiQuitInstallSection updater={updater} />
				<RuntimeSection updater={updater} />
			</div>
		);
	}

	const notes =
		state.notes.length > 0 ? (
			// 不接管 open：让浏览器保留用户展开/收起的状态，进度刷新不会把它收回去。
			<details className="ddu-notes">
				<summary>{t("updateDesktopNotes", { n: state.notes.length })}</summary>
				<div className="ddu-notes-body">
					{state.notes.map((note) => (
						<section key={`${note.version}:${note.markdown.slice(0, 32)}`}>
							{note.version ? <h4>v{note.version}</h4> : null}
							<Markdown text={note.markdown} disableMath />
						</section>
					))}
					{state.notesCut ? <div className="dd-note">{t("updateDesktopNotesCut")}</div> : null}
				</div>
			</details>
		) : null;

	const progress = (
		<>
			<div
				className="ddu-progress"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={state.percent}
			>
				<i style={{ width: `${state.percent}%` }} />
			</div>
			<div className="dd-note">
				{t("updateDesktopDownloadProgress", {
					percent: state.percent,
					done: formatSize(state.transferred),
					// 还没拿到总大小（刚起步 / 服务端没给 content-length）时用破折号，别显示 0 B / 0 B。
					total: state.total > 0 ? formatSize(state.total) : "—",
				})}
				{state.bytesPerSecond > 0 ? ` · ${t("updateDesktopSpeed", { rate: formatSize(state.bytesPerSecond) })}` : ""}
			</div>
		</>
	);

	const body = () => {
		switch (state.phase) {
			case "checking":
				return (
					<>
						<div className="dd-note">{t("updateDesktopChecking")}</div>
						{manualLink}
					</>
				);
			case "available":
				return (
					<>
						<div className="dd-note warn">
							{t("updateDesktopAvailable", { version: state.targetVersion ?? "" })}
							{state.releasesBehind > 1 ? ` · ${t("updateDesktopBehind", { n: state.releasesBehind })}` : ""}
						</div>
						{skipped ? (
							<>
								<div className="dd-note">{t("updateDesktopSkipped", { version: state.targetVersion ?? "" })}</div>
								<button type="button" className="dd-refresh" onClick={() => updater.skip(null)}>
									{t("updateDesktopUnskip")}
								</button>
							</>
						) : (
							<div className="dd-actions">
								<button type="button" className="dd-refresh accent" onClick={() => updater.download()}>
									{t("updateDesktopDownload")}
								</button>
								{state.targetVersion && (
									<button type="button" className="dd-refresh" onClick={() => updater.skip(state.targetVersion)}>
										{t("updateDesktopSkip")}
									</button>
								)}
							</div>
						)}
						{notes}
						{manualLink}
					</>
				);
			case "downloading":
				return (
					<>
						{progress}
						<div className="dd-actions">
							<button type="button" className="dd-refresh" onClick={() => updater.cancel()}>
								{t("updateDesktopCancel")}
							</button>
						</div>
						{notes}
					</>
				);
			case "downloaded":
				return (
					<>
						<div className="dd-note ok">{t("updateDesktopDownloaded")}</div>
						<div className="dd-actions">
							<button type="button" className="dd-refresh accent" onClick={() => updater.quitAndInstall()}>
								{t("updateDesktopInstall")}
							</button>
						</div>
						<div className="dd-note">{t("updateDesktopAutoInstall")}</div>
						{busy ? <div className="dd-note warn">{t("updateDesktopBusy")}</div> : null}
						{notes}
					</>
				);
			case "up-to-date":
				return (
					<>
						<div className="dd-note ok">{t("updateDesktopUpToDate", { version: state.currentVersion })}</div>
						<button type="button" className="dd-refresh" onClick={() => updater.check({ manual: true })}>
							{t("updateDesktopCheck")}
						</button>
					</>
				);
			case "error": {
				const key = ERROR_KEYS[state.errorCode ?? "unknown"];
				return (
					<>
						<div className="dd-note err">{t(key, { error: state.error ?? "" })}</div>
						<div className="dd-actions">
							<button type="button" className="dd-refresh" onClick={() => updater.check({ manual: true })}>
								{t("updateDesktopRetry")}
							</button>
						</div>
						{manualLink}
					</>
				);
			}
			default:
				return (
					<>
						<button type="button" className="dd-refresh accent" onClick={() => updater.check({ manual: true })}>
							{t("updateDesktopCheck")}
						</button>
						{manualLink}
					</>
				);
		}
	};

	return (
		<div className="ddu">
			{versionRows}
			{body()}
			{actionError}
			<MsiQuitInstallSection updater={updater} />
			<RuntimeSection updater={updater} />
		</div>
	);
}
