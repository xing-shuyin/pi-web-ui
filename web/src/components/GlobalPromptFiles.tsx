import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiCheck, FiFileText, FiPlus, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import { requestJson } from "../api-client";
import { useT } from "../i18n";
import { HintTip } from "./HintTip";

type GlobalPromptAgent = "pi" | "claude" | "codex" | "cursor" | "windsurf" | "gemini" | "opencode" | "qwen" | "custom";
type GlobalPromptKind = "system" | "append" | "context" | "rules";

interface GlobalPromptFile {
	id: string;
	agent: GlobalPromptAgent;
	kind: GlobalPromptKind;
	path: string;
	label?: string;
	custom: boolean;
	exists: boolean;
	content: string;
	revision: string;
	truncated: boolean;
	error?: string;
}

interface GlobalPromptDirectory {
	id: string;
	agent: GlobalPromptAgent;
	kind: "rules";
	path: string;
	fileCount: number;
	error?: string;
}

interface GlobalPromptCatalog {
	files: GlobalPromptFile[];
	directories: GlobalPromptDirectory[];
	customStorageBlocked: boolean;
}

const AGENT_LABEL_KEYS = {
	pi: "globalPromptAgent_pi",
	claude: "globalPromptAgent_claude",
	codex: "globalPromptAgent_codex",
	cursor: "globalPromptAgent_cursor",
	windsurf: "globalPromptAgent_windsurf",
	gemini: "globalPromptAgent_gemini",
	opencode: "globalPromptAgent_opencode",
	qwen: "globalPromptAgent_qwen",
	custom: "globalPromptAgent_custom",
} as const;

const KIND_LABEL_KEYS = {
	system: "globalPromptKind_system",
	append: "globalPromptKind_append",
	context: "globalPromptKind_context",
	rules: "globalPromptKind_rules",
} as const;

export function GlobalPromptFiles({ onApplied }: { onApplied: () => void }) {
	const t = useT();
	const [catalog, setCatalog] = useState<GlobalPromptCatalog | null>(null);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const dirtyIdsRef = useRef(new Set<string>());
	const [openId, setOpenId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [savingId, setSavingId] = useState<string | null>(null);
	const [savedId, setSavedId] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [customPath, setCustomPath] = useState("");
	const [customLabel, setCustomLabel] = useState("");
	const [addingCustom, setAddingCustom] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const next = await requestJson<GlobalPromptCatalog>("/api/global-prompts");
			setCatalog(next);
			setDrafts((previous) => {
				const merged: Record<string, string> = {};
				for (const file of next.files) {
					merged[file.id] = dirtyIdsRef.current.has(file.id) ? (previous[file.id] ?? file.content) : file.content;
				}
				return merged;
			});
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const existingCount = useMemo(() => catalog?.files.filter((file) => file.exists).length ?? 0, [catalog]);

	const save = async (file: GlobalPromptFile) => {
		if (savingId || file.truncated || file.error) return;
		setSavingId(file.id);
		setSavedId(null);
		setError("");
		try {
			const result = await requestJson<{ file: GlobalPromptFile }>("/api/global-prompts", {
				method: "PUT",
				body: {
					id: file.id,
					content: drafts[file.id] ?? file.content,
					expectedRevision: file.revision,
				},
			});
			setCatalog((previous) =>
				previous
					? { ...previous, files: previous.files.map((item) => (item.id === file.id ? result.file : item)) }
					: previous,
			);
			setDrafts((previous) => ({ ...previous, [file.id]: result.file.content }));
			dirtyIdsRef.current.delete(file.id);
			setSavedId(file.id);
			if (file.agent === "pi") onApplied();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSavingId(null);
		}
	};

	const addCustom = async () => {
		const path = customPath.trim();
		if (!path || addingCustom) return;
		setAddingCustom(true);
		setError("");
		try {
			const next = await requestJson<GlobalPromptCatalog>("/api/global-prompts/custom", {
				method: "POST",
				body: { path, ...(customLabel.trim() ? { label: customLabel.trim() } : {}) },
			});
			setCatalog(next);
			setDrafts((previous) => {
				const merged = { ...previous };
				for (const file of next.files) merged[file.id] ??= file.content;
				return merged;
			});
			setCustomPath("");
			setCustomLabel("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setAddingCustom(false);
		}
	};

	const removeCustom = async (file: GlobalPromptFile) => {
		if (!window.confirm(t("globalPromptRemoveConfirm", { path: file.path }))) return;
		setError("");
		try {
			const next = await requestJson<GlobalPromptCatalog>(`/api/global-prompts/custom/${encodeURIComponent(file.id)}`, {
				method: "DELETE",
			});
			setCatalog(next);
			setDrafts((previous) => {
				const merged = { ...previous };
				delete merged[file.id];
				dirtyIdsRef.current.delete(file.id);
				return merged;
			});
			if (openId === file.id) setOpenId(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<details className="set-field global-prompts set-fold">
			<summary className="prompt-templates-head global-prompts-head">
				<span className="set-field-label">{t("globalPromptFilesTitle")}</span>
				<HintTip text={t("globalPromptFilesDesc")} />
				<span className="set-count">{existingCount}</span>
				<span className="set-fold-chev" aria-hidden="true">
					▾
				</span>
			</summary>
			<div className="global-prompts-body">
				<div className="global-prompts-toolbar">
					<p className="set-hint">{t("globalPromptFilesHint")}</p>
					<button type="button" className="set-btn-mini" onClick={() => void load()} disabled={loading}>
						<FiRefreshCw className={loading ? "spin" : ""} /> {t("globalPromptRefresh")}
					</button>
				</div>
				{error && <p className="global-prompts-error">{error}</p>}
				{catalog?.customStorageBlocked && (
					<p className="global-prompts-error">{t("globalPromptCustomStorageBlocked")}</p>
				)}
				{loading && !catalog ? (
					<p className="set-empty">{t("globalPromptLoading")}</p>
				) : catalog && catalog.files.length === 0 ? (
					<p className="set-empty">{t("globalPromptEmpty")}</p>
				) : null}
				{catalog && catalog.directories.length > 0 && (
					<div className="global-prompt-dirs">
						{catalog.directories.map((directory) => (
							<div className="global-prompt-dir" key={directory.id}>
								<span>
									{t(AGENT_LABEL_KEYS[directory.agent])} · {t("globalPromptRulesDir")}
								</span>
								<code title={directory.path}>{directory.path}</code>
								<span className="set-muted">
									{directory.error
										? t("globalPromptDirUnavailable")
										: t("globalPromptRuleCount", { n: directory.fileCount })}
								</span>
							</div>
						))}
					</div>
				)}
				<div className="global-prompt-list">
					{catalog?.files.map((file) => {
						const open = openId === file.id;
						const editable = !file.truncated && !file.error;
						return (
							<div className={`global-prompt-file${open ? " open" : ""}`} key={file.id}>
								<button
									type="button"
									className="global-prompt-file-head"
									aria-expanded={open}
									onClick={() => setOpenId(open ? null : file.id)}
								>
									<FiFileText className="global-prompt-file-icon" />
									<span className="global-prompt-file-title">
										<span>
											{t(AGENT_LABEL_KEYS[file.agent])} · {t(KIND_LABEL_KEYS[file.kind])}
										</span>
										{file.label && <em>{file.label}</em>}
									</span>
									<span className="global-prompt-file-path" title={file.path}>
										{file.path}
									</span>
									<span className={`global-prompt-file-status${file.exists ? " exists" : ""}`}>
										{file.exists ? t("globalPromptExists") : t("globalPromptMissing")}
									</span>
									<span className={`global-prompt-file-chev${open ? " open" : ""}`} aria-hidden="true">
										▾
									</span>
								</button>
								{open && (
									<div className="global-prompt-file-body">
										<p className="set-hint">
											{file.agent === "pi" ? t("globalPromptPiHint") : t("globalPromptOtherAgentHint")}
										</p>
										{file.error && <p className="global-prompts-error">{file.error}</p>}
										{file.truncated && <p className="global-prompts-error">{t("globalPromptTruncated")}</p>}
										<textarea
											className="set-prompt-input global-prompt-editor"
											rows={14}
											value={drafts[file.id] ?? file.content}
											disabled={!editable}
											placeholder={t("globalPromptEditorPlaceholder")}
											onChange={(event) => {
												dirtyIdsRef.current.add(file.id);
												if (savedId === file.id) setSavedId(null);
												setDrafts((previous) => ({ ...previous, [file.id]: event.target.value }));
											}}
											onKeyDown={(event) => {
												if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
													event.preventDefault();
													void save(file);
												}
											}}
										/>
										<div className="global-prompt-file-foot">
											<span className="set-muted">
												{savedId === file.id ? t("globalPromptSaved") : t("globalPromptRevisionHint")}
											</span>
											<span className="global-prompt-foot-spacer" />
											{file.custom && (
												<button type="button" className="set-btn-mini danger" onClick={() => void removeCustom(file)}>
													<FiTrash2 /> {t("globalPromptRemove")}
												</button>
											)}
											<button
												type="button"
												className="set-save-btn"
												disabled={!editable || savingId !== null}
												onClick={() => void save(file)}
											>
												{savingId === file.id ? (
													<FiRefreshCw className="spin" />
												) : savedId === file.id ? (
													<FiCheck />
												) : null}
												{savingId === file.id ? t("globalPromptSaving") : t("globalPromptSave")}
											</button>
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
				<form
					className="global-prompt-custom"
					onSubmit={(event) => {
						event.preventDefault();
						void addCustom();
					}}
				>
					<div className="set-field-label">{t("globalPromptCustomAdd")}</div>
					<p className="set-hint">{t("globalPromptCustomAddHint")}</p>
					<div className="global-prompt-custom-row">
						<input
							className="set-input"
							value={customPath}
							placeholder={t("globalPromptCustomPath")}
							onChange={(event) => setCustomPath(event.target.value)}
						/>
						<input
							className="set-input"
							value={customLabel}
							placeholder={t("globalPromptCustomLabel")}
							onChange={(event) => setCustomLabel(event.target.value)}
						/>
						<button type="submit" className="set-save-btn" disabled={!customPath.trim() || addingCustom}>
							<FiPlus /> {addingCustom ? t("globalPromptAdding") : t("globalPromptAdd")}
						</button>
					</div>
				</form>
			</div>
		</details>
	);
}
