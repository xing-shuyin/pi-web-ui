import {
	cloneElement,
	isValidElement,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { FiChevronRight, FiDownload, FiTerminal } from "react-icons/fi";
import { ENGINE_CATALOG } from "../../../server/engine-catalog";
import type { NativeCliConfig, NativeCliDiscoveryResult } from "../types";
import { appUrl } from "../base-url";
import { parseRemoteWorkspaceUri } from "../remote-ssh-client";
import { useT } from "../i18n";
import { useAppField } from "../app-globals";
import { isNativeCliRemoteCwd, nativeCliArgumentLines } from "../native-cli";
import { shortenPath } from "../tool-args";
import { Modal } from "./Modal";
import "./NativeCliCreateModal.css";

export interface NativeCliCreateModalProps {
	cwd?: string;
	onClose: () => void;
	onCreate: (config: NativeCliConfig) => void;
	disabled?: boolean;
}

// 单行能容下的路径字符数（560px 弹窗里卡片文字宽约 178px ≈ 30 个 ASCII 字符）：
// 超出走尾部优先的中段省略，完整路径始终留在 title 里，CSS ellipsis 只做兜底。
const ENGINE_PATH_BUDGET = 30;
const CWD_PATH_BUDGET = 56;

// 中日韩等全宽字符宽度翻倍，同样像素预算下只能放一半字符。
const pathBudget = (value: string) =>
	/[^\x00-\x7f]/.test(value) ? Math.round(ENGINE_PATH_BUDGET / 2) : ENGINE_PATH_BUDGET;

interface EngineDetail {
	text: string;
	full?: string;
}

export function NativeCliCreateModal(props: NativeCliCreateModalProps) {
	return <NativeCliCreateForm key={props.cwd ?? ""} {...props} />;
}

function NativeCliCreateForm({ cwd, onClose, onCreate, disabled = false }: NativeCliCreateModalProps) {
	const t = useT();
	const formId = useId();
	const [configuredPreset, setConfiguredPreset] = useState<NativeCliConfig["preset"] | null>(null);
	const [executable, setExecutable] = useState("");
	const [argumentsByPreset, setArgumentsByPreset] = useState<Record<string, string>>({});
	const remote = isNativeCliRemoteCwd(cwd ?? "");
	const remoteLocation = remote ? parseRemoteWorkspaceUri(cwd ?? "") : null;
	const [discovery, setDiscovery] = useState<NativeCliDiscoveryResult | null>(null);
	const [discoveryError, setDiscoveryError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [keepAlive, setKeepAlive] = useState(false);
	const persistenceAvailable = remote && discovery?.persistence?.available === true;
	const withPersistence = (config: NativeCliConfig): NativeCliConfig =>
		keepAlive && persistenceAvailable ? { ...config, keepAlive: true } : config;
	const discoveryController = useRef<AbortController | null>(null);
	const detecting = Boolean(cwd) && !discovery && discoveryError === null;
	// Probe the same endpoint for local and SSH workspaces so missing CLIs are reported before a launch fails.
	useEffect(() => {
		if (!cwd) return;
		const controller = new AbortController();
		discoveryController.current = controller;
		void (async () => {
			try {
				const response = await fetch(appUrl(`/api/native-cli/discovery?cwd=${encodeURIComponent(cwd)}`), {
					signal: controller.signal,
				});
				const result = await response.json();
				if (controller.signal.aborted) return;
				if (!response.ok) throw new Error(result.error || "");
				if (result.cwd !== cwd || result.target !== (remote ? "ssh" : "local") || !Array.isArray(result.clis)) {
					throw new Error();
				}
				setDiscovery(result);
			} catch (error) {
				if (!controller.signal.aborted) {
					setDiscoveryError(error instanceof Error ? error.message : "");
				}
			}
		})();
		return () => controller.abort();
	}, [cwd, remote, attempt]);
	const close = () => {
		discoveryController.current?.abort();
		onClose();
	};
	const detected = (preset: NativeCliConfig["preset"]) =>
		preset === "custom" ? undefined : discovery?.clis.find((cli) => cli.preset === preset);
	// SSH presets stay unavailable until detection confirms them; a failed local probe must never block creation.
	const presetUnavailable = (preset: NativeCliConfig["preset"]) => {
		if (disabled || preset === "custom") return disabled;
		const cli = detected(preset);
		return remote ? !cli?.available : cli?.available === false;
	};
	const engineDetail = (engine: (typeof engines)[number]): EngineDetail => {
		const cli = detected(engine.id);
		const command = engine.cliCommand ?? engine.name;
		if (cli?.available) {
			const full = cli.executable ?? command;
			return { text: shortenPath(full, pathBudget(full)), full };
		}
		if (remote) {
			return { text: cli?.error ?? (detecting ? t("nativeCliRemoteDetecting") : t("nativeCliRemoteUnavailable")) };
		}
		if (cli) return { text: t("nativeCliNotInstalled") };
		if (detecting) return { text: t("nativeCliDetecting") };
		return { text: engine.cliRequiresArgs ? t("nativeCliConfigureArgs") : command };
	};
	const installEngine = (name: string, command: string) => {
		window.dispatchEvent(
			new CustomEvent("pi-web-ui:plugin-run-command", {
				detail: { title: t("installEngineTabTitle", { name }), command },
			}),
		);
		close();
	};
	const engines = Object.values(ENGINE_CATALOG).filter((engine) => engine.cliCommand);
	const preferred = ["claude", "codex", "pi"];
	engines.sort((a, b) => {
		const rank = (id: string) => (preferred.includes(id) ? preferred.indexOf(id) : preferred.length);
		return rank(a.id) - rank(b.id);
	});
	const argumentText = configuredPreset ? (argumentsByPreset[configuredPreset] ?? "") : "";
	const args = nativeCliArgumentLines(argumentText);
	const requiresArgs =
		configuredPreset !== null && configuredPreset !== "custom" && ENGINE_CATALOG[configuredPreset].cliRequiresArgs;
	const canCreate =
		configuredPreset !== null &&
		!presetUnavailable(configuredPreset) &&
		(configuredPreset !== "custom" || Boolean(executable.trim())) &&
		(!requiresArgs || Boolean(args[0]?.trim()));

	const installMethod = (engine: (typeof engines)[number]): "terminal" | "docs" | null => {
		const command = engine.installCommand;
		if (!command) return null;
		return /^https?:\/\//i.test(command) ? "docs" : "terminal";
	};

	const select = (preset: NativeCliConfig["preset"]) => {
		if (presetUnavailable(preset)) return;
		if (preset === "custom" || ENGINE_CATALOG[preset].cliRequiresArgs) {
			setConfiguredPreset(preset);
			return;
		}
		onCreate(withPersistence({ preset }));
	};

	return (
		<Modal
			title={t("nativeCliCreate")}
			icon={<FiTerminal size={18} />}
			onClose={close}
			className="native-cli-create-modal"
			closeOnBackdropClick={!disabled}
			closeOnEscape={!disabled}
			showCloseButton={!disabled}
		>
			<div className="native-cli-create-body" aria-busy={disabled || detecting}>
				<p className="native-cli-create-hint">{t("nativeCliChooseEngine")}</p>
				{cwd && (
					<div className="native-cli-create-cwd" title={cwd}>
						{remoteLocation ? (
							<>
								<div>
									{t("nativeCliRemoteLocation", {
										host: `${remoteLocation.username}@${remoteLocation.host}:${remoteLocation.port}`,
									})}
								</div>
								<div>{t("nativeCliRemotePath", { path: shortenPath(remoteLocation.remotePath, CWD_PATH_BUDGET) })}</div>
							</>
						) : (
							shortenPath(cwd, CWD_PATH_BUDGET)
						)}
					</div>
				)}
				{detecting && (
					<p className="native-cli-create-hint" role="status">
						{t(remote ? "nativeCliRemoteDetecting" : "nativeCliDetecting")}
					</p>
				)}
				{discoveryError !== null && (
					<div role="alert" className="native-cli-create-hint">
						<p>{discoveryError || t(remote ? "nativeCliRemoteDiscoveryFailed" : "nativeCliDiscoveryFailed")}</p>
						{remote && <p>{t("nativeCliRemoteConnectHint")}</p>}
					</div>
				)}
				{cwd && (
					<div>
						<button
							type="button"
							className="btn"
							disabled={disabled || detecting}
							onClick={() => {
								discoveryController.current?.abort();
								setDiscovery(null);
								setKeepAlive(false);
								setDiscoveryError(null);
								setAttempt((current) => current + 1);
							}}
						>
							{t("nativeCliRemoteRetry")}
						</button>
					</div>
				)}
				{remote && (
					<div className="native-cli-persistence">
						<label>
							<input
								type="checkbox"
								checked={keepAlive && persistenceAvailable}
								disabled={disabled || !persistenceAvailable}
								onChange={(event) => setKeepAlive(event.target.checked)}
								aria-describedby={`${formId}-persistence-hint`}
							/>
							{t("nativeCliSession.keepAlive")}
						</label>
						<p id={`${formId}-persistence-hint`} className="native-cli-create-hint">
							{persistenceAvailable
								? t("nativeCliSession.keepAliveHint")
								: discovery?.persistence?.error || t("nativeCliSession.persistenceUnavailable")}
						</p>
					</div>
				)}
				<div className="native-cli-create-options">
					{engines.map((engine) => {
						const detectedCli = detected(engine.id);
						const detail = engineDetail(engine);
						const installer = !remote && detectedCli?.available === false ? installMethod(engine) : null;
						const installCommand = engine.installCommand ?? "";
						return (
							<div key={engine.id} className="native-cli-create-item">
								<button
									type="button"
									className="native-cli-create-option"
									disabled={presetUnavailable(engine.id)}
									aria-expanded={engine.cliRequiresArgs ? configuredPreset === engine.id : undefined}
									aria-controls={engine.cliRequiresArgs ? `${formId}-config` : undefined}
									onClick={() => select(engine.id)}
								>
									<FiTerminal size={18} />
									<span>
										<strong>{engine.name}</strong>
										<small className={detail.full ? "native-cli-create-path" : undefined} title={detail.full}>
											{detail.text}
										</small>
									</span>
									<FiChevronRight size={16} />
								</button>
								{installer === "terminal" && (
									<button
										type="button"
										className="native-cli-create-install"
										disabled={disabled}
										title={installCommand}
										onClick={() => installEngine(engine.name, installCommand)}
									>
										<FiDownload size={13} />
										{t("nativeCliInstall")}
									</button>
								)}
								{installer === "docs" && (
									<a className="native-cli-create-install" href={installCommand} target="_blank" rel="noreferrer">
										<FiDownload size={13} />
										{t("nativeCliInstallDocs")}
									</a>
								)}
							</div>
						);
					})}
					<div className="native-cli-create-item">
						<button
							type="button"
							className="native-cli-create-option"
							disabled={disabled}
							aria-expanded={configuredPreset === "custom"}
							aria-controls={`${formId}-config`}
							onClick={() => select("custom")}
						>
							<FiTerminal size={18} />
							<span>
								<strong>{t("nativeCliCustom")}</strong>
								<small>{t("nativeCliExecutable")}</small>
							</span>
							<FiChevronRight size={16} />
						</button>
					</div>
				</div>
				{configuredPreset && (
					<form
						id={`${formId}-config`}
						className="native-cli-create-config"
						onSubmit={(event) => {
							event.preventDefault();
							if (!canCreate) return;
							onCreate(
								withPersistence(
									configuredPreset === "custom"
										? { preset: "custom", executable: executable.trim(), args }
										: { preset: configuredPreset, args },
								),
							);
						}}
					>
						<strong>
							{configuredPreset === "custom" ? t("nativeCliCustom") : ENGINE_CATALOG[configuredPreset].name}
						</strong>
						{configuredPreset === "custom" && (
							<label htmlFor={`${formId}-executable`}>
								{remote ? t("nativeCliRemoteExecutable") : t("nativeCliExecutable")}
								<input
									id={`${formId}-executable`}
									value={executable}
									onChange={(event) => setExecutable(event.target.value)}
									disabled={disabled}
									required
									autoFocus
									autoComplete="off"
								/>
							</label>
						)}
						{remote && configuredPreset === "custom" && (
							<p className="native-cli-create-hint">{t("nativeCliRemoteExecutableHint")}</p>
						)}
						<label htmlFor={`${formId}-args`}>
							{t("nativeCliArgs")}
							<textarea
								id={`${formId}-args`}
								value={argumentText}
								onChange={(event) =>
									setArgumentsByPreset((current) => ({ ...current, [configuredPreset]: event.target.value }))
								}
								disabled={disabled}
								rows={4}
								required={Boolean(requiresArgs)}
								aria-describedby={`${formId}-args-hint`}
							/>
						</label>
						<p id={`${formId}-args-hint`} className="native-cli-create-hint">
							{t("nativeCliArgsHint")}
						</p>
						<div className="native-cli-create-actions">
							<button type="submit" className="btn primary" disabled={!canCreate}>
								{t("nativeCliStart")}
							</button>
						</div>
					</form>
				)}
			</div>
		</Modal>
	);
}

export function NativeCliCreateEntry({
	children,
	cwd,
	onCreateCli,
}: {
	children?: ReactNode;
	cwd?: string;
	onCreateCli?: (cwd?: string) => void;
}) {
	const t = useT();
	const tabs = useAppField("tabs");
	const available = Boolean(onCreateCli) && (!tabs || tabs.includes("terminal"));
	const entryRef = useRef<HTMLSpanElement>(null);
	const cliRef = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		const entry = entryRef.current;
		const trigger = entry?.querySelector<HTMLButtonElement>(":scope > button");
		if (!entry || !trigger) return;
		const measure = () => {
			const height = trigger.getBoundingClientRect().height;
			if (height > 0) entry.style.setProperty("--native-cli-action-width", `${height}px`);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(trigger);
		return () => observer.disconnect();
	}, [available]);
	if (!available || !onCreateCli) return children;
	const trigger = isValidElement<{ title?: string; "aria-label"?: string }>(children)
		? cloneElement(children, {
				title: children.props.title ?? t("newChat"),
				"aria-label": children.props["aria-label"] ?? t("newChat"),
			})
		: children;
	return (
		<span
			ref={entryRef}
			className="native-cli-create-entry"
			role="group"
			aria-label={t("newChat")}
			data-cli-expanded={open || undefined}
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
			onFocus={() => setOpen(true)}
			onBlur={(event) => {
				if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOpen(false);
			}}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft" && open) {
					event.preventDefault();
					cliRef.current?.focus();
				} else if (event.key === "ArrowRight" || event.key === "Escape") {
					event.preventDefault();
					entryRef.current?.querySelector<HTMLButtonElement>(":scope > button")?.focus();
					if (event.key === "Escape") setOpen(false);
				}
			}}
		>
			{trigger}
			<span className="native-cli-create-hover" aria-hidden={!open} inert={!open}>
				<button
					ref={cliRef}
					type="button"
					className="native-cli-create-hover-button"
					title={t("nativeCliCreate")}
					aria-label={t("nativeCliCreate")}
					tabIndex={open ? 0 : -1}
					onClick={(event) => {
						event.stopPropagation();
						setOpen(false);
						onCreateCli(cwd);
					}}
				>
					<FiTerminal size={12} />
				</button>
			</span>
		</span>
	);
}
