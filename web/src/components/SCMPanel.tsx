import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { FiArrowDown, FiArrowUp, FiCheck, FiCpu, FiGitBranch, FiRefreshCw, FiTerminal } from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { ClientMessage, CommandDef, ServerMessage } from "../types";
import { randomUuid } from "../uuid";
import { quotePath } from "../scm-quote";
import { clampScmSidebarWidth, parseScmSidebarWidth, SCM_SIDEBAR_DEFAULT, SCM_SIDEBAR_WIDTH_KEY } from "../scm-sidebar";
import { filterScmCommits } from "../scm-history-filter";
import {
	COMMIT_RECALL_INITIAL,
	cycleCommitRecall,
	loadCommitHistory,
	rememberCommitMessage,
	type CommitRecallState,
} from "../scm-commit-history";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import type { UiSlotEntry } from "../ui-slots";
import { renderMergedToolbar } from "../slot-toolbar";

interface ScmFile {
	path: string;
	x: string;
	y: string;
}

interface ScmStatus {
	branch: string;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	upstreamGone: boolean;
	files: ScmFile[];
}

interface ScmBranch {
	name: string;
	current: boolean;
	remote?: string | boolean;
}

interface ScmCommit {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	subject: string;
	decorations: string;
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
	register: (conversationId: string, id: string, writer: { write(data: string): void; dispose(): void }) => () => void;
	restart: (id: string) => void;
	select: (id: string) => void;
}

interface ScmPanelProps {
	chat: ChatState;
	terminal: ScmTerminalBridge;
	active: boolean;
	onSwitchToTerminal: () => void;
	uiScmToolbar?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry) => void;
}

export function ScmPanel({ chat, terminal, active, onSwitchToTerminal, uiScmToolbar, onUiAction }: ScmPanelProps) {
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
	const [genLoading, setGenLoading] = useState(false);
	const [genError, setGenError] = useState<string | null>(null);
	const [sidebarWidth, setSidebarWidth] = useState(() =>
		parseScmSidebarWidth(localStorage.getItem(SCM_SIDEBAR_WIDTH_KEY)),
	);
	const [commitMsg, setCommitMsg] = useState("");
	const [historyFilter, setHistoryFilter] = useState("");
	const [commitHistory, setCommitHistory] = useState<string[]>(() => loadCommitHistory());
	const recallRef = useRef<CommitRecallState>(COMMIT_RECALL_INITIAL);

	const seqRef = useRef(0);
	const statusReqRef = useRef(-1);
	const diffReqRef = useRef(-1);
	const commitReqRef = useRef(-1);
	const historyReqRef = useRef(-1);
	const genReqRef = useRef(-1);
	const lastCwdRef = useRef<string | undefined>(undefined);
	const selectedFileRef = useRef<ScmFile | null>(null);
	const prevTerminalsRef = useRef<TerminalMeta[]>([]);

	const sidebarWidthRef = useRef(sidebarWidth);
	sidebarWidthRef.current = sidebarWidth;
	const bodyRef = useRef<HTMLDivElement | null>(null);

	const persistSidebarWidth = useCallback((width: number) => {
		try {
			localStorage.setItem(SCM_SIDEBAR_WIDTH_KEY, String(width));
		} catch {}
	}, []);

	const onDividerPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			const startX = e.clientX;
			const startWidth = sidebarWidthRef.current;
			const containerPx = bodyRef.current?.getBoundingClientRect().width ?? 0;
			let last = startWidth;
			const move = (ev: PointerEvent) => {
				last = clampScmSidebarWidth(startWidth + (ev.clientX - startX), containerPx);
				setSidebarWidth(last);
			};
			const up = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", up);
				document.body.classList.remove("panel-resizing");
				persistSidebarWidth(last);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", up);
			document.body.classList.add("panel-resizing");
		},
		[persistSidebarWidth],
	);

	const resetSidebarWidth = useCallback(() => {
		setSidebarWidth(SCM_SIDEBAR_DEFAULT);
		persistSidebarWidth(SCM_SIDEBAR_DEFAULT);
	}, [persistSidebarWidth]);

	const applyScmData = useCallback((data: Extract<ServerMessage, { type: "scm_data" }>) => {
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
			setFileDiff((prev) => (prev && !st.files.some((f) => f.path === prev.file.path) ? null : prev));
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
		} else if (data.reqId === genReqRef.current) {
			genReqRef.current = -1;
			setGenLoading(false);
			if (!data.ok) {
				setGenError(data.error ?? t("scmGenMsgFail"));
				return;
			}
			setGenError(null);
			setCommitMsg(data.text ?? "");
		}
	}, []);

	useEffect(() => {
		const data = chat.scmData;
		if (data && data.type === "scm_data") applyScmData(data);
	}, [chat.scmData, applyScmData]);

	const sendScm = useCallback(
		(
			msg:
				| { type: "scm_status" }
				| { type: "scm_history" }
				| { type: "scm_filediff"; path: string }
				| { type: "scm_commit"; hash: string }
				| { type: "scm_commitmsg" },
			slot: React.MutableRefObject<number>,
		): boolean => {
			if (!chat.ready || chat.status !== "open") return false;
			const id = ++seqRef.current;
			if (!appSend({ ...msg, reqId: id } as ClientMessage)) {
				seqRef.current -= 1;
				return false;
			}
			slot.current = id;
			return true;
		},
		[chat.ready, chat.status],
	);

	const refresh = useCallback(
		(manual = false, silent = false) => {
			if (!chat.ready || chat.status !== "open") return;
			if (!chat.state?.cwd) return;
			if (lastCwdRef.current !== undefined && lastCwdRef.current !== chat.state.cwd) {
				setStatus(null);
				setBranches([]);
				setStatMap(new Map());
				setHistory([]);
				setHistoryFilter("");
				setHistoryLoading(false);
				historyReqRef.current = -1;
				setSelectedCommit(null);
				setCommitDetail("");
				setFileDiff(null);
				setSelected(null);
				setGenError(null);
				setGenLoading(false);
				genReqRef.current = -1;
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

	const runGitCommand = useCallback(
		(title: string, command: string) => {
			if (!chat.ready) return;
			const def: CommandDef = { name: title, command, cwd: "${pwd}" };
			let targetId: string;
			const existing = chat.terminals.find((tm) => tm.title === title);
			if (existing) {
				terminal.restart(existing.id);
				appSend({
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
		[chat.ready, chat.state?.cwd, chat.terminals, onSwitchToTerminal, terminal],
	);

	const handleCommit = useCallback(() => {
		const msg = commitMsg.trim();
		if (!msg || notRepo) return;
		const escaped = msg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
		runGitCommand("git commit", `git commit -m "${escaped}"`);
		setCommitHistory(rememberCommitMessage(msg));
		setCommitMsg("");
		recallRef.current = COMMIT_RECALL_INITIAL;
	}, [commitMsg, notRepo, runGitCommand]);

	const handleCommitAll = useCallback(() => {
		const msg = commitMsg.trim();
		if (!msg || notRepo) return;
		const escaped = msg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
		runGitCommand("git commit", `git add -A && git commit -m "${escaped}"`);
		setCommitHistory(rememberCommitMessage(msg));
		setCommitMsg("");
		recallRef.current = COMMIT_RECALL_INITIAL;
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
			const localName = branchSel.slice(entry.remote.length + 1);
			runGitCommand("git checkout", `git checkout -b ${localName} ${branchSel} || git checkout ${branchSel}`);
		} else {
			runGitCommand("git checkout", `git checkout ${branchSel}`);
		}
	}, [branchSel, branches, notRepo, runGitCommand]);

	const handlePush = useCallback(() => runGitCommand("git push", "git push"), [runGitCommand]);
	const handlePull = useCallback(() => runGitCommand("git pull", "git pull"), [runGitCommand]);

	const handleGenCommitMsg = useCallback(() => {
		if (genLoading || notRepo || !chat.ready || chat.status !== "open") return;
		setGenError(null);
		if (!sendScm({ type: "scm_commitmsg" }, genReqRef)) {
			setGenError(t("scmGenMsgFail"));
		} else {
			setGenLoading(true);
		}
	}, [genLoading, notRepo, chat.ready, chat.status, sendScm, t]);

	const loadHistory = useCallback(() => {
		if (!sendScm({ type: "scm_history" }, historyReqRef)) {
			historyReqRef.current = -1;
		}
	}, [sendScm]);

	useEffect(() => {
		if (active) refresh();
	}, [active, refresh]);

	useEffect(() => {
		if (viewMode === "history" && status) loadHistory();
	}, [viewMode, status, loadHistory]);

	useEffect(() => {
		if (chat.scmDirty > 0 && active) refresh(false, true);
	}, [chat.scmDirty]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		if (!active || !chat.ready || chat.status !== "open") return;
		const timer = setInterval(() => {
			if (document.visibilityState === "hidden") return;
			refresh(false, true);
		}, 30_000);
		return () => clearInterval(timer);
	}, [active, chat.ready, chat.status, refresh]);

	useEffect(() => {
		const prev = prevTerminalsRef.current;
		prevTerminalsRef.current = chat.terminals;
		if (!active) return;
		const finishedGitWrite = chat.terminals.some((tm) => {
			if (tm.running !== false) return false;
			const wasRunning = prev.find((p) => p.id === tm.id)?.running === true;
			return wasRunning && tm.title.startsWith("git ");
		});
		if (finishedGitWrite && chat.ready && chat.status === "open") {
			refresh(false, true);
			if (viewMode === "history" && status) loadHistory();
		}
	}, [chat.terminals, active, chat.ready, chat.status, refresh, viewMode, status, loadHistory]);

	const kindLabels: Record<FileKind, string> = {
		staged: t("scmStaged"),
		unstaged: t("scmUnstaged"),
		untracked: t("scmUntracked"),
		both: t("scmStagedUnstaged"),
	};

	const filteredHistory = filterScmCommits(history, historyFilter);

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

	const SCM_DEFAULT_ORDER = [
		"host:scm-changes",
		"host:scm-history",
		"host:scm-refresh",
		"host:scm-branch",
		"host:scm-switch",
		"host:scm-push",
		"host:scm-pull",
		"host:scm-input",
		"host:scm-genmsg",
		"host:scm-commit",
		"host:scm-commit-all",
		"host:scm-term",
	];
	const allScmEntries: UiSlotEntry[] =
		uiScmToolbar === undefined
			? SCM_DEFAULT_ORDER.map((id) => ({ id, source: "host" }) as UiSlotEntry)
			: uiScmToolbar.filter((e) => !e.hidden);
	const SCM_ROW_IDS = [
		"host:scm-branch",
		"host:scm-switch",
		"host:scm-push",
		"host:scm-pull",
		"host:scm-input",
		"host:scm-genmsg",
		"host:scm-commit",
		"host:scm-commit-all",
	];
	const scmZone = (ids: string[], withPlugins: boolean): UiSlotEntry[] => {
		const set = new Set(ids);
		return allScmEntries.filter((e) => set.has(e.id) || (withPlugins && e.source !== "host"));
	};
	const scmShow = (id: string): boolean =>
		uiScmToolbar === undefined || !uiScmToolbar.some((e) => e.id === id && e.hidden);
	const scmLabel = (id: string, fallback: string): string => {
		const e = allScmEntries.find((x) => x.id === id);
		return e?.labelExplicit ? e.label : fallback;
	};
	const scmHostNodes: Record<string, ReactNode> = {
		"host:scm-changes": (
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
				{scmLabel("host:scm-changes", t("scmChanges"))}
			</button>
		),
		"host:scm-history": (
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
				{scmLabel("host:scm-history", t("scmHistory"))}
			</button>
		),
		"host:scm-refresh": (
			<button
				type="button"
				className="panel-refresh"
				title={t("scmRefreshTip")}
				disabled={busy}
				onClick={() => refresh(true)}
			>
				<FiRefreshCw className={busy ? "scm-spin" : ""} />
			</button>
		),
		"host:scm-branch": (
			<select
				className="scm-select"
				value={branchSel}
				disabled={notRepo || branches.length === 0}
				title={scmLabel("host:scm-branch", t("scmSwitchBranch"))}
				onChange={(e) => setBranchSel(e.target.value)}
			>
				<option value="" disabled>
					{t("scmSelectBranch")}
				</option>
				{branches
					.filter((b) => !b.remote)
					.map((b) => (
						<option key={b.name} value={b.name}>
							{b.current ? `* ${b.name}` : b.name}
						</option>
					))}
				{branches.some((b) => b.remote) && (
					<optgroup label={t("scmRemoteBranches")}>
						{branches
							.filter((b) => b.remote)
							.map((b) => (
								<option key={b.name} value={b.name}>
									{b.name}
								</option>
							))}
					</optgroup>
				)}
			</select>
		),
		"host:scm-switch": (
			<button
				type="button"
				className="btn"
				disabled={!branchSel || branchSel === status?.branch || notRepo}
				title={t("scmSwitchBranchTip", { branch: branchSel })}
				onClick={handleSwitch}
			>
				<FiGitBranch />
				{scmLabel("host:scm-switch", t("scmSwitch"))}
			</button>
		),
		"host:scm-push": (
			<button
				type="button"
				className="btn"
				disabled={!status || status.detached || notRepo}
				title={t("scmPushTip")}
				onClick={handlePush}
			>
				<FiArrowUp />
				{scmLabel("host:scm-push", t("scmPush"))}
			</button>
		),
		"host:scm-pull": (
			<button
				type="button"
				className="btn"
				disabled={!status || status.detached || notRepo}
				title={t("scmPullTip")}
				onClick={handlePull}
			>
				<FiArrowDown />
				{scmLabel("host:scm-pull", t("scmPull"))}
			</button>
		),
		"host:scm-input": (
			<input
				className="scm-commit-input"
				value={commitMsg}
				placeholder={t("scmCommitPlaceholder")}
				disabled={notRepo}
				title={commitHistory.length > 0 ? t("scmCommitHistoryTip") : undefined}
				onChange={(e) => {
					setCommitMsg(e.target.value);
					recallRef.current = COMMIT_RECALL_INITIAL;
				}}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter") {
						handleCommit();
						return;
					}
					if (e.key === "ArrowUp" || e.key === "ArrowDown") {
						const hit = cycleCommitRecall(
							commitHistory,
							recallRef.current,
							commitMsg,
							e.key === "ArrowUp" ? "up" : "down",
						);
						if (hit) {
							e.preventDefault();
							recallRef.current = hit.state;
							setCommitMsg(hit.text);
						}
					}
				}}
			/>
		),
		"host:scm-genmsg": (
			<button
				type="button"
				className="btn"
				disabled={genLoading || notRepo || !status || status.files.length === 0}
				title={t("scmGenMsgTip")}
				onClick={handleGenCommitMsg}
			>
				<FiCpu className={genLoading ? "scm-spin" : ""} />
				{genLoading ? t("scmGenMsgRunning") : scmLabel("host:scm-genmsg", t("scmGenMsg"))}
			</button>
		),
		"host:scm-commit": (
			<button
				type="button"
				className="btn primary"
				disabled={!commitMsg.trim() || notRepo}
				title={t("scmCommitTip")}
				onClick={handleCommit}
			>
				<FiCheck />
				{scmLabel("host:scm-commit", t("scmCommit"))}
			</button>
		),
		"host:scm-commit-all": (
			<button
				type="button"
				className="btn"
				disabled={!commitMsg.trim() || notRepo}
				title={t("scmCommitAllTip")}
				onClick={handleCommitAll}
			>
				{scmLabel("host:scm-commit-all", t("scmCommitAll"))}
			</button>
		),
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
						{renderMergedToolbar(scmZone(["host:scm-changes", "host:scm-history"], false), scmHostNodes, onUiAction)}
					</div>
					{renderMergedToolbar(scmZone(["host:scm-refresh"], true), scmHostNodes, onUiAction)}
				</div>

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
					{renderMergedToolbar(scmZone(SCM_ROW_IDS, false), scmHostNodes, onUiAction)}
				</div>

				{genError && (
					<div className="scm-gen-error" role="alert" title={t("close")} onClick={() => setGenError(null)}>
						{genError}
					</div>
				)}
			</div>

			<div className="scm-body" ref={bodyRef} style={{ "--scm-sidebar-w": `${sidebarWidth}px` } as CSSProperties}>
				{viewMode === "history" ? (
					<div className="scm-history">
						<div className="scm-files-header">
							<span>{t("scmHistory")}</span>
							{history.length > 0 && (
								<span className="scm-files-count">
									{historyFilter.trim() ? `${filteredHistory.length}/${history.length}` : history.length}
								</span>
							)}
						</div>
						{history.length > 0 && !notRepo && (
							<input
								className="scm-history-filter"
								value={historyFilter}
								placeholder={t("scmHistoryFilterPlaceholder")}
								title={t("scmHistoryFilterTip")}
								onChange={(e) => setHistoryFilter(e.target.value)}
							/>
						)}
						<div className="scm-history-list">
							{notRepo ? (
								<div className="scm-empty">{t("scmNotGitRepo")}</div>
							) : !status || historyLoading ? (
								<div className="scm-empty">{chat.status === "open" ? t("scmLoading") : t("scmConnecting")}</div>
							) : history.length === 0 ? (
								<div className="scm-empty">{t("scmNoHistory")}</div>
							) : filteredHistory.length === 0 ? (
								<div className="scm-empty">{t("scmHistoryFilterEmpty")}</div>
							) : (
								filteredHistory.map((commit) => (
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
											{commit.decorations && <span className="scm-commit-refs">{commit.decorations}</span>}
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
							{status && status.files.length > 0 && <span className="scm-files-count">{status.files.length}</span>}
						</div>
						<div className="scm-files-list">
							{notRepo ? (
								<div className="scm-empty">{t("scmNotGitRepo")}</div>
							) : !status ? (
								<div className="scm-empty">{chat.status === "open" ? t("scmLoading") : t("scmConnecting")}</div>
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
											<span className={`scm-file-xy ${kind === "untracked" ? "q" : "x"}`}>
												{f.x !== " " ? f.x : "\u00a0"}
											</span>
											<span className={`scm-file-xy ${kind === "untracked" ? "q" : "y"}`}>
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

				<div
					className="scm-divider"
					role="separator"
					aria-orientation="vertical"
					title={t("dragToResize")}
					onPointerDown={onDividerPointerDown}
					onDoubleClick={resetSidebarWidth}
				/>

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
								{!selectedCommit && !error && <div className="scm-empty">{t("scmSelectCommitHint")}</div>}
								{selectedCommit && commitLoading && !error && <div className="scm-empty">{t("scmLoading")}</div>}
								{selectedCommit && !commitLoading && !error && commitDetail ? renderDiff(commitDetail) : null}
							</>
						) : (
							<>
								{error && <div className="scm-error">{error}</div>}
								{!selected && !error && <div className="scm-empty">{t("scmSelectFileHint")}</div>}
								{selected && !fileDiff && !error && <div className="scm-empty">{t("scmLoading")}</div>}
								{selected && fileDiff && fileDiff.untracked && <div className="scm-empty">{t("scmUntrackedNote")}</div>}
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
										{!fileDiff.staged && !fileDiff.worktree && <div className="scm-empty">{t("scmNoDiff")}</div>}
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
				{scmShow("host:scm-term") && (
					<button type="button" className="scm-goto-term" onClick={onSwitchToTerminal}>
						{scmLabel("host:scm-term", t("scmViewTerminal"))}
					</button>
				)}
			</div>
		</div>
	);
}
