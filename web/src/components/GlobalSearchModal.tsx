import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiFileText, FiFolder, FiMessageSquare, FiPackage, FiSearch, FiX } from "react-icons/fi";
import type { FileSearchResult, MessageAnchor, ProjectSummary, SessionSearchResult } from "../types";
import { useT } from "../i18n";
import { getPluginSearchProvider, listPluginSearchProviders, triggerPluginUiAction } from "../plugin-host";
import { appSend, useAppField, useEngineCapabilities } from "../app-globals";
import { composeToComposer } from "../composer-bridge";
import { nextSearchReqId } from "../search-req-id";

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
	onClose: () => void;
	onSwitchSession: (path: string, anchors?: MessageAnchor[]) => void;
	onSwitchProject: (path: string) => void;
	onPreviewFile: (path: string, name: string) => void;
}

function matches(text: string, q: string): boolean {
	return text.toLowerCase().includes(q);
}

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
	const capabilities = useEngineCapabilities();
	const pluginSectionLabel = t("pluginMenuTitle");
	const cwd = useAppField("cwd");
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const [active, setActive] = useState(0);
	const lastReqRef = useRef(0);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
			} else if (item.kind === "plugin") {
				void triggerPluginUiAction(item.providerId, item.action, item.action).catch(() => {});
			} else onPreviewFile(item.path, item.name);
		},
		[onSwitchSession, onSwitchProject, onPreviewFile, deferredQuery],
	);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
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
