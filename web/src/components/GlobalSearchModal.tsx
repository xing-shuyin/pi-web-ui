import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiFileText, FiFolder, FiMessageSquare, FiPackage, FiSearch, FiX } from "react-icons/fi";
import type { FileSearchResult, MessageAnchor, ProjectSummary, SessionSearchResult } from "../types";
import { useT } from "../i18n";
import { getPluginSearchProvider, listPluginSearchProviders, triggerPluginUiAction } from "../plugin-host";
import { appSend, useAppField } from "../app-globals";
import { composeToComposer } from "../composer-bridge";
import { nextSearchReqId } from "../search-req-id";

interface GlobalSearchModalProps {
	/** 常驻挂载：open=false 时隐藏但仍保留查询词与结果，下次打开直接恢复 */
	open: boolean;
	/** Recent projects (lazy — requested on open). */
	projects: ProjectSummary[];
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
 * ④ 插件：各插件经 host.searchProviders 注册的全局搜索提供者（无提供者整节不渲染）。
 * 点击结果后面板保持打开、结果不被清空，可直接点下一条；会话点击
 * 会收起面板并跳到命中消息的位置（搜索状态仍保留在面板里，重开即恢复）。
 */
export function GlobalSearchModal({
	open,
	projects,
	fileSearch,
	sessionSearch,
	onClose,
	onSwitchSession,
	onSwitchProject,
	onPreviewFile,
}: GlobalSearchModalProps) {
	const t = useT();
	// 节标题复用现成词条（zh「插件」/ en「Plugins」/ 各语言包自带译文）。
	const pluginSectionLabel = t("pluginMenuTitle");
	// 当前工作目录：走全局（web/src/app-globals.ts），不再从 App 传（项目行的
	// 「当前」标记与 cwd 变化重探测都靠它）。
	const cwd = useAppField("cwd");
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const [active, setActive] = useState(0);
	const lastReqRef = useRef(0);
	// Debounce timer so typing doesn't fire a workspace walk per keystroke.
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// 缓存属于本次查询的文件搜索结果，避免其他组件（如 ChatInput @补全）
	// 的并发或后续 fileSearch 把当前展示结果冲掉（issue #496）。
	const [activeFileSearch, setActiveFileSearch] = useState<{
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null>(null);

	// 每次打开面板时发起探测（不是 App 挂载时）：预热会话/项目列表，并用
	// 当前查询重新跑文件/会话搜索 —— 面板关闭期间 cwd 或转录可能已变化，
	// 重开要的是新鲜结果；新 reqId 会遮蔽仓库里携带旧 reqId 的结果。
	useEffect(() => {
		if (!open) return;
		appSend({ type: "list_sessions" });
		appSend({ type: "list_projects" });
		const qq = query.trim();
		if (qq) {
			const reqId = nextSearchReqId();
			lastReqRef.current = reqId;
			setSearchPending(true);
			appSend({ type: "search_files", reqId, query: qq });
			appSend({ type: "search_sessions", reqId, query: qq });
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
			setActiveFileSearch(null);
			return;
		}
		debounceRef.current = setTimeout(() => {
			const reqId = nextSearchReqId();
			lastReqRef.current = reqId;
			setSearchPending(true);
			appSend({ type: "search_files", reqId, query: q });
			appSend({ type: "search_sessions", reqId, query: q });
		}, 300);
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- send is stable
	}, [deferredQuery]);

	// 当服务端推送的 fileSearch 携带的是本组件最新发出的 reqId 时才认领
	useEffect(() => {
		if (fileSearch && fileSearch.reqId === lastReqRef.current) {
			setActiveFileSearch(fileSearch);
		}
	}, [fileSearch]);

	const q = deferredQuery.trim().toLowerCase();

	const sessionHits = useMemo(() => {
		if (!q || !sessionSearch || sessionSearch.reqId !== lastReqRef.current || !sessionSearch.ok) return [];
		// 服务端全文匹配结果（已含 AI 输出），直接按返回顺序展示
		return sessionSearch.results;
	}, [sessionSearch, q]);
	const projectHits = useMemo(() => (q ? projects.filter((p) => matches(p.path, q)).slice(0, 10) : []), [projects, q]);
	const fileHits = useMemo(() => {
		if (!q || !activeFileSearch || !activeFileSearch.ok) return [];
		return activeFileSearch.results;
	}, [activeFileSearch, q]);

	// Clear the "searching" hint once BOTH latest responses (files + sessions)
	// have landed — either one still pending keeps the hint on.
	useEffect(() => {
		if (
			activeFileSearch &&
			activeFileSearch.reqId === lastReqRef.current &&
			sessionSearch &&
			sessionSearch.reqId === lastReqRef.current &&
			lastReqRef.current !== 0
		) {
			setSearchPending(false);
		}
	}, [activeFileSearch, sessionSearch]);
	const fileTruncated = !!activeFileSearch && activeFileSearch.ok && activeFileSearch.truncated;

	/** ④ 插件命中（一行 = 一个 provider 的一条 search 结果）。 */
	interface PluginHit {
		providerId: string;
		providerLabel: string;
		title: string;
		hint?: string;
		action: string;
	}
	const [pluginHits, setPluginHits] = useState<PluginHit[]>([]);
	// 有 query 时调每个 provider 的 search(q)：Promise.allSettled + 单家 3000ms 超时；
	// searchProviders 是模块级内存注册表（api 上的字段只是它的代理）：优先经已挂载的
	// 宿主实例枚举（与插件看到的是同一份），未挂载回落直接 import；list() 只给轻量信息，
	// search 函数走条目自带的（typeof 防御，没有就不调）——无提供者时下面整节不渲染。
	useEffect(() => {
		if (!open) return;
		const qq = deferredQuery.trim();
		if (!qq) {
			setPluginHits([]);
			return;
		}
		let cancelled = false;
		interface ProviderLike {
			id: string;
			label: string;
			search?: (q: string) => Promise<unknown>;
		}
		let providers: ProviderLike[] = [];
		try {
			const w = window as unknown as { __piWebUiHost?: { searchProviders?: { list?: () => unknown } } };
			const viaHost = w.__piWebUiHost?.searchProviders?.list;
			if (typeof viaHost === "function") {
				const arr: unknown = viaHost.call(w.__piWebUiHost);
				if (Array.isArray(arr)) providers = arr as ProviderLike[];
			} else if (typeof listPluginSearchProviders === "function") {
				providers = listPluginSearchProviders() as ProviderLike[];
			}
		} catch {
			providers = [];
		}
		// list() 只给轻量信息（无 search 函数）：经 getPluginSearchProvider 补全可调定义。
		const searchable = providers
			.filter((p) => p && typeof p.id === "string")
			.map((p) => {
				if (typeof p.search === "function") return p;
				try {
					const full = getPluginSearchProvider(p.id);
					return full && typeof full.search === "function" ? { ...p, search: full.search } : null;
				} catch {
					return null;
				}
			})
			.filter((p): p is ProviderLike & { search: (q: string) => Promise<unknown> } => !!p);
		if (searchable.length === 0) {
			setPluginHits([]);
			return;
		}
		void Promise.allSettled(
			searchable.map((p) =>
				Promise.race([
					(p.search as (q: string) => Promise<unknown>)(qq),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
				]).then(
					(items) => ({ provider: p, items: Array.isArray(items) ? items : [] }),
					() => ({ provider: p, items: [] as unknown[] }),
				),
			),
		).then((settled) => {
			if (cancelled) return;
			const hits: PluginHit[] = [];
			for (const s of settled) {
				if (s.status !== "fulfilled") continue;
				for (const it of s.value.items) {
					if (!it || typeof it !== "object") continue;
					const rec = it as { title?: unknown; hint?: unknown; action?: unknown };
					if (typeof rec.title !== "string" || typeof rec.action !== "string") continue;
					hits.push({
						providerId: s.value.provider.id,
						providerLabel: s.value.provider.label,
						title: rec.title,
						...(typeof rec.hint === "string" ? { hint: rec.hint } : {}),
						action: rec.action,
					});
				}
			}
			setPluginHits(hits.slice(0, 20));
		});
		return () => {
			cancelled = true;
		};
	}, [open, deferredQuery]);

	/** Flat navigation order: conversations → projects → files → plugins. */
	type NavItem =
		| { kind: "session"; path: string; anchors: MessageAnchor[] }
		| { kind: "project"; path: string }
		| { kind: "file"; path: string; name: string }
		| { kind: "plugin"; providerId: string; providerLabel: string; title: string; action: string };
	const navItems = useMemo<NavItem[]>(
		() => [
			...sessionHits.map((s) => ({
				kind: "session" as const,
				path: s.path,
				anchors: s.anchors,
			})),
			...projectHits.map((p) => ({ kind: "project" as const, path: p.path })),
			...fileHits.filter((f) => f.type === "file").map((f) => ({ kind: "file" as const, path: f.path, name: f.name })),
			...pluginHits.map((h) => ({
				kind: "plugin" as const,
				providerId: h.providerId,
				providerLabel: h.providerLabel,
				title: h.title,
				action: h.action,
			})),
		],
		[sessionHits, projectHits, fileHits, pluginHits],
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
				appSend({ type: "list_sessions" });
				appSend({ type: "list_projects" });
				const qq = deferredQuery.trim();
				if (qq) {
					const reqId = nextSearchReqId();
					lastReqRef.current = reqId;
					setSearchPending(true);
					appSend({ type: "search_files", reqId, query: qq });
					appSend({ type: "search_sessions", reqId, query: qq });
				}
			} else if (item.kind === "plugin") {
				// 插件命中：交给插件自己的 UI 动作（签名与 App 的顶栏条目调用一致）；
				// 无人接管静默忽略，面板保持打开，可直接点下一条。
				void triggerPluginUiAction(item.providerId, item.action, item.action).catch(() => {
					/* 忽略 */
				});
			} else onPreviewFile(item.path, item.name);
			// 项目/文件点击不关面板：结果继续保持，可直接点下一条；
			// 会话点击已在上方收起（为让跳转可见），搜索状态仍保留、重开即恢复。
		},
		[onSwitchSession, onSwitchProject, onPreviewFile, deferredQuery],
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
				// 审查 #14：空结果时长度为 0，min(a+1, -1) 会把 active 推成 -1 ——
				// 下限钳到 0，保证 active 始终指向合法条目（空列表则停在 0）。
				setActive((a) => Math.max(0, Math.min(a + 1, navItems.length - 1)));
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

	const total = sessionHits.length + projectHits.length + fileHits.length + pluginHits.length;

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
								const title = s.name || s.path.split(/[\\/]/).pop() || s.path;
								return (
									<div key={s.path} className="gs-item-wrap">
										<button
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
												{title}
												<em className="gs-item-meta">{s.messageCount}</em>
											</span>
											<span className="gs-item-sub">{s.firstMessage}</span>
										</button>
										<button
											type="button"
											className="gs-quote"
											title={t("quoteConversation")}
											onClick={(e) => {
												e.stopPropagation();
												composeToComposer({
													attachments: [
														{
															path: "",
															key: `conv||${s.path}`,
															name: title,
															mode: "conversation",
															sessionPath: s.path,
														},
													],
												});
											}}
										>
											💬 {t("quoteConversationShort")}
										</button>
									</div>
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

					{pluginHits.length > 0 && (
						<div className="gs-section">
							{sectionHead(pluginSectionLabel, pluginHits.length, <FiPackage />)}
							{pluginHits.map((h, hi) => {
								navIdx++;
								const idx = navIdx;
								return (
									<button
										key={`${h.providerId}:${h.action}:${hi}`}
										type="button"
										className={idx === active ? "gs-item active" : "gs-item"}
										title={h.providerLabel}
										onMouseEnter={() => setActive(idx)}
										onClick={() =>
											activate({
												kind: "plugin",
												providerId: h.providerId,
												providerLabel: h.providerLabel,
												title: h.title,
												action: h.action,
											})
										}
									>
										<span className="gs-item-title">{h.title}</span>
										<span className="gs-item-sub">{h.hint ?? h.providerLabel}</span>
									</button>
								);
							})}
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
