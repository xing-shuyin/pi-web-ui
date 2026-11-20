import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { randomUuid } from "../uuid";
import {
	FiChevronDown,
	FiChevronUp,
	FiCopy,
	FiCornerUpLeft,
	FiEdit2,
	FiMenu,
	FiPlay,
	FiPlus,
	FiRefreshCw,
	FiTerminal,
	FiTrash2,
	FiX,
} from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { CommandDef } from "../types";
import { TermXterm, type TermContextRequest } from "./TermXterm";
import { TerminalContextMenu, type TerminalMenuEntry } from "./TerminalContextMenu";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import type { TerminalOwnerKind } from "../terminal-bridge";
import { buildTerminalQuote } from "../terminal-quote";
import { composeToComposer, focusComposer } from "../composer-bridge";

const tabKey = (t: TerminalMeta) =>
	JSON.stringify([t.ownerKind ?? "client", t.ownerKind === "conversation" ? t.conversationId : "", t.id]);
import type { UiSlotEntry } from "../ui-slots";
import { renderMergedToolbar, renderSlotToolbar } from "../slot-toolbar";
export { renderSlotToolbar };

interface TerminalPanelProps {
	chat: ChatState;
	terminal: {
		create: (meta: TerminalMeta) => void;
		close: (id: string, ownerKind?: TerminalOwnerKind, conversationId?: string) => void;
		register: (
			conversationId: string,
			id: string,
			writer: { write(data: string): void; dispose(): void },
			ownerKind?: TerminalOwnerKind,
		) => () => void;
		restart: (id: string) => void;
		select: (id: string) => void;
	};
	uiTerminalToolbar?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry) => void;
	collapsed?: boolean;
	onToggleCollapse?: () => void;
	/** 头部 ✕ = 隐藏面板（终端会话继续跑）；杀终端只走每个 tab 自己的 ✕。必传：否则右上角会变成一个点了没反应的按钮。 */
	onHide: () => void;
}

interface Draft {
	name: string;
	command: string;
	cwd: string;
}

/**
 * 终端右键菜单：一次弹一份，开在新光标处。
 * 两处右键是两个不同的东西——标签上右键引用的是「这个终端对象」，输出区右键引用的是「这段文字」。
 */
type TerminalMenuState =
	| ({ kind: "output"; terminalId: string; title: string } & TermContextRequest)
	| { kind: "tab"; x: number; y: number; tab: TerminalMeta };

const EMPTY_DRAFT: Draft = { name: "", command: "", cwd: "${pwd}" };

/* 命令栏：固定在终端左侧的一列，不再是贴着按钮的浮层。开合与宽度都记住。 */
const RAIL_OPEN_KEY = "pi-web-ui:term-cmd-rail-open";
const RAIL_WIDTH_KEY = "pi-web-ui:term-cmd-rail-w";
const RAIL_MIN_W = 176;
const RAIL_DEFAULT_W = 252;
/** 与 drawer.css 手机断点一致：窄屏命令栏改成盖住终端的抽屉。 */
const NARROW_QUERY = "(max-width: 768px)";

function isNarrowViewport(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(NARROW_QUERY).matches;
}

function readRailOpen(): boolean {
	try {
		const raw = localStorage.getItem(RAIL_OPEN_KEY);
		if (raw === "0" || raw === "1") return raw === "1";
	} catch {
		/* localStorage 可能被禁用，退回默认开 */
	}
	return true;
}

function readRailWidth(): number {
	try {
		const raw = localStorage.getItem(RAIL_WIDTH_KEY);
		const v = raw === null ? Number.NaN : Number(raw);
		if (Number.isFinite(v) && v >= RAIL_MIN_W) return v;
	} catch {
		/* 同上 */
	}
	return RAIL_DEFAULT_W;
}

export function TerminalPanel({
	chat: allChat,
	terminal,
	uiTerminalToolbar,
	onUiAction,
	collapsed = false,
	onToggleCollapse,
	onHide,
}: TerminalPanelProps) {
	const activeConversationId = allChat.activeConversationId || allChat.state?.conversationId || "";
	const shellTerminals = useMemo(
		() =>
			allChat.terminals.filter(
				(item) =>
					!item.nativeCli &&
					((item.ownerKind ?? "client") === "client" || item.conversationId === activeConversationId),
			),
		[allChat.terminals, activeConversationId],
	);
	const chat = { ...allChat, terminals: shellTerminals };
	const t = useT();
	const [activeId, setActiveId] = useState<string | null>(null);
	const [cmdRailOpen, setCmdRailOpen] = useState<boolean>(() => !isNarrowViewport() && readRailOpen());
	const [railWidth, setRailWidth] = useState<number>(readRailWidth);
	const [railDragging, setRailDragging] = useState(false);
	const mainRef = useRef<HTMLDivElement | null>(null);
	const [isNew, setIsNew] = useState(false);
	const [editingIdx, setEditingIdx] = useState<number | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	const [confirmDel, setConfirmDel] = useState<number | null>(null);
	const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [aiBashOpen, setAiBashOpen] = useState(true);
	const [renamingTab, setRenamingTab] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [termMenu, setTermMenu] = useState<TerminalMenuState | null>(null);

	useEffect(() => {
		if (chat.terminals.length === 0) setActiveId(null);
		else if (!chat.terminals.some((t) => tabKey(t) === activeId)) {
			setActiveId(tabKey(chat.terminals[chat.terminals.length - 1]));
		}
	}, [chat.terminals, activeId]);

	useEffect(() => {
		if (chat.terminalActiveId) {
			const tab = chat.terminals.find((t) => t.id === chat.terminalActiveId && (t.ownerKind ?? "client") === "client");
			if (tab) setActiveId(tabKey(tab));
		}
	}, [chat.terminalActiveId]);

	useEffect(() => {
		// 窄屏命令栏是临时抽屉（盖住终端），不写回桌面上的“常驻”偏好。
		if (isNarrowViewport()) return;
		try {
			localStorage.setItem(RAIL_OPEN_KEY, cmdRailOpen ? "1" : "0");
		} catch {
			/* 忽略持久化失败 */
		}
	}, [cmdRailOpen]);

	useEffect(() => {
		if (railDragging) return;
		try {
			localStorage.setItem(RAIL_WIDTH_KEY, String(Math.round(railWidth)));
		} catch {
			/* 忽略持久化失败 */
		}
	}, [railWidth, railDragging]);

	/** 窄屏命令栏盖着终端：一旦要看终端（新建/运行/切 tab）就自动让位。 */
	const dismissRailOnNarrow = () => {
		if (isNarrowViewport()) setCmdRailOpen(false);
	};

	const railMaxWidth = () => {
		const host = mainRef.current?.clientWidth ?? window.innerWidth;
		return Math.max(RAIL_MIN_W + 40, Math.round(host * 0.5));
	};

	/** 拖右侧分隔条改命令栏宽度；双击复位。 */
	const onRailGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const el = e.currentTarget;
		const startX = e.clientX;
		const startW = railWidth;
		const ceil = railMaxWidth();
		let last = startW;
		el.setPointerCapture(e.pointerId);
		setRailDragging(true);
		document.body.classList.add("panel-resizing");
		const move = (ev: PointerEvent) => {
			last = Math.min(ceil, Math.max(RAIL_MIN_W, Math.round(startW + (ev.clientX - startX))));
			setRailWidth(last);
		};
		const up = () => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
			el.removeEventListener("pointercancel", up);
			document.body.classList.remove("panel-resizing");
			setRailDragging(false);
			try {
				localStorage.setItem(RAIL_WIDTH_KEY, String(last));
			} catch {
				/* 忽略持久化失败 */
			}
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
		el.addEventListener("pointercancel", up);
	};

	useEffect(() => {
		return () => {
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		};
	}, []);

	const userTabs = chat.terminals.filter((t) => !t.agentBash);
	const agentTabs = chat.terminals.filter((t) => t.agentBash);

	const openTab = (
		meta: Omit<TerminalMeta, "running" | "exitCode" | "id" | "conversationId" | "cols" | "rows"> &
			Partial<Pick<TerminalMeta, "cols" | "rows">>,
	) => {
		if (!chat.ready) return;
		const id = randomUuid();
		const conversationId = chat.activeConversationId || chat.state?.conversationId || "";
		terminal.create({
			...meta,
			id,
			conversationId,
			cols: meta.cols ?? 80,
			rows: meta.rows ?? 24,
			running: true,
			exitCode: null,
		});
		setActiveId(JSON.stringify(["client", "", id]));
		dismissRailOnNarrow();
	};

	const openShell = () =>
		openTab({
			title: t("terminalTitle", { n: userTabs.length + 1 }),
			cwd: chat.state?.cwd ?? "",
		});

	const runCommand = (cmd: CommandDef) => {
		dismissRailOnNarrow();
		const title = cmd.name || cmd.command;
		const existing = chat.terminals.find((t) => t.title === title && (t.ownerKind ?? "client") === "client");
		if (existing) {
			terminal.restart(existing.id);
			setActiveId(tabKey(existing));
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
			return;
		}
		openTab({ title, cwd: chat.state?.cwd ?? "", command: cmd });
	};

	const closeTab = (key: string) => {
		const tab = chat.terminals.find((item) => tabKey(item) === key);
		if (!tab) return;
		appSend({
			type: "terminal_kill",
			terminalId: tab.id,
			conversationId: tab.conversationId,
			ownerKind: tab.ownerKind ?? "client",
		});
		terminal.close(tab.id, tab.ownerKind ?? "client", tab.conversationId);
		if (activeId === key) setActiveId(null);
	};

	/** 输出区右键「引用到输入框」：有选中就用选中，没选中就用当前屏幕（视口）那段输出。 */
	const quoteTerminalOutput = (target: { text: string; terminalId: string; title: string }) => {
		const quote = buildTerminalQuote({
			text: target.text,
			terminalId: target.terminalId,
			sessionId: allChat.state?.sessionId ?? "",
		});
		if (!quote) return;
		const accepted = composeToComposer({
			attachments: [{ path: "", name: target.title, mode: "quote", quote, key: randomUuid() }],
		});
		if (accepted) focusComposer();
	};

	/**
	 * 标签右键「引用到输入框」：引用的是**终端这个对象**（id + 标题 + 现场解析的 cwd/命令），
	 * 不是一段文字。AI 拿到 id 后用 terminal 工具按需读它的实时输出，所以引用不会立刻过期。
	 */
	const referenceTerminalTab = (tab: TerminalMeta) => {
		const accepted = composeToComposer({
			attachments: [{ path: "", name: tab.title, mode: "terminal", terminalId: tab.id, key: `terminal:${tab.id}` }],
		});
		if (accepted) focusComposer();
	};

	const copyTerminalText = (text: string) => {
		void navigator.clipboard?.writeText(text).catch(() => {});
	};

	const termMenuEntries: TerminalMenuEntry[] = !termMenu
		? []
		: termMenu.kind === "output"
			? [
					{ id: "quote", label: t("quoteConversation"), icon: <FiCornerUpLeft /> },
					...(termMenu.fromSelection ? [{ id: "copy", label: t("copy"), icon: <FiCopy /> }] : []),
				]
			: [
					{ id: "reference", label: t("referenceTerminal"), icon: <FiCornerUpLeft /> },
					{ id: "rename", label: t("renameTerminal"), icon: <FiEdit2 /> },
					{ id: "close", label: t("closeTerminal"), icon: <FiX /> },
				];

	const onTermMenuSelect = (id: string) => {
		const target = termMenu;
		setTermMenu(null);
		if (!target) return;
		if (target.kind === "output") {
			if (id === "quote") quoteTerminalOutput(target);
			else if (id === "copy") copyTerminalText(target.text);
			return;
		}
		if (id === "reference") referenceTerminalTab(target.tab);
		else if (id === "rename") {
			setRenameDraft(target.tab.title);
			setRenamingTab(tabKey(target.tab));
		} else if (id === "close") closeTab(tabKey(target.tab));
	};

	const renderTab = (tab: TerminalMeta) => (
		<div
			key={tabKey(tab)}
			className={`term-tab ${tabKey(tab) === activeId ? "active" : ""}`}
			onContextMenu={(e) => {
				// 重命名输入框里右键还是走系统菜单（复制 / 粘贴文本）
				if (e.target instanceof Element && e.target.closest("input, textarea")) return;
				e.preventDefault();
				e.stopPropagation();
				setTermMenu({ kind: "tab", x: e.clientX, y: e.clientY, tab });
			}}
		>
			<button
				type="button"
				className="term-tab-main"
				title={`${tab.cwd}${tab.command ? `\n> ${tab.command.command}` : ""}`}
				onClick={() => {
					if (renamingTab) return;
					setActiveId(tabKey(tab));
					dismissRailOnNarrow();
				}}
			>
				<span className={`term-tab-dot ${tab.running ? "run" : "exit"}`} />
				<span className="term-tab-title">
					{renamingTab === tabKey(tab) ? (
						<input
							autoFocus
							className="term-tab-rename-input"
							value={renameDraft}
							placeholder={tab.title}
							onClick={(e) => e.stopPropagation()}
							onChange={(e) => setRenameDraft(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter" && !e.nativeEvent.isComposing) {
									const title = renameDraft.trim();
									if (title)
										appSend({
											type: "rename_terminal",
											terminalId: tab.id,
											conversationId: tab.conversationId,
											ownerKind: tab.ownerKind ?? "client",
											title,
										});
									setRenamingTab(null);
								} else if (e.key === "Escape") {
									setRenamingTab(null);
								}
							}}
							onBlur={() => setRenamingTab(null)}
						/>
					) : (
						tab.title
					)}
					{!tab.running && (
						<span className="term-tab-exit">
							{t("exited", {
								code: tab.exitCode === null ? "" : ` ${tab.exitCode}`,
							})}
						</span>
					)}
				</span>
			</button>
			<button
				type="button"
				className="term-tab-close term-tab-rename"
				title={t("renameTerminal")}
				onClick={(e) => {
					e.stopPropagation();
					setRenameDraft(tab.title);
					setRenamingTab(tabKey(tab));
				}}
			>
				<FiEdit2 />
			</button>
			<button type="button" className="term-tab-close" title={t("closeTerminal")} onClick={() => closeTab(tabKey(tab))}>
				<FiX />
			</button>
		</div>
	);

	const startNew = () => {
		setIsNew(true);
		setEditingIdx(null);
		setDraft(EMPTY_DRAFT);
	};

	const startEdit = (idx: number) => {
		const c = chat.commands[idx];
		if (!c) return;
		setIsNew(false);
		setEditingIdx(idx);
		setDraft({ name: c.name, command: c.command, cwd: c.cwd ?? "" });
	};

	const cancelEdit = () => {
		setIsNew(false);
		setEditingIdx(null);
	};

	const saveDraft = () => {
		const name = draft.name.trim();
		const command = draft.command.trim();
		if (!name || !command) return;
		const cwd = draft.cwd.trim();
		const def: CommandDef = { name, command, cwd: cwd ? cwd : undefined };
		const next = isNew
			? [...chat.commands, def]
			: editingIdx !== null
				? chat.commands.map((c, i) => (i === editingIdx ? def : c))
				: chat.commands;
		appSend({ type: "save_commands", commands: next });
		cancelEdit();
	};

	const requestDelete = (idx: number) => {
		if (confirmDel === idx) {
			const next = chat.commands.filter((_, i) => i !== idx);
			appSend({ type: "save_commands", commands: next });
			setConfirmDel(null);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		} else {
			setConfirmDel(idx);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
			confirmTimer.current = setTimeout(() => setConfirmDel(null), 2500);
		}
	};

	const editing = isNew || editingIdx !== null;

	const TERM_DEFAULT_ORDER = ["host:term-cmd-refresh", "host:term-cmd-new", "host:term-tab-new"];
	const allTermEntries: UiSlotEntry[] =
		uiTerminalToolbar === undefined
			? TERM_DEFAULT_ORDER.map((id) => ({ id, source: "host" }) as UiSlotEntry)
			: uiTerminalToolbar.filter((e) => !e.hidden);
	const termZone = (ids: string[], withPlugins: boolean): UiSlotEntry[] => {
		const set = new Set(ids);
		return allTermEntries.filter((e) => set.has(e.id) || (withPlugins && e.source !== "host"));
	};
	const termLabel = (id: string, fallback: string): string => {
		const e = allTermEntries.find((x) => x.id === id);
		return e?.labelExplicit ? e.label : fallback;
	};
	const termHostNodes: Record<string, ReactNode> = {
		"host:term-cmd-refresh": (
			<button
				type="button"
				className="panel-refresh"
				title={termLabel("host:term-cmd-refresh", t("rerun"))}
				onClick={() => appSend({ type: "list_commands" })}
			>
				<FiRefreshCw />
			</button>
		),
		"host:term-cmd-new": (
			<button
				type="button"
				className="panel-new"
				title={termLabel("host:term-cmd-new", t("newCommand"))}
				onClick={startNew}
			>
				<FiPlus />
			</button>
		),
		"host:term-tab-new": (
			<button
				type="button"
				className="panel-new"
				title={termLabel("host:term-tab-new", t("newTerminal"))}
				onClick={openShell}
			>
				<FiPlus />
			</button>
		),
	};

	const runningCount = chat.terminals.filter((item) => item.running).length;

	const commandsBody = editing ? (
		<div className="cmd-form">
			<label htmlFor="cmd-name">{t("name")}</label>
			<input
				id="cmd-name"
				className="cmd-input"
				value={draft.name}
				placeholder={t("exampleName")}
				autoFocus
				onChange={(e) => setDraft({ ...draft, name: e.target.value })}
			/>
			<label htmlFor="cmd-command">{t("command")}</label>
			<input
				id="cmd-command"
				className="cmd-input"
				value={draft.command}
				placeholder={t("exampleCommand")}
				onChange={(e) => setDraft({ ...draft, command: e.target.value })}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.nativeEvent.isComposing) {
						saveDraft();
					}
				}}
			/>
			<label htmlFor="cmd-cwd">
				{t("directory")} <span className="cmd-hint">{t("cwdHint")}</span>
			</label>
			<input
				id="cmd-cwd"
				className="cmd-input"
				value={draft.cwd}
				placeholder="${pwd}"
				onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.nativeEvent.isComposing) {
						saveDraft();
					}
				}}
			/>
			<div className="cmd-form-actions">
				<button type="button" className="btn" onClick={cancelEdit}>
					{t("cancel")}
				</button>
				<button
					type="button"
					className="btn primary"
					disabled={!draft.name.trim() || !draft.command.trim()}
					onClick={saveDraft}
				>
					{t("save")}
				</button>
			</div>
		</div>
	) : (
		<>
			{chat.commands.length === 0 && <div className="panel-empty">{t("noCommands")}</div>}
			{chat.commands.map((c, i) => (
				<div key={i} className="cmd-item">
					<button type="button" className="cmd-run" title={t("clickToRun")} onClick={() => runCommand(c)}>
						<FiPlay />
					</button>
					<button type="button" className="cmd-main" title={t("clickToRun")} onClick={() => runCommand(c)}>
						<span className="cmd-name">{c.name}</span>
						<span className="cmd-command">{c.command}</span>
						{c.cwd && <span className="cmd-cwd">{c.cwd}</span>}
					</button>
					<button type="button" className="cmd-act" title={t("edit")} onClick={() => startEdit(i)}>
						<FiEdit2 />
					</button>
					<button
						type="button"
						className={`cmd-act del ${confirmDel === i ? "confirm" : ""}`}
						title={t("delete")}
						onClick={() => requestDelete(i)}
					>
						{confirmDel === i ? t("confirmQ") : <FiTrash2 />}
					</button>
				</div>
			))}
		</>
	);

	return (
		<div className="terminal-view">
			<div
				className="term-main"
				ref={mainRef}
				style={{ "--term-cmd-w": `${Math.round(railWidth)}px` } as CSSProperties}
			>
				{cmdRailOpen && (
					<>
						<aside className="term-cmd-rail term-commands" aria-label={t("commands")}>
							<div className="panel-header term-cmd-head">
								<span className="panel-title">{t("commands")}</span>
								<div className="panel-header-actions">
									{renderMergedToolbar(
										termZone(["host:term-cmd-refresh", "host:term-cmd-new"], false),
										termHostNodes,
										onUiAction,
									)}
								</div>
							</div>
							<div className="panel-body term-cmd-body">{commandsBody}</div>
						</aside>
						<div
							className="term-cmd-grip resize-handle"
							role="separator"
							aria-orientation="vertical"
							title={t("dragToResize")}
							onPointerDown={onRailGripDown}
							onDoubleClick={() => setRailWidth(RAIL_DEFAULT_W)}
						/>
					</>
				)}
				<div className="term-panes">
					<div className="td-head">
						<div className="td-tabs">
							{userTabs.map(renderTab)}
							{agentTabs.length > 0 && (
								<>
									<button
										type="button"
										className={`td-group ${aiBashOpen ? "" : "closed"}`}
										title={t("aiBashGroup")}
										onClick={() => setAiBashOpen((v) => !v)}
									>
										<span className="td-caret">▾</span>
										<span>{t("aiBashGroup")}</span>
										<span className="td-count">{agentTabs.length}</span>
									</button>
									{aiBashOpen && agentTabs.map(renderTab)}
								</>
							)}
							{chat.terminals.length === 0 && <span className="td-empty-hint">{t("noTerminal")}</span>}
						</div>
						<div className="td-sep" />
						{renderMergedToolbar(termZone(["host:term-tab-new"], true), termHostNodes, onUiAction)}
						<div className="td-actions">
							{runningCount > 0 && (
								<span className="td-badge">
									<span className="td-tab-dot run" />
									{runningCount}
								</span>
							)}
							<button
								type="button"
								className={`icon-btn term-cmd-toggle${cmdRailOpen ? " on" : ""}`}
								title={t("commands")}
								aria-pressed={cmdRailOpen}
								onClick={() => setCmdRailOpen((v) => !v)}
							>
								<FiMenu />
							</button>
							<button
								type="button"
								className="icon-btn"
								title={collapsed ? t("termDrawerExpand") : t("termDrawerCollapse")}
								onClick={onToggleCollapse}
							>
								{collapsed ? <FiChevronUp /> : <FiChevronDown />}
							</button>
							<button type="button" className="icon-btn" title={t("termDrawerHide")} onClick={onHide}>
								<FiX />
							</button>
						</div>
					</div>
					<div className="term-body">
						{chat.terminals.length === 0 ? (
							<div className="term-empty">
								<FiTerminal className="term-empty-icon" />
								<div className="term-empty-title">{t("builtinTerminal")}</div>
								<div className="term-empty-sub">{t("termEmptySub")}</div>
							</div>
						) : (
							chat.terminals.map((tab) => (
								<TermXterm
									key={tabKey(tab)}
									ownerKind={tab.ownerKind ?? "client"}
									conversationId={tab.conversationId}
									terminalId={tab.id}
									command={tab.command}
									cwd={tab.cwd}
									title={tab.title}
									agentBash={tab.agentBash}
									active={tabKey(tab) === activeId}
									running={tab.running}
									exitCode={tab.exitCode}
									register={terminal.register}
									onContextRequest={(request) =>
										setTermMenu({ kind: "output", ...request, terminalId: tab.id, title: tab.title })
									}
								/>
							))
						)}
					</div>
				</div>
			</div>
			{termMenu && (
				<TerminalContextMenu
					x={termMenu.x}
					y={termMenu.y}
					entries={termMenuEntries}
					onSelect={onTermMenuSelect}
					onClose={() => setTermMenu(null)}
				/>
			)}
		</div>
	);
}
