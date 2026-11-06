import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeKey } from "../shortcut-stack";
import {
	FiArrowRight,
	FiArrowUp,
	FiBookmark,
	FiCheck,
	FiFolder,
	FiFolderPlus,
	FiGlobe,
	FiHardDrive,
	FiHome,
	FiMonitor,
	FiServer,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import { isZhLocale, useLocale, useT } from "../i18n";
import { appSend, useAppField, useEngineCapabilities } from "../app-globals";
import { TipButton } from "./HintTip.js";
import {
	deleteRemoteProfile,
	formatRemoteWorkspaceUri,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	requestRemoteInstallTools,
	requestRemoteListDir,
	requestRemoteProbe,
	requestRemoteProfiles,
} from "../remote-ssh-client";
import type { RemoteSshDirItem, RemoteSshProfileSummary, RemoteSshSystemInfo, RemoteSshToolsInfo } from "../types";

export const MACHINE_ROOT = "@root";

export const browseQuery = (p: string) => (p.endsWith("/") ? p : p + "/");

export function joinProjectPath(parent: string, name: string): string {
	const trimmedName = name.trim();
	const normParent = parent.replace(/\\/g, "/");
	if (normParent.endsWith("/")) {
		return normParent + trimmedName;
	}
	if (/^[A-Za-z]:$/.test(normParent)) {
		return normParent + "/" + trimmedName;
	}
	return normParent + "/" + trimmedName;
}

export function isValidProjectName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return false;
	if (trimmed === "." || trimmed === "..") return false;
	if (trimmed.includes("/") || trimmed.includes("\\")) return false;
	return true;
}

export const parentOf = (p: string): string | null => {
	const s = p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
	if (s === MACHINE_ROOT || s === "/") return null;
	const i = s.lastIndexOf("/");
	if (i < 0) {
		return /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null;
	}
	if (i === 0) return "/";
	const parent = s.slice(0, i);
	return /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent;
};

interface DirectoryBrowserProps {
	portalContainer?: HTMLElement;
	localOnly?: boolean;
	currentCwd: string;
	pathCompletions: { name: string; path: string; type: "dir" | "file" }[];
	workspaceRoots: string[];
	onClose: () => void;
	onSelectDirectory: (path: string) => void;
	mode?: "folder" | "project";
	onCreateProject?: (path: string) => void;
	className?: string;
	backdropClassName?: string;
	role?: string;
	ariaLabel?: string;
}

export function DirectoryBrowser({
	currentCwd,
	pathCompletions,
	workspaceRoots,
	onClose,
	onSelectDirectory,
	mode = "folder",
	onCreateProject,
	className,
	backdropClassName,
	role,
	ariaLabel,
	localOnly = false,
	portalContainer,
}: DirectoryBrowserProps) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const capabilities = useEngineCapabilities();
	const supportsRemoteSsh = capabilities.remoteSsh && !localOnly;
	const homeDir = useAppField("homeDir");
	const desktopDir = useAppField("desktopDir");

	const [activeTab, setActiveTab] = useState<"local" | "remote">(() =>
		supportsRemoteSsh && isRemoteWorkspaceUri(currentCwd) ? "remote" : "local",
	);

	useEffect(() => {
		if (!supportsRemoteSsh && activeTab === "remote") {
			setActiveTab("local");
		}
	}, [supportsRemoteSsh, activeTab]);

	const [browsePath, setBrowsePath] = useState("");
	const [draft, setDraft] = useState("");
	const [showNew, setShowNew] = useState(false);
	const [newName, setNewName] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [compIndex, setCompIndex] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const newInputRef = useRef<HTMLInputElement>(null);

	const [profiles, setProfiles] = useState<RemoteSshProfileSummary[]>([]);
	const [sshHost, setSshHost] = useState("");
	const [sshPort, setSshPort] = useState("22");
	const [sshUser, setSshUser] = useState("");
	const [sshAuthType, setSshAuthType] = useState<"password" | "key" | "agent">("password");
	const [sshPassword, setSshPassword] = useState("");
	const [sshKeyPath, setSshKeyPath] = useState("~/.ssh/id_rsa");
	const [sshSaveProfile, setSshSaveProfile] = useState(true);
	const [sshProfileName, setSshProfileName] = useState("");

	const [connecting, setConnecting] = useState(false);
	const [sshError, setSshError] = useState<string | null>(null);
	const [connectionId, setConnectionId] = useState<string | null>(null);
	const [remoteSystem, setRemoteSystem] = useState<RemoteSshSystemInfo | null>(null);
	const [remoteTools, setRemoteTools] = useState<RemoteSshToolsInfo | null>(null);
	const [suggestedTools, setSuggestedTools] = useState<string[]>([]);
	const [installingTool, setInstallingTool] = useState(false);

	const [remoteCwd, setRemoteCwd] = useState("/");
	const [remoteDraft, setRemoteDraft] = useState("/");
	const [remoteItems, setRemoteItems] = useState<RemoteSshDirItem[]>([]);
	const [loadingRemoteDir, setLoadingRemoteDir] = useState(false);
	const [showRemoteNew, setShowRemoteNew] = useState(false);
	const [remoteNewName, setRemoteNewName] = useState("");
	const [remoteCreateError, setRemoteCreateError] = useState<string | null>(null);

	const dirs = pathCompletions.filter((c) => c.type === "dir");

	useEffect(() => {
		if (isRemoteWorkspaceUri(currentCwd)) {
			const parsed = parseRemoteWorkspaceUri(currentCwd);
			if (parsed) {
				setSshHost(parsed.host);
				setSshPort(String(parsed.port));
				setSshUser(parsed.username);
				setRemoteCwd(parsed.remotePath);
				setRemoteDraft(parsed.remotePath);
			}
		} else {
			const norm = (currentCwd || "").replace(/\\/g, "/");
			setBrowsePath(norm);
			setDraft(norm);
		}
		setShowNew(false);
		setNewName("");
		setLocalError(null);
		setCompIndex(-1);
	}, [currentCwd]);

	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			inputRef.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [activeTab]);

	useEscapeKey(() => {
		if (showNew || showRemoteNew) {
			setShowNew(false);
			setNewName("");
			setLocalError(null);
			setShowRemoteNew(false);
			setRemoteNewName("");
			setRemoteCreateError(null);
		} else {
			onClose();
		}
	});

	useEffect(() => {
		if (activeTab !== "local") return;
		const timer = setTimeout(() => {
			appSend({ type: "complete_path", path: browseQuery(browsePath) });
		}, 60);
		return () => clearTimeout(timer);
	}, [browsePath, activeTab]);

	useEffect(() => {
		if (activeTab !== "local" || draft === browsePath) return;
		const timer = setTimeout(() => {
			appSend({ type: "complete_path", path: draft });
		}, 150);
		return () => clearTimeout(timer);
	}, [draft, browsePath, activeTab]);

	const commitLocal = (path: string) => {
		const trimmed = path.trim();
		if (!trimmed || trimmed === MACHINE_ROOT) return;
		onSelectDirectory(trimmed);
	};

	const goQuickJump = (target: string) => {
		setBrowsePath(target);
		setDraft(target);
		setCompIndex(-1);
		setLocalError(null);
	};

	const handleCreateLocal = () => {
		const trimmed = newName.trim();
		if (!trimmed || browsePath === MACHINE_ROOT) return;

		if (mode === "project") {
			if (!isValidProjectName(trimmed)) {
				setLocalError(t("invalidProjectName"));
				return;
			}
			const fullPath = joinProjectPath(browsePath, trimmed);
			if (onCreateProject) {
				onCreateProject(fullPath);
			} else {
				appSend({ type: "make_dir", path: fullPath });
				onSelectDirectory(fullPath);
			}
			setShowNew(false);
			setNewName("");
			setLocalError(null);
			onClose();
		} else {
			appSend({ type: "make_dir", path: `${browseQuery(browsePath)}${trimmed}` });
			setTimeout(() => {
				appSend({ type: "complete_path", path: browseQuery(browsePath) });
			}, 80);
			setNewName("");
			setShowNew(false);
		}
	};

	const onLocalKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			if (showNew) {
				setShowNew(false);
				setNewName("");
				setLocalError(null);
			} else {
				onClose();
			}
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			commitLocal(draft);
		} else if (e.key === "Tab") {
			if (dirs.length === 0) return;
			e.preventDefault();
			const idx = compIndex >= 0 ? (compIndex + 1) % dirs.length : 0;
			setCompIndex(idx);
			setDraft(dirs[idx].path);
			setBrowsePath(dirs[idx].path);
		}
	};

	const handleConnectAndProbe = async (overrideParams?: {
		host: string;
		port: number;
		username: string;
		auth: any;
		profileName?: string;
	}) => {
		const host = (overrideParams?.host ?? sshHost).trim();
		const port = overrideParams?.port ?? (parseInt(sshPort, 10) || 22);
		const user = (overrideParams?.username ?? sshUser).trim();

		if (!host || !user) {
			setSshError(isZh ? "请填写主机地址和用户名" : "Please provide host address and username");
			return;
		}

		setConnecting(true);
		setSshError(null);

		const auth =
			overrideParams?.auth ??
			(sshAuthType === "password"
				? { type: "password" as const, password: sshPassword }
				: sshAuthType === "key"
					? { type: "key" as const, privateKeyPath: sshKeyPath }
					: { type: "agent" as const });

		const res = await requestRemoteProbe({
			host,
			port,
			username: user,
			auth,
			saveProfile: sshSaveProfile,
			profileName: overrideParams?.profileName || sshProfileName.trim() || undefined,
		});

		setConnecting(false);

		if (!res.ok || !res.connectionId) {
			setSshError(res.error || (isZh ? "连接远程服务器失败" : "Failed to connect to remote server"));
			return;
		}

		setConnectionId(res.connectionId);
		setRemoteSystem(res.system ?? null);
		setRemoteTools(res.tools ?? null);
		setSuggestedTools(res.suggestedInstall ?? []);

		const parsedRemotePath = isRemoteWorkspaceUri(currentCwd) ? parseRemoteWorkspaceUri(currentCwd)?.remotePath : null;
		const targetDir = parsedRemotePath && parsedRemotePath !== "/" ? parsedRemotePath : res.system?.homeDir || "/";
		setRemoteCwd(targetDir);
		setRemoteDraft(targetDir);
		void loadRemoteDir(res.connectionId, targetDir);

		void requestRemoteProfiles().then((p) => setProfiles(p));
	};

	const autoConnectedRef = useRef(false);
	useEffect(() => {
		if (activeTab === "remote") {
			void requestRemoteProfiles().then((p) => {
				setProfiles(p);
				if (!autoConnectedRef.current && !connectionId && !connecting && isRemoteWorkspaceUri(currentCwd)) {
					const parsed = parseRemoteWorkspaceUri(currentCwd);
					if (parsed) {
						const matched =
							p.find(
								(item) =>
									item.host === parsed.host &&
									(item.username === parsed.username || !parsed.username) &&
									(item.port === parsed.port || (!parsed.port && item.port === 22)),
							) ||
							p.find((item) => item.host === parsed.host && item.username === parsed.username) ||
							p.find((item) => item.host === parsed.host);
						if (matched) {
							autoConnectedRef.current = true;
							setSshHost(matched.host);
							setSshPort(String(matched.port));
							setSshUser(matched.username);
							setSshAuthType(matched.authType);
							if (matched.privateKeyPath) setSshKeyPath(matched.privateKeyPath);
							void handleConnectAndProbe({
								host: matched.host,
								port: matched.port,
								username: matched.username,
								profileName: matched.name,
								auth:
									matched.authType === "password"
										? { type: "password", password: "" }
										: matched.authType === "key"
											? { type: "key", privateKeyPath: matched.privateKeyPath }
											: { type: "agent" },
							});
						}
					}
				}
			});
		}
	}, [activeTab, currentCwd, connectionId, connecting]);

	const loadRemoteDir = async (connId: string, dirPath: string) => {
		setLoadingRemoteDir(true);
		setSshError(null);
		const res = await requestRemoteListDir(connId, dirPath);
		setLoadingRemoteDir(false);

		if (res.ok) {
			setRemoteCwd(res.path);
			setRemoteDraft(res.path);
			setRemoteItems(res.items);
		} else {
			setSshError(res.error || (isZh ? "读取远程目录失败" : "Failed to read remote directory"));
		}
	};

	const handleInstallTool = async (tool: string) => {
		if (!connectionId) return;
		setInstallingTool(true);
		setSshError(null);

		const res = await requestRemoteInstallTools(connectionId, [tool]);
		setInstallingTool(false);

		if (res.ok) {
			setSuggestedTools((prev) => prev.filter((t) => t !== tool));
			if (remoteTools && tool === "git") {
				setRemoteTools({ ...remoteTools, git: { installed: true, version: isZh ? "已安装" : "Installed" } });
			}
		} else {
			setSshError(
				res.error ||
					(isZh
						? `安装 ${tool} 失败，可能需要远端 sudo 权限`
						: `Failed to install ${tool}, remote sudo permissions may be required`),
			);
		}
	};

	const commitRemote = (targetPath: string) => {
		const port = parseInt(sshPort, 10) || 22;
		const homeDir = remoteSystem?.homeDir || "/";
		let resolved = (targetPath || "").trim() || remoteCwd || "/";
		if (resolved === "~") {
			resolved = homeDir;
		} else if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
			resolved = `${homeDir.replace(/\/+$/, "")}/${resolved.slice(2).replace(/\\/g, "/")}`;
		}
		const uri = formatRemoteWorkspaceUri(sshUser, sshHost, port, resolved);
		onSelectDirectory(uri);
		onClose();
	};

	const handleCreateRemote = () => {
		const trimmed = remoteNewName.trim();
		if (!trimmed || !connectionId) return;
		if (!isValidProjectName(trimmed)) {
			setRemoteCreateError(t("invalidProjectName"));
			return;
		}
		const port = parseInt(sshPort, 10) || 22;
		const base = remoteCwd.replace(/\/+$/, "") || "/";
		const abs = base === "/" ? `/${trimmed}` : `${base}/${trimmed}`;
		const uri = formatRemoteWorkspaceUri(sshUser, sshHost, port, abs);
		if (mode === "project") {
			if (onCreateProject) {
				onCreateProject(uri);
			} else {
				appSend({ type: "make_dir", path: uri });
				onSelectDirectory(uri);
			}
			setShowRemoteNew(false);
			setRemoteNewName("");
			setRemoteCreateError(null);
			onClose();
		} else {
			appSend({ type: "make_dir", path: uri });
			setRemoteNewName("");
			setShowRemoteNew(false);
			setRemoteCreateError(null);
			const conn = connectionId;
			const dir = remoteCwd;
			setTimeout(() => {
				void loadRemoteDir(conn, dir);
			}, 300);
		}
	};

	const upPath = parentOf(browsePath);
	const remoteUpPath = parentOf(remoteCwd);
	const norm = (p: string) => {
		const f = p.replace(/\\/g, "/").replace(/\/+$/, "");
		return /^[A-Za-z]:/.test(f) ? f.toLowerCase() : f;
	};
	const cur = norm(browsePath);
	const canAddRoot =
		Boolean(browsePath) &&
		browsePath !== MACHINE_ROOT &&
		cur !== norm(currentCwd) &&
		!workspaceRoots.some((r) => norm(r) === cur);

	return createPortal(
		<>
			<div
				className={`status-cwd-backdrop ${backdropClassName ?? ""}`.trim()}
				onClick={onClose}
				onPointerDown={(e) => e.stopPropagation()}
				onMouseDown={(e) => e.stopPropagation()}
			/>
			<div
				className={`cwd-picker ${className ?? ""}`.trim()}
				role={role}
				aria-label={ariaLabel}
				onPointerDown={(e) => e.stopPropagation()}
				onMouseDown={(e) => e.stopPropagation()}
				onWheel={(e) => e.stopPropagation()}
			>
				{supportsRemoteSsh ? (
					<div className="cwd-mode-tabs">
						<button
							type="button"
							className={`cwd-mode-tab ${activeTab === "local" ? "active" : ""}`}
							onClick={() => setActiveTab("local")}
						>
							💻 {t("workspaceModeLocal")}
						</button>
						<button
							type="button"
							className={`cwd-mode-tab ${activeTab === "remote" ? "active" : ""}`}
							onClick={() => setActiveTab("remote")}
						>
							🌐 {t("workspaceModeRemote")}
						</button>
						<button type="button" className="cwd-close" title={t("close")} aria-label={t("close")} onClick={onClose}>
							<FiX />
						</button>
					</div>
				) : (
					<div className="cwd-mode-tabs cwd-mode-tabs-single">
						<div className="cwd-mode-tab active" style={{ cursor: "default" }}>
							💻 {t("workspaceModeLocal")}
						</div>
						<button type="button" className="cwd-close" title={t("close")} aria-label={t("close")} onClick={onClose}>
							<FiX />
						</button>
					</div>
				)}

				{activeTab === "local" && (
					<>
						<div className="cwd-picker-head">
							<span className="cwd-picker-title" title={browsePath === MACHINE_ROOT ? t("computer") : browsePath}>
								{browsePath === MACHINE_ROOT ? <FiHardDrive /> : <FiFolder />}
								<span>{browsePath === MACHINE_ROOT ? t("computer") : browsePath}</span>
							</span>
						</div>
						<div className="cwd-toolbar" role="toolbar" aria-label={t("projectPickerTitle")}>
							<TipButton
								className={`cwd-jump ${browsePath === MACHINE_ROOT ? "active" : ""}`}
								tip={t("computer")}
								onClick={() => goQuickJump(MACHINE_ROOT)}
							>
								<FiHardDrive />
							</TipButton>
							{homeDir !== "" && (
								<TipButton
									className={`cwd-jump ${norm(browsePath) === norm(homeDir) ? "active" : ""}`}
									tip={`${t("homeDir")} ${homeDir}`}
									onClick={() => goQuickJump(homeDir)}
								>
									<FiHome />
								</TipButton>
							)}
							{desktopDir !== "" && (
								<TipButton
									className={`cwd-jump ${norm(browsePath) === norm(desktopDir) ? "active" : ""}`}
									tip={`${t("desktopDir")} ${desktopDir}`}
									onClick={() => goQuickJump(desktopDir)}
								>
									<FiMonitor />
								</TipButton>
							)}
							<span className="cwd-toolbar-sep" aria-hidden="true" />
							<TipButton
								className="cwd-jump tool-up"
								tip={
									upPath ? `${t("cwdGoUp")} · ${upPath}` : `${t("cwdGoUp")} · ${isZh ? "已在顶层" : "already at top"}`
								}
								aria-disabled={!upPath}
								onClick={() => {
									if (upPath) goQuickJump(upPath);
								}}
							>
								<FiArrowUp />
							</TipButton>
							<TipButton
								className="cwd-jump tool-root"
								tip={
									canAddRoot
										? t("addWorkspaceRootHint")
										: browsePath === MACHINE_ROOT
											? `${t("addWorkspaceRoot")} · ${isZh ? "此电脑本身不是目录" : "This PC is not a directory"}`
											: cur === norm(currentCwd)
												? `${t("addWorkspaceRoot")} · ${isZh ? "已是当前项目目录" : "Already the current project"}`
												: `${t("addWorkspaceRoot")} · ${isZh ? "已在工作区根中" : "Already a workspace root"}`
								}
								aria-disabled={!canAddRoot}
								onClick={() => {
									if (!canAddRoot) return;
									appSend({ type: "set_workspace_roots", roots: [...workspaceRoots, browsePath] });
								}}
							>
								<FiBookmark />
							</TipButton>
							<TipButton
								className={`cwd-jump tool-new ${showNew ? "active" : ""}`}
								tip={
									browsePath === MACHINE_ROOT
										? `${t("cwdNewFolder")} · ${isZh ? "此电脑下不能新建" : "Cannot create here"}`
										: showNew
											? t("cwdCancel")
											: t("cwdNewFolder")
								}
								aria-disabled={browsePath === MACHINE_ROOT}
								onClick={() => {
									if (browsePath === MACHINE_ROOT) return;
									if (showNew) {
										setShowNew(false);
										setNewName("");
										setLocalError(null);
									} else {
										setNewName("");
										setLocalError(null);
										setShowNew(true);
									}
								}}
							>
								<FiFolderPlus />
							</TipButton>
							<span className="cwd-toolbar-spacer" />
							<TipButton
								className="cwd-jump primary tool-pick"
								tip={
									browsePath === MACHINE_ROOT
										? `${t("cwdPickCurrent")} · ${isZh ? "此电脑不能作为工作目录" : "This PC cannot be a workspace"}`
										: `${t("cwdPickCurrent")} · ${browsePath}`
								}
								aria-disabled={browsePath === MACHINE_ROOT}
								onClick={() => commitLocal(browsePath)}
							>
								<FiCheck />
							</TipButton>
						</div>
						<div className="cwd-picker-row">
							<input
								ref={inputRef}
								className="status-cwd-input cwd-picker-input"
								value={draft}
								placeholder={t("enterPath")}
								spellCheck={false}
								onChange={(e) => {
									setDraft(e.target.value);
									setCompIndex(-1);
								}}
								onKeyDown={onLocalKeyDown}
							/>
							{draft.trim() !== "" && draft !== browsePath && (
								<TipButton
									className="cwd-jump tool-enter"
									tip={`${t("cwdEnter")} · ${draft.trim()}`}
									onClick={() => {
										setBrowsePath(draft.trim());
										setCompIndex(-1);
									}}
								>
									<FiArrowRight />
								</TipButton>
							)}
						</div>
						<div className="cwd-list">
							{upPath && (
								<div key=".." className="cwd-item">
									<button
										type="button"
										className="cwd-enter"
										title={`${t("cwdGoUp")} · ${upPath}`}
										onClick={() => goQuickJump(upPath)}
									>
										<FiFolder />
										<span className="cwd-name">..</span>
									</button>
								</div>
							)}
							{dirs.length === 0 && !upPath && <div className="cwd-empty">{t("cwdEmpty")}</div>}
							{dirs.map((d) => (
								<div key={d.path} className="cwd-item">
									<button
										type="button"
										className="cwd-enter"
										title={`${t("cwdEnter")} ${d.path}`}
										onClick={() => {
											setBrowsePath(d.path);
											setDraft(d.path);
											setCompIndex(-1);
										}}
									>
										<FiFolder />
										<span className="cwd-name">{d.name}</span>
									</button>
									<TipButton
										className="cwd-jump tool-choose"
										tip={`${t("cwdChoose")} · ${d.path}`}
										onClick={() => commitLocal(d.path)}
									>
										<FiCheck />
									</TipButton>
								</div>
							))}
						</div>
						{showNew && (
							<div className="cwd-picker-foot">
								<div className="cwd-newrow">
									<input
										ref={newInputRef}
										value={newName}
										autoFocus
										spellCheck={false}
										placeholder={t("cwdNewName")}
										onChange={(e) => {
											setNewName(e.target.value);
											if (localError) setLocalError(null);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter" && !e.nativeEvent.isComposing) {
												e.preventDefault();
												handleCreateLocal();
											} else if (e.key === "Escape") {
												e.stopPropagation();
												setShowNew(false);
												setNewName("");
												setLocalError(null);
											}
										}}
									/>
									<TipButton className="cwd-jump primary" tip={t("cwdCreate")} onClick={handleCreateLocal}>
										<FiCheck />
									</TipButton>
									<TipButton
										className="cwd-jump"
										tip={t("cwdCancel")}
										onClick={() => {
											setShowNew(false);
											setNewName("");
											setLocalError(null);
										}}
									>
										<FiX />
									</TipButton>
								</div>
								{localError && (
									<div
										className="project-picker-error"
										style={{ color: "var(--red)", fontSize: "11px", marginTop: "4px" }}
									>
										{localError}
									</div>
								)}
							</div>
						)}
					</>
				)}

				{activeTab === "remote" && (
					<div className="cwd-ssh-container">
						{!connectionId ? (
							<div className="cwd-ssh-form">
								{profiles.length > 0 && (
									<>
										<div className="cwd-ssh-profiles-title">📋 {t("sshSavedProfiles")}</div>
										{profiles.map((p) => (
											<div
												key={p.name}
												className="cwd-ssh-profile-card"
												onClick={() => {
													setSshHost(p.host);
													setSshPort(String(p.port));
													setSshUser(p.username);
													setSshAuthType(p.authType);
													if (p.privateKeyPath) setSshKeyPath(p.privateKeyPath);
													void handleConnectAndProbe({
														host: p.host,
														port: p.port,
														username: p.username,
														profileName: p.name,
														auth:
															p.authType === "password"
																? { type: "password", password: "" }
																: p.authType === "key"
																	? { type: "key", privateKeyPath: p.privateKeyPath }
																	: { type: "agent" },
													});
												}}
											>
												<div className="cwd-ssh-profile-meta">
													<span className="cwd-ssh-profile-name">
														<FiServer style={{ marginRight: "4px" }} />
														{p.name}
													</span>
													<span className="cwd-ssh-profile-addr">
														{p.username}@{p.host}:{p.port}
													</span>
												</div>
												<button
													type="button"
													className="cwd-ssh-profile-del"
													title={t("delete")}
													onClick={(e) => {
														e.stopPropagation();
														if (confirm(t("sshDeleteProfileConfirm"))) {
															deleteRemoteProfile(p.name);
															setProfiles((prev) => prev.filter((item) => item.name !== p.name));
														}
													}}
												>
													<FiTrash2 />
												</button>
											</div>
										))}
									</>
								)}

								<div className="cwd-ssh-row" style={{ marginTop: "4px" }}>
									<label>{t("sshHost")}:</label>
									<input
										className="cwd-ssh-input"
										value={sshHost}
										placeholder="192.168.1.100"
										onChange={(e) => setSshHost(e.target.value)}
									/>
									<label style={{ width: "32px", textAlign: "right" }}>{t("sshPort")}:</label>
									<input
										className="cwd-ssh-input"
										style={{ width: "45px", flex: "none" }}
										value={sshPort}
										onChange={(e) => setSshPort(e.target.value)}
									/>
								</div>

								<div className="cwd-ssh-row">
									<label>{t("sshUser")}:</label>
									<input
										className="cwd-ssh-input"
										value={sshUser}
										placeholder="root / ubuntu"
										onChange={(e) => setSshUser(e.target.value)}
									/>
								</div>

								<div className="cwd-ssh-row">
									<label>{t("sshAuthType")}:</label>
									<select
										className="cwd-ssh-select"
										value={sshAuthType}
										onChange={(e) => setSshAuthType(e.target.value as any)}
									>
										<option value="password">{t("sshPassword")}</option>
										<option value="key">{t("sshKeyPath")}</option>
										<option value="agent">{t("sshAgent")}</option>
									</select>
								</div>

								{sshAuthType === "password" && (
									<div className="cwd-ssh-row">
										<label>{t("sshPassword")}:</label>
										<input
											type="password"
											className="cwd-ssh-input"
											value={sshPassword}
											placeholder="••••••••"
											onChange={(e) => setSshPassword(e.target.value)}
										/>
									</div>
								)}

								{sshAuthType === "key" && (
									<div className="cwd-ssh-row">
										<label>{t("sshKeyPath")}:</label>
										<input
											className="cwd-ssh-input"
											value={sshKeyPath}
											placeholder="~/.ssh/id_rsa"
											onChange={(e) => setSshKeyPath(e.target.value)}
										/>
									</div>
								)}

								<div className="cwd-ssh-row" style={{ fontSize: "11px", color: "var(--text-dim)" }}>
									<label style={{ width: "auto" }}>
										<input
											type="checkbox"
											checked={sshSaveProfile}
											onChange={(e) => setSshSaveProfile(e.target.checked)}
											style={{ marginRight: "4px" }}
										/>
										{t("sshSaveProfile")}
									</label>
								</div>

								{sshSaveProfile && (
									<div className="cwd-ssh-row">
										<label>{t("sshProfileName")}:</label>
										<input
											className="cwd-ssh-input"
											value={sshProfileName}
											placeholder="my-server"
											onChange={(e) => setSshProfileName(e.target.value)}
										/>
									</div>
								)}

								{sshError && (
									<div style={{ color: "var(--red)", fontSize: "11px", padding: "2px 0" }}>⚠️ {sshError}</div>
								)}

								<button
									type="button"
									className="cwd-choose-btn primary"
									style={{ marginTop: "4px" }}
									disabled={connecting}
									onClick={() => void handleConnectAndProbe()}
								>
									{connecting ? t("sshConnecting") : t("sshConnectAndProbe")}
								</button>
							</div>
						) : (
							<>
								<div className="cwd-ssh-probe-box">
									<div className="cwd-ssh-probe-header">
										<span>
											🌐 {sshUser}@{sshHost} ({remoteSystem?.os} {remoteSystem?.arch})
										</span>
										<button
											type="button"
											className="cwd-ssh-profile-del"
											onClick={() => {
												setConnectionId(null);
												setRemoteSystem(null);
												setRemoteTools(null);
											}}
										>
											{t("sshDisconnect")}
										</button>
									</div>

									<div style={{ display: "flex", gap: "6px", flexWrap: "wrap", fontSize: "10px" }}>
										<span className={`cwd-ssh-tool-badge ${remoteTools?.git.installed ? "ok" : "missing"}`}>
											Git: {remoteTools?.git.installed ? "✓" : "✗"}
										</span>
										<span className={`cwd-ssh-tool-badge ${remoteTools?.node.installed ? "ok" : "missing"}`}>
											Node: {remoteTools?.node.installed ? "✓" : "✗"}
										</span>
										<span className={`cwd-ssh-tool-badge ${remoteTools?.bash.installed ? "ok" : "missing"}`}>
											Bash: {remoteTools?.bash.installed ? "✓" : "✗"}
										</span>
									</div>

									{suggestedTools.length > 0 && (
										<div className="cwd-ssh-install-box">
											<div>
												⚠️{" "}
												{isZh
													? "远端环境未检测到 Git / 基础工具，SCM 与执行功能可能受限。"
													: "Git / essential tools not detected on remote host; SCM and execution features may be limited."}
											</div>
											<div style={{ display: "flex", gap: "6px", marginTop: "2px" }}>
												<button
													type="button"
													className="cwd-choose-btn primary"
													disabled={installingTool}
													onClick={() => void handleInstallTool(suggestedTools[0])}
												>
													{installingTool ? t("sshInstalling") : `⚡ ${t("sshInstallTool")} ${suggestedTools[0]}`}
												</button>
												<button type="button" className="cwd-choose-btn" onClick={() => setSuggestedTools([])}>
													{t("sshSkipAndBrowse")}
												</button>
											</div>
										</div>
									)}
								</div>

								<div className="cwd-picker-head">
									<span className="cwd-picker-title" title={remoteCwd}>
										<FiGlobe />
										<span>{remoteCwd}</span>
									</span>
								</div>
								<div className="cwd-toolbar" role="toolbar" aria-label={t("workspaceModeRemote")}>
									<TipButton
										className="cwd-jump tool-up"
										tip={
											remoteCwd === "/"
												? `${t("cwdGoUp")} · ${isZh ? "已在顶层" : "already at top"}`
												: `${t("cwdGoUp")} · ${parentOf(remoteCwd) || "/"}`
										}
										aria-disabled={remoteCwd === "/" || loadingRemoteDir}
										onClick={() => {
											if (loadingRemoteDir) return;
											const parent = parentOf(remoteCwd);
											if (parent && connectionId) void loadRemoteDir(connectionId, parent);
										}}
									>
										<FiArrowUp />
									</TipButton>
									<TipButton
										className={`cwd-jump tool-new ${showRemoteNew ? "active" : ""}`}
										tip={showRemoteNew ? t("cwdCancel") : t("cwdNewFolder")}
										onClick={() => setShowRemoteNew((v) => !v)}
									>
										<FiFolderPlus />
									</TipButton>
									<span className="cwd-toolbar-spacer" />
								</div>

								<div className="cwd-picker-row">
									<input
										className="status-cwd-input cwd-picker-input"
										value={remoteDraft}
										placeholder={t("enterPath")}
										spellCheck={false}
										onChange={(e) => setRemoteDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && connectionId) {
												void loadRemoteDir(connectionId, remoteDraft);
											}
										}}
									/>
									{remoteDraft.trim() && remoteDraft.trim() !== remoteCwd && connectionId && (
										<TipButton
											className="cwd-jump tool-enter"
											tip={`${t("cwdEnter")} · ${remoteDraft.trim()}`}
											onClick={() => void loadRemoteDir(connectionId, remoteDraft)}
										>
											<FiArrowRight />
										</TipButton>
									)}
									<TipButton
										className="cwd-jump primary tool-pick"
										tip={`${t("sshOpenRemoteWorkspace")} · ${remoteDraft.trim() || remoteCwd}`}
										onClick={() => commitRemote(remoteDraft.trim() || remoteCwd)}
									>
										<FiCheck />
									</TipButton>
								</div>

								<div className="cwd-list">
									{!loadingRemoteDir && remoteUpPath && (
										<div key=".." className="cwd-item">
											<button
												type="button"
												className="cwd-enter"
												title={`${t("cwdGoUp")} · ${remoteUpPath}`}
												onClick={() => {
													if (connectionId) void loadRemoteDir(connectionId, remoteUpPath);
												}}
											>
												<FiFolder />
												<span className="cwd-name">..</span>
											</button>
										</div>
									)}
									{loadingRemoteDir ? (
										<div className="cwd-empty">{isZh ? "正在加载远程目录…" : "Loading remote directory…"}</div>
									) : remoteItems.length === 0 ? (
										<div className="cwd-empty">{t("cwdEmpty")}</div>
									) : (
										remoteItems.map((item) => (
											<div key={item.path} className="cwd-item">
												<button
													type="button"
													className="cwd-enter"
													title={`${item.type === "dir" ? t("cwdEnter") : ""} ${item.path}`}
													onClick={() => {
														if (item.type === "dir" && connectionId) {
															void loadRemoteDir(connectionId, item.path);
														}
													}}
												>
													{item.type === "dir" ? <FiFolder /> : <span>📄</span>}
													<span className="cwd-name">{item.name}</span>
												</button>
												{item.type === "dir" && (
													<TipButton
														className="cwd-jump tool-choose"
														tip={`${t("cwdChoose")} · ${item.path}`}
														onClick={() => commitRemote(item.path)}
													>
														<FiCheck />
													</TipButton>
												)}
											</div>
										))
									)}
								</div>
								{connectionId && showRemoteNew && (
									<div className="cwd-picker-foot">
										<div className="cwd-newrow">
											<input
												value={remoteNewName}
												autoFocus
												spellCheck={false}
												placeholder={t("cwdNewName")}
												onChange={(e) => {
													setRemoteNewName(e.target.value);
													if (remoteCreateError) setRemoteCreateError(null);
												}}
												onKeyDown={(e) => {
													if (e.key === "Enter" && !e.nativeEvent.isComposing) {
														e.preventDefault();
														handleCreateRemote();
													} else if (e.key === "Escape") {
														e.stopPropagation();
														setShowRemoteNew(false);
														setRemoteNewName("");
														setRemoteCreateError(null);
													}
												}}
											/>
											<TipButton className="cwd-jump primary" tip={t("cwdCreate")} onClick={handleCreateRemote}>
												<FiCheck />
											</TipButton>
											<TipButton
												className="cwd-jump"
												tip={t("cwdCancel")}
												onClick={() => {
													setShowRemoteNew(false);
													setRemoteNewName("");
													setRemoteCreateError(null);
												}}
											>
												<FiX />
											</TipButton>
										</div>
										{remoteCreateError && (
											<div
												className="project-picker-error"
												style={{ color: "var(--red)", fontSize: "11px", marginTop: "4px" }}
											>
												{remoteCreateError}
											</div>
										)}
									</div>
								)}
							</>
						)}
					</div>
				)}
			</div>
		</>,
		portalContainer ?? document.body,
	);
}
