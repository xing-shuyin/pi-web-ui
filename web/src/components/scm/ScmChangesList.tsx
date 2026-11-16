import { useMemo, useState } from "react";
import { FiCheck, FiMinus, FiPlus, FiSearch, FiTrash2, FiX } from "react-icons/fi";
import { useT } from "../../i18n";
import {
	scmFileKind,
	scmStatusLetter,
	splitScmFiles,
	sumScmStats,
	type ScmFileKind,
	type ScmFileLike,
	type ScmStatLike,
} from "../../scm-file-kind";

/**
 * 更改列表：按「已暂存 / 更改」分组，行首勾选框就是暂存开关（GitHub Desktop 的语义）。
 *
 * 分组只表达“这一行属于哪边”，同一个文件可以同时出现在两组（both = 暂存后又改过），
 * 判定全部走 `scm-file-kind`，组件里不再自己解释 x/y。
 */
export interface ScmChangesListProps {
	files: readonly ScmFileLike[];
	stats: ReadonlyMap<string, ScmStatLike>;
	selectedPath: string | null;
	notRepo: boolean;
	/** 还没拿到 status（首次查询 / 断线） */
	pending: boolean;
	connected: boolean;
	onSelect: (file: ScmFileLike) => void;
	onStage: (file: ScmFileLike) => void;
	onUnstage: (file: ScmFileLike) => void;
	onDiscard: (file: ScmFileLike) => void;
	onStageAll: () => void;
	onUnstageAll: () => void;
}

const LETTER_TONE: Record<string, string> = {
	A: "green",
	U: "green",
	D: "red",
	R: "accent",
	M: "amber",
};

function fileTone(f: ScmFileLike): string {
	return LETTER_TONE[scmStatusLetter(f)] ?? "amber";
}

export function ScmChangesList({
	files,
	stats,
	selectedPath,
	notRepo,
	pending,
	connected,
	onSelect,
	onStage,
	onUnstage,
	onDiscard,
	onStageAll,
	onUnstageAll,
}: ScmChangesListProps) {
	const t = useT();
	const [query, setQuery] = useState("");

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return [...files];
		return files.filter((f) => f.path.toLowerCase().includes(q));
	}, [files, query]);

	const groups = useMemo(() => splitScmFiles(filtered), [filtered]);
	const stagedSummary = useMemo(() => sumScmStats(groups.staged, stats), [groups.staged, stats]);
	const unstagedSummary = useMemo(() => sumScmStats(groups.unstaged, stats), [groups.unstaged, stats]);
	const hasUnstaged = groups.unstaged.length > 0;

	return (
		<div className="scm-files">
			<div className="scm-files-header">
				<span>{t("scmChanges")}</span>
				<span className="scm-files-head-actions">
					{files.length > 0 && <span className="scm-files-count">{files.length}</span>}
					<button
						type="button"
						className="scm-act"
						title={t("scmStageAllTip")}
						aria-label={t("scmStageAllTip")}
						disabled={notRepo || !hasUnstaged}
						onClick={onStageAll}
					>
						<FiPlus />
					</button>
					<button
						type="button"
						className="scm-act"
						title={t("scmUnstageAllTip")}
						aria-label={t("scmUnstageAllTip")}
						disabled={notRepo || groups.staged.length === 0}
						onClick={onUnstageAll}
					>
						<FiMinus />
					</button>
				</span>
			</div>

			{!notRepo && files.length > 0 && (
				<div className="scm-filter">
					<FiSearch aria-hidden="true" />
					<input
						value={query}
						placeholder={t("scmFilterFiles")}
						title={t("scmFilterFilesTip")}
						aria-label={t("scmFilterFilesTip")}
						onChange={(e) => setQuery(e.target.value)}
						spellCheck={false}
					/>
					{query && (
						<button type="button" className="scm-filter-clear" aria-label={t("close")} onClick={() => setQuery("")}>
							<FiX />
						</button>
					)}
				</div>
			)}

			<div className="scm-files-list">
				{notRepo ? (
					<div className="scm-empty">{t("scmNotGitRepo")}</div>
				) : pending ? (
					<div className="scm-empty">{connected ? t("scmLoading") : t("scmConnecting")}</div>
				) : files.length === 0 ? (
					<div className="scm-empty">{t("scmNoChanges")}</div>
				) : filtered.length === 0 ? (
					<div className="scm-empty">{t("scmFilterEmpty")}</div>
				) : (
					<>
						{groups.staged.length > 0 && (
							<div className="scm-group" data-group="staged">
								<div className="scm-group-head">
									<span className="scm-group-title">{t("scmStaged")}</span>
									<span className="scm-group-count">{groups.staged.length}</span>
									{stagedSummary.add > 0 && <span className="scm-group-stat add">+{stagedSummary.add}</span>}
									{stagedSummary.del > 0 && <span className="scm-group-stat del">-{stagedSummary.del}</span>}
								</div>
								{groups.staged.map((f) => (
									<FileRow
										key={`staged:${f.path}`}
										f={f}
										stagedRow
										stat={stats.get(f.path)}
										selected={selectedPath === f.path}
										onSelect={onSelect}
										onStage={onStage}
										onUnstage={onUnstage}
										onDiscard={onDiscard}
									/>
								))}
							</div>
						)}
						{groups.unstaged.length > 0 && (
							<div className="scm-group" data-group="changes">
								<div className="scm-group-head">
									<span className="scm-group-title">{t("scmChanges")}</span>
									<span className="scm-group-count">{groups.unstaged.length}</span>
									{unstagedSummary.add > 0 && <span className="scm-group-stat add">+{unstagedSummary.add}</span>}
									{unstagedSummary.del > 0 && <span className="scm-group-stat del">-{unstagedSummary.del}</span>}
								</div>
								{groups.unstaged.map((f) => (
									<FileRow
										key={`changes:${f.path}`}
										f={f}
										stagedRow={false}
										stat={stats.get(f.path)}
										selected={selectedPath === f.path}
										onSelect={onSelect}
										onStage={onStage}
										onUnstage={onUnstage}
										onDiscard={onDiscard}
									/>
								))}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

interface FileRowProps {
	f: ScmFileLike;
	stagedRow: boolean;
	stat?: ScmStatLike;
	selected: boolean;
	onSelect: (f: ScmFileLike) => void;
	onStage: (f: ScmFileLike) => void;
	onUnstage: (f: ScmFileLike) => void;
	onDiscard: (f: ScmFileLike) => void;
}

function FileRow({ f, stagedRow, stat, selected, onSelect, onStage, onUnstage, onDiscard }: FileRowProps) {
	const t = useT();
	const kind: ScmFileKind = scmFileKind(f);
	const partial = kind === "both";
	const kindLabel = stagedRow
		? partial
			? t("scmStagedUnstaged")
			: t("scmStaged")
		: kind === "untracked"
			? t("scmUntracked")
			: partial
				? t("scmStagedUnstaged")
				: t("scmUnstaged");
	const tickTitle = stagedRow ? t("scmUnstageTip", { path: f.path }) : t("scmStageTip", { path: f.path });
	return (
		<div
			className={`scm-file${selected ? " active" : ""}${stagedRow ? " staged" : ""}`}
			title={`${kindLabel} · ${f.path}`}
			onClick={() => onSelect(f)}
		>
			<label
				className="scm-file-tick"
				title={tickTitle}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<input
					type="checkbox"
					checked={stagedRow}
					aria-label={tickTitle}
					onChange={() => (stagedRow ? onUnstage(f) : onStage(f))}
				/>
				<span className="scm-file-box" aria-hidden="true">
					<FiCheck />
				</span>
			</label>
			<span className={`scm-file-letter ${fileTone(f)}`}>{scmStatusLetter(f)}</span>
			<span className="scm-file-path">{f.path}</span>
			{stat && (stat.add > 0 || stat.del > 0) && (
				<span className="scm-file-stat">
					{stat.add > 0 && <span className="add">+{stat.add}</span>}
					{stat.del > 0 && <span className="del">-{stat.del}</span>}
				</span>
			)}
			<span className="scm-file-actions">
				{stagedRow ? (
					<button
						type="button"
						className="scm-act"
						title={t("scmUnstageTip", { path: f.path })}
						aria-label={t("scmUnstageTip", { path: f.path })}
						onClick={(e) => {
							e.stopPropagation();
							onUnstage(f);
						}}
					>
						<FiMinus />
					</button>
				) : (
					<button
						type="button"
						className="scm-act"
						title={t("scmStageTip", { path: f.path })}
						aria-label={t("scmStageTip", { path: f.path })}
						onClick={(e) => {
							e.stopPropagation();
							onStage(f);
						}}
					>
						<FiPlus />
					</button>
				)}
				{!stagedRow && (
					<button
						type="button"
						className="scm-act"
						title={
							kind === "untracked"
								? t("scmDiscardUntrackedTip", { path: f.path })
								: t("scmDiscardTip", { path: f.path })
						}
						aria-label={
							kind === "untracked"
								? t("scmDiscardUntrackedTip", { path: f.path })
								: t("scmDiscardTip", { path: f.path })
						}
						onClick={(e) => {
							e.stopPropagation();
							onDiscard(f);
						}}
					>
						<FiTrash2 />
					</button>
				)}
			</span>
		</div>
	);
}
