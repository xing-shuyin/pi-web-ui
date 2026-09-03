import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiFileText, FiFolder, FiMessageSquare, FiSearch, FiX } from "react-icons/fi";
import type { ClientMessage, FileSearchResult, MessageAnchor, ProjectSummary, SessionSearchResult } from "../types";
import { useT } from "../i18n";

interface GlobalSearchModalProps {
	/** 常驻挂载：open=false 时隐藏但仍保留查询词与结果，下次打开直接恢复 */
	open: boolean;
	send: (msg: ClientMessage) => boolean;
	/** Recent projects (lazy — requested on open). */
	projects: ProjectSummary[];
	cwd: string;
	fileSearch: {
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null;
	/** Server-side conversation-content matches (full transcript text,
	 *  AI output included) — reqId-matched like fileSearch. */
	sessionSearch: {
		reqId: number;
		ok: boolean;
		results: SessionSearchResult[];
	} | null;
	onClose: () => void;
	/** Restore a history session (switch_session); anchors（若有）让上层在
	 *  会话载入后跳到对应消息。 */
	onSwitchSession: (path: string, anchors?: MessageAnchor[]) => void;
	/** Open a recent project (set_cwd). */
	onSwitchProject: (path: string) => void;
	/** Preview a matched file (opens the file preview panel). */
	onPreviewFile: (path: string, name: string) => void;
}

/** Case-insensitive substring test (empty needle matches nothing here —
 *  callers hide sections until there is a query). */
function matches(text: string, q: string): boolean {
	return text.toLowerCase().includes(q);
}

/**
 * 全局搜索弹窗 —— 一个输入框同时搜三类目标：
 * ① 对话：历史会话**全文**匹配（服务端在转录里搜 user + assistant 文本，
 *    含 AI 输出；点击恢复会话）；
 * ② 项目：最近项目路径（客户端过滤，点击 set_cwd 切换工作区）；
 * ③ 文件：当前工作区递归文件名匹配（服务端 search_files，reqId 匹配，
 *    点击打开文件预览）。↑↓/Enter 键盘导航，Esc 关闭。
 * 点击结果后面板保持打开、结果不被清空，可直接点下一条；会话点击
 * 会收起面板并跳到命中消息的位置（搜索状态仍保留在面板里，重开即恢复）。
 */
export function GlobalSearchModal({
	open,
	send,
	projects,
	cwd,
	fileSearch,
	sessionSearch,
	onClose,
	onSwitchSession,
	onSwitchProject,
	onPreviewFile,
}: GlobalSearchModalProps) {
	const t = useT();
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const [active, setActive] = useState(0);
	// Local reqId counter for search_files requests; only accept results
	// carrying the latest one (stale responses from earlier keystrokes drop).
	const reqIdRef = useRef(1);
	const lastReqRef = useRef(0);
	// Debounce timer so typing doesn't fire a workspace walk per keystroke.
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// 每次打开面板时发起探测（不是 App 挂载时）：预热会话/项目列表，并用
	// 当前查询重新跑文件/会话搜索 —— 面板关闭期间 cwd 或转录可能已变化，
	// 重开要的是新鲜结果；新 reqId 会遮蔽仓库里携带旧 reqId 的结果。
	useEffect(() => {
		if (!open) return;
		send({ type: "list_sessions" });
		send({ type: "list_projects" });
		const qq = query.trim();
		if (qq) {
			const reqId = ++reqIdRef.current;
			lastReqRef.current = reqId;
			setSearchPending(true);
			send({ type: "search_files", reqId, query: qq });
			send({ type: "search_sessions", reqId, query: qq });
		}
		requestAnimationFrame(() => inputRef.current?.select());
		// eslint-disable-next-line react-hooks/exhaustive-deps -- open 触发即可，query 变更走 debounce effect
	}, [open]);

	/** True while a server-side search (files or session text) is in flight
	 *  for the latest query. */
	const [searchPending, setSearchPending] = useState(false);

	// Fire server-side searches on each settled query change: file-name walk
	// + conversation-content match. One shared reqId keeps both in sync.
	useEffect(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		const q = deferredQuery.trim();
		if (!q) {
			setSearchPending(false);
			return;
		}
		debounceRef.current = setTimeout(() => {
			const reqId = ++reqIdRef.current;
			lastReqRef.current = reqId;
			setSearchPending(true);
			send({ type: "search_files", reqId, query: q });
			send({ type: "search_sessions", reqId, query: q });
		}, 300);
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- send is stable
	}, [deferredQuery]);

	const q = deferredQuery.trim().toLowerCase();

	const sessionHits = useMemo(() => {
		if (!q || !sessionSearch || sessionSearch.reqId !== lastReqRef.current || !sessionSearch.ok) return [];
		// 服务端全文匹配结果（已含 AI 输出），直接按返回顺序展示
		return sessionSearch.results;
	}, [sessionSearch, q]);
	const projectHits = useMemo(() => (q ? projects.filter((p) => matches(p.path, q)).slice(0, 10) : []), [projects, q]);
	const fileHits = useMemo(() => {
		if (!q || !fileSearch || fileSearch.reqId !== lastReqRef.current || !fileSearch.ok) return [];
		return fileSearch.results;
	}, [fileSearch, q]);

	// Clear the "searching" hint once BOTH latest responses (files + sessions)
	// have landed — either one still pending keeps the hint on.
	useEffect(() => {
		if (
			fileSearch &&
			fileSearch.reqId === lastReqRef.current &&
			sessionSearch &&
			sessionSearch.reqId === lastReqRef.current &&
			lastReqRef.current !== 0
		) {
			setSearchPending(false);
		}
	}, [fileSearch, sessionSearch]);
	const fileTruncated = !!fileSearch && fileSearch.ok && fileSearch.truncated;

	/** Flat navigation order: conversations → projects → files. */
	type NavItem =
		| { kind: "session"; path: string; anchors: MessageAnchor[] }
		| { kind: "project"; path: string }
		| { kind: "file"; path: string; name: string };
	const navItems = useMemo<NavItem[]>(
		() => [
			...sessionHits.map((s) => ({
				kind: "session" as const,
				path: s.path,
				anchors: s.anchors,
			})),
			...projectHits.map((p) => ({ kind: "project" as const, path: p.path })),
			...fileHits.filter((f) => f.type === "file").map((f) => ({ kind: "file" as const, path: f.path, name: f.name })),
		],
		[sessionHits, projectHits, fileHits],
	);

	useEffect(() => {
		setActive(0);
	}, [deferredQuery]);

	const activate = useCallback(
		(item: NavItem | undefined) => {
			if (!item) return;
			if (item.kind === "session") {
				onSwitchSession(item.path, item.anchors);
				// 跳到对应消息需要能看到对话 —— 收起面板；搜索状态已保留，重开即恢复
				onClose();
			} else if (item.kind === "project") {
				onSwitchProject(item.path);
				// 工作区已切换：重发探测，让结果跟随新 cwd（会话全文 + 文件走查）
				send({ type: "list_sessions" });
				send({ type: "list_projects" });
				const qq = deferredQuery.trim();
				if (qq) {
					const reqId = ++reqIdRef.current;
					lastReqRef.current = reqId;
					setSearchPending(true);
					send({ type: "search_files", reqId, query: qq });
					send({ type: "search_sessions", reqId, query: qq });
				}
			} else onPreviewFile(item.path, item.name);
			// 项目/文件点击不关面板：结果继续保持，可直接点下一条；
			// 会话点击已在上方收起（为让跳转可见），搜索状态仍保留、重开即恢复。
		},
		[onSwitchSession, onSwitchProject, onPreviewFile, send, deferredQuery],
	);

	// Esc closes; ↑/↓ + Enter navigate. (仅面板打开时挂键盘监听——组件常驻，
	// 关闭时不能拦截全局按键。)
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive((a) => Math.min(a + 1, navItems.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive((a) => Math.max(a - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				activate(navItems[active]);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [navItems, active, activate, onClose, open]);

	const total = sessionHits.length + projectHits.length + fileHits.length;

	/** Section header with match count. */
	const sectionHead = (label: string, count: number, icon: ReactNode) => (
		<div className="gs-section-head">
			{icon}
			<span>{label}</span>
			<em>{count}</em>
		</div>
	);

	let navIdx = -1;

	// 关闭时隐藏而不卸载：query / 结果 / 选中项全部保留，下次打开原样恢复。
	// 所有 hooks 都在上面，这里 return null 只是不渲染。
	if (!open) return null;

	return (
		<div className="modal-backdrop gs-backdrop" onClick={onClose}>
			<div className="gs-modal" onClick={(e) => e.stopPropagation()}>
				<div className="gs-input-row">
					<FiSearch />
					<input
						ref={inputRef}
						type="text"
						value={query}
						placeholder={t("gsPlaceholder")}
						onChange={(e) => setQuery(e.target.value)}
					/>
					<button type="button" className="gs-close" title={t("close")} onClick={onClose}>
						<FiX />
					</button>
				</div>

				<div className="gs-results">
					{!q && <div className="gs-empty">{t("gsHint")}</div>}
					{q && total === 0 && !fileTruncated && (
						<div className="gs-empty">{searchPending ? t("gsSearching") : t("gsNoResults")}</div>
					)}

					{sessionHits.length > 0 && (
						<div className="gs-section">
							{sectionHead(t("gsSessions"), sessionHits.length, <FiMessageSquare />)}
							{sessionHits.map((s) => {
								navIdx++;
								const idx = navIdx;
								return (
									<button
										key={s.path}
										type="button"
										className={idx === active ? "gs-item active" : "gs-item"}
										onMouseEnter={() => setActive(idx)}
										onClick={() =>
											activate({
												kind: "session",
												path: s.path,
												anchors: s.anchors,
											})
										}
									>
										<span className="gs-item-title">
											{s.name || s.path.split(/[\\/]/).pop()}
											<em className="gs-item-meta">{s.messageCount}</em>
										</span>
										<span className="gs-item-sub">{s.firstMessage}</span>
									</button>
								);
							})}
						</div>
					)}

					{projectHits.length > 0 && (
						<div className="gs-section">
							{sectionHead(t("gsProjects"), projectHits.length, <FiFolder />)}
							{projectHits.map((p) => {
								navIdx++;
								const idx = navIdx;
								const isCurrent = cwd && p.path === cwd;
								return (
									<button
										key={p.path}
										type="button"
										className={idx === active ? "gs-item active" : "gs-item"}
										onMouseEnter={() => setActive(idx)}
										onClick={() => activate({ kind: "project", path: p.path })}
									>
										<span className="gs-item-title">
											{p.path.split(/[\\/]/).pop()}
											{isCurrent && <em className="gs-item-meta">{t("gsCurrentProject")}</em>}
										</span>
										<span className="gs-item-sub">{p.path}</span>
									</button>
								);
							})}
						</div>
					)}

					{(fileHits.length > 0 || (q && fileTruncated)) && (
						<div className="gs-section">
							{sectionHead(t("gsFiles"), fileHits.length, <FiFileText />)}
							{fileHits.map((f) => {
								navIdx++;
								const idx = navIdx;
								return (
									<button
										key={`${f.type}:${f.path}`}
										type="button"
										className={idx === active ? "gs-item active" : "gs-item"}
										disabled={f.type === "dir"}
										title={f.type === "dir" ? undefined : t("gsOpenPreview")}
										onMouseEnter={() => setActive(idx)}
										onClick={() => {
											if (f.type === "file")
												activate({
													kind: "file",
													path: f.path,
													name: f.name,
												});
										}}
									>
										<span className="gs-item-title">{f.name}</span>
										<span className="gs-item-sub">{f.path}</span>
									</button>
								);
							})}
							{fileTruncated && <div className="gs-truncated">{t("gsTruncated")}</div>}
						</div>
					)}
				</div>

				<div className="gs-foot">
					<span>↑↓ {t("gsNavigate")}</span>
					<span>Enter {t("gsOpen")}</span>
					<span>Esc {t("gsCloseHint")}</span>
				</div>
			</div>
		</div>
	);
}
