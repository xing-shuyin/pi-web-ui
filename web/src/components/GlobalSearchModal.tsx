import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
	type MouseEvent,
	type ReactNode,
} from "react";
import { FiFileText, FiFolder, FiMessageSquare, FiPackage, FiSearch, FiX } from "react-icons/fi";
import type { FileSearchResult, MessageAnchor, ProjectSummary, SessionSearchResult } from "../types";
import { useT, type Translate } from "../i18n";
import { getPluginSearchProvider, listPluginSearchProviders, triggerPluginUiAction } from "../plugin-host";
import { appSend, useAppField, useEngineCapabilities } from "../app-globals";
import { composeToComposer } from "../composer-bridge";
import { nextSearchReqId } from "../search-req-id";
import { closeContextMenu, contextMenuItems, getContextMenu, openContextMenu } from "../context-menu-state";
import { openQuickAsk, type QuickAskReferenceSource } from "../quick-ask";
import { copyTextToClipboard } from "../use-copy-feedback";
import type { UiSlotEntry } from "../ui-slots";

interface GlobalSearchModalProps {
	open: boolean;
	projects: ProjectSummary[];
	fileSearch: {
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null;
	sessionSearch: {
		reqId: number;
		ok: boolean;
		results: SessionSearchResult[];
	} | null;
	uiContextSearch?: UiSlotEntry[];
	quickAskReferenceMenus?: boolean;
	onClose: () => void;
	onSwitchSession: (path: string, anchors?: MessageAnchor[]) => void;
	onSwitchProject: (path: string) => void;
	onPreviewFile: (path: string, name: string) => void;
	onOpenFolder?: (path: string) => void;
}

export type SearchMenuTarget =
	| { kind: "session"; path: string; title: string; anchors: MessageAnchor[]; pinned: boolean; sessionId?: string }
	| { kind: "project"; path: string }
	| { kind: "file" | "folder"; path: string; name: string }
	| { kind: "plugin"; providerId: string; providerLabel: string; title: string; action: string };

function baseName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function joinWorkspacePath(cwd: string, path: string): string {
	if (!cwd || !path) return path;
	if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
	return `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

function menuTargetId(target: SearchMenuTarget): string {
	return target.kind === "plugin" ? `${target.providerId}:${target.action}` : target.path;
}

function menuTargetLabel(target: SearchMenuTarget): string {
	switch (target.kind) {
		case "session":
			return target.title;
		case "plugin":
			return target.title;
		case "file":
		case "folder":
			return target.name;
		default:
			return baseName(target.path);
	}
}

/**
 * 搜索结果的右键菜单条目：内置条目按命中类型显隐/改标签，插件条目原样透传（`when` 判据由右键菜单层评估）。
 */
export function buildSearchMenuEntries(
	entries: readonly UiSlotEntry[],
	target: SearchMenuTarget,
	opts: { t: Translate; conversationRef: boolean; quickAskReferenceMenus: boolean },
): UiSlotEntry[] {
	const { t } = opts;
	const openLabel =
		target.kind === "file"
			? t("fileOpenPreview")
			: target.kind === "folder"
				? t("fileEnterDir")
				: target.kind === "project"
					? t("searchMenuSwitchProject")
					: t("gsOpen");
	const relative = target.kind === "file" || target.kind === "folder";
	return entries.map((entry) => {
		if (entry.source !== "host") return entry;
		switch (entry.id) {
			case "host:search-open":
				return { ...entry, label: openLabel };
			case "host:search-open-folder":
				return target.kind === "project" ? entry : { ...entry, hidden: true };
			case "host:search-reveal":
				return target.kind === "plugin" ? { ...entry, hidden: true } : entry;
			case "host:search-pin":
				if (target.kind !== "session") return { ...entry, hidden: true };
				return target.pinned ? { ...entry, label: t("unpinConversation") } : entry;
			case "host:search-quote":
				return target.kind === "session" && opts.conversationRef ? entry : { ...entry, hidden: true };
			case "host:search-quick-ask":
				return opts.quickAskReferenceMenus && target.kind !== "plugin" ? entry : { ...entry, hidden: true };
			case "host:search-copy-rel":
				return relative ? entry : { ...entry, hidden: true };
			case "host:search-copy-path":
				return target.kind === "plugin" ? { ...entry, hidden: true } : entry;
			case "host:search-copy-id":
				return target.kind === "session" && target.sessionId ? entry : { ...entry, hidden: true };
			default:
				return entry;
		}
	});
}

function matches(text: string, q: string): boolean {
	return text.toLowerCase().includes(q);
}

export function GlobalSearchModal({
	open,
	projects,
	fileSearch,
	sessionSearch,
	uiContextSearch = [],
	quickAskReferenceMenus = true,
	onClose,
	onSwitchSession,
	onSwitchProject,
	onPreviewFile,
	onOpenFolder,
}: GlobalSearchModalProps) {
	const t = useT();
	const capabilities = useEngineCapabilities();
	const pluginSectionLabel = t("pluginMenuTitle");
	const cwd = useAppField("cwd");
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const [active, setActive] = useState(0);
	const lastReqRef = useRef(0);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const menuTargetRef = useRef<SearchMenuTarget | null>(null);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [flash, setFlash] = useState("");

	const flashCopied = useCallback(() => {
		setFlash(t("copied"));
		if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
		flashTimerRef.current = setTimeout(() => setFlash(""), 1600);
	}, [t]);

	useEffect(
		() => () => {
			if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
		},
		[],
	);

	useEffect(() => {
		if (open) return;
		if (getContextMenu()?.slot === "contextmenu.search") closeContextMenu();
	}, [open]);

	const [activeFileSearch, setActiveFileSearch] = useState<{
		reqId: number;
		ok: boolean;
		results: FileSearchResult[];
		truncated?: boolean;
	} | null>(null);

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

	const [searchPending, setSearchPending] = useState(false);

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

	useEffect(() => {
		if (fileSearch && fileSearch.reqId === lastReqRef.current) {
			setActiveFileSearch(fileSearch);
		}
	}, [fileSearch]);

	const q = deferredQuery.trim().toLowerCase();

	const sessionHits = useMemo(() => {
		if (!q || !sessionSearch || sessionSearch.reqId !== lastReqRef.current || !sessionSearch.ok) return [];
		return sessionSearch.results;
	}, [sessionSearch, q]);
	const projectHits = useMemo(() => (q ? projects.filter((p) => matches(p.path, q)).slice(0, 10) : []), [projects, q]);
	const fileHits = useMemo(() => {
		if (!q || !activeFileSearch || !activeFileSearch.ok) return [];
		return activeFileSearch.results;
	}, [activeFileSearch, q]);

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

	interface PluginHit {
		providerId: string;
		providerLabel: string;
		title: string;
		hint?: string;
		action: string;
	}
	const [pluginHits, setPluginHits] = useState<PluginHit[]>([]);
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

	type NavItem =
		| { kind: "session"; path: string; anchors: MessageAnchor[] }
		| { kind: "project"; path: string }
		| { kind: "file"; path: string; name: string }
		| { kind: "folder"; path: string }
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
			...fileHits.filter((f) => f.type === "dir").map((f) => ({ kind: "folder" as const, path: f.path })),
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
				onClose();
			} else if (item.kind === "project") {
				onSwitchProject(item.path);
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
			} else if (item.kind === "folder") {
				onOpenFolder?.(item.path);
				onClose();
			} else if (item.kind === "plugin") {
				void triggerPluginUiAction(item.providerId, item.action, item.action).catch(() => {});
			} else onPreviewFile(item.path, item.name);
		},
		[onSwitchSession, onSwitchProject, onPreviewFile, onOpenFolder, deferredQuery],
	);

	const navItemOf = useCallback((target: SearchMenuTarget): NavItem => {
		switch (target.kind) {
			case "session":
				return { kind: "session", path: target.path, anchors: target.anchors };
			case "project":
				return { kind: "project", path: target.path };
			case "folder":
				return { kind: "folder", path: target.path };
			case "file":
				return { kind: "file", path: target.path, name: target.name };
			default:
				return {
					kind: "plugin",
					providerId: target.providerId,
					providerLabel: target.providerLabel,
					title: target.title,
					action: target.action,
				};
		}
	}, []);

	const quickAskReferenceOf = useCallback(
		(target: SearchMenuTarget): QuickAskReferenceSource | undefined => {
			if (target.kind === "session") return { kind: "conversation", sessionFile: target.path };
			if (target.kind === "plugin") return undefined;
			if (target.kind === "project") return { kind: "directory", path: target.path };
			return { kind: target.kind === "folder" ? "directory" : "file", path: joinWorkspacePath(cwd, target.path) };
		},
		[cwd],
	);

	const searchMenuEntries = useCallback(
		(target: SearchMenuTarget): UiSlotEntry[] =>
			buildSearchMenuEntries(uiContextSearch, target, {
				t,
				conversationRef: capabilities.conversationRef,
				quickAskReferenceMenus,
			}),
		[uiContextSearch, capabilities.conversationRef, quickAskReferenceMenus, t],
	);

	const dispatchSearchMenuEntry = useCallback(
		(entryId: string) => {
			const target = menuTargetRef.current;
			if (!target) return;
			const copy = (text: string) => {
				void copyTextToClipboard(text).then((ok) => {
					if (ok) flashCopied();
				});
			};
			switch (entryId) {
				case "host:search-open":
					activate(navItemOf(target));
					return;
				case "host:search-open-folder":
					if (target.kind !== "project") return;
					onOpenFolder?.(target.path);
					onClose();
					return;
				case "host:search-reveal":
					if (target.kind === "plugin") return;
					appSend({ type: "file_reveal", path: target.path });
					return;
				case "host:search-pin":
					if (target.kind !== "session") return;
					appSend({ type: "pin_session", path: target.path, pinned: !target.pinned });
					return;
				case "host:search-quote":
					if (target.kind !== "session") return;
					composeToComposer({
						attachments: [
							{
								path: "",
								key: `conv||${target.path}`,
								name: target.title,
								mode: "conversation",
								sessionPath: target.path,
							},
						],
					});
					return;
				case "host:search-quick-ask": {
					const reference = quickAskReferenceOf(target);
					if (reference) openQuickAsk({ reference });
					return;
				}
				case "host:search-copy-name": {
					if (target.kind === "session" || target.kind === "plugin") copy(target.title);
					else if (target.kind === "project") copy(baseName(target.path));
					else copy(target.name);
					return;
				}
				case "host:search-copy-rel":
					if (target.kind === "file" || target.kind === "folder") copy(target.path);
					return;
				case "host:search-copy-path": {
					if (target.kind === "session" || target.kind === "project") copy(target.path);
					else if (target.kind === "file" || target.kind === "folder") copy(joinWorkspacePath(cwd, target.path));
					return;
				}
				case "host:search-copy-id":
					if (target.kind === "session" && target.sessionId) copy(target.sessionId);
					return;
				default:
					return;
			}
		},
		[activate, cwd, flashCopied, navItemOf, onClose, onOpenFolder, quickAskReferenceOf],
	);

	const showSearchMenu = useCallback(
		(e: MouseEvent<HTMLElement>, target: SearchMenuTarget) => {
			e.preventDefault();
			e.stopPropagation();
			menuTargetRef.current = target;
			const entries = searchMenuEntries(target);
			if (contextMenuItems(entries).length === 0) return;
			openContextMenu({
				x: e.clientX,
				y: e.clientY,
				slot: "contextmenu.search",
				target: { id: menuTargetId(target), kind: target.kind, label: menuTargetLabel(target) },
				entries,
				onHostAction: (entry) => dispatchSearchMenuEntry(entry.id),
			});
		},
		[dispatchSearchMenuEntry, searchMenuEntries],
	);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			// 菜单打开时键盘归菜单（上下键/回车/Esc 都不该再驱动结果列表）
			if (getContextMenu()) return;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
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

	const sectionHead = (label: string, count: number, icon: ReactNode) => (
		<div className="gs-section-head">
			{icon}
			<span>{label}</span>
			<em>{count}</em>
		</div>
	);

	let navIdx = -1;

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
								const title =
									s.displayName ||
									s.name ||
									s.firstMessage?.trim() ||
									(s.path.split(/[\\/]/).pop() || s.path).replace(/\.jsonl$/i, "");
								return (
									<div
										key={s.path}
										className="gs-item-wrap"
										onContextMenu={(e) => {
											setActive(idx);
											showSearchMenu(e, {
												kind: "session",
												path: s.path,
												title,
												anchors: s.anchors,
												pinned: Boolean(s.pinned),
												...(s.sessionId ? { sessionId: s.sessionId } : {}),
											});
										}}
									>
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
										{capabilities.conversationRef && (
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
										)}
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
										onContextMenu={(e) => {
											setActive(idx);
											showSearchMenu(e, { kind: "project", path: p.path });
										}}
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
										title={t("gsOpenPreview")}
										onMouseEnter={() => setActive(idx)}
										onContextMenu={(e) => {
											setActive(idx);
											showSearchMenu(e, {
												kind: f.type === "dir" ? "folder" : "file",
												path: f.path,
												name: f.name,
											});
										}}
										onClick={() => {
											if (f.type === "file")
												activate({
													kind: "file",
													path: f.path,
													name: f.name,
												});
											else
												activate({
													kind: "folder",
													path: f.path,
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
										onContextMenu={(e) => {
											setActive(idx);
											showSearchMenu(e, {
												kind: "plugin",
												providerId: h.providerId,
												providerLabel: h.providerLabel,
												title: h.title,
												action: h.action,
											});
										}}
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
					{flash && <span className="gs-flash">{flash}</span>}
				</div>
			</div>
		</div>
	);
}
