import { useCallback, useEffect, useMemo, useState } from "react";
import { FiCpu, FiExternalLink, FiMonitor, FiSave } from "react-icons/fi";
import {
	getDesktopSystemIntegrationBridge,
	getDesktopWindowBridge,
	isDesktopShell,
	type DesktopBrowserBridge,
	type DesktopSystemIntegrationBridge,
	type DesktopSystemIntegrationSnapshot,
} from "../desktop";
import { appSend } from "../app-globals";
import type { MessageKey } from "../i18n/catalog";
import { useT } from "../i18n";
import type { UiPluginInfo } from "../types";

type StartupMode = "agent" | "browser" | "split";

const STARTUP_MODES: StartupMode[] = ["agent", "browser", "split"];
const STARTUP_MODE_LABEL: Record<StartupMode, MessageKey> = {
	agent: "settingsStartupModeAgent",
	browser: "settingsStartupModeBrowser",
	split: "settingsStartupModeSplit",
};

/** 内置浏览器（Chromium PDF 查看器）能原样渲染，不依赖插件 */
const BUILTIN_FILE_TYPES = [".pdf"];

interface FileTypeOption {
	ext: string;
	/** 扩展名大写（UI 上够用，不额外为每种格式起译名） */
	label: string;
	/** 接管它的插件 id；内置为空 */
	pluginId: string;
}

function desktopBrowserBridge(): DesktopBrowserBridge | null {
	if (!isDesktopShell()) return null;
	// embedded（浏览器内嵌）视图没有桌面宿主桥，不能改启动模式
	if (getDesktopWindowBridge() === null) return null;
	const bridge = (window as unknown as { piDesktop?: { browser?: DesktopBrowserBridge } }).piDesktop?.browser;
	return bridge?.getStartupMode && bridge?.setStartupMode ? (bridge as DesktopBrowserBridge) : null;
}

/**
 * 候选文件类型 = 内置 PDF + 已装插件声明能接管的扩展名（`manifest.fileHandlers`）。
 * 「装了 office 才有 docx/pptx 可绑」这条规则由这里天然保证：没装就列不出来。
 */
export function candidateFileTypes(plugins: UiPluginInfo[]): FileTypeOption[] {
	const out = new Map<string, FileTypeOption>();
	for (const ext of BUILTIN_FILE_TYPES) out.set(ext, { ext, label: ext.slice(1).toUpperCase(), pluginId: "" });
	for (const plugin of plugins) {
		if (plugin.error) continue;
		const handlers = (plugin as { fileHandlers?: { extensions?: unknown }[] }).fileHandlers;
		if (!Array.isArray(handlers)) continue;
		for (const handler of handlers) {
			if (!Array.isArray(handler?.extensions)) continue;
			for (const raw of handler.extensions) {
				if (typeof raw !== "string") continue;
				const ext = raw.toLowerCase().startsWith(".") ? raw.toLowerCase() : `.${raw.toLowerCase()}`;
				if (!/^\.[a-z0-9][a-z0-9._-]*$/.test(ext) || out.has(ext)) continue;
				out.set(ext, { ext, label: ext.slice(1).toUpperCase(), pluginId: plugin.id });
			}
		}
	}
	return [...out.values()].sort((a, b) => (a.ext === ".pdf" ? -1 : b.ext === ".pdf" ? 1 : a.ext.localeCompare(b.ext)));
}

/** 应用设置 → 桌面应用：启动模式（与浏览器面板的设置同源，写入 BrowserSettings.defaultMode） */
export function DesktopAppSettings({ plugins = [] }: { plugins?: UiPluginInfo[] }) {
	const t = useT();
	const [bridge] = useState(desktopBrowserBridge);
	const [mode, setMode] = useState<StartupMode | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!bridge?.getStartupMode) return;
		let stopped = false;
		void bridge
			.getStartupMode()
			.then((value) => {
				if (stopped) return;
				setMode(value === "browser" || value === "split" ? value : "agent");
			})
			.catch(() => {
				if (!stopped) setFailed(true);
			});
		return () => {
			stopped = true;
		};
	}, [bridge]);

	const candidates = useMemo(() => candidateFileTypes(plugins), [plugins]);

	const save = (next: StartupMode) => {
		setMode(next);
		setFailed(false);
		void bridge
			?.setStartupMode?.(next)
			.then((ok) => {
				if (ok === false) setFailed(true);
			})
			.catch(() => setFailed(true));
	};

	return (
		<>
			{bridge && (
				<div className="set-section">
					<div className="set-section-title">
						<FiMonitor className="set-section-icon" />
						{t("settingsDesktopApp")}
					</div>
					<div className="set-note">{t("settingsStartupModeHint")}</div>
					<div className="set-row set-field-row">
						<label className="set-row-name" htmlFor="set-startup-mode">
							{t("settingsStartupMode")}
						</label>
						<select
							id="set-startup-mode"
							className="set-select"
							value={mode ?? "agent"}
							disabled={mode === null}
							onChange={(e) => save(e.target.value as StartupMode)}
						>
							{STARTUP_MODES.map((value) => (
								<option key={value} value={value}>
									{t(STARTUP_MODE_LABEL[value])}
								</option>
							))}
						</select>
					</div>
					{failed && <div className="set-note">{t("settingsStartupModeFailed")}</div>}
				</div>
			)}
			<SystemIntegrationSection candidates={candidates} />
			<PiEngineSection />
		</>
	);
}

/**
 * 系统集成（Windows）：默认浏览器 + 文件关联。
 * 注册表写入在桌面主进程（`desktop/system-integration.ts`），这里只做开关与状态展示；
 * 用户必须自己去「默认应用」里确认——Win10/11 不允许程序静默设默认。
 */
function SystemIntegrationSection({ candidates }: { candidates: FileTypeOption[] }) {
	const t = useT();
	const [bridge] = useState<DesktopSystemIntegrationBridge | null>(() => getDesktopSystemIntegrationBridge());
	const [snapshot, setSnapshot] = useState<DesktopSystemIntegrationSnapshot | null>(null);
	const [browserOn, setBrowserOn] = useState(false);
	const [extensions, setExtensions] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; error: string | null } | null>(null);
	const [loadError, setLoadError] = useState(false);

	const refresh = useCallback(() => {
		if (!bridge) return;
		void bridge
			.get()
			.then((next) => {
				setSnapshot(next);
				setBrowserOn(next.selection.browser);
				setExtensions(next.selection.extensions);
				setLoadError(false);
			})
			.catch(() => setLoadError(true));
	}, [bridge]);

	useEffect(refresh, [refresh]);

	if (!bridge) return null;

	const toggleExtension = (ext: string, on: boolean) => {
		setResult(null);
		setExtensions((prev) => (on ? [...new Set([...prev, ext])] : prev.filter((value) => value !== ext)));
	};

	const apply = () => {
		if (!bridge) return;
		setSaving(true);
		setResult(null);
		void bridge
			.apply({ browser: browserOn, extensions })
			.then((next) => {
				setSnapshot(next);
				setBrowserOn(next.selection.browser);
				setExtensions(next.selection.extensions);
				setResult({ ok: next.ok !== false, error: next.error ?? null });
			})
			.catch((error: unknown) =>
				setResult({ ok: false, error: error instanceof Error ? error.message : String(error) }),
			)
			.finally(() => setSaving(false));
	};

	const supported = snapshot?.canApply === true;
	const isDefault = (ext: string) => snapshot?.files.find((file) => file.ext === ext)?.isDefault === true;

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiMonitor className="set-section-icon" />
				{t("settingsSystemIntegration")}
			</div>
			<div className="set-note">{t("settingsSystemIntegrationHint")}</div>
			{loadError && <div className="set-note">{t("settingsSystemIntegrationLoadFailed")}</div>}
			{snapshot && !supported && (
				<div className="set-note">
					{snapshot.supported ? t("settingsSystemIntegrationPackagedOnly") : t("settingsSystemIntegrationUnsupported")}
				</div>
			)}
			{supported && (
				<>
					<label className="set-toggle">
						<input type="checkbox" checked={browserOn} onChange={(e) => setBrowserOn(e.target.checked)} />
						<span>{t("settingsSystemIntegrationBrowser")}</span>
					</label>
					<div className="set-note">
						{snapshot?.browser.isDefault
							? t("settingsSystemIntegrationIsDefault")
							: t("settingsSystemIntegrationNeedsConfirm")}
					</div>
					<div className="set-row-actions">
						<button
							type="button"
							className="set-save-btn"
							onClick={() => void bridge.openDefaultApps().catch(() => false)}
						>
							<FiExternalLink /> {t("settingsSystemIntegrationOpenDefaults")}
						</button>
					</div>
					<div className="set-note">{t("settingsSystemIntegrationFiles")}</div>
					{candidates.length === 0 ? (
						<div className="set-note">{t("settingsSystemIntegrationNoHandlers")}</div>
					) : (
						candidates.map((candidate) => (
							<label className="set-toggle" key={candidate.ext}>
								<input
									type="checkbox"
									checked={extensions.includes(candidate.ext)}
									onChange={(e) => toggleExtension(candidate.ext, e.target.checked)}
								/>
								<span>
									{candidate.label}
									{candidate.pluginId ? ` · ${candidate.pluginId}` : ""}
									{isDefault(candidate.ext) ? ` · ${t("settingsSystemIntegrationIsDefault")}` : ""}
								</span>
							</label>
						))
					)}
					{snapshot?.stale && (
						<div className="set-note">
							{t("settingsSystemIntegrationStale", { path: snapshot.registeredExe ?? "?" })}
						</div>
					)}
					<div className="set-row-actions">
						<button type="button" className="set-save-btn" disabled={saving} onClick={apply}>
							<FiSave /> {t("settingsSystemIntegrationSave")}
						</button>
					</div>
					{result?.ok && <div className="set-note">{t("settingsSystemIntegrationSaved")}</div>}
					{result && !result.ok && (
						<div className="set-note">{t("settingsSystemIntegrationFailed", { error: result.error ?? "" })}</div>
					)}
				</>
			)}
		</div>
	);
}

interface PiEngineStatus {
	bundled: string | null;
	inUse: string | null;
	latest: string | null;
}

/**
 * Pi 引擎（仅桌面壳）：安装包内 node_modules 不可写，这里把本机全局副本升到 @latest。
 * 更新后不自动重启 —— 复用已有的 `restart_service` 路径，由用户点重启生效。
 */
function PiEngineSection() {
	const t = useT();
	const inShell = isDesktopShell();
	const [status, setStatus] = useState<PiEngineStatus | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [updating, setUpdating] = useState(false);
	const [updatedVersion, setUpdatedVersion] = useState<string | null>(null);
	const [updateError, setUpdateError] = useState<string | null>(null);
	const [restarting, setRestarting] = useState(false);

	useEffect(() => {
		if (!inShell) return;
		let stopped = false;
		void fetch("/api/engine/status", { cache: "no-store" })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error(`http ${res.status}`))))
			.then((body: PiEngineStatus) => {
				if (stopped) return;
				setStatus({
					bundled: typeof body?.bundled === "string" ? body.bundled : null,
					inUse: typeof body?.inUse === "string" ? body.inUse : null,
					latest: typeof body?.latest === "string" ? body.latest : null,
				});
				setLoadFailed(false);
			})
			.catch(() => {
				if (!stopped) setLoadFailed(true);
			});
		return () => {
			stopped = true;
		};
	}, [inShell]);

	if (!inShell) return null;

	const upToDate = Boolean(status?.latest && status?.inUse && status.latest === status.inUse);
	const fmt = (v: string | null | undefined) => (v ? `v${v}` : "—");

	const update = () => {
		if (updating) return;
		setUpdating(true);
		setUpdateError(null);
		setUpdatedVersion(null);
		void fetch("/api/engine/update", { method: "POST" })
			.then((res) => res.json())
			.then((body: { ok: boolean; version?: unknown; error?: unknown }) => {
				if (body?.ok) {
					setUpdatedVersion(typeof body.version === "string" ? body.version : "latest");
					setStatus((prev) =>
						prev ? { ...prev, latest: typeof body.version === "string" ? body.version : prev.latest } : prev,
					);
				} else {
					setUpdateError(typeof body?.error === "string" && body.error ? body.error : t("piEngineLoadFailed"));
				}
			})
			.catch((error: unknown) => setUpdateError(error instanceof Error ? error.message : String(error)))
			.finally(() => setUpdating(false));
	};

	const restart = () => {
		if (restarting) return;
		setRestarting(true);
		appSend({ type: "restart_service" });
	};

	return (
		<div className="set-section">
			<div className="set-section-title">
				<FiCpu className="set-section-icon" />
				{t("piEngineSection")}
			</div>
			<div className="set-note">{t("piEngineHint")}</div>
			{loadFailed && <div className="set-note">{t("piEngineLoadFailed")}</div>}
			{status && (
				<>
					<div className="set-row set-field-row">
						<span className="set-row-name">{t("piEngineBundled")}</span>
						<span>{fmt(status.bundled)}</span>
					</div>
					<div className="set-row set-field-row">
						<span className="set-row-name">{t("piEngineInUse")}</span>
						<span>{fmt(status.inUse)}</span>
					</div>
					<div className="set-row set-field-row">
						<span className="set-row-name">{t("piEngineLatest")}</span>
						<span>{fmt(status.latest)}</span>
					</div>
				</>
			)}
			{upToDate && !updatedVersion && <div className="set-note">{t("piEngineUpToDate")}</div>}
			<div className="set-row-actions">
				<button type="button" className="set-save-btn" disabled={updating || upToDate} onClick={update}>
					{updating ? t("piEngineUpdating") : t("piEngineUpdate")}
				</button>
				{updatedVersion && (
					<button type="button" className="set-save-btn" disabled={restarting} onClick={restart}>
						{restarting ? t("restartingService") : t("restartService")}
					</button>
				)}
			</div>
			{updatedVersion && <div className="set-note">{t("piEngineUpdated", { version: updatedVersion })}</div>}
			{updateError && <div className="set-note">{t("piEngineUpdateFailed", { error: updateError })}</div>}
		</div>
	);
}
