import { useEffect, useState } from "react";
import { FiBookmark, FiCheck, FiClock, FiFilePlus, FiFolder, FiPackage, FiUpload, FiX } from "react-icons/fi";
import { LuFlaskConical } from "react-icons/lu";
import { useT } from "../i18n";
import type { ClientMessage, ProjectSummary, SandboxDiffView, SandboxInfo } from "../types";

export interface SandboxModalProps {
	mode: "create" | "promote" | "apply";
	currentCwd?: string;
	currentSandbox?: SandboxInfo | null;
	sandboxDiff?: SandboxDiffView | null;
	projects: ProjectSummary[];
	send: (msg: ClientMessage) => void;
	onClose: () => void;
}

function baseNameOf(p: string): string {
	return (
		p
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() || p
	);
}

export function SandboxModal({
	mode,
	currentCwd,
	currentSandbox,
	sandboxDiff,
	projects,
	send,
	onClose,
}: SandboxModalProps) {
	const t = useT();

	// Default source path when importing: if currently inside a sandbox that has a sourcePath, use that;
	// otherwise use currentCwd (if not a sandbox) or first non-sandbox recent project.
	const defaultSourcePath =
		currentSandbox?.sourcePath ||
		(!currentSandbox && currentCwd ? currentCwd : projects.find((p) => !p.sandbox)?.path || currentCwd || "");

	const [initMode, setInitMode] = useState<"blank" | "import">(defaultSourcePath ? "import" : "blank");
	const [sourcePath, setSourcePath] = useState<string>(defaultSourcePath);
	const [ephemeral, setEphemeral] = useState<boolean>(true);
	const [name, setName] = useState<string>("");

	// Promote state
	const suggestedTarget = currentSandbox?.sourcePath
		? `${currentSandbox.sourcePath}-exp`
		: `~/projects/${(currentSandbox?.name || "sandbox-app").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "sandbox-app"}`;
	const [targetPath, setTargetPath] = useState<string>(suggestedTarget);
	const [switchToTarget, setSwitchToTarget] = useState<boolean>(true);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		if (mode === "apply" && currentSandbox?.path) {
			send({ type: "diff_sandbox", path: currentSandbox.path });
		}
	}, [mode, currentSandbox?.path, send]);

	const nonSandboxProjects = projects.filter((p) => !p.sandbox);

	const handleSubmitCreate = (e: React.FormEvent) => {
		e.preventDefault();
		const src = initMode === "import" ? sourcePath.trim() : undefined;
		if (initMode === "import" && !src) return;
		send({
			type: "create_sandbox",
			name: name.trim() || undefined,
			sourcePath: src,
			ephemeral,
		});
		onClose();
	};

	const handleSubmitPromote = (e: React.FormEvent) => {
		e.preventDefault();
		const target = targetPath.trim();
		if (!target) return;
		send({
			type: "promote_sandbox",
			path: currentSandbox?.path,
			targetPath: target,
			switchToTarget,
		});
		onClose();
	};

	const handleSubmitApply = (e: React.FormEvent) => {
		e.preventDefault();
		if (!currentSandbox?.path) return;
		send({
			type: "apply_sandbox_to_source",
			path: currentSandbox.path,
		});
		onClose();
	};

	const diffMatchesCurrent =
		sandboxDiff &&
		currentSandbox &&
		(sandboxDiff.sandboxId === currentSandbox.id || sandboxDiff.path === currentSandbox.path);
	const totalChangedCount = diffMatchesCurrent
		? sandboxDiff.added.length + sandboxDiff.modified.length + sandboxDiff.deleted.length
		: 0;

	const headerTitle =
		mode === "create" ? t("sandboxModalTitle") : mode === "promote" ? t("sandboxPromoteTitle") : t("sandboxApplyTitle");

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal sandbox-modal" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="modal-close" onClick={onClose} title={t("close")} aria-label={t("close")}>
					<FiX />
				</button>
				<div className="modal-head">
					<span className="modal-head-icon" aria-hidden>
						<LuFlaskConical />
					</span>
					<h2>{headerTitle}</h2>
				</div>

				{mode === "create" ? (
					<form className="modal-body sandbox-modal-body" onSubmit={handleSubmitCreate}>
						<p className="sandbox-modal-subtitle">{t("sandboxModalSubtitle")}</p>

						<div className="sandbox-field-group">
							<label className="sandbox-field-label">{t("sandboxModeLabel")}</label>
							<div className="sandbox-choice-grid">
								<button
									type="button"
									className={`sandbox-choice-card ${initMode === "import" ? "active" : ""}`}
									onClick={() => setInitMode("import")}
								>
									<div className="sandbox-choice-title">
										<FiPackage aria-hidden /> {t("sandboxModeImport")}
									</div>
									<div className="sandbox-choice-desc">{t("sandboxModeImportDesc")}</div>
								</button>
								<button
									type="button"
									className={`sandbox-choice-card ${initMode === "blank" ? "active" : ""}`}
									onClick={() => setInitMode("blank")}
								>
									<div className="sandbox-choice-title">
										<FiFilePlus aria-hidden /> {t("sandboxModeBlank")}
									</div>
									<div className="sandbox-choice-desc">{t("sandboxModeBlankDesc")}</div>
								</button>
							</div>
						</div>

						{initMode === "import" && (
							<div className="sandbox-field-group">
								<label className="sandbox-field-label">{t("sandboxSourceLabel")}</label>
								<input
									type="text"
									className="sandbox-text-input"
									value={sourcePath}
									onChange={(e) => setSourcePath(e.target.value)}
									placeholder={t("sandboxSourcePlaceholder")}
									required
								/>
								{nonSandboxProjects.length > 0 && (
									<div className="sandbox-source-chips">
										{nonSandboxProjects.slice(0, 6).map((p) => (
											<button
												key={p.path}
												type="button"
												className={`sandbox-source-chip ${sourcePath === p.path ? "active" : ""}`}
												onClick={() => setSourcePath(p.path)}
												title={p.path}
											>
												<FiFolder aria-hidden style={{ marginRight: 4, verticalAlign: "-1px" }} />
												{baseNameOf(p.path)}
											</button>
										))}
									</div>
								)}
							</div>
						)}

						<div className="sandbox-field-group">
							<label className="sandbox-field-label">{t("sandboxLifecycleLabel")}</label>
							<div className="sandbox-choice-grid">
								<button
									type="button"
									className={`sandbox-choice-card ${ephemeral ? "active" : ""}`}
									onClick={() => setEphemeral(true)}
								>
									<div className="sandbox-choice-title">
										<FiClock aria-hidden /> {t("sandboxLifecycleEphemeral")}
									</div>
									<div className="sandbox-choice-desc">{t("sandboxLifecycleEphemeralDesc")}</div>
								</button>
								<button
									type="button"
									className={`sandbox-choice-card ${!ephemeral ? "active" : ""}`}
									onClick={() => setEphemeral(false)}
								>
									<div className="sandbox-choice-title">
										<FiBookmark aria-hidden /> {t("sandboxLifecyclePermanent")}
									</div>
									<div className="sandbox-choice-desc">{t("sandboxLifecyclePermanentDesc")}</div>
								</button>
							</div>
						</div>

						<div className="sandbox-field-group">
							<label className="sandbox-field-label">{t("sandboxNameLabel")}</label>
							<input
								type="text"
								className="sandbox-text-input"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder={
									initMode === "import" && sourcePath.trim()
										? `${baseNameOf(sourcePath.trim())} (Sandbox)`
										: t("sandboxNamePlaceholder")
								}
							/>
						</div>

						<div className="sandbox-modal-actions">
							<button type="button" className="btn" onClick={onClose}>
								{t("cancel")}
							</button>
							<button type="submit" className="btn primary" disabled={initMode === "import" && !sourcePath.trim()}>
								<LuFlaskConical aria-hidden style={{ marginRight: 5, verticalAlign: "-2px" }} />
								{t("sandboxCreateSubmit")}
							</button>
						</div>
					</form>
				) : mode === "promote" ? (
					<form className="modal-body sandbox-modal-body" onSubmit={handleSubmitPromote}>
						<p className="sandbox-modal-subtitle">
							{t("sandboxPromoteSubtitle", { name: currentSandbox?.name || "" })}
						</p>

						<div className="sandbox-field-group">
							<label className="sandbox-field-label">{t("sandboxPromoteTargetLabel")}</label>
							<input
								type="text"
								className="sandbox-text-input"
								value={targetPath}
								onChange={(e) => setTargetPath(e.target.value)}
								placeholder={t("sandboxPromoteTargetPlaceholder")}
								autoFocus
								required
							/>
						</div>

						<label className="sandbox-checkbox-row">
							<input type="checkbox" checked={switchToTarget} onChange={(e) => setSwitchToTarget(e.target.checked)} />
							<span>{t("sandboxPromoteSwitchLabel")}</span>
						</label>

						<div className="sandbox-modal-actions">
							<button type="button" className="btn" onClick={onClose}>
								{t("cancel")}
							</button>
							<button type="submit" className="btn primary" disabled={!targetPath.trim()}>
								<FiUpload aria-hidden style={{ marginRight: 5, verticalAlign: "-2px" }} />
								{t("sandboxPromoteSubmit")}
							</button>
						</div>
					</form>
				) : (
					<form className="modal-body sandbox-modal-body" onSubmit={handleSubmitApply}>
						<p className="sandbox-modal-subtitle">
							{t("sandboxActionApplyConfirm", {
								name: currentSandbox?.name || "",
								source: currentSandbox?.sourcePath || "",
							})}
						</p>

						{!diffMatchesCurrent ? (
							<div className="sandbox-diff-loading">{t("loading")}</div>
						) : sandboxDiff.error ? (
							<div className="sandbox-diff-empty">{sandboxDiff.error}</div>
						) : (
							<div className="sandbox-diff-box">
								<div className="sandbox-diff-stats">
									{t("sandboxDiffStats", {
										added: sandboxDiff.added.length,
										modified: sandboxDiff.modified.length,
										deleted: sandboxDiff.deleted.length,
										unchanged: sandboxDiff.unchangedCount,
									})}
								</div>
								{sandboxDiff.added.length + sandboxDiff.modified.length + sandboxDiff.deleted.length === 0 ? (
									<div className="sandbox-diff-empty">{t("sandboxDiffEmpty")}</div>
								) : (
									<div className="sandbox-diff-list">
										{sandboxDiff.added.map((f) => (
											<div key={`a:${f}`} className="sandbox-diff-item added">
												<span className="sandbox-diff-tag added">+</span>
												<span className="sandbox-diff-path">{f}</span>
											</div>
										))}
										{sandboxDiff.modified.map((f) => (
											<div key={`m:${f}`} className="sandbox-diff-item modified">
												<span className="sandbox-diff-tag modified">~</span>
												<span className="sandbox-diff-path">{f}</span>
											</div>
										))}
										{sandboxDiff.deleted.map((f) => (
											<div key={`d:${f}`} className="sandbox-diff-item deleted">
												<span className="sandbox-diff-tag deleted">-</span>
												<span className="sandbox-diff-path">{f}</span>
											</div>
										))}
									</div>
								)}
								{sandboxDiff.deleted.length > 0 && (
									<div className="sandbox-diff-note">{t("sandboxDiffDeletedNote")}</div>
								)}
							</div>
						)}

						<div className="sandbox-modal-actions">
							<button type="button" className="btn" onClick={onClose}>
								{t("cancel")}
							</button>
							<button type="submit" className="btn primary" disabled={!diffMatchesCurrent || totalChangedCount === 0}>
								<FiCheck aria-hidden style={{ marginRight: 5, verticalAlign: "-2px" }} />
								{t("sandboxApplySubmit", { count: totalChangedCount })}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
