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
	register: (conversationId: string, id: string, writer: { write(data: string): void; dispose(): void }) => () => void;
	restart: (id: string) => void;
	select: (id: string) => void;
}

export interface ScmPanelProps {
	chat: ChatState;
	terminal: ScmTerminalBridge;
	/** True when this view is currently visible (drives auto-refresh). */
	active: boolean;
	/** Switch the top-level view to the terminal (write ops run there). */
	onSwitchToTerminal: () => void;
	/** `scm.toolbar` 槽位的最终条目（全量，含 hidden；宿主 chrome + 插件按槽位顺序合并渲染）。
	 *  不传 = 未接线，回落默认顺序（与旧硬编码一致）。 */
	uiScmToolbar?: UiSlotEntry[];
	/** 点击一条工具条目：交回 App 分发给贡献它的插件（与顶栏 onUiAction 同通道）。 */
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
	// 「AI 生成提交信息」：一次性补全耗时不定（秒级到十秒级），独立于 git
	// 查询的 busy/error，错误展示在提交输入行下方（靠近触发按钮）。
	const [genLoading, setGenLoading] = useState(false);
	const [genError, setGenError] = useState<string | null>(null);
	// 左栏（改动文件 / 提交历史）宽度：拖动分隔条调整、双击复位，跨会话记忆
	// （issue #139）。存档只在拖动结束时写入，拖拽过程中只改内存状态。
	const [sidebarWidth, setSidebarWidth] = useState(() =>
		parseScmSidebarWidth(localStorage.getItem(SCM_SIDEBAR_WIDTH_KEY)),
	);
	const [commitMsg, setCommitMsg] = useState("");
	// 提交树过滤框（纯前端过滤主题/作者/hash，随历史重查与切工作区重置）。
	const [historyFilter, setHistoryFilter] = useState("");
	// 提交信息历史（localStorage，最近 20 条）与 ↑/↓ 回溯游标。
	const [commitHistory, setCommitHistory] = useState<string[]>(() => loadCommitHistory());
	const recallRef = useRef<CommitRecallState>(COMMIT_RECALL_INITIAL);

	/** Monotonic request id — responses are matched per pending slot below. */
	const seqRef = useRef(0);
	const statusReqRef = useRef(-1);
	const diffReqRef = useRef(-1);
	const commitReqRef = useRef(-1);
	const historyReqRef = useRef(-1);
	const genReqRef = useRef(-1);
	/** Cwd the last refresh ran against — a workspace switch resets state. */
	const lastCwdRef = useRef<string | undefined>(undefined);
	/** The file whose diff is in flight (scm_data carries no request context). */
	const selectedFileRef = useRef<ScmFile | null>(null);
	/** Terminal tab list snapshot — detects git write-command completion. */
	const prevTerminalsRef = useRef<TerminalMeta[]>([]);

	// ---- 左栏宽度拖拽（issue #139）：量容器 → 夹取 → 松手写存档 ----
	const sidebarWidthRef = useRef(sidebarWidth);
	sidebarWidthRef.current = sidebarWidth;
	/** `.scm-body`：拖拽时量它的宽度，给 diff 区留出最小宽度。 */
	const bodyRef = useRef<HTMLDivElement | null>(null);

	/** 记住宽度（拖动结束 / 双击复位时各写一次，过程中不写）。 */
	const persistSidebarWidth = useCallback((width: number) => {
		try {
			localStorage.setItem(SCM_SIDEBAR_WIDTH_KEY, String(width));
		} catch {
			// 隐私模式 / 配额满：写不进去就只管本次会话
		}
	}, []);

	/** 拖动分隔条：左栏右边界跟随指针，双击复位由分隔条的 onDoubleClick 负责。 */
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

	/** 双击分隔条 → 回默认宽度（同样写存档，刷新后不会又跳回拖出来的宽度）。 */
	const resetSidebarWidth = useCallback(() => {
		setSidebarWidth(SCM_SIDEBAR_DEFAULT);
		persistSidebarWidth(SCM_SIDEBAR_DEFAULT);
	}, [persistSidebarWidth]);

	/**
	 * Apply an scm_data response that matches one of our in-flight requests.
	 * The server answers every request exactly once (ok or error), so loading
	 * states always settle — no queues or timeouts needed on this side.
	 */
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
			// Remote-tracking ref: create a local branch tracking it (falls back
			// to a plain checkout when the local branch already exists).
			const localName = branchSel.slice(entry.remote.length + 1);
			runGitCommand("git checkout", `git checkout -b ${localName} ${branchSel} || git checkout ${branchSel}`);
		} else {
			runGitCommand("git checkout", `git checkout ${branchSel}`);
		}
	}, [branchSel, branches, notRepo, runGitCommand]);

	const handlePush = useCallback(() => runGitCommand("git push", "git push"), [runGitCommand]);
	const handlePull = useCallback(() => runGitCommand("git pull", "git pull"), [runGitCommand]);

	/** 「AI 生成」：服务端用当前模型对暂存（无暂存则全部）改动做一次性补全，
	 *  结果直接填进提交输入框（覆盖旧草稿——按钮语义就是“重新生成”）。
	 *  进行中禁用按钮防止并发；失败错误显示在输入行下方。 */
	const handleGenCommitMsg = useCallback(() => {
		if (genLoading || notRepo || !chat.ready || chat.status !== "open") return;
		setGenError(null);
		if (!sendScm({ type: "scm_commitmsg" }, genReqRef)) {
			setGenError(t("scmGenMsgFail"));
		} else {
			setGenLoading(true);
		}
	}, [genLoading, notRepo, chat.ready, chat.status, sendScm, t]);

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
			return wasRunning && tm.title.startsWith("git ");
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

	// 提交树过滤（主题/作者/hash/decorations，空格分隔 AND；空查询原样返回）。
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

	/** ---- 槽位合并：头栏簇（视图 tab/刷新 + 插件）与分支行簇（分支/推送/提交…）分别按槽位排序；
	 *  未接线用默认顺序（与旧硬编码一致）。分支名展示是纯信息（不进槽位），提交输入框可调序。 ---- */
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
	/** 某簇要画的条目：该簇宿主 id + 头栏簇的插件条目（插件 historically 只落头栏，分支行保持宿主）。 */
	const scmZone = (ids: string[], withPlugins: boolean): UiSlotEntry[] => {
		const set = new Set(ids);
		return allScmEntries.filter((e) => set.has(e.id) || (withPlugins && e.source !== "host"));
	};
	const scmShow = (id: string): boolean =>
		uiScmToolbar === undefined || !uiScmToolbar.some((e) => e.id === id && e.hidden);
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
				{t("scmChanges")}
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
				{t("scmHistory")}
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
				title={t("scmSwitchBranch")}
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
				{t("scmSwitch")}
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
				{t("scmPush")}
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
				{t("scmPull")}
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
					// 用户手动编辑即退出回溯态（草稿已无意义）。
					recallRef.current = COMMIT_RECALL_INITIAL;
				}}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing) return;
					if (e.key === "Enter") {
						handleCommit();
						return;
					}
					// ↑/↓ 回溯最近用过的提交信息（shell 风格；↑ 记住当前草稿，↓ 退回）。
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
				{genLoading ? t("scmGenMsgRunning") : t("scmGenMsg")}
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
				{t("scmCommit")}
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
				{t("scmCommitAll")}
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
						{/* 视图 tab 按槽位顺序（changes/history 互换）。 */}
						{renderMergedToolbar(scmZone(["host:scm-changes", "host:scm-history"], false), scmHostNodes, onUiAction)}
					</div>
					{/* 刷新 + 插件按槽位顺序（插件 historically 落头栏）。 */}
					{renderMergedToolbar(scmZone(["host:scm-refresh"], true), scmHostNodes, onUiAction)}
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
					{/* 分支行：分支选择/切换/推送/拉取/提交输入/AI 生成/提交/提交全部按槽位顺序（插件 historically 只落头栏）。 */}
					{renderMergedToolbar(scmZone(SCM_ROW_IDS, false), scmHostNodes, onUiAction)}
				</div>

				{/* AI 生成提交信息的失败提示：紧贴触发它的按钮（点击关闭）。 */}
				{genError && (
					<div className="scm-gen-error" role="alert" title={t("close")} onClick={() => setGenError(null)}>
						{genError}
					</div>
				)}
			</div>

			{/* body: files + diff */}
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

				{/* 左栏 ↔ diff 之间的拖拽分隔条（issue #139）。 */}
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
						{t("scmViewTerminal")}
					</button>
				)}
			</div>
		</div>
	);
}
