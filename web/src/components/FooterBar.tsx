import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { FiFolder } from "react-icons/fi";
import type { ChatState } from "../use-chat";
import { useT } from "../i18n";
import { appSend, useAppField, useAppGlobals } from "../app-globals";
import { cacheMetrics, estimateStreamTokens, streamRate, trimRateSamples, type RateSample } from "../cache-stats";
import type { UiSlotEntry } from "../ui-slots";

interface FooterBarProps {
	/** 底栏条目（bottombar 槽位：内置 + 插件的最终结果，宿主已排好序）。 */
	bottombarItems?: import("../ui-slots").UiSlotEntry[];
	/** 点击一个条目：view 由宿主切视图，其余（action）交给贡献它的插件。 */
	onUiAction?: (item: import("../ui-slots").UiSlotEntry, value?: string) => void;
	chat: ChatState;
}

/** 机器根（此电脑/盘符列表）wire 字面量 —— 与 server/files-service.ts 的 MACHINE_ROOT 同值。 */
const MACHINE_ROOT = "@root";

/** 未接线时的回退顺序（= BUILTIN_UI_ITEMS 里 bottombar 槽位的默认次序）。
 *  降级路径没有 slot 数据，分区只能按这张静态表（正常链路一律走 entry.align）。 */
const FALLBACK_BOTTOMBAR: { id: string; align: "start" | "end" }[] = [
	{ id: "host:conn", align: "start" },
	{ id: "host:engine", align: "start" },
	{ id: "host:ctx", align: "start" },
	{ id: "host:cost", align: "start" },
	{ id: "host:cache", align: "start" },
	{ id: "host:msg-count", align: "start" },
	{ id: "host:plugin-status", align: "start" },
	{ id: "host:working", align: "start" },
	{ id: "host:host-metrics", align: "end" },
	{ id: "host:cwd", align: "end" },
];

/**
 * Compact status bar: connection, context usage, cost, session, queue, and the
 * workspace path — click the path to open a directory picker (browse into
 * folders, go up, create folders, or pick one as the working directory).
 */
export function FooterBar({ chat, bottombarItems, onUiAction }: FooterBarProps) {
	const t = useT();
	// 引擎徐标：走全局（web/src/app-globals.ts），不依赖 chat 整体对象。
	const { engine } = useAppGlobals();
	/** 额外工作区根（多根，见 server/protocol.ts 的 set_workspace_roots）：cwd 选择器里
	 *  可以直接把**当前浏览的目录**加成根 —— 这是除「右栏文件树右键」之外的第二个人口，
	 *  底栏本来就是改/看工作目录的地方，用户找得到。 */
	const workspaceRoots = useAppField("workspaceRoots");
	const state = chat.state;
	const [editing, setEditing] = useState(false);
	/** Directory currently shown in the picker (absolute, "/"-separated). */
	const [browsePath, setBrowsePath] = useState("");
	/** Free-form path input (still available for typing exact paths). */
	const [draft, setDraft] = useState("");
	/** "New folder" inline input state. */
	const [showNew, setShowNew] = useState(false);
	const [newName, setNewName] = useState("");
	/** Tab 补全的当前候选下标（-1 = 未选中，Tab 从头开始）。 */
	const [compIndex, setCompIndex] = useState(-1);
	const inputRef = useRef<HTMLInputElement>(null);
	const newInputRef = useRef<HTMLInputElement>(null);
	/** Completion list scoped to the picker: directories only (files are noise
	 *  for a working-directory selector; the free-form input covers files). */
	const dirs = chat.pathCompletions.filter((c) => c.type === "dir");

	/** Browse query with trailing separator so the server lists the WHOLE dir. */
	const browseQuery = (p: string) => (p.endsWith("/") ? p : p + "/");

	/** Parent of an absolute "/"-separated path; null at the filesystem root.
	 *  Windows 盘符根（"C:"）的父级是机器根 @root（盘符列表）；posix "/" 无父级。 */
	const parentOf = (p: string): string | null => {
		let s = p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
		if (s === MACHINE_ROOT || s === "/") return null;
		const i = s.lastIndexOf("/");
		if (i < 0) {
			// "/"、盘符根 "C:" 或裸名
			return /^[A-Za-z]:$/.test(s) ? MACHINE_ROOT : null;
		}
		if (i === 0) return "/"; // posix "/foo" → "/"
		const parent = s.slice(0, i);
		// Windows drive root resolves weirdly without the trailing slash.
		return /^[A-Za-z]:$/.test(parent) ? parent + "/" : parent;
	};

	// Debounced listing request while the picker is open.
	useEffect(() => {
		if (!editing) return;
		const t = setTimeout(() => {
			appSend({ type: "complete_path", path: browseQuery(browsePath) });
		}, 60);
		return () => clearTimeout(t);
	}, [browsePath, editing]);

	// 输入草稿 ≠ 当前浏览目录（正在打字）时，按草稿请求补全供 Tab 接受 ——
	// 换盘符（输入 D:）与任意路径的增量补全都走这里。
	useEffect(() => {
		if (!editing || draft === browsePath) return;
		const t = setTimeout(() => {
			appSend({ type: "complete_path", path: draft });
		}, 150);
		return () => clearTimeout(t);
	}, [draft, browsePath, editing]);

	// Live generation-speed samples (tokens/sec). Kept in a ref so pushing a
	// sample never triggers a re-render. The SDK only commits a turn's usage
	// counters at message_end, so `stats.tokens.output` is FLAT while streaming —
	// instead we estimate tokens from the in-flight message content (text +
	// thinking), which grows every token. Sample at most every 250ms; baseline
	// resets the moment streaming stops.
	const samplesRef = useRef<RateSample[]>([]);
	const streamingNow = state?.isStreaming ?? false;
	const streamEst = state?.streamingMessage ? estimateStreamTokens(state.streamingMessage.content) : 0;
	useEffect(() => {
		if (!streamingNow) {
			samplesRef.current = [];
			return;
		}
		const now = Date.now();
		const prev = samplesRef.current;
		const last = prev[prev.length - 1];
		if (last && now - last.t < 250) return; // throttle
		samplesRef.current = trimRateSamples([...prev, { t: now, out: streamEst }], now);
	}, [streamingNow, streamEst]);

	if (!state) return null;
	const s = state.stats;

	const cache = cacheMetrics(s.tokens);
	const hitPct = cache.hitRate * 100;
	const hitClass = cache.totalInput === 0 ? "" : cache.hitRate >= 0.7 ? "ok" : cache.hitRate >= 0.4 ? "mid" : "warn";
	const hitText = cache.totalInput > 0 ? `${hitPct.toFixed(1)}%` : "—";
	const rate = streamingNow ? streamRate(samplesRef.current) : 0;

	const connClass = chat.ready ? "ok" : chat.status === "closed" ? "error" : "busy";
	const connLabel = chat.ready ? t("connected") : chat.status === "closed" ? t("reconnecting") : t("connecting");

	const context = s.contextUsage;
	// 压缩软上限（issue #229 / #245）：设置了有效软上限时，底栏进度条与数字显示以该上限为满格刻度
	const cap = context.softCap ?? null;
	const hasCap = cap !== null && cap > 0 && cap < context.contextWindow;
	const effectiveMax = hasCap ? cap : context.contextWindow;

	const ctxPercent =
		context.tokens !== null && effectiveMax > 0
			? Math.min(100, Math.round((context.tokens / effectiveMax) * 100))
			: null;
	const ctxText =
		context.tokens !== null && ctxPercent !== null
			? `${context.estimated ? "~" : ""}${formatTokens(context.tokens)} / ${formatTokens(effectiveMax)}`
			: "—";
	const ctxBarClass = ctxPercent === null ? "" : ctxPercent >= 80 ? "warn" : ctxPercent >= 50 ? "mid" : "ok";

	const queueTotal = state.queue.steering.length + state.queue.followUp.length;

	const startEdit = () => {
		// 服务端 cwd 是原生分隔符（Windows 下带反斜杠），选择器内部统一用 "/"，
		// 否则 parentOf 按 "/" 切分会直接返回 null，↑ 按钮一开始就是禁用的。
		const norm = state.cwd.replace(/\\/g, "/");
		setDraft(norm);
		setBrowsePath(norm);
		setShowNew(false);
		setNewName("");
		setEditing(true);
	};

	/** Toggle the working directory and close the picker. 机器根是虚拟层，不能作工作目录。 */
	const commit = (path: string) => {
		const trimmed = path.trim();
		if (trimmed === MACHINE_ROOT) return;
		if (trimmed && trimmed !== state.cwd) appSend({ type: "set_cwd", path: trimmed });
		setEditing(false);
	};

	/** Create a folder under the currently browsed directory. */
	const createFolder = () => {
		const name = newName.trim();
		if (!name) return;
		appSend({ type: "make_dir", path: `${browseQuery(browsePath)}${name}` });
		// make_dir has no direct response — refresh the listing shortly after.
		setTimeout(() => {
			appSend({ type: "complete_path", path: browseQuery(browsePath) });
		}, 80);
		setNewName("");
		setShowNew(false);
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			setEditing(false);
		} else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
			commit(draft);
		} else if (e.key === "Tab") {
			// Tab 补全：循环接受目录候选（换盘符也走这里——候选可能是 D: 盘）。
			if (dirs.length === 0) return;
			e.preventDefault();
			const idx = compIndex >= 0 ? (compIndex + 1) % dirs.length : 0;
			setCompIndex(idx);
			setDraft(dirs[idx].path);
			setBrowsePath(dirs[idx].path);
		}
	};

	const upPath = parentOf(browsePath);

	/**
	 * 宿主内置条目的**节点工厂**（issue #146 的「位置登记」真正落地）：底栏的可见性与顺序
	 * 完全由 `bottombarItems`（= `buildUiSlots` 的结果）决定 —— 用户在设置面板「界面布局」里
	 * 隐藏一条、或在 ↑↓ 里挪一条，这里就少画一个 / 换位置（以前宿主条目写死在 JSX 里，
	 * 布局页那几个勾选框是摆设）。
	 *
	 * 条件渲染（引擎徽标只在非 pi 引擎、插件状态只在有状态、工作中只在流式时）留在各工厂里：
	 * 条件不满足 → 返回 null → 那一条**连同分隔符**一起不画（不留孤零零的 `·`）。
	 */
	const hostNodes: Record<string, ReactNode> = {
		"host:conn": (
			<span className={`status-item status-conn ${connClass}`} title={connLabel}>
				<span className={`status-dot ${connClass}`} />
				<span className="status-conn-label">{connLabel}</span>
			</span>
		),
		"host:engine":
			engine !== "pi" ? (
				<span className={`status-item engine-badge engine-${engine}`} title={`${t("engineBadge")}: ${engine}`}>
					{engine === "dsh" ? "DSH" : engine}
				</span>
			) : null,
		"host:ctx": (() => {
			const ctxTitle = hasCap
				? `${t("contextUsage")}: ${formatTokens(context.tokens ?? 0)} / ${formatTokens(cap)} (${t("softCapMarker")}, max ${formatTokens(context.contextWindow)})`
				: cap !== null && cap > 0
					? `${t("contextUsage")} · ${t("softCapMarker")}: ${formatTokens(cap)}`
					: t("contextUsage");
			return (
				<span className="status-item status-ctx" title={ctxTitle}>
					{/* 窄屏（≤420px）只留进度条 + 数字，标签由 CSS 收起 */}
					<span className="ctx-label">{t("context")}</span>
					<span className={`ctx-bar ${ctxBarClass}`}>
						{ctxPercent !== null && (
							<span className="ctx-bar-fill" style={{ width: `${Math.min(ctxPercent, 100)}%` }} />
						)}
					</span>
					{ctxText}
				</span>
			);
		})(),
		"host:cost": (
			<span className="status-item" title={t("cumulativeCost")}>
				${formatCost(s.cost)}
			</span>
		),
		"host:cache": (
			<span
				className="status-item status-cache"
				title={t("cacheHitTip", {
					read: formatTokens(cache.read),
					write: formatTokens(cache.write),
					miss: formatTokens(cache.miss),
					input: formatTokens(cache.totalInput),
				})}
			>
				{t("cacheHit")}
				<b className={`cache-pct ${hitClass}`}>{hitText}</b>
			</span>
		),
		"host:msg-count": (
			<span className="status-item" title={t("sessionMessages")}>
				{t("messages")} {s.totalMessages}
			</span>
		),
		"host:plugin-status":
			chat.statuses.length > 0 ? (
				<span className="status-item ext-status" title={t("pluginStatus")}>
					{chat.statuses.map((st) => st.text).join(" · ")}
				</span>
			) : null,
		"host:working": state.isStreaming ? (
			<>
				<span className="status-item working">
					<span className="working-spin" />
					{t("working")}
					{queueTotal > 0 && (
						<span className="status-queue">
							⏳ {queueTotal} {t("queued")}
						</span>
					)}
				</span>
				<span className="status-item status-rate" title={t("rateTip")}>
					{/* 手机上「工作中」文案被隐藏，这里给个小转圈（仅窄屏显示） */}
					<span className="working-spin rate-spin" />
					{rate > 0 ? `${Math.round(rate)}${t("tps")}` : "…"}
				</span>
			</>
		) : null,
		"host:host-metrics": (() => {
			const metrics = chat.hostMetrics;
			if (!metrics) return null;
			const cpu =
				metrics.cpuPercent === null || !Number.isFinite(metrics.cpuPercent)
					? "—"
					: `${Math.round(metrics.cpuPercent)}%`;
			const memory = Number.isFinite(metrics.memoryPercent) ? `${Math.round(metrics.memoryPercent)}%` : "—";
			return (
				<span
					className="status-item status-host-metrics"
					title={`${t("hostResourcesTip")}\n${t("hostProcessor")}: ${cpu} · ${t("hostMemory")}: ${memory}`}
				>
					{t("hostProcessor")} {cpu} · {t("hostMemory")} {memory}
				</span>
			);
		})(),
		"host:cwd": editing ? (
			<>
				{/* Click-away backdrop closes the picker. */}
				<div className="status-cwd-backdrop" onClick={() => setEditing(false)} />
				<div className="cwd-picker">
					<div className="cwd-picker-head">
						<span className="cwd-picker-title" title={browsePath === MACHINE_ROOT ? t("computer") : browsePath}>
							{browsePath === MACHINE_ROOT ? "💻" : <FiFolder />}
							<span>{browsePath === MACHINE_ROOT ? t("computer") : browsePath}</span>
						</span>
						<button
							type="button"
							className="cwd-up"
							disabled={browsePath === MACHINE_ROOT}
							title={t("computer")}
							onClick={() => {
								setBrowsePath(MACHINE_ROOT);
								setDraft(MACHINE_ROOT);
								setCompIndex(-1);
							}}
						>
							💻
						</button>
						<button
							type="button"
							className="cwd-up"
							disabled={!upPath}
							title={t("cwdGoUp")}
							onClick={() => {
								if (upPath) {
									setBrowsePath(upPath);
									setDraft(upPath);
									setCompIndex(-1);
								}
							}}
						>
							↑ {t("cwdGoUp")}
						</button>
						{/* 把当前浏览的目录加成「额外工作区根」（宿主侧多根）：与右栏文件树右键的
						    「添加为工作区根」同一件事，两条入口。已在列 / 就是主工作区 / 机器根时禁用。 */}
						{(() => {
							// 选择器内部统一用 "/"（见 startEdit 的归一），而 state.cwd / roots 是原生分隔符：
							// 比路径一律折成 "/" 再比（win32 再折大小写），否则主工作区会被误判成「可加」。
							const norm = (p: string) => {
								const f = p.replace(/\\/g, "/").replace(/\/+$/, "");
								// win32 盘符路径折大小写（同一目录的两种写法不该被当成两个）；posix 不折。
								return /^[A-Za-z]:/.test(f) ? f.toLowerCase() : f;
							};
							const cur = norm(browsePath);
							const canAddRoot =
								Boolean(browsePath) &&
								browsePath !== MACHINE_ROOT &&
								cur !== norm(state.cwd) &&
								!workspaceRoots.some((r) => norm(r) === cur);
							return (
								<button
									type="button"
									className="cwd-up"
									disabled={!canAddRoot}
									title={t("addWorkspaceRootHint")}
									onClick={() => {
										if (!canAddRoot) return;
										appSend({ type: "set_workspace_roots", roots: [...workspaceRoots, browsePath] });
									}}
								>
									＋ {t("addWorkspaceRoot")}
								</button>
							);
						})()}
					</div>
					<div className="cwd-picker-row">
						<input
							ref={inputRef}
							className="status-cwd-input cwd-picker-input"
							value={draft}
							placeholder={t("enterPath")}
							spellCheck={false}
							onChange={(e) => {
								setDraft(e.target.value);
								setCompIndex(-1);
							}}
							onKeyDown={onKeyDown}
						/>
						<button
							type="button"
							className="cwd-choose-btn primary"
							title={t("cwdPickCurrent")}
							disabled={browsePath === MACHINE_ROOT}
							onClick={() => commit(browsePath)}
						>
							{t("cwdPickCurrent")}
						</button>
					</div>
					<div className="cwd-list">
						{dirs.length === 0 && <div className="cwd-empty">{t("cwdEmpty")}</div>}
						{dirs.map((d) => (
							<div key={d.path} className="cwd-item">
								<button
									type="button"
									className="cwd-enter"
									title={`${t("cwdEnter")} ${d.path}`}
									onClick={() => {
										setBrowsePath(d.path);
										setDraft(d.path);
										setCompIndex(-1);
									}}
								>
									<FiFolder />
									<span className="cwd-name">{d.name}</span>
								</button>
								<button type="button" className="cwd-choose-btn" title={t("cwdChoose")} onClick={() => commit(d.path)}>
									{t("cwdChoose")}
								</button>
							</div>
						))}
					</div>
					<div className="cwd-picker-foot">
						{showNew ? (
							<div className="cwd-newrow">
								<input
									ref={newInputRef}
									value={newName}
									autoFocus
									spellCheck={false}
									placeholder={t("cwdNewName")}
									onChange={(e) => setNewName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.nativeEvent.isComposing) {
											e.preventDefault();
											createFolder();
										} else if (e.key === "Escape") {
											e.stopPropagation();
											setShowNew(false);
											setNewName("");
										}
									}}
								/>
								<button type="button" className="cwd-choose-btn primary" onClick={createFolder}>
									{t("cwdCreate")}
								</button>
								<button
									type="button"
									className="cwd-choose-btn"
									onClick={() => {
										setShowNew(false);
										setNewName("");
									}}
								>
									{t("cwdCancel")}
								</button>
							</div>
						) : (
							<button type="button" className="cwd-newbtn" onClick={() => setShowNew(true)}>
								＋ {t("cwdNewFolder")}
							</button>
						)}
					</div>
				</div>
			</>
		) : (
			<button
				type="button"
				className="status-item status-cwd"
				title={t("cwdTip", { path: state.cwd })}
				onClick={startEdit}
			>
				📁 {state.cwd}
			</button>
		),
	};

	/**
	 * 按 slot 顺序落成要画的一串：宿主条目查节点工厂，插件条目画按钮。
	 *
	 * `bottombarItems` 没给（未接线 / 单测）时**回退到内置默认顺序**：没拿到 slot 数据就把整个
	 * 底栏清空是最糟的降级（与 TopBar 的 hostOn 同口径）。
	 */
	const entries: { id: string; entry: UiSlotEntry | null; fallbackAlign: "start" | "end" }[] = bottombarItems
		? bottombarItems.map((e) => ({ id: e.id, entry: e, fallbackAlign: "start" as const }))
		: FALLBACK_BOTTOMBAR.map(({ id, align }) => ({ id, entry: null, fallbackAlign: align }));
	const leftItems: { key: string; node: ReactNode }[] = [];
	const centerItems: { key: string; node: ReactNode }[] = [];
	const rightItems: { key: string; node: ReactNode }[] = [];
	for (const { id, entry, fallbackAlign } of entries) {
		if (entry?.hidden) continue;
		let node: ReactNode = null;
		if (id.startsWith("host:")) {
			node = hostNodes[id];
		} else if (entry) {
			// kind="select"：底栏空间小，只画下拉本身（title=hint||label）。
			if (entry.kind === "select" && entry.options?.length) {
				node = (
					<select
						className="status-select"
						title={entry.hint ?? entry.label}
						aria-label={entry.label}
						value={
							entry.options.some((o) => o.value === entry.value) ? (entry.value as string) : entry.options[0]!.value
						}
						onChange={(e) => onUiAction?.(entry, e.target.value)}
					>
						{entry.options.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				);
			} else {
				node = (
					<button
						type="button"
						className="status-action"
						title={entry.hint ?? entry.label}
						onClick={() => onUiAction?.(entry)}
					>
						{entry.icon ? `${entry.icon} ` : ""}
						{entry.label}
						{entry.badge ? <span className="status-badge">{entry.badge}</span> : null}
					</button>
				);
			}
		}
		if (!node) continue;
		// 分区走数据不走 id：正常链路看 entry.align（manifest/arrange/用户偏好都能改），
		// 降级链路（entry 为空）看 FALLBACK 表里的静态 align。
		const zone = entry?.align ?? fallbackAlign;
		if (zone === "end") {
			rightItems.push({ key: id, node });
		} else if (zone === "center") {
			centerItems.push({ key: id, node });
		} else {
			leftItems.push({ key: id, node });
		}
	}

	const renderGroup = (groupItems: { key: string; node: ReactNode }[]) =>
		groupItems.map((it, i) => (
			<Fragment key={it.key}>
				{/* 分隔符只在「前面真画了东西」时插：条件不满足的宿主条目不留孤儿 `·`。 */}
				{i > 0 && <span className="status-sep">·</span>}
				{it.node}
			</Fragment>
		));

	return (
		<footer className="statusbar">
			<div className="statusbar-left">{renderGroup(leftItems)}</div>
			{centerItems.length > 0 && <div className="statusbar-center">{renderGroup(centerItems)}</div>}
			<div className="statusbar-right">{renderGroup(rightItems)}</div>
		</footer>
	);
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}

function formatCost(cost: number): string {
	if (cost <= 0) return "0";
	if (cost < 0.0001) return "<0.0001";
	return cost.toFixed(4).replace(/\.?0+$/, "");
}
