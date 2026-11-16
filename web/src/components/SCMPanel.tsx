import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	FiArrowDown,
	FiArrowUp,
	FiCheck,
	FiChevronDown,
	FiChevronLeft,
	FiCommand,
	FiCpu,
	FiGitBranch,
	FiRefreshCw,
	FiTerminal,
	FiTrash2,
	FiX,
	FiZap,
} from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { ClientMessage, CommandDef, ServerMessage } from "../types";
import { randomUuid } from "../uuid";
import { quotePath } from "../scm-quote";
import { clampScmSidebarWidth, parseScmSidebarWidth, SCM_SIDEBAR_DEFAULT, SCM_SIDEBAR_WIDTH_KEY } from "../scm-sidebar";
import { filterScmCommits } from "../scm-history-filter";
import { scmFileKind, splitScmFiles, sumScmStats } from "../scm-file-kind";
import { buildScmPaletteActions, type ScmPaletteAction } from "../scm-palette-actions";
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
import { Dropdown } from "./Dropdown";
import { ScmChangesList } from "./scm/ScmChangesList";
import { ScmCommandPalette } from "./scm/ScmCommandPalette";
import "../scm-panel.css";

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

function isDiffMetaLine(ln: string): boolean {
	return (
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
	);
}

function estimateDiffStats(text: string): { add: number; del: number; hunks: number } {
	let add = 0;
	let del = 0;
	let hunks = 0;
	for (const ln of text.split("\n")) {
		if (ln.startsWith("@@")) {
			hunks += 1;
		} else if (ln.startsWith("+++") || ln.startsWith("---")) {
			continue;
		} else if (ln.startsWith("+")) {
			add += 1;
		} else if (ln.startsWith("-")) {
			del += 1;
		}
	}
	return { add, del, hunks };
}

function estimateMultiDiffStats(texts: string[]): { add: number; del: number; hunks: number } {
	let add = 0;
	let del = 0;
	let hunks = 0;
	for (const text of texts) {
		if (!text) continue;
		const s = estimateDiffStats(text);
		add += s.add;
		del += s.del;
		hunks += s.hunks;
	}
	return { add, del, hunks };
}

interface ScmStashEntry {
	ref: string;
	message: string;
}

interface ScmBlameLine {
	hash: string;
	shortHash: string;
	author: string;
	date: string;
	lineNo: number;
	content: string;
}

function stripAnsiForScm(s: string): string {
	return (
		s
			.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
			.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
			.replace(/\x1b\(B/g, "")
			// bash/readline 会在行首插 DEC 双字符序列（\x1b> = DECKPNM、\x1b= = DECKPAM），
			// 它们会跟着 git 输出一起进缓冲：不去掉的话 marker 行永远配不上（追溯/储藏列表解析不出东西）。
			.replace(/\x1b[=>NO78c]/g, "")
			.replace(/\x1b/g, "")
			.replace(/\r/g, "")
	);
}

function parseStashListText(text: string): ScmStashEntry[] {
	const out: ScmStashEntry[] = [];
	for (const raw of stripAnsiForScm(text).split("\n")) {
		const ln = raw.trim();
		if (!ln) continue;
		const m = /^(stash@\{\d+\}):\s*(.*)$/.exec(ln);
		if (m) out.push({ ref: m[1], message: m[2] });
	}
	return out;
}

function formatBlameDate(authorTimeSec: number): string {
	if (!Number.isFinite(authorTimeSec) || authorTimeSec <= 0) return "";
	try {
		return new Date(authorTimeSec * 1000).toISOString().slice(0, 10);
	} catch {
		return "";
	}
}

function parseBlamePorcelainText(text: string): ScmBlameLine[] {
	const clean = stripAnsiForScm(text);
	const lines = clean.split("\n");
	const out: ScmBlameLine[] = [];
	let hash = "";
	let author = "";
	let authorTime = 0;
	let finalStart = 0;
	let blockCount = 0;
	let inBlock = false;
	const flushContent = (content: string) => {
		if (!inBlock || blockCount <= 0) return;
		const lineNo = finalStart + blockCountConsumedRef.value;
		out.push({
			hash,
			shortHash: /^[0]+$/.test(hash) ? "0000000" : hash.slice(0, 7),
			author: author || "?",
			date: formatBlameDate(authorTime),
			lineNo,
			content,
		});
		blockCountConsumedRef.value += 1;
	};
	const blockCountConsumedRef = { value: 0 };
	for (const raw of lines) {
		const ln = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		const hm = /^([0-9a-f]{40}|0{40}) \d+ (\d+) (\d+)$/.exec(ln);
		if (hm) {
			hash = hm[1];
			author = "";
			authorTime = 0;
			finalStart = Number(hm[2]);
			blockCount = Number(hm[3]);
			blockCountConsumedRef.value = 0;
			inBlock = true;
			continue;
		}
		if (!inBlock) continue;
		if (ln.startsWith("author ") && !ln.startsWith("author-mail") && !ln.startsWith("author-time")) {
			author = ln.slice("author ".length);
			continue;
		}
		if (ln.startsWith("author-time ")) {
			authorTime = Number(ln.slice("author-time ".length).trim());
			continue;
		}
		if (ln.startsWith("\t")) {
			flushContent(ln.slice(1));
			if (blockCountConsumedRef.value >= blockCount) {
				inBlock = false;
			}
			continue;
		}
		if (ln.startsWith("filename ")) continue;
		if (ln.startsWith("boundary")) continue;
	}
	return out.slice(0, 3000);
}

function isValidBranchName(name: string): boolean {
	if (!name || name.length > 200) return false;
	if (/\s/.test(name)) return false;
	if (name.includes("..")) return false;
	if (/[~^:?*\\[\]]/.test(name)) return false;
	if (name.startsWith("/") || name.endsWith("/")) return false;
	if (name.includes("//")) return false;
	if (name.endsWith(".lock") || name.endsWith(".")) return false;
	if (name.startsWith("-") || name.includes("@{")) return false;
	return /^[A-Za-z0-9._/-]+$/.test(name);
}

function parseHunkHeader(ln: string): { oldStart: number; newStart: number } | null {
	const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
	if (!m) return null;
	return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

type SideCell = { no: number | null; text: string; kind: "ctx" | "add" | "del" | "empty" };
type SideRow = { kind: "hdr" | "hunk"; text: string } | { kind: "pair"; left: SideCell; right: SideCell };

function buildSideRows(text: string): SideRow[] {
	const rows: SideRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	let haveNos = false;
	let pendingDel: { no: number | null; text: string }[] = [];
	let pendingAdd: { no: number | null; text: string }[] = [];
	const flush = () => {
		const n = Math.max(pendingDel.length, pendingAdd.length);
		for (let i = 0; i < n; i++) {
			const d = pendingDel[i];
			const a = pendingAdd[i];
			rows.push({
				kind: "pair",
				left: d ? { no: d.no, text: d.text, kind: "del" } : { no: null, text: "", kind: "empty" },
				right: a ? { no: a.no, text: a.text, kind: "add" } : { no: null, text: "", kind: "empty" },
			});
		}
		pendingDel = [];
		pendingAdd = [];
	};
	for (const ln of text.split("\n")) {
		if (ln.startsWith("@@")) {
			flush();
			const p = parseHunkHeader(ln);
			if (p) {
				oldLine = p.oldStart;
				newLine = p.newStart;
				haveNos = true;
			}
			rows.push({ kind: "hunk", text: ln });
			continue;
		}
		if (isDiffMetaLine(ln) || ln.startsWith("\\ ")) {
			flush();
			rows.push({ kind: "hdr", text: ln });
			continue;
		}
		if (ln.startsWith("+")) {
			pendingAdd.push({ no: haveNos ? newLine : null, text: ln.slice(1) });
			if (haveNos) newLine += 1;
			continue;
		}
		if (ln.startsWith("-")) {
			pendingDel.push({ no: haveNos ? oldLine : null, text: ln.slice(1) });
			if (haveNos) oldLine += 1;
			continue;
		}
		flush();
		const ctx = ln.startsWith(" ") ? ln.slice(1) : ln;
		rows.push({
			kind: "pair",
			left: { no: haveNos ? oldLine : null, text: ctx, kind: "ctx" },
			right: { no: haveNos ? newLine : null, text: ctx, kind: "ctx" },
		});
		if (haveNos) {
			oldLine += 1;
			newLine += 1;
		}
	}
	flush();
	return rows;
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
	onClose?: () => void;
}

export function ScmPanel({
	chat,
	terminal,
	active,
	onSwitchToTerminal,
	uiScmToolbar,
	onUiAction,
	onClose,
}: ScmPanelProps) {
	const t = useT();
	const [status, setStatus] = useState<ScmStatus | null>(null);
	const [branches, setBranches] = useState<ScmBranch[]>([]);
	const [branchMenuOpen, setBranchMenuOpen] = useState(false);
	const [statMap, setStatMap] = useState<Map<string, StatInfo>>(new Map());
	const [viewMode, setViewMode] = useState<"changes" | "history" | "stash">("changes");
	const [paletteOpen, setPaletteOpen] = useState(false);
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
	const [stashList, setStashList] = useState<ScmStashEntry[] | null>(null);
	const [stashLoading, setStashLoading] = useState(false);
	const [showBlame, setShowBlame] = useState(false);
	const [blameLines, setBlameLines] = useState<ScmBlameLine[] | null>(null);
	const [blameLoading, setBlameLoading] = useState(false);
	const [blameError, setBlameError] = useState<string | null>(null);
	const [diffView, setDiffView] = useState<"inline" | "side">("inline");
	const [showLineNos, setShowLineNos] = useState(true);
	const [isNarrow, setIsNarrow] = useState(false);
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

	const handleStageAll = useCallback(() => {
		if (notRepo) return;
		runGitCommand("git add", "git add -A");
	}, [notRepo, runGitCommand]);

	const handleUnstageAll = useCallback(() => {
		if (notRepo) return;
		runGitCommand("git reset", "git reset HEAD");
	}, [notRepo, runGitCommand]);

	const handleDiscard = useCallback(
		(f: ScmFile) => {
			if (notRepo) return;
			const untracked = scmFileKind(f) === "untracked";
			const ok = window.confirm(t(untracked ? "scmDiscardUntrackedConfirm" : "scmDiscardConfirm", { path: f.path }));
			if (!ok) return;
			if (untracked) {
				runGitCommand("rm", `rm -rf -- ${quotePath(f.path)}`);
			} else {
				runGitCommand("git restore", `git restore --source=HEAD -- ${quotePath(f.path)}`);
			}
		},
		[notRepo, runGitCommand, t],
	);

	// 选分支就是切分支：菜单里点一下直接 checkout，不再有“先选中、再点切换”的两步。
	const switchBranch = useCallback(
		(name: string) => {
			if (!name || notRepo) return;
			setBranchMenuOpen(false);
			if (status && !status.detached && name === status.branch) return;
			const entry = branches.find((x) => x.name === name);
			if (entry?.remote && typeof entry.remote === "string") {
				const localName = name.slice(entry.remote.length + 1);
				runGitCommand("git checkout", `git checkout -b ${localName} ${name} || git checkout ${name}`);
			} else {
				runGitCommand("git checkout", `git checkout ${name}`);
			}
		},
		[branches, notRepo, runGitCommand, status],
	);

	const deleteBranch = useCallback(
		(name: string, force: boolean) => {
			if (!name || notRepo) return;
			if (status && !status.detached && name === status.branch) {
				window.alert(t("scmBranchDeleteCurrent"));
				return;
			}
			if (!window.confirm(force ? t("scmBranchForceDeleteConfirm1", { name }) : t("scmBranchDeleteConfirm", { name })))
				return;
			if (force && !window.confirm(t("scmBranchForceDeleteConfirm2", { name }))) return;
			setBranchMenuOpen(false);
			runGitCommand("git branch", `git branch ${force ? "-D" : "-d"} ${name}`);
		},
		[notRepo, status, runGitCommand, t],
	);

	const handlePush = useCallback(() => runGitCommand("git push", "git push"), [runGitCommand]);
	const handlePull = useCallback(() => runGitCommand("git pull", "git pull"), [runGitCommand]);
	const handleFetch = useCallback(() => runGitCommand("git fetch", "git fetch --all --prune"), [runGitCommand]);

	const runGitCapture = useCallback(
		(
			title: string,
			innerCommand: string,
			startMarker: string,
			endMarker: string,
			onCaptured: (text: string) => void,
		) => {
			if (!chat.ready) return;
			const convId = chat.activeConversationId || chat.state?.conversationId || "";
			const command = `echo ${startMarker}; ${innerCommand}; echo ${endMarker}`;
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
					cols: 120,
					rows: 24,
				});
				targetId = existing.id;
			} else {
				targetId = randomUuid();
				terminal.create({
					id: targetId,
					conversationId: convId,
					title,
					cwd: chat.state?.cwd ?? "",
					cols: 120,
					rows: 24,
					running: true,
					exitCode: null,
					command: def,
				});
			}
			let buf = "";
			let done = false;
			let unsub: (() => void) | null = null;
			const finish = (text: string) => {
				if (done) return;
				done = true;
				try {
					unsub?.();
				} catch {}
				onCaptured(text);
			};
			try {
				unsub = terminal.register(convId, targetId, {
					write(data: string) {
						if (done) return;
						buf += data;
						if (buf.length > 2_000_000) buf = buf.slice(-2_000_000);
						// marker 必须是“独占一行”：终端会把整条命令回显一遍，两个 marker 就躺在同一行里，
						// 用 indexOf/includes 会在回显那一刻就收工，把命令行本身当成输出
						// （追溯 / 储藏列表因此长期解析不出任何行）。真正的 echo 输出是单独一行。
						const lines = stripAnsiForScm(buf).split("\n");
						let start = -1;
						for (let i = lines.length - 1; i >= 0; i--) {
							if (lines[i].trim() === startMarker) {
								start = i;
								break;
							}
						}
						if (start < 0) return;
						let end = -1;
						for (let i = start + 1; i < lines.length; i++) {
							if (lines[i].trim() === endMarker) {
								end = i;
								break;
							}
						}
						if (end < 0) return;
						finish(lines.slice(start + 1, end).join("\n"));
					},
					dispose() {},
				});
			} catch {}
			window.setTimeout(() => {
				if (!done) {
					done = true;
					try {
						unsub?.();
					} catch {}
				}
			}, 15000);
		},
		[chat.ready, chat.activeConversationId, chat.state?.conversationId, chat.state?.cwd, chat.terminals, terminal],
	);

	const handleStashList = useCallback(() => {
		if (notRepo) return;
		setStashLoading(true);
		runGitCapture(
			"git stash list",
			"git --no-pager stash list",
			"__SCM_STASH_LIST_START__",
			"__SCM_STASH_LIST_END__",
			(text) => {
				setStashList(parseStashListText(text));
				setStashLoading(false);
			},
		);
		window.setTimeout(() => setStashLoading(false), 16000);
	}, [notRepo, runGitCapture]);

	const handleStashSave = useCallback(
		(includeUntracked = false) => {
			if (notRepo) return;
			const msg = window.prompt(t("scmStashMsgPrompt"), "");
			if (msg === null) return;
			const scope = includeUntracked ? t("scmStashScopeUntracked") : "";
			if (!window.confirm(t("scmStashSaveConfirm", { scope }))) return;
			const trimmed = msg.trim();
			const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
			const parts = ["git stash push"];
			if (includeUntracked) parts.push("-u");
			if (trimmed) parts.push(`-m "${escaped}"`);
			runGitCommand("git stash", parts.join(" "));
			handleStashList();
		},
		[notRepo, runGitCommand, handleStashList, t],
	);

	const handleStashPopWithRef = useCallback(
		(ref: string) => {
			if (notRepo) return;
			if (!window.confirm(t("scmStashPopConfirm", { ref }))) return;
			runGitCommand("git stash", `git stash pop '${ref}'`);
		},
		[notRepo, runGitCommand, t],
	);

	const handleStashApplyWithRef = useCallback(
		(ref: string) => {
			if (notRepo) return;
			if (!window.confirm(t("scmStashApplyConfirm", { ref }))) return;
			runGitCommand("git stash", `git stash apply '${ref}'`);
		},
		[notRepo, runGitCommand, t],
	);

	const handleStashDropWithRef = useCallback(
		(ref: string) => {
			if (notRepo) return;
			if (!window.confirm(t("scmStashDropConfirm", { ref }))) return;
			runGitCommand("git stash", `git stash drop '${ref}'`);
		},
		[notRepo, runGitCommand, t],
	);

	const handleStashOpen = useCallback(() => {
		setViewMode("stash");
		setError(null);
		handleStashList();
	}, [handleStashList]);

	const handleDiscardSelected = useCallback(() => {
		if (!selected) return;
		handleDiscard(selected);
	}, [selected, handleDiscard]);

	const handleCreateTag = useCallback(() => {
		if (notRepo) return;
		const name = (window.prompt(t("scmTagCreatePrompt"), "") ?? "").trim();
		if (!name) return;
		if (!isValidBranchName(name)) {
			window.alert(t("scmTagInvalid"));
			return;
		}
		if (!window.confirm(t("scmTagCreateConfirm", { name }))) return;
		runGitCommand("git tag", `git tag ${name}`);
	}, [notRepo, runGitCommand, t]);

	const handlePushTags = useCallback(() => {
		if (notRepo) return;
		if (!window.confirm(t("scmTagPushConfirm"))) return;
		runGitCommand("git push", "git push --tags");
	}, [notRepo, runGitCommand, t]);

	const handleAmend = useCallback(() => {
		if (notRepo) return;
		const msg = commitMsg.trim();
		if (msg) {
			if (!window.confirm(t("scmAmendConfirmWithMsg"))) return;
			const escaped = msg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
			runGitCommand("git commit", `git add -A && git commit --amend -m "${escaped}"`);
			setCommitHistory(rememberCommitMessage(msg));
			setCommitMsg("");
			recallRef.current = COMMIT_RECALL_INITIAL;
		} else {
			if (!window.confirm(t("scmAmendConfirmNoMsg"))) return;
			runGitCommand("git commit", "git add -A && git commit --amend --no-edit");
		}
	}, [notRepo, commitMsg, runGitCommand, t]);

	const handleBranchCreate = useCallback(() => {
		if (notRepo) return;
		const name = (window.prompt(t("scmBranchNewPrompt"), "") ?? "").trim();
		if (!name) return;
		if (!isValidBranchName(name)) {
			window.alert(t("scmBranchInvalid"));
			return;
		}
		if (!window.confirm(t("scmBranchCreateConfirm", { name }))) return;
		runGitCommand("git checkout", `git checkout -b ${name}`);
	}, [notRepo, runGitCommand, t]);

	const handleBranchRename = useCallback(() => {
		if (notRepo || !status || status.detached) return;
		const cur = status.branch;
		if (!cur) return;
		const next = (window.prompt(t("scmBranchRenamePrompt", { name: cur }), cur) ?? "").trim();
		if (!next || next === cur) return;
		if (!isValidBranchName(next)) {
			window.alert(t("scmBranchInvalid"));
			return;
		}
		if (!window.confirm(t("scmBranchRenameConfirm", { old: cur, new: next }))) return;
		runGitCommand("git branch", `git branch -m ${next}`);
	}, [notRepo, status, runGitCommand, t]);

	const fetchBlame = useCallback(
		(path: string) => {
			if (notRepo || !path) return;
			setBlameLoading(true);
			setBlameError(null);
			runGitCapture(
				"git blame",
				`git --no-pager blame --line-porcelain -- ${quotePath(path)}`,
				"__SCM_BLAME_START__",
				"__SCM_BLAME_END__",
				(text) => {
					const parsed = parseBlamePorcelainText(text);
					if (parsed.length === 0) {
						setBlameLines(null);
						setBlameError(t("scmBlameFail"));
					} else {
						setBlameLines(parsed);
						setBlameError(null);
					}
					setBlameLoading(false);
				},
			);
			window.setTimeout(() => setBlameLoading(false), 16000);
		},
		[notRepo, runGitCapture, t],
	);

	// blame 只在这里翻转开关：抓取交给下面的 effect（单触发点，避免两条路径各抳一次）。
	const handleBlameToggle = useCallback(() => setShowBlame((prev) => !prev), []);

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
		const mq = window.matchMedia("(max-width: 768px)");
		const update = () => setIsNarrow(mq.matches);
		update();
		mq.addEventListener("change", update);
		return () => mq.removeEventListener("change", update);
	}, []);

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
			return wasRunning && (tm.title.startsWith("git ") || tm.title === "rm");
		});
		if (finishedGitWrite && chat.ready && chat.status === "open") {
			refresh(false, true);
			if (viewMode === "history" && status) loadHistory();
		}
	}, [chat.terminals, active, chat.ready, chat.status, refresh, viewMode, status, loadHistory]);

	const fetchBlameRef = useRef(fetchBlame);
	useEffect(() => {
		fetchBlameRef.current = fetchBlame;
	}, [fetchBlame]);

	const blameTargetPath = selected?.path ?? null;
	const blameTargetUntracked = !!selected && selected.x === "?" && selected.y === "?";
	useEffect(() => {
		if (!showBlame) return;
		if (!blameTargetPath || blameTargetUntracked) {
			setBlameLines(null);
			setBlameLoading(false);
			setBlameError(blameTargetPath ? t("scmBlameEmpty") : null);
			return;
		}
		// 依赖里只能放“路径 / 是否未跟踪”：fetchBlame 的身份跟着 chat.terminals 变，
		// 每次抓取又会新建终端把 terminals 改掉，直接依赖它会无限重渲染（React #185 白屏）。
		fetchBlameRef.current(blameTargetPath);
	}, [showBlame, blameTargetPath, blameTargetUntracked, t]);

	useEffect(() => {
		setStashList(null);
		setStashLoading(false);
		setBlameLines(null);
		setBlameError(null);
		setBlameLoading(false);
	}, [chat.state?.cwd]);

	const changeLists = useMemo(() => splitScmFiles(status?.files ?? []), [status]);
	const stagedSummary = useMemo(() => sumScmStats(changeLists.staged, statMap), [changeLists, statMap]);
	const fileCount = status?.files.length ?? 0;
	const commitTarget = status && !status.detached ? status.branch : "";

	const paletteActions = useMemo<ScmPaletteAction[]>(() => {
		const actions = buildScmPaletteActions({
			t,
			notRepo,
			status,
			branches,
			fileCount,
			stagedCount: stagedSummary.count,
			commitMsg,
			selectedPath: selected?.path ?? null,
			showBlame,
			handlers: {
				pull: handlePull,
				push: handlePush,
				fetch: handleFetch,
				branchCreate: handleBranchCreate,
				branchRename: handleBranchRename,
				branchCheckout: switchBranch,
				commit: handleCommit,
				commitAll: handleCommitAll,
				amend: handleAmend,
				genMessage: handleGenCommitMsg,
				stageAll: handleStageAll,
				unstageAll: handleUnstageAll,
				stashSave: handleStashSave,
				stashOpen: handleStashOpen,
				discardSelected: handleDiscardSelected,
				toggleBlame: handleBlameToggle,
				openTerminal: onSwitchToTerminal,
				refresh: () => refresh(true),
				createTag: handleCreateTag,
				pushTags: handlePushTags,
			},
		});
		return actions;
	}, [
		t,
		notRepo,
		status,
		branches,
		fileCount,
		stagedSummary.count,
		commitMsg,
		selected,
		showBlame,
		handlePull,
		handlePush,
		handleFetch,
		handleBranchCreate,
		handleBranchRename,
		switchBranch,
		handleCommit,
		handleCommitAll,
		handleAmend,
		handleGenCommitMsg,
		handleStageAll,
		handleUnstageAll,
		handleStashSave,
		handleStashOpen,
		handleDiscardSelected,
		handleBlameToggle,
		onSwitchToTerminal,
		refresh,
		handleCreateTag,
		handlePushTags,
	]);

	// ⌘⇧P：面板可见时才接管（⌘⇧G 在 App 里是开关 Git 抽屉，⌘K 是全局搜索）。
	useEffect(() => {
		if (!active) return;
		const onKey = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
			if (e.key.toLowerCase() !== "p") return;
			e.preventDefault();
			setPaletteOpen((v) => !v);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [active]);

	const filteredHistory = filterScmCommits(history, historyFilter);
	const effectiveDiffView = isNarrow ? "inline" : diffView;
	const allFiles = status?.files ?? [];
	const selIdx = selected ? allFiles.findIndex((f) => f.path === selected.path) : -1;
	const prevFile = selIdx > 0 ? allFiles[selIdx - 1] : null;
	const nextFile = selIdx >= 0 && selIdx < allFiles.length - 1 ? allFiles[selIdx + 1] : null;
	const fileEstimate =
		fileDiff && !fileDiff.untracked ? estimateMultiDiffStats([fileDiff.staged, fileDiff.worktree]) : null;
	const fileStatEntry = selected ? statMap.get(selected.path) : undefined;
	const fileAdd = fileStatEntry?.add ?? fileEstimate?.add ?? 0;
	const fileDel = fileStatEntry?.del ?? fileEstimate?.del ?? 0;
	const fileHunks = fileEstimate?.hunks ?? 0;
	const commitStats = commitDetail ? estimateDiffStats(commitDetail) : null;
	const renderText = (text: string) =>
		effectiveDiffView === "side" ? renderSideBySide(text, showLineNos) : renderDiff(text);

	const renderDiff = (text: string) => {
		const lines = text.split("\n");
		return (
			<pre className="scm-diff-pre">
				{lines.map((ln, i) => {
					let cls = "";
					if (isDiffMetaLine(ln)) {
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

	const renderSideCell = (cell: SideCell, showNos: boolean, key: string | number) => {
		if (cell.kind === "empty") {
			return <div key={key} style={{ flex: 1, minWidth: 0 }} />;
		}
		const bg = cell.kind === "del" ? "var(--red-soft)" : cell.kind === "add" ? "var(--green-soft)" : "transparent";
		const fg = cell.kind === "del" ? "var(--red)" : cell.kind === "add" ? "var(--green)" : "var(--text-dim)";
		const sign = cell.kind === "del" ? "-" : cell.kind === "add" ? "+" : " ";
		return (
			<div
				key={key}
				style={{
					flex: 1,
					minWidth: 0,
					display: "flex",
					gap: 6,
					padding: "0 6px",
					borderRadius: 4,
					background: bg,
					color: fg,
					fontFamily: "var(--mono)",
					fontSize: "12.5px",
					lineHeight: 1.55,
				}}
			>
				{showNos && (
					<span
						style={{
							flexShrink: 0,
							width: 30,
							textAlign: "right",
							color: "var(--text-faint)",
							userSelect: "none",
						}}
					>
						{cell.no ?? ""}
					</span>
				)}
				<span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
					{`${sign}${cell.text}` || " "}
				</span>
			</div>
		);
	};

	const renderSideBySide = (text: string, showNos: boolean) => {
		const rows = buildSideRows(text);
		return (
			<div style={{ display: "flex", flexDirection: "column", gap: 2, paddingBottom: 8 }}>
				{rows.map((row, i) => {
					if (row.kind !== "pair") {
						return (
							<div key={i} className={`scm-diff-line ${row.kind === "hunk" ? "hunk" : "hdr"}`}>
								{row.text || " "}
							</div>
						);
					}
					return (
						<div key={i} style={{ display: "flex", gap: 8, padding: "0 14px" }}>
							{renderSideCell(row.left, showNos, `l${i}`)}
							{renderSideCell(row.right, showNos, `r${i}`)}
						</div>
					);
				})}
			</div>
		);
	};

	const SCM_DEFAULT_ORDER = [
		"host:scm-changes",
		"host:scm-history",
		"host:scm-refresh",
		"host:scm-branch",
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
	const localBranches = branches.filter((b) => !b.remote);
	const remoteBranches = branches.filter((b) => b.remote);
	// 分标签显示当前分支；分离 HEAD / 查询中 / 非仓库都有明确文案（不再靠 select 的 placeholder）。
	const branchLabel = status
		? status.detached
			? t("scmDetached")
			: status.branch || t("scmSelectBranch")
		: t("scmSelectBranch");
	const branchDiagDisabled = notRepo || branches.length === 0;

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
			<Dropdown
				open={branchMenuOpen}
				onOpenChange={(next) => setBranchMenuOpen(next && !branchDiagDisabled)}
				align="left"
				direction="down"
				portal
				caret={false}
				tip={t("scmCurrentBranch")}
				triggerClassName="gd-branch"
				className={`gd-branch-dd${branchDiagDisabled ? " disabled" : ""}`}
				trigger={
					<>
						<FiGitBranch className="gd-branch-glyph" />
						<span className="gd-branch-name">{branchLabel}</span>
						<FiChevronDown className={`gd-branch-caret${branchMenuOpen ? " up" : ""}`} />
					</>
				}
				menuClassName="gd-branch-menu"
				menuStyle={{ width: 288, maxHeight: 380 }}
			>
				<div className="dd-header">{t("scmSwitchBranch")}</div>
				{localBranches.length === 0 && <div className="gd-branch-empty">{t("scmSelectBranch")}</div>}
				{localBranches.map((b) => (
					<div key={b.name} className={`gd-branch-row${b.current ? " current" : ""}`}>
						<button
							type="button"
							className="gd-branch-pick"
							title={b.current ? t("scmCurrentBranch") : t("scmSwitchBranchTip", { branch: b.name })}
							onClick={() => switchBranch(b.name)}
						>
							<span className="gd-branch-tick">{b.current ? <FiCheck /> : null}</span>
							<span className="gd-branch-text">{b.name}</span>
						</button>
						<button
							type="button"
							className="gd-branch-del"
							title={b.current ? t("scmBranchDeleteCurrent") : t("scmBranchDeleteTip")}
							aria-label={t("scmBranchDelete")}
							disabled={b.current}
							onClick={() => deleteBranch(b.name, false)}
						>
							<FiTrash2 />
						</button>
						<button
							type="button"
							className="gd-branch-del force"
							title={b.current ? t("scmBranchDeleteCurrent") : t("scmBranchForceDeleteTip")}
							aria-label={t("scmBranchForceDelete")}
							disabled={b.current}
							onClick={() => deleteBranch(b.name, true)}
						>
							<FiZap />
						</button>
					</div>
				))}
				{remoteBranches.length > 0 && (
					<>
						<div className="dd-header">{t("scmRemoteBranches")}</div>
						{remoteBranches.map((b) => (
							<div key={b.name} className="gd-branch-row">
								<button
									type="button"
									className="gd-branch-pick"
									title={t("scmSwitchBranchTip", { branch: b.name })}
									onClick={() => switchBranch(b.name)}
								>
									<span className="gd-branch-tick" />
									<span className="gd-branch-text mono">{b.name}</span>
								</button>
							</div>
						))}
					</>
				)}
			</Dropdown>
		),
		"host:scm-push": (
			<button
				type="button"
				className={`btn${status && status.ahead > 0 ? " primary" : ""}`}
				disabled={!status || status.detached || status.upstreamGone || notRepo || status.ahead === 0}
				title={t("scmPushTip")}
				onClick={handlePush}
			>
				<FiArrowUp />
				{scmLabel("host:scm-push", t("scmPush"))}
				{status && status.ahead > 0 && <span className="scm-sync-count">↑{status.ahead}</span>}
			</button>
		),
		"host:scm-pull": (
			<button
				type="button"
				className={`btn${status && status.behind > 0 ? " primary" : ""}`}
				disabled={!status || status.detached || status.upstreamGone || notRepo || status.behind === 0}
				title={t("scmPullTip")}
				onClick={handlePull}
			>
				<FiArrowDown />
				{scmLabel("host:scm-pull", t("scmPull"))}
				{status && status.behind > 0 && <span className="scm-sync-count">↓{status.behind}</span>}
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
				disabled={!commitMsg.trim() || notRepo || stagedSummary.count === 0}
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
				<div className="gd-titlebar">
					{renderMergedToolbar(scmZone(["host:scm-branch"], false), scmHostNodes, onUiAction)}
					<div className="gd-actions">
						{renderMergedToolbar(scmZone(["host:scm-refresh"], true), scmHostNodes, onUiAction)}
						<button
							type="button"
							className="icon-btn"
							title={t("scmPaletteTriggerTip")}
							aria-haspopup="dialog"
							aria-expanded={paletteOpen}
							onClick={() => setPaletteOpen(true)}
						>
							<FiCommand />
						</button>
						{onClose && (
							<button type="button" className="icon-btn" title={t("close")} onClick={onClose}>
								<FiX />
							</button>
						)}
					</div>
				</div>

				<div className="scm-sync">
					<button type="button" className="btn" disabled={notRepo} title={t("scmSyncFetchTip")} onClick={handleFetch}>
						<FiRefreshCw />
						{t("scmSyncFetch")}
					</button>
					<span className="sp" />
					{status?.upstreamGone && <span className="scm-upstream-gone">{t("scmUpstreamGone")}</span>}
					{renderMergedToolbar(scmZone(["host:scm-pull"], false), scmHostNodes, onUiAction)}
					{renderMergedToolbar(scmZone(["host:scm-push"], false), scmHostNodes, onUiAction)}
				</div>

				<div className="gd-seg">
					{renderMergedToolbar(scmZone(["host:scm-changes", "host:scm-history"], false), scmHostNodes, onUiAction)}
					<button
						type="button"
						className={viewMode === "stash" ? "on" : ""}
						aria-selected={viewMode === "stash"}
						onClick={() => {
							setViewMode("stash");
							setError(null);
							void handleStashList();
						}}
					>
						{t("scmStash")}
						{stashList && stashList.length > 0 && <span className="n">{stashList.length}</span>}
					</button>
				</div>

				{genError && (
					<div className="scm-gen-error" role="alert" title={t("close")} onClick={() => setGenError(null)}>
						{genError}
					</div>
				)}
			</div>

			<div
				className={`scm-body${viewMode === "stash" ? " stash-mode" : ""}${selected || selectedCommit ? " detail-mode" : ""}`}
				ref={bodyRef}
				style={{ "--scm-sidebar-w": `${sidebarWidth}px` } as CSSProperties}
			>
				{viewMode === "stash" ? (
					<div className="scm-stash">
						<div className="scm-files-header">
							<span>{t("scmStash")}</span>
							<button
								type="button"
								className="scm-act"
								style={{ width: "auto", padding: "0 6px", fontSize: 11 }}
								title={t("scmStashListTip")}
								disabled={notRepo || stashLoading}
								onClick={handleStashList}
							>
								{stashLoading ? t("scmStashLoading") : t("scmStashList")}
							</button>
						</div>
						<div className="scm-files-list">
							{notRepo ? (
								<div className="scm-empty">{t("scmNotGitRepo")}</div>
							) : stashLoading ? (
								<div className="scm-empty">{t("scmStashLoading")}</div>
							) : !stashList || stashList.length === 0 ? (
								<div className="scm-empty">{t("scmStashEmpty")}</div>
							) : (
								stashList.map((entry) => (
									<div key={entry.ref} className="scm-file" style={{ cursor: "default" }}>
										<span className="scm-file-path" title={entry.ref}>
											<span style={{ color: "var(--accent)", fontFamily: "var(--mono)" }}>{entry.ref}</span>
											{"  "}
											{entry.message || "—"}
										</span>
										<span className="scm-file-actions">
											<button
												type="button"
												className="scm-act"
												style={{ width: "auto", padding: "0 5px", fontSize: 10.5 }}
												title={t("scmStashPopTip")}
												onClick={() => handleStashPopWithRef(entry.ref)}
											>
												{t("scmStashPop")}
											</button>
											<button
												type="button"
												className="scm-act"
												style={{ width: "auto", padding: "0 5px", fontSize: 10.5 }}
												title={t("scmStashApplyTip")}
												onClick={() => handleStashApplyWithRef(entry.ref)}
											>
												{t("scmStashApply")}
											</button>
											<button
												type="button"
												className="scm-act"
												style={{ width: "auto", padding: "0 5px", fontSize: 10.5 }}
												title={t("scmStashDropTip")}
												onClick={() => handleStashDropWithRef(entry.ref)}
											>
												{t("scmStashDrop")}
											</button>
										</span>
									</div>
								))
							)}
						</div>
					</div>
				) : viewMode === "history" ? (
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
					<ScmChangesList
						files={status?.files ?? []}
						stats={statMap}
						selectedPath={selected?.path ?? null}
						notRepo={notRepo}
						pending={!status}
						connected={chat.status === "open"}
						onSelect={showFileDiff}
						onStage={handleStage}
						onUnstage={handleUnstage}
						onDiscard={handleDiscard}
						onStageAll={handleStageAll}
						onUnstageAll={handleUnstageAll}
					/>
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
						<button
							type="button"
							className="scm-back"
							title={t("scmBackToList")}
							onClick={() => {
								setSelected(null);
								setSelectedCommit(null);
							}}
						>
							<FiChevronLeft />
						</button>
						<span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
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
						{viewMode === "history"
							? selectedCommit &&
								!commitLoading &&
								commitStats &&
								(commitStats.add > 0 || commitStats.del > 0) && (
									<span className="scm-file-stat" style={{ flexShrink: 0 }}>
										{commitStats.add > 0 && <span className="add">+{commitStats.add}</span>}{" "}
										{commitStats.del > 0 && <span className="del">-{commitStats.del}</span>}{" "}
										{commitStats.hunks > 0 && <span>{t("scmDiffHunks", { n: commitStats.hunks })}</span>}
									</span>
								)
							: selected &&
								fileDiff &&
								!fileDiff.untracked &&
								(fileAdd > 0 || fileDel > 0 || fileHunks > 0) && (
									<span className="scm-file-stat" style={{ flexShrink: 0 }}>
										{fileAdd > 0 && <span className="add">+{fileAdd}</span>}{" "}
										{fileDel > 0 && <span className="del">-{fileDel}</span>}{" "}
										{fileHunks > 0 && <span>{t("scmDiffHunks", { n: fileHunks })}</span>}
									</span>
								)}
						{viewMode !== "history" && selected && (
							<span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
								<button
									type="button"
									className="scm-act"
									style={{ width: "auto", padding: "0 6px", fontSize: 11 }}
									title={t("scmDiffPrevTip")}
									aria-label={t("scmDiffPrev")}
									disabled={!prevFile}
									onClick={() => prevFile && showFileDiff(prevFile)}
								>
									↑
								</button>
								<button
									type="button"
									className="scm-act"
									style={{ width: "auto", padding: "0 6px", fontSize: 11 }}
									title={t("scmDiffNextTip")}
									aria-label={t("scmDiffNext")}
									disabled={!nextFile}
									onClick={() => nextFile && showFileDiff(nextFile)}
								>
									↓
								</button>
							</span>
						)}
						<span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
							<button
								type="button"
								className="scm-act"
								style={{
									width: "auto",
									padding: "0 6px",
									fontSize: 11,
									...(effectiveDiffView === "inline"
										? { background: "var(--accent-soft)", borderColor: "var(--accent)" }
										: {}),
								}}
								title={t("scmDiffInlineTip")}
								onClick={() => setDiffView("inline")}
							>
								{t("scmDiffInline")}
							</button>
							<button
								type="button"
								className="scm-act"
								style={{
									width: "auto",
									padding: "0 6px",
									fontSize: 11,
									...(effectiveDiffView === "side"
										? { background: "var(--accent-soft)", borderColor: "var(--accent)" }
										: {}),
								}}
								title={t("scmDiffSideBySideTip")}
								disabled={isNarrow}
								onClick={() => setDiffView("side")}
							>
								{t("scmDiffSideBySide")}
							</button>
							{effectiveDiffView === "side" && (
								<label
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 4,
										fontSize: 11,
										fontWeight: 400,
										cursor: "pointer",
									}}
								>
									<input type="checkbox" checked={showLineNos} onChange={(e) => setShowLineNos(e.target.checked)} />
									{t("scmDiffLineNumbers")}
								</label>
							)}
							{viewMode !== "history" && selected && (
								<button
									type="button"
									className="scm-act"
									style={{
										width: "auto",
										padding: "0 6px",
										fontSize: 11,
										...(showBlame ? { background: "var(--accent-soft)", borderColor: "var(--accent)" } : {}),
									}}
									title={t("scmBlameTip")}
									onClick={handleBlameToggle}
								>
									{showBlame ? t("scmBlameHide") : t("scmBlame")}
								</button>
							)}
						</span>
					</div>
					<div className="scm-diff-body">
						{viewMode === "history" ? (
							<>
								{error && <div className="scm-error">{error}</div>}
								{!selectedCommit && !error && <div className="scm-empty">{t("scmSelectCommitHint")}</div>}
								{selectedCommit && commitLoading && !error && <div className="scm-empty">{t("scmLoading")}</div>}
								{selectedCommit && !commitLoading && !error && commitDetail ? renderText(commitDetail) : null}
							</>
						) : (
							<>
								{error && <div className="scm-error">{error}</div>}
								{!selected && !error && <div className="scm-empty">{t("scmSelectFileHint")}</div>}
								{selected && !fileDiff && !error && <div className="scm-empty">{t("scmLoading")}</div>}
								{selected && fileDiff && fileDiff.untracked && <div className="scm-empty">{t("scmUntrackedNote")}</div>}
								{selected && fileDiff && !fileDiff.untracked && (
									<>
										{showBlame && (
											<>
												<div className="scm-diff-section">
													{t("scmBlame")}
													{blameLoading && (
														<span style={{ marginLeft: 8, fontWeight: 400 }}>· {t("scmBlameLoading")}</span>
													)}
												</div>
												{blameLoading && !blameLines && <div className="scm-empty">{t("scmBlameLoading")}</div>}
												{!blameLoading && blameError && <div className="scm-error">{blameError}</div>}
												{!blameLoading && !blameError && (!blameLines || blameLines.length === 0) && (
													<div className="scm-empty">{t("scmBlameEmpty")}</div>
												)}
												{!blameError && blameLines && blameLines.length > 0 && (
													<pre className="scm-diff-pre" style={{ maxHeight: 260, overflowY: "auto" }}>
														{blameLines.map((bl) => (
															<div
																key={bl.lineNo}
																className="scm-diff-line"
																style={{ display: "flex", gap: 8 }}
																title={`${bl.hash} · ${bl.author} · ${bl.date}`}
															>
																<span
																	style={{
																		flexShrink: 0,
																		width: 36,
																		textAlign: "right",
																		color: "var(--text-faint)",
																		userSelect: "none",
																	}}
																>
																	{bl.lineNo}
																</span>
																<span
																	style={{
																		flexShrink: 0,
																		width: 62,
																		fontFamily: "var(--mono)",
																		color: "var(--accent)",
																	}}
																>
																	{bl.shortHash}
																</span>
																<span
																	style={{
																		flexShrink: 0,
																		maxWidth: 120,
																		overflow: "hidden",
																		textOverflow: "ellipsis",
																		whiteSpace: "nowrap",
																	}}
																>
																	{bl.author}
																</span>
																<span style={{ flexShrink: 0, color: "var(--text-faint)" }}>{bl.date}</span>
																<span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
																	{bl.content || " "}
																</span>
															</div>
														))}
													</pre>
												)}
											</>
										)}
										{fileDiff.staged && (
											<>
												<div className="scm-diff-section">{t("scmStaged")}</div>
												{renderText(fileDiff.staged)}
											</>
										)}
										{fileDiff.worktree && (
											<>
												<div className="scm-diff-section">{t("scmUnstaged")}</div>
												{renderText(fileDiff.worktree)}
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

			<div className="gd-commit-bar">
				<div className="commit-box">
					{renderMergedToolbar(scmZone(["host:scm-input"], false), scmHostNodes, onUiAction)}
					<div className="scm-commit-meta">
						<span>
							{stagedSummary.count === 0
								? t("scmCommitNothingStaged")
								: t("scmCommitMetaCount", { count: stagedSummary.count })}
							{stagedSummary.add > 0 && <span className="add"> · +{stagedSummary.add}</span>}
							{stagedSummary.del > 0 && <span className="del"> · −{stagedSummary.del}</span>}
						</span>
						{commitTarget && (
							<span className="scm-commit-target">{t("scmCommitTarget", { branch: commitTarget })}</span>
						)}
					</div>
					<div className="commit-row">
						{renderMergedToolbar(scmZone(["host:scm-genmsg"], false), scmHostNodes, onUiAction)}
						<span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
							{renderMergedToolbar(scmZone(["host:scm-commit-all"], false), scmHostNodes, onUiAction)}
							{renderMergedToolbar(scmZone(["host:scm-commit"], false), scmHostNodes, onUiAction)}
						</span>
					</div>
				</div>
				<div className="gd-foot">
					<button type="button" className="link" onClick={onSwitchToTerminal}>
						<FiTerminal />
						{scmLabel("host:scm-term", t("scmViewTerminal"))}
					</button>
					<span
						style={{
							marginLeft: "auto",
							minWidth: 0,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{status?.upstream ?? ""}
					</span>
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

			<ScmCommandPalette
				open={paletteOpen}
				onClose={() => setPaletteOpen(false)}
				labels={{
					title: t("scmPaletteOpen"),
					placeholder: t("scmPalettePlaceholder"),
					empty: t("scmPaletteEmpty"),
					move: t("scmPaletteKeysMove"),
					run: t("scmPaletteKeysRun"),
					close: t("scmPaletteKeysClose"),
					count: (n) => t("scmPaletteCount", { count: n }),
				}}
				actions={paletteActions}
			/>
		</div>
	);
}
