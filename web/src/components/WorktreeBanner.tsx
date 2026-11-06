import { useEffect } from "react";
import { FiArrowLeft, FiGitBranch, FiRefreshCw, FiTrash2 } from "react-icons/fi";
import type { WorktreeInfo } from "../types";
import { useT } from "../i18n";

export function useWorktreeRefresh(mainPath: string | undefined, onRefresh: () => void) {
	useEffect(() => {
		const refresh = () => {
			if (document.visibilityState === "visible") onRefresh();
		};
		refresh();
		const timer = window.setInterval(refresh, 30_000);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.clearInterval(timer);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [mainPath, onRefresh]);
}

export function WorktreeView({
	worktree,
	onRefresh,
	onSwitch,
	onRemove,
	onBack,
}: {
	worktree?: WorktreeInfo | null;
	onRefresh: () => void;
	onSwitch: (path: string) => void;
	onRemove: (path: string) => void;
	onBack: () => void;
}) {
	const t = useT();
	const linked = worktree?.linkedWorktrees ?? [];
	const rows = worktree
		? [
				{
					path: worktree.mainPath,
					branch: worktree.mainBranch,
					isMain: true,
					isDirty: undefined as boolean | undefined,
				},
				...linked.map((row) => ({ ...row, isMain: false })),
			]
		: [];
	if (worktree?.isLinkedWorktree && !rows.some((row) => row.path === worktree.currentPath)) {
		rows.push({ path: worktree.currentPath, branch: worktree.branch, isMain: false, isDirty: undefined });
	}
	return (
		<section className="worktree-view" aria-label={t("worktreeViewTitle")}>
			<div className="worktree-view-header">
				<button type="button" className="btn" onClick={onBack}>
					<FiArrowLeft />
					{t("worktreeBackToChat")}
				</button>
				<h2>{t("worktreeViewTitle")}</h2>
				<button
					type="button"
					className="btn"
					onClick={onRefresh}
					aria-label={t("worktreeRefresh")}
					title={t("worktreeRefresh")}
				>
					<FiRefreshCw />
				</button>
			</div>
			<p className="worktree-view-hint">{t("worktreeViewHint")}</p>
			{!worktree && <p>{t("worktreeEmpty")}</p>}
			<div className="worktree-view-list">
				{rows.map((row) => {
					const current = row.path === worktree?.currentPath;
					const name = row.branch || t("worktreeDetached");
					return (
						<article className={`worktree-card${current ? " current" : ""}`} key={row.path}>
							<div className="worktree-card-title">
								<FiGitBranch />
								<strong>{name}</strong>
								{current && <span className="worktree-current">{t("worktreeCurrent")}</span>}
							</div>
							<div className="worktree-card-path">{row.path}</div>
							<div className="worktree-card-actions">
								<span className={row.isDirty ? "worktree-dirty" : "worktree-status"}>
									{row.isMain
										? t("worktreeMain")
										: row.isDirty === undefined
											? t("worktreeBadgeLinked")
											: row.isDirty
												? t("worktreeHasChanges")
												: t("worktreeClean")}
								</span>
								{!current && (
									<button type="button" className="btn" onClick={() => onSwitch(row.path)}>
										{row.isMain ? t("worktreeActionSwitchMain") : t("worktreeSwitch")}
									</button>
								)}
							</div>
							{!row.isMain && (
								<details className="worktree-card-details">
									<summary>{t("worktreeManage")}</summary>
									<button
										type="button"
										className="btn danger"
										onClick={() => {
											if (window.confirm(t("worktreeActionRemoveConfirm", { path: row.path }))) onRemove(row.path);
										}}
									>
										<FiTrash2 />
										{t("worktreeActionRemove")}
									</button>
								</details>
							)}
						</article>
					);
				})}
			</div>
		</section>
	);
}
