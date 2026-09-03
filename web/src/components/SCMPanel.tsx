/* ------------------------------------------------------------------ */
/* read-only git queries (server-side execFile)                        */
/*                                                                     */
/* The panel's status / diff / history queries go through the dedicated */
/* scm_status / scm_filediff / scm_commit wire messages: the server runs */
/* plain `git` via execFile (no shell — no prompts, no echo, no ANSI)   */
/* and replies with structured JSON in scm_data. Requests are matched   */
/* by reqId; every request is answered exactly once so the UI can never */
/* get stuck "loading".                                                 */
/*                                                                     */
/* Write operations (commit / checkout / push / pull) still run in the  */
/* visible terminal tab so the user sees exactly what happened.         */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	FiArrowDown,
	FiArrowUp,
	FiCheck,
	FiGitBranch,
	FiRefreshCw,
	FiTerminal,
} from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { ClientMessage, CommandDef, ServerMessage } from "../types";
import { randomUuid } from "../uuid";
import { quotePath } from "../scm-quote";
import { useT } from "../i18n";

/* ------------------------------------------------------------------ */
/* data shapes                                                         */
/* ------------------------------------------------------------------ */

export interface ScmFile {
	/** Repo-relative path (unquoted). */
	path: string;
	/** porcelain index (staged) status letter. */
	x: string;
	/** porcelain worktree status letter. */
	y: string;
}

export interface ScmStatus {
	branch: string;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	upstreamGone: boolean;
	files: ScmFile[];
}

export interface ScmBranch {
	name: string;
	current: boolean;
	/** Remote name for remote-tracking refs ("origin/main" → "origin"). */
	remote?: string | boolean;
}

interface ScmCommit {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	decorations: string;
	/** The graph prefix emitted by `git log --graph` (for example `| * `). */
	graph: string;
}

interface StatInfo {
	add: number;
	del: number;
}

type FileKind = "staged" | "unstaged" | "untracked" | "both";

function fileKind(f: ScmFile): FileKind {
	if (f.x === "?" && f.y === "?") return "untracked";
	const staged = f.x !== " " && f.x !== "?";
	const unstaged = f.y !== " " && f.y !== "?";
	if (staged && unstaged) return "both";
	if (staged) return "staged";
	return "unstaged";
}

interface ScmTerminalBridge {
	create: (meta: TerminalMeta) => void;
	close: (id: string) => void;
	register: (
		conversationId: string,
		id: string,
		writer: { write(data: string): void; dispose(): void },
	) => () => void;
	restart: (id: string) => void;
	select: (id: string) => void;
}

export interface ScmPanelProps {
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	terminal: ScmTerminalBridge;
	/** True when this view is currently visible (drives auto-refresh). */
	active: boolean;
	/** Switch the top-level view to the terminal (write ops run there). */
	onSwitchToTerminal: () => void;
}

export function ScmPanel({
	chat,
	send,
	terminal,
	active,
	onSwitchToTerminal,
}: ScmPanelProps) {
	const t = useT();
	const [status, setStatus] = useState<ScmStatus | null>(null);
	const [branches, setBranches] = useState<ScmBranch[]>([]);
	const [branchSel, setBranchSel] = useState("");
	const [statMap, setStatMap] = useState<Map<string, StatInfo>>(new Map());
	const [viewMode, setViewMode] = useState<"changes" | "history">("changes");
	const [history, setHistory] = useState<ScmCommit[]>([]);
	const [selectedCommit, setSelectedCommit] = useState<ScmCommit | null>(null);
	const [commitDetail, setCommitDetail] = useState("");
	const [commitLoading, setCommitLoading] = useState(false);
	const [selected, setSelected] = useState<ScmFile | null>(null);
	const [fileDiff, setFileDiff] = useState<{
		file: ScmFile;
		staged: string;
		worktree: string;
		untracked: boolean;
	} | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notRepo, setNotRepo] = useState(false);
	const [commitMsg, setCommitMsg] = useState("");

	/** Monotonic request id — responses are matched per pending slot below. */
	const seqRef = useRef(0);
	const statusReqRef = useRef(-1);
	const diffReqRef = useRef(-1);
	const commitReqRef = useRef(-1);
	const historyReqRef = useRef(-1);
	/** Cwd the last refresh ran against — a workspace switch resets state. */
	const lastCwdRef = useRef<string | undefined>(undefined);
	/** The file whose diff is in flight (scm_data carries no request context). */
	const selectedFileRef = useRef<ScmFile | null>(null);
	/** Terminal tab list snapshot — detects git write-command completion. */
	const prevTerminalsRef = useRef<TerminalMeta[]>([]);

	/**
	 * Apply an scm_data response that matches one of our in-flight requests.
	 * The server answers every request exactly once (ok or error), so loading
	 * states always settle — no queues or timeouts needed on this side.
	 */
	const applyScmData = useCallback(
		(data: Extract<ServerMessage, { type: "scm_data" }>) => {
			if (data.reqId === statusReqRef.current) {
				statusReqRef.current = -1;
				setBusy(false);
				setError(null);
				if (!data.ok) {
					setError(data.error ?? t("scmQueryFailedShort"));
					return;
				}
				if (data.notRepo) {
					setNotRepo(true);
					setStatus(null);
					setBranches([]);
					setStatMap(new Map());
					setHistory([]);
					setSelectedCommit(null);
					setCommitDetail("");
					setFileDiff(null);
					return;
				}
				setNotRepo(false);
				const st: ScmStatus = {
					branch: data.branch ?? "",
					detached: !!data.detached,
					upstream: data.upstream ?? null,
					ahead: data.ahead ?? 0,
					behind: data.behind ?? 0,
					upstreamGone: !!data.upstreamGone,
					files: (data.files ?? []).map((f) => ({ ...f })),
				};
				const brs: ScmBranch[] = (data.branches ?? []).map((x) => ({ ...x }));
				const stats = new Map<string, StatInfo>();
				for (const [path, pair] of Object.entries(data.stats ?? {})) {
					stats.set(path, { add: pair[0], del: pair[1] });
				}
				setStatus(st);
				setBranches(brs);
				setStatMap(stats);
				setBranchSel((prev) => {
					if (st.detached) return prev || "";
					if (st.branch && brs.some((x) => x.name === st.branch)) return st.branch;
					if (prev && brs.some((x) => x.name === prev)) return prev;
					return brs[0]?.name ?? "";
				});
				setFileDiff((prev) =>
					prev && !st.files.some((f) => f.path === prev.file.path)
						? null
						: prev,
				);
			} else if (data.reqId === diffReqRef.current) {
				diffReqRef.current = -1;
				setDiffLoading(false);
				if (!data.ok) {
					setError(data.error ?? t("scmQueryFailedShort"));
					return;
				}
				const file = selectedFileRef.current;
				if (!file) return;
				setFileDiff({
					file,
					staged: data.stagedText ?? "",
					worktree: data.worktreeText ?? "",
					untracked: false,
				});
			} else if (data.reqId === historyReqRef.current) {
				historyReqRef.current = -1;
				setHistoryLoading(false);
				if (!data.ok) {
					setError(data.error ?? t("scmQueryFailedShort"));
					return;
				}
				setHistory((data.history ?? []).map((c) => ({ ...c })));
			} else if (data.reqId === commitReqRef.current) {
				commitReqRef.current = -1;
				setCommitLoading(false);
				if (!data.ok) {
					setError(data.error ?? t("scmQueryFailedShort"));
					return;
				}
				setCommitDetail(data.text ?? "");
			}
		},
		[],
	);

	// Responses arrive through chat.scmData — apply when the reqId matches.
	useEffect(() => {
		const data = chat.scmData;
		if (data && data.type === "scm_data") applyScmData(data);
	}, [chat.scmData, applyScmData]);

	/**
	 * Send an scm query and arm its pending slot. Returns false (without
	 * arming anything) when the socket is gone — otherwise the missing
	 * response would leave the spinner spinning forever.
	 */
	const sendScm = useCallback(
		(
			msg:
				| { type: "scm_status" }
				| { type: "scm_history" }
				| { type: "scm_filediff"; path: string }
				| { type: "scm_commit"; hash: string },
			slot: React.MutableRefObject<number>,
		): boolean => {
			if (!chat.ready || chat.status !== "open") return false;
			const id = ++seqRef.current;
			if (!send({ ...msg, reqId: id } as ClientMessage)) {
				seqRef.current -= 1;
				return false;
			}
			slot.current = id;
			return true;
		},
		[chat.ready, chat.status, send],
	);

	/* ------------------------------------------------------------------ */
	/* status refresh + per-file diff                                      */
	/* ------------------------------------------------------------------ */

	const refresh = useCallback(
		(manual = false, silent = false) => {
			if (!chat.ready || chat.status !== "open") return;
			if (!chat.state?.cwd) return;
			// Workspace switch → reset stale selections so nothing from the
			// previous repo leaks into the new one.
			if (lastCwdRef.current !== undefined && lastCwdRef.current !== chat.state.cwd) {
				setStatus(null);
				setBranches([]);
				setStatMap(new Map());
				setHistory([]);
				setHistoryLoading(false);
				historyReqRef.current = -1;
				setSelectedCommit(null);
				setCommitDetail("");
				setFileDiff(null);
				setSelected(null);
			}
			lastCwdRef.current = chat.state.cwd;
			setError(null);
			if (sendScm({ type: "scm_status" }, statusReqRef)) {
				if (!silent) setBusy(true);
			}
		},
		[chat.ready, chat.state?.cwd, chat.status, sendScm],
	);

	const showFileDiff = useCallback(
		(f: ScmFile) => {
			setSelected(f);
			setSelectedCommit(null);
			selectedFileRef.current = f;
			if (f.x === "?" && f.y === "?") {
				setFileDiff({ file: f, staged: "", worktree: "", untracked: true });
				return;
			}
			setDiffLoading(true);
			setError(null);
			if (!sendScm({ type: "scm_filediff", path: f.path }, diffReqRef)) {
				setDiffLoading(false);
			}
		},
		[sendScm],
	);

	const showCommitDetail = useCallback(
		(commit: ScmCommit) => {
			setSelectedCommit(commit);
			setSelected(null);
			setFileDiff(null);
			setCommitDetail("");
			setCommitLoading(true);
			setError(null);
			if (!sendScm({ type: "scm_commit", hash: commit.hash }, commitReqRef)) {
				setCommitLoading(false);
			}
		},
		[sendScm],
	);

	/* ------------------------------------------------------------------ */
	/* write operations → visible terminal tab                             */
	/* ------------------------------------------------------------------ */

	const runGitCommand = useCallback(
		(title: string, command: string) => {
			if (!chat.ready) return;
			const def: CommandDef = { name: title, command, cwd: "${pwd}" };
			let targetId: string;
			const existing = chat.terminals.find((tm) => tm.title === title);
			if (existing) {
				terminal.restart(existing.id);
				send({
					type: "run_command",
					terminalId: existing.id,
					conversationId: existing.conversationId,
					command: def,
					cols: 80,
					rows: 24,
				});
				targetId = existing.id;
			} else {
				targetId = randomUuid();
				terminal.create({
					id: targetId,
					conversationId: chat.activeConversationId || chat.state?.conversationId || "",
					title,
					cwd: chat.state?.cwd ?? "",
					cols: 80,
					rows: 24,
					running: true,
					exitCode: null,
					command: def,
				});
			}
			terminal.select(targetId);
			onSwitchToTerminal();
		},
		[chat.ready, chat.state?.cwd, chat.terminals, onSwitchToTerminal, send, terminal],
	);

	const handleCommit = useCallback(() => {
		const msg = commitMsg.trim();
		if (!msg || notRepo) return;
		const escaped = msg
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"')
			.replace(/`/g, "\\`")
			.replace(/\$/g, "\\$");
		runGitCommand("git commit", `git add -A && git commit -m "${escaped}"`);
		setCommitMsg("");
	}, [commitMsg, notRepo, runGitCommand]);

	const handleStage = useCallback(
		(f: ScmFile) => {
			if (notRepo) return;
			runGitCommand("git add", `git add -- ${quotePath(f.path)}`);
		},
		[notRepo, runGitCommand],
	);

	const handleUnstage = useCallback(
		(f: ScmFile) => {
			if (notRepo) return;
			runGitCommand("git reset", `git reset HEAD -- ${quotePath(f.path)}`);
		},
		[notRepo, runGitCommand],
	);

	const handleSwitch = useCallback(() => {
		if (!branchSel || notRepo) return;
		const entry = branches.find((x) => x.name === branchSel);
		if (entry?.remote && typeof entry.remote === "string") {
			// Remote-tracking ref: create a local branch tracking it (falls back
			// to a plain checkout when the local branch already exists).
			const localName = branchSel.slice(entry.remote.length + 1);
			runGitCommand(
				"git checkout",
				`git checkout -b ${localName} ${branchSel} || git checkout ${branchSel}`,
			);
		} else {
			runGitCommand("git checkout", `git checkout ${branchSel}`);
		}
	}, [branchSel, branches, notRepo, runGitCommand]);

	const handlePush = useCallback(() => runGitCommand("git push", "git push"), [runGitCommand]);
	const handlePull = useCallback(() => runGitCommand("git pull", "git pull"), [runGitCommand]);

	/** Load the commit graph (lazy — only needed by the history tab). */
	const loadHistory = useCallback(() => {
		if (!sendScm({ type: "scm_history" }, historyReqRef)) {
			historyReqRef.current = -1;
		}
	}, [sendScm]);

	/* ------------------------------------------------------------------ */
	/* lifecycle                                                          */
	/* ------------------------------------------------------------------ */

	// Auto-refresh when the panel becomes visible or the workspace changes
	// (refresh reads the latest cwd, so this also covers project switches).
	useEffect(() => {
		if (active) refresh();
	}, [active, refresh]);

	// Lazy-load the commit graph when the history tab is opened.
	useEffect(() => {
		if (viewMode === "history" && status) loadHistory();
	}, [viewMode, status, loadHistory]);

	// Server pushed "the watched git dir changed" → re-query (fs.watch makes
	// this instant for CLI/IDE changes; no polling needed when watch works).
	useEffect(() => {
		if (chat.scmDirty > 0 && active) refresh(false, true);
	}, [chat.scmDirty]); // eslint-disable-line react-hooks/exhaustive-deps

	// Poll fallback: fs.watch can fail on some filesystems; also catches
	// changes the watcher missed. Cheap — one execFile batch per interval.
	useEffect(() => {
		if (!active || !chat.ready || chat.status !== "open") return;
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			refresh(false, true);
		}, 30_000);
		return () => clearInterval(timer);
	}, [active, chat.ready, chat.status, refresh]);

	// Auto-refresh when a git write command finishes in its terminal tab —
	// the panel updates itself without the user having to switch views or
	// hit refresh. Matches every SCM-generated write op ("git …" titles).
	useEffect(() => {
		const prev = prevTerminalsRef.current;
		prevTerminalsRef.current = chat.terminals;
		if (!active) return;
		const finishedGitWrite = chat.terminals.some((tm) => {
			if (tm.running !== false) return false;
			const wasRunning = prev.find((p) => p.id === tm.id)?.running === true;
			return wasRunning && /^git /.test(tm.title);
		});
		if (finishedGitWrite && chat.ready && chat.status === "open") {
			refresh(false, true);
			// A finished write invalidates the loaded graph too.
			if (viewMode === "history" && status) loadHistory();
		}
	}, [chat.terminals, active, chat.ready, chat.status, refresh, viewMode, status, loadHistory]);

	/* ------------------------------------------------------------------ */
	/* render                                                             */
	/* ------------------------------------------------------------------ */

	const kindLabels: Record<FileKind, string> = {
		staged: t("scmStaged"),
		unstaged: t("scmUnstaged"),
		untracked: t("scmUntracked"),
		both: t("scmStagedUnstaged"),
	};

	const renderDiff = (text: string) => {
		const lines = text.split("\n");
		return (
			<pre className="scm-diff-pre">
				{lines.map((ln, i) => {
					let cls = "";
					if (
						ln.startsWith("diff --git") ||
						ln.startsWith("index ") ||
						ln.startsWith("new file") ||
						ln.startsWith("deleted file") ||
						ln.startsWith("old mode") ||
						ln.startsWith("new mode") ||
						ln.startsWith("similarity index") ||
						ln.startsWith("rename ") ||
						ln.startsWith("copy ") ||
						ln.startsWith("Binary files") ||
						ln.startsWith("---") ||
						ln.startsWith("+++")
					) {
						cls = "hdr";
					} else if (ln.startsWith("@@")) {
						cls = "hunk";
					} else if (ln.startsWith("+")) {
						cls = "add";
					} else if (ln.startsWith("-")) {
						cls = "del";
					}
					return (
						<div key={i} className={`scm-diff-line ${cls}`}>
							{ln || " "}
						</div>
					);
				})}
			</pre>
		);
	};

	return (
		<div className="scm-view">
			<div className="scm-header">
				<div className="scm-title-row">
					<span className="scm-title">
						<FiGitBranch />
						{t("scmTitle")}
					</span>
					<div className="scm-view-tabs" role="tablist">
						<button
							type="button"
							role="tab"
							aria-selected={viewMode === "changes"}
							className={viewMode === "changes" ? "active" : ""}
							onClick={() => {
								setViewMode("changes");
								setError(null);
							}}
						>
							{t("scmChanges")}
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={viewMode === "history"}
							className={viewMode === "history" ? "active" : ""}
							onClick={() => {
								setViewMode("history");
								setError(null);
							}}
						>
							{t("scmHistory")}
						</button>
					</div>
						<button
							type="button"
							className="panel-refresh"
							title={t("scmRefreshTip")}
							disabled={busy}
							onClick={() => refresh(true)}
						>
							<FiRefreshCw className={busy ? "scm-spin" : ""} />
						</button>
				</div>

				{/* branch + push/pull */}
				<div className="scm-row">
					<span className="scm-branch-current" title={t("scmCurrentBranch")}>
						<FiGitBranch />
						{status ? (status.detached ? t("scmDetached") : status.branch) : "…"}
						{status?.upstream && (
							<span className="scm-upstream">
								{status.upstreamGone
									? t("scmUpstreamGone")
									: status.ahead > 0 || status.behind > 0
										? t("scmAheadBehind", {
												ahead: status.ahead,
												behind: status.behind,
											})
										: status.upstream}
							</span>
						)}
					</span>
					<select
						className="scm-select"
						value={branchSel}
						disabled={notRepo || branches.length === 0}
						title={t("scmSwitchBranch")}
						onChange={(e) => setBranchSel(e.target.value)}
					>
						<option value="" disabled>
							{t("scmSelectBranch")}
						</option>
						{branches.filter((b) => !b.remote).map((b) => (
							<option key={b.name} value={b.name}>
								{b.current ? `* ${b.name}` : b.name}
							</option>
						))}
						{branches.some((b) => b.remote) && (
							<optgroup label={t("scmRemoteBranches")}>
								{branches.filter((b) => b.remote).map((b) => (
									<option key={b.name} value={b.name}>
										{b.name}
									</option>
								))}
							</optgroup>
						)}
					</select>
					<button
						type="button"
						className="btn"
						disabled={!branchSel || branchSel === status?.branch || notRepo}
						title={t("scmSwitchBranchTip", { branch: branchSel })}
						onClick={handleSwitch}
					>
						<FiGitBranch />
						{t("scmSwitch")}
					</button>
					<button
						type="button"
						className="btn"
						disabled={!status || status.detached || notRepo}
						title={t("scmPushTip")}
						onClick={handlePush}
					>
						<FiArrowUp />
						{t("scmPush")}
					</button>
					<button
						type="button"
						className="btn"
						disabled={!status || status.detached || notRepo}
						title={t("scmPullTip")}
						onClick={handlePull}
					>
						<FiArrowDown />
						{t("scmPull")}
					</button>
					<input
						className="scm-commit-input"
						value={commitMsg}
						placeholder={t("scmCommitPlaceholder")}
						disabled={notRepo}
						onChange={(e) => setCommitMsg(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.nativeEvent.isComposing) {
								handleCommit();
							}
						}}
					/>
					<button
						type="button"
						className="btn primary"
						disabled={!commitMsg.trim() || notRepo}
						title={t("scmCommitTip")}
						onClick={handleCommit}
					>
						<FiCheck />
						{t("scmCommit")}
					</button>
				</div>
			</div>

			{/* body: files + diff */}
			<div className="scm-body">
				{viewMode === "history" ? (
					<div className="scm-history">
						<div className="scm-files-header">
							<span>{t("scmHistory")}</span>
							{history.length > 0 && (
								<span className="scm-files-count">{history.length}</span>
							)}
						</div>
						<div className="scm-history-list">
							{notRepo ? (
								<div className="scm-empty">{t("scmNotGitRepo")}</div>
							) : !status || historyLoading ? (
								<div className="scm-empty">
									{chat.status === "open" ? t("scmLoading") : t("scmConnecting")}
								</div>
							) : history.length === 0 ? (
								<div className="scm-empty">{t("scmNoHistory")}</div>
							) : (
								history.map((commit) => (
									<button
										key={commit.hash}
										type="button"
										className={`scm-commit ${selectedCommit?.hash === commit.hash ? "active" : ""}`}
										onClick={() => showCommitDetail(commit)}
										title={commit.hash}
									>
										<span className="scm-commit-graph" aria-hidden="true">
											{commit.graph || "* "}
										</span>
										<span className="scm-commit-info">
											<span className="scm-commit-subject">{commit.subject}</span>
											<span className="scm-commit-meta">
												{commit.shortHash} · {commit.author} · {commit.date}
											</span>
											{commit.decorations && (
												<span className="scm-commit-refs">{commit.decorations}</span>
											)}
										</span>
									</button>
								))
							)}
						</div>
					</div>
				) : (
				<div className="scm-files">
					<div className="scm-files-header">
						<span>{t("scmChanges")}</span>
						{status && status.files.length > 0 && (
							<span className="scm-files-count">{status.files.length}</span>
						)}
					</div>
					<div className="scm-files-list">
						{notRepo ? (
							<div className="scm-empty">{t("scmNotGitRepo")}</div>
						) : !status ? (
							<div className="scm-empty">
								{chat.status === "open" ? t("scmLoading") : t("scmConnecting")}
							</div>
						) : status.files.length === 0 ? (
							<div className="scm-empty">{t("scmNoChanges")}</div>
						) : (
							status.files.map((f) => {
								const kind = fileKind(f);
								const st = statMap.get(f.path);
								return (
									<div
										key={f.path}
										className={`scm-file ${selected?.path === f.path ? "active" : ""}`}
										title={kindLabels[kind]}
										onClick={() => showFileDiff(f)}
									>
										<span
											className={`scm-file-xy ${kind === "untracked" ? "q" : "x"}`}
										>
											{f.x !== " " ? f.x : "\u00a0"}
										</span>
										<span
											className={`scm-file-xy ${kind === "untracked" ? "q" : "y"}`}
										>
											{f.y !== " " ? f.y : "\u00a0"}
										</span>
										<span className="scm-file-path">{f.path}</span>
										{st && (st.add > 0 || st.del > 0) && (
											<span className="scm-file-stat">
												{st.add > 0 && <span className="add">+{st.add}</span>}
												{st.del > 0 && <span className="del">-{st.del}</span>}
											</span>
										)}
										<span className="scm-file-actions">
											{(f.y !== " " || kind === "untracked") && (
												<button
													type="button"
													className="scm-act"
													title={t("scmStageTip", { path: f.path })}
													onClick={(e) => {
														e.stopPropagation();
														handleStage(f);
													}}
												>
													+
												</button>
											)}
											{kind === "staged" || kind === "both" ? (
												<button
													type="button"
													className="scm-act"
													title={t("scmUnstageTip", { path: f.path })}
													onClick={(e) => {
														e.stopPropagation();
														handleUnstage(f);
													}}
												>
													−
												</button>
											) : null}
										</span>
									</div>
								);
							})
						)}
					</div>
				</div>
				)}

				<div className="scm-diff">
					<div className="scm-diff-header">
						<span>
							{viewMode === "history"
								? selectedCommit
									? `${selectedCommit.shortHash} ${selectedCommit.subject}`
									: t("scmCommitDetail")
								: selected
									? selected.path
									: t("scmDiff")}
						</span>
						{(viewMode === "history" ? commitLoading : diffLoading) && (
							<span className="scm-diff-loading">{t("scmLoading")}</span>
						)}
					</div>
					<div className="scm-diff-body">
						{viewMode === "history" ? (
							<>
								{error && <div className="scm-error">{error}</div>}
								{!selectedCommit && !error && (
									<div className="scm-empty">{t("scmSelectCommitHint")}</div>
								)}
								{selectedCommit && commitLoading && !error && (
									<div className="scm-empty">{t("scmLoading")}</div>
								)}
								{selectedCommit && !commitLoading && !error && commitDetail
									? renderDiff(commitDetail)
									: null}
							</>
						) : (
							<>
								{error && <div className="scm-error">{error}</div>}
								{!selected && !error && (
									<div className="scm-empty">{t("scmSelectFileHint")}</div>
								)}
								{selected && !fileDiff && !error && (
									<div className="scm-empty">{t("scmLoading")}</div>
								)}
								{selected && fileDiff && fileDiff.untracked && (
									<div className="scm-empty">{t("scmUntrackedNote")}</div>
								)}
								{selected && fileDiff && !fileDiff.untracked && (
									<>
										{fileDiff.staged && (
											<>
												<div className="scm-diff-section">{t("scmStaged")}</div>
												{renderDiff(fileDiff.staged)}
											</>
										)}
										{fileDiff.worktree && (
											<>
												<div className="scm-diff-section">{t("scmUnstaged")}</div>
												{renderDiff(fileDiff.worktree)}
											</>
										)}
										{!fileDiff.staged && !fileDiff.worktree && (
											<div className="scm-empty">{t("scmNoDiff")}</div>
										)}
									</>
								)}
							</>
						)}
					</div>
				</div>
			</div>

			<div className="scm-hint">
				<FiTerminal />
				<span>{t("scmRunsInTerminal")}</span>
				<button type="button" className="scm-goto-term" onClick={onSwitchToTerminal}>
					{t("scmViewTerminal")}
				</button>
			</div>
		</div>
	);
}
