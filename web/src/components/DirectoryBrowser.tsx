import { useEffect, useRef, useState } from "react";
import { FiFolder, FiGlobe, FiServer, FiTrash2, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
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

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与 server/files-service.ts 的 MACHINE_ROOT 同值。 */
export const MACHINE_ROOT = "@root";

export const browseQuery = (p: string) => (p.endsWith("/") ? p : p + "/");

/**
 * 规范拼接工作目录父路径与新建子目录名称。
 * 该函数只负责正斜杠路径连接；服务端负责解析为原生绝对路径。
 */
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

/** 校验新建项目名称：不能包含分隔符、不能为 . 或 ..、不能唯空。 */
export function isValidProjectName(name: string): boolean {
	const trimmed = name.trim();
	if (!trimmed) return false;
	if (trimmed === "." || trimmed === "..") return false;
	if (trimmed.includes("/") || trimmed.includes("\\")) return false;
	return true;
}

/** Parent of an absolute "/"-separated path; null at the filesystem root. */
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
}: DirectoryBrowserProps) {
	const t = useT();

	// 模式 Tab：本地 vs 远程 SSH
	const [activeTab, setActiveTab] = useState<"local" | "remote">(() =>
		isRemoteWorkspaceUri(currentCwd) ? "remote" : "local",
	);

	// ===== 本地文件浏览状态 =====
	const [browsePath, setBrowsePath] = useState("");
	const [draft, setDraft] = useState("");
	const [showNew, setShowNew] = useState(false);
	const [newName, setNewName] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [compIndex, setCompIndex] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const newInputRef = useRef<HTMLInputElement>(null);

	// ===== 远程 SSH 状态 =====
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

	// 远程目录树状态
	const [remoteCwd, setRemoteCwd] = useState("/");
	const [remoteDraft, setRemoteDraft] = useState("/");
	const [remoteItems, setRemoteItems] = useState<RemoteSshDirItem[]>([]);
	const [loadingRemoteDir, setLoadingRemoteDir] = useState(false);

	const dirs = pathCompletions.filter((c) => c.type === "dir");

	// 初始化本地路径
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

	// 打开远程 Tab 时拉取已保存的 profiles
	useEffect(() => {
		if (activeTab === "remote") {
			void requestRemoteProfiles().then((p) => setProfiles(p));
		}
	}, [activeTab]);

	// 打开后聚焦输入框
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			inputRef.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [activeTab]);

	// 全局 Escape 键监听
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				if (showNew) {
					setShowNew(false);
					setNewName("");
					setLocalError(null);
				} else {
					onClose();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [showNew, onClose]);

	// 本地目录浏览请求（60ms 防抖）
	useEffect(() => {
		if (activeTab !== "local") return;
		const timer = setTimeout(() => {
			appSend({ type: "complete_path", path: browseQuery(browsePath) });
		}, 60);
		return () => clearTimeout(timer);
	}, [browsePath, activeTab]);

	// 本地自由路径打字补全（150ms 防抖）
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

	const handleCreateLocal = () => {
		const trimmed = newName.trim();
		if (!trimmed) return;

		if (mode === "project") {
			if (!isValidProjectName(trimmed)) {
				setLocalError(t("invalidProjectName"));
				return;
			}
			const fullPath = joinProjectPath(browsePath, trimmed);
			onCreateProject?.(fullPath);
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

	// ===== 远程 SSH 操作逻辑 =====

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
			setSshError("请填写主机地址和用户名");
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
			setSshError(res.error || "连接远程服务器失败");
			return;
		}

		setConnectionId(res.connectionId);
		setRemoteSystem(res.system ?? null);
		setRemoteTools(res.tools ?? null);
		setSuggestedTools(res.suggestedInstall ?? []);

		// 默认进入远端主目录
		const targetDir = res.system?.homeDir || "/";
		setRemoteCwd(targetDir);
		setRemoteDraft(targetDir);
		void loadRemoteDir(res.connectionId, targetDir);

		// 刷新已保存列表
		void requestRemoteProfiles().then((p) => setProfiles(p));
	};

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
			setSshError(res.error || "读取远程目录失败");
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
				setRemoteTools({ ...remoteTools, git: { installed: true, version: "已安装" } });
			}
		} else {
			setSshError(res.error || `安装 ${tool} 失败，可能需要远端 sudo 权限`);
		}
	};

	const commitRemote = (targetPath: string) => {
		const port = parseInt(sshPort, 10) || 22;
		const uri = formatRemoteWorkspaceUri(sshUser, sshHost, port, targetPath);
		onSelectDirectory(uri);
		onClose();
	};

	const upPath = parentOf(browsePath);
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

	return (
		<>
			<div className={`status-cwd-backdrop ${backdropClassName ?? ""}`.trim()} onClick={onClose} />
			<div className={`cwd-picker ${className ?? ""}`.trim()} role={role} aria-label={ariaLabel}>
				{/* 模式切换 Tab */}
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

				{/* 本地目录视图 */}
				{activeTab === "local" && (
					<>
						<div className="cwd-picker-head">
							<span className="cwd-picker-title" title={browsePath === MACHINE_ROOT ? t("computer") : browsePath}>
								{browsePath === MACHINE_ROOT ? "💻" : <FiFolder />}
								<span>{browsePath === MACHINE_ROOT ? t("computer") : browsePath}</span>
							</span>
							<button
								type="button"
								className="cwd-up"
								disabled={browsePath === MACHINE_ROOT}
								title={t("computer")}
								onClick={() => {
									setBrowsePath(MACHINE_ROOT);
									setDraft(MACHINE_ROOT);
									setCompIndex(-1);
								}}
							>
								💻
							</button>
							<button
								type="button"
								className="cwd-up"
								disabled={!upPath}
								title={t("cwdGoUp")}
								onClick={() => {
									if (upPath) {
										setBrowsePath(upPath);
										setDraft(upPath);
										setCompIndex(-1);
									}
								}}
							>
								↑ {t("cwdGoUp")}
							</button>
							<button
								type="button"
								className="cwd-up"
								disabled={!canAddRoot}
								title={t("addWorkspaceRootHint")}
								onClick={() => {
									if (!canAddRoot) return;
									appSend({ type: "set_workspace_roots", roots: [...workspaceRoots, browsePath] });
								}}
							>
								＋ {t("addWorkspaceRoot")}
							</button>
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
							<button
								type="button"
								className="cwd-choose-btn primary"
								title={t("cwdPickCurrent")}
								disabled={browsePath === MACHINE_ROOT}
								onClick={() => commitLocal(browsePath)}
							>
								{t("cwdPickCurrent")}
							</button>
						</div>
						<div className="cwd-list">
							{dirs.length === 0 && <div className="cwd-empty">{t("cwdEmpty")}</div>}
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
									<button
										type="button"
										className="cwd-choose-btn"
										title={t("cwdChoose")}
										onClick={() => commitLocal(d.path)}
									>
										{t("cwdChoose")}
									</button>
								</div>
							))}
						</div>
						<div className="cwd-picker-foot">
							{showNew ? (
								<div className="cwd-newrow">
									<input
										ref={newInputRef}
										value={newName}
										autoFocus
										spellCheck={false}
										placeholder={mode === "project" ? t("projectName") : t("cwdNewName")}
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
									<button type="button" className="cwd-choose-btn primary" onClick={handleCreateLocal}>
										{mode === "project" ? t("createAndOpenProject") : t("cwdCreate")}
									</button>
									<button
										type="button"
										className="cwd-choose-btn"
										onClick={() => {
											setShowNew(false);
											setNewName("");
											setLocalError(null);
										}}
									>
										{t("cwdCancel")}
									</button>
								</div>
							) : (
								<button type="button" className="cwd-newbtn" onClick={() => setShowNew(true)}>
									＋ {mode === "project" ? t("newProject") : t("cwdNewFolder")}
								</button>
							)}
							{localError && (
								<div
									className="project-picker-error"
									style={{ color: "var(--red)", fontSize: "11px", marginTop: "4px" }}
								>
									{localError}
								</div>
							)}
						</div>
					</>
				)}

				{/* 远程 (SSH) 视图 */}
				{activeTab === "remote" && (
					<div className="cwd-ssh-container">
						{!connectionId ? (
							/* 未连接：展示已存配置与新建连接表单 */
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
							/* 已连接：展示探针信息与远程目录浏览 */
							<>
								{/* 探针信息与必要工具检测 */}
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

									{/* 工具缺失引导 */}
									{suggestedTools.length > 0 && (
										<div className="cwd-ssh-install-box">
											<div>⚠️ 远端环境未检测到 Git / 基础工具，SCM 与执行功能可能受限。</div>
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

								{/* 远程路径浏览条 */}
								<div className="cwd-picker-head">
									<span className="cwd-picker-title" title={remoteCwd}>
										<FiGlobe />
										<span>{remoteCwd}</span>
									</span>
									<button
										type="button"
										className="cwd-up"
										disabled={remoteCwd === "/" || loadingRemoteDir}
										title={t("cwdGoUp")}
										onClick={() => {
											const parent = parentOf(remoteCwd) || "/";
											if (connectionId) void loadRemoteDir(connectionId, parent);
										}}
									>
										↑ {t("cwdGoUp")}
									</button>
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
									<button type="button" className="cwd-choose-btn primary" onClick={() => commitRemote(remoteCwd)}>
										{t("sshOpenRemoteWorkspace")}
									</button>
								</div>

								{/* 远程文件列表 */}
								<div className="cwd-list">
									{loadingRemoteDir ? (
										<div className="cwd-empty">正在加载远程目录…</div>
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
													<button
														type="button"
														className="cwd-choose-btn"
														title={t("cwdChoose")}
														onClick={() => commitRemote(item.path)}
													>
														{t("cwdChoose")}
													</button>
												)}
											</div>
										))
									)}
								</div>
							</>
						)}
					</div>
				)}
			</div>
		</>
	);
}
