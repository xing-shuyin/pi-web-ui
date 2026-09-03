import { useEffect, useRef, useState } from "react";
import { randomUuid } from "../uuid";
import { FiEdit2, FiMenu, FiPlay, FiPlus, FiRefreshCw, FiTerminal, FiTrash2, FiX } from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { ClientMessage, CommandDef } from "../types";
import { TermXterm } from "./TermXterm";
import { useT } from "../i18n";

interface TerminalPanelProps {
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	terminal: {
		create: (meta: TerminalMeta) => void;
		close: (id: string) => void;
		register: (
			conversationId: string,
			id: string,
			writer: { write(data: string): void; dispose(): void },
		) => () => void;
		restart: (id: string) => void;
		select: (id: string) => void;
	};
}

interface Draft {
	name: string;
	command: string;
	cwd: string;
}

const EMPTY_DRAFT: Draft = { name: "", command: "", cwd: "${pwd}" };

/**
 * Built-in terminal — two panes:
 *   left : user command list (.pi/commands.json) on top + terminal tabs below
 *          (on mobile this whole column slides in as a drawer)
 *   right: the active terminal (one xterm per tab, kept mounted)
 */
export function TerminalPanel({ chat, send, terminal }: TerminalPanelProps) {
	const t = useT();
	const [activeId, setActiveId] = useState<string | null>(null);
	// Mobile: the left column (commands + tabs) slides in as a drawer.
	const [sideOpen, setSideOpen] = useState(false);
	// Command list editing state.
	const [isNew, setIsNew] = useState(false);
	const [editingIdx, setEditingIdx] = useState<number | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	// Two-step delete confirmation.
	const [confirmDel, setConfirmDel] = useState<number | null>(null);
	const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 终端接管 bash 的「AI bash」折叠分组开关（默认展开）。
	const [aiBashOpen, setAiBashOpen] = useState(true);
	const [renamingTab, setRenamingTab] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");

	// When the connection drops the server kills all PTYs and the reducer clears
	// the tab list — make sure the active selection doesn't dangle.
	useEffect(() => {
		if (chat.terminals.length === 0) setActiveId(null);
		else if (!chat.terminals.some((t) => t.id === activeId)) {
			setActiveId(chat.terminals[chat.terminals.length - 1].id);
		}
	}, [chat.terminals, activeId]);

	// The SCM / settings panel asked to focus a specific terminal tab (git write
	// ops, uninstall runs) — follow the request so the user sees the command run.
	useEffect(() => {
		if (chat.terminalActiveId) {
			setActiveId(chat.terminalActiveId);
			setSideOpen(false);
		}
	}, [chat.terminalActiveId]);

	useEffect(() => {
		return () => {
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		};
	}, []);

	// -- tab management --------------------------------------------------------

	// 终端接管 bash 的 ai-bash 终端单独归到「AI bash」折叠分组，与用户终端分开。
	const userTabs = chat.terminals.filter((t) => !t.agentBash);
	const agentTabs = chat.terminals.filter((t) => t.agentBash);

	const openTab = (
		meta: Omit<TerminalMeta, "running" | "exitCode" | "id" | "conversationId" | "cols" | "rows"> &
			Partial<Pick<TerminalMeta, "cols" | "rows">>,
	) => {
		if (!chat.ready) return; // topbar already shows the connection state
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
		setActiveId(id);
		setSideOpen(false);
	};

	const openShell = () =>
		openTab({
			title: t("terminalTitle", { n: userTabs.length + 1 }),
			cwd: chat.state?.cwd ?? "",
		});

	const runCommand = (cmd: CommandDef) => {
		const title = cmd.name || cmd.command;
		// Reuse a terminal with the same title (VSCode-style task reuse): the
		// command is re-run in the SAME tab — a running process is interrupted
		// first (the server kills the PTY's process group and starts fresh).
		const existing = chat.terminals.find((t) => t.title === title);
		if (existing) {
			terminal.restart(existing.id);
			setActiveId(existing.id);
			send({
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

	const closeTab = (id: string) => {
		const tab = chat.terminals.find((item) => item.id === id);
		if (tab) send({ type: "terminal_kill", terminalId: id, conversationId: tab.conversationId });
		terminal.close(id);
		if (activeId === id) {
			const rest = chat.terminals.filter((t) => t.id !== id);
			setActiveId(rest.length > 0 ? rest[rest.length - 1].id : null);
		}
	};

	// 单个终端标签（用户终端 + ai-bash 分组共用）。
	const renderTab = (tab: TerminalMeta) => (
		<div key={tab.id} className={`term-tab ${tab.id === activeId ? "active" : ""}`}>
			<button
				type="button"
				className="term-tab-main"
				title={`${tab.cwd}${tab.command ? `\n> ${tab.command.command}` : ""}`}
				onClick={() => {
					if (renamingTab) return;
					setActiveId(tab.id);
					setSideOpen(false);
				}}
			>
				<span className={`term-tab-dot ${tab.running ? "run" : "exit"}`} />
				<span className="term-tab-title">
					{renamingTab === tab.id ? (
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
										send({ type: "rename_terminal", terminalId: tab.id, conversationId: tab.conversationId, title });
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
					setRenamingTab(tab.id);
				}}
			>
				<FiEdit2 />
			</button>
			<button type="button" className="term-tab-close" title={t("closeTerminal")} onClick={() => closeTab(tab.id)}>
				<FiX />
			</button>
		</div>
	);

	// -- command list editing --------------------------------------------------

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
		send({ type: "save_commands", commands: next });
		cancelEdit();
	};

	const requestDelete = (idx: number) => {
		if (confirmDel === idx) {
			const next = chat.commands.filter((_, i) => i !== idx);
			send({ type: "save_commands", commands: next });
			setConfirmDel(null);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		} else {
			setConfirmDel(idx);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
			confirmTimer.current = setTimeout(() => setConfirmDel(null), 2500);
		}
	};

	const editing = isNew || editingIdx !== null;

	return (
		<div className="terminal-view">
			{/* ---------------- left: command list + terminal tabs ---------------- */}
			<aside className={`term-side term-commands ${sideOpen ? "open" : ""}`}>
				<div className="panel-header">
					<span className="panel-title">{t("commands")}</span>
					<div className="panel-header-actions">
						<button
							type="button"
							className="panel-refresh"
							title={t("rerun")}
							onClick={() => send({ type: "list_commands" })}
						>
							<FiRefreshCw />
						</button>
						<button type="button" className="panel-new" title={t("newCommand")} onClick={startNew}>
							<FiPlus />
						</button>
					</div>
				</div>

				<div className="panel-body">
					{editing ? (
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
					)}
				</div>

				{/* ---------------- tabs (below the command list) ---------------- */}
				<div className="term-tabs-block">
					<div className="panel-header">
						<span className="panel-title">{t("terminal")}</span>
						<button type="button" className="panel-new" title={t("newTerminal")} onClick={openShell}>
							<FiPlus />
						</button>
					</div>
					<div className="panel-body">
						{chat.terminals.length === 0 && <div className="panel-empty">{t("noTerminal")}</div>}
						{userTabs.map(renderTab)}
						{agentTabs.length > 0 && (
							<div className="term-folder">
								<button
									type="button"
									className={`term-folder-header ${aiBashOpen ? "open" : ""}`}
									title={t("aiBashGroup")}
									onClick={() => setAiBashOpen((v) => !v)}
								>
									<span className="term-folder-caret">{aiBashOpen ? "▾" : "▸"}</span>
									<span className="term-folder-title">{t("aiBashGroup")}</span>
									<span className="term-folder-count">{agentTabs.length}</span>
								</button>
								{aiBashOpen && <div className="term-folder-body">{agentTabs.map(renderTab)}</div>}
							</div>
						)}
					</div>
				</div>
			</aside>

			{/* ---------------- right: terminals ---------------- */}
			<div className="term-main">
				{sideOpen && <div className="drawer-backdrop" onClick={() => setSideOpen(false)} />}
				<button type="button" className="term-side-toggle" title={t("commands")} onClick={() => setSideOpen((v) => !v)}>
					<FiMenu />
				</button>
				{chat.terminals.length === 0 ? (
					<div className="term-empty">
						<FiTerminal className="term-empty-icon" />
						<div className="term-empty-title">{t("builtinTerminal")}</div>
						<div className="term-empty-sub">{t("termEmptySub")}</div>
					</div>
				) : (
					chat.terminals.map((t) => (
						<TermXterm
							key={`${t.conversationId}:${t.id}`}
							conversationId={t.conversationId}
							terminalId={t.id}
							command={t.command}
							cwd={t.cwd}
							title={t.title}
							active={t.id === activeId}
							send={send}
							register={terminal.register}
						/>
					))
				)}
			</div>
		</div>
	);
}
