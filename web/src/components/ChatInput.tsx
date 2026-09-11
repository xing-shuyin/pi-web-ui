import { memo, useEffect, useRef, useState } from "react";
import { FiSend, FiSquare, FiPaperclip, FiArrowUp, FiGrid, FiZap } from "react-icons/fi";
import type { ClientMessage, ModelInfo, ProviderKeyInfo, SlashCommandInfo, UiMessage, UiState } from "../types";
import { useT, useI18n } from "../i18n";
import { isRasterImage } from "../image-paste";
import { recordModelUsage } from "../model-usage";
import { loadPromptHistory, pushPromptHistory } from "../prompt-history";
import { detectTouchFirstDevice } from "../touch-device";

import { ModelThinking } from "./ModelThinking";
import { useTemplates } from "./PromptTemplates";

/** True on touch-first devices (phones / tablets driven by a soft keyboard) —
 *  see `touch-device.ts` for the detection rules (Windows 触屏笔记本不算触屏，
 *  否则回车只换行、发不出去). */
const IS_TOUCH = detectTouchFirstDevice();

/** Props are deliberately NARROW (no whole-ChatState object): every field is
 *  stable while tokens stream in (the messages ARRAY reference is kept stable
 *  by the server when the persisted set is unchanged), so the shallow-compared
 *  memo() below skips this input bar on every text delta. */
interface ChatInputProps {
	ready: boolean;
	streaming: boolean;
	/** Persisted messages (stable reference while unchanged) — used by /copy. */
	messages: UiMessage[];
	slashCommands: SlashCommandInfo[];
	/** Forwarded to ModelThinking (all fields stable while streaming). */
	modelState: {
		model: UiState["model"];
		thinkingLevel: UiState["thinkingLevel"];
		availableThinkingLevels: UiState["availableThinkingLevels"];
	} | null;
	models: ModelInfo[];
	modelsLoading: boolean;
	send: (msg: ClientMessage) => boolean;
	/** Files/folders attached via the right panel / preview, waiting to be sent. */
	attachments: {
		path: string;
		name: string;
		mode: "inline" | "reference" | "lines";
		isDir?: boolean;
		lines?: { start: number; end: number };
		/** Raw pasted/dropped/uploaded image (no workspace path). */
		imageData?: string;
		mimeType?: string;
		/** Raw uploaded file bytes (no workspace path). */
		fileData?: string;
		size?: number;
		/** Stable key for pasted images (path is ""). */
		key?: string;
	}[];
	onRemoveAttachment: (path: string) => void;
	/** Images pasted into the input / dropped onto it / picked via upload. */
	onAddImageFiles: (files: File[]) => void;
	/** Any dropped/uploaded file (images go through onAddImageFiles instead). */
	onAddLocalFiles: (files: File[]) => void;
	/** Client-side notices (e.g. folders dropped). */
	onNotice: (level: "info" | "warning" | "error", text: string) => void;
	/** Called after a prompt is successfully sent — clears pending attachments. */
	onSent: () => void;
	/** Opens the custom-model config modal (mobile input row). */
	onManageModels: () => void;
	/** Stored API keys per built-in provider (masked) — drives the picker's
	 *  multi-key grouping (click a model under a key to switch to it). */
	providerKeys: Record<string, ProviderKeyInfo[]>;
	/** 输入框上方的快捷短语（点击即发送；与文件引用 chips 是两套独立 UI，互不干扰）。 */
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
}

export const ChatInput = memo(function ChatInput({
	ready,
	streaming,
	messages,
	slashCommands,
	modelState,
	models,
	modelsLoading,
	send,
	attachments,
	onRemoveAttachment,
	onAddImageFiles,
	onAddLocalFiles,
	onNotice,
	onSent,
	onManageModels,
	providerKeys,
	quickPhrases,
	quickPhrasesEnabled,
}: ChatInputProps) {
	const t = useT();
	const { locale } = useI18n();
	/** 打开模板库（对话中途也可随时取用提示词模板）。 */
	const { openPicker } = useTemplates();
	const slashDesc = (c: SlashCommandInfo) =>
		locale !== "zh" && c.descriptionEn ? c.descriptionEn : (c.description ?? "");
	const slashHint = (c: SlashCommandInfo) =>
		locale !== "zh" && c.argumentHintEn ? c.argumentHintEn : (c.argumentHint ?? "");
	const [text, setText] = useState("");
	const [dragOver, setDragOver] = useState(false);
	/** Slash-command picker: non-null while open (filtered by the current input). */
	const [completions, setCompletions] = useState<SlashCommandInfo[] | null>(null);
	const [completionIndex, setCompletionIndex] = useState(0);
	/** /help modal — shows the full command catalog. */
	const [showHelp, setShowHelp] = useState(false);
	/** Width captured from the input box when /help opens — the modal overlays
	 *  the whole viewport, so it must measure the chat column to match. */
	const [helpWidth, setHelpWidth] = useState<number | undefined>(undefined);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	/** 全局 prompt 历史导航状态（issue #68）：-1 = 未在历史中，>=0 = 历史下标。 */
	const historyIndexRef = useRef(-1);
	const draftRef = useRef("");

	const SOURCE_LABEL: Record<SlashCommandInfo["source"], string> = {
		builtin: t("slashBuiltin"),
		extension: t("slashExtension"),
		prompt: t("slashPrompt"),
		skill: t("slashSkill"),
		plugin: t("slashPlugin"),
	};

	/** Recompute the command picker from the current input text. */
	const updateCompletions = (value: string) => {
		// Match the RAW value (no trim): a trailing space must close the picker
		// so Enter right after it submits instead of completing the command.
		const m = value.match(/^\/([^\s]*)$/);
		if (m && ready) {
			const prefix = m[1].toLowerCase();
			const matches = slashCommands.filter((c) => c.name.toLowerCase().startsWith(prefix));
			setCompletions(matches.length > 0 ? matches : null);
			setCompletionIndex(0);
		} else {
			setCompletions(null);
		}
	};

	// Keep the highlighted command visible while navigating with the keyboard
	// (the picker scrolls; arrow keys must not leave the selection off-screen —
	// same behavior as the FooterBar path completions).
	useEffect(() => {
		const el = menuRef.current?.querySelector(".slash-item.active");
		el?.scrollIntoView({ block: "nearest" });
	}, [completionIndex, completions]);

	/** Insert the highlighted command into the input (" /cmd " + rest). */
	const acceptCompletion = (cmd?: SlashCommandInfo) => {
		const list = completions ?? [];
		const pick = cmd ?? list[completionIndex % Math.max(list.length, 1)];
		if (!pick) {
			setCompletions(null);
			return;
		}
		// Replace the current "/prefix" token with the completed command. The
		// trailing space closes the picker and lets the user type args right away.
		const m = text.match(/^\/([^\s]*)([\s\S]*)$/);
		const rest = m ? m[2] : "";
		setText(`/${pick.name} ${rest}`);
		setCompletions(null);
		taRef.current?.focus();
	};

	const copyLastAssistant = async () => {
		const msgs = messages;
		const last = [...msgs]
			.reverse()
			.find((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && (b as { text?: string }).text));
		const textToCopy = last?.content
			.filter((b) => b.type === "text")
			.map((b) => (b as { text: string }).text)
			.join("\n");
		if (!textToCopy) {
			onNotice("warning", t("slashCopyEmpty"));
			return;
		}
		try {
			await navigator.clipboard.writeText(textToCopy);
			onNotice("info", t("slashCopied"));
		} catch {
			onNotice("error", t("slashCopyFailed"));
		}
	};

	const handleFiles = (files: FileList | File[] | null) => {
		if (!files || files.length === 0) {
			// A folder drag lands here with an empty FileList — tell the user.
			onNotice("warning", t("foldersNotSupported"));
			return;
		}
		const images = Array.from(files).filter((f) => isRasterImage(f.type));
		const others = Array.from(files).filter((f) => !isRasterImage(f.type));
		// P1-7：当前模型明确不支持图片（vision === false）时拒绝图片附件。
		const noVision = currentModelNoVision();
		if (images.length > 0 && noVision) {
			onNotice("warning", noVision);
		} else if (images.length > 0) {
			onAddImageFiles(images);
		}
		if (others.length > 0) onAddLocalFiles(others);
	};

	const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const items = e.clipboardData?.items;
		if (!items) return;
		const images: File[] = [];
		for (const item of items) {
			if (item.kind === "file" && isRasterImage(item.type)) {
				const f = item.getAsFile();
				if (f) images.push(f);
			}
		}
		if (images.length === 0) return; // plain text paste — leave the default
		e.preventDefault();
		// P1-7：当前模型明确不支持图片时拒绝粘贴并提示。
		const noVision = currentModelNoVision();
		if (noVision) {
			onNotice("warning", noVision);
			return;
		}
		onAddImageFiles(images);
	};

	/** 当前模型在模型清单中标记为 text-only（vision === false）→ 返回提示文案。
	 *  pi 引擎/自定义模型无此标记（undefined）→ 不阻止（视觉桥/后端兜底）。 */
	const currentModelNoVision = (): string | null => {
		const m = modelState?.model;
		if (!m?.id) return null;
		const info = models.find((x) => x.id === m.id);
		return info && info.vision === false ? t("modelNoVision", { name: info.name }) : null;
	};

	const connected = ready;

	// Re-open the picker when the command catalog arrives late — the user may
	// have typed "/" before the server pushed slash_commands (cold start).
	const lastTextRef = useRef(text);
	useEffect(() => {
		lastTextRef.current = text;
	}, [text]);
	useEffect(() => {
		updateCompletions(lastTextRef.current);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [slashCommands]);

	// Fill the input from the welcome-page example cards.
	useEffect(() => {
		const onFill = (e: Event) => {
			const detail = (e as CustomEvent<string>).detail;
			setText(detail);
			taRef.current?.focus();
		};
		window.addEventListener("pi-web:fill", onFill);
		return () => window.removeEventListener("pi-web:fill", onFill);
	}, []);

	// Esc closes the /help modal.
	useEffect(() => {
		if (!showHelp) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setShowHelp(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [showHelp]);

	// Auto-grow the textarea; no scrollbar until it hits the height cap.
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto"; // natural height first, then clamp
		const capped = ta.scrollHeight > 220;
		ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
		ta.style.overflowY = capped ? "auto" : "hidden";
	}, [text]);

	/** 输入框光标是否在第一行（Up 才进入历史；多行时光标在首行内才触发，避免打断多行编辑）。 */
	const isCursorAtFirstLine = (ta: HTMLTextAreaElement): boolean => {
		if (ta.selectionStart !== ta.selectionEnd) return false;
		const before = ta.value.slice(0, ta.selectionStart);
		return !before.includes("\n");
	};
	const isCursorAtLastLine = (ta: HTMLTextAreaElement): boolean => {
		if (ta.selectionStart !== ta.selectionEnd) return false;
		const after = ta.value.slice(ta.selectionStart);
		return !after.includes("\n");
	};

	/** 把当前待发送附件（含粘贴图/上传文件/工作区引用）转成 prompt 消息格式。
	 *  submit 与快捷短语发送共用 —— 点短语时文件引用同样带上，不丢失。 */
	const buildPromptAttachments = () =>
		attachments.map((a) => {
			if (a.imageData) {
				return {
					path: "",
					imageData: a.imageData,
					mimeType: a.mimeType,
					name: a.name,
				};
			}
			if (a.fileData) {
				return {
					path: "",
					fileData: a.fileData,
					mimeType: a.mimeType,
					name: a.name,
					size: a.size,
				};
			}
			return {
				path: a.path,
				mode: a.mode,
				...(a.lines ? { lines: a.lines } : {}),
			};
		});

	const submit = (queue = false) => {
		const trimmed = text.trim();
		const hasRawAttach = attachments.some((a) => a.imageData || a.fileData);
		if (!connected || (!trimmed && !hasRawAttach)) return;
		// Client-side slash commands (never sent to the server).
		if (trimmed === "/help") {
			// Match the modal width to the input box (the backdrop spans the full
			// viewport, so the CSS max-width would be wider than the chat column).
			const box = taRef.current?.closest(".inputbox")?.getBoundingClientRect();
			setHelpWidth(box?.width);
			setShowHelp(true);
			setText("");
			taRef.current?.focus();
			return;
		}
		if (trimmed === "/copy") {
			setText("");
			taRef.current?.focus();
			void copyLastAssistant();
			return;
		}
		// While the agent is streaming, the server queues this prompt as a
		// steering message (delivered as soon as the current assistant turn
		// settles, skipping remaining tool calls — the pi CLI Enter semantic)
		// and the agent immediately responds to it — see AgentService.prompt()
		// in agent-service.ts. The 补充 (supplement) button passes queue=true,
		// which the server delivers as followUp instead — the prompt is sent
		// only after the WHOLE run finishes ("AI 生成结束才发送").
		if (
			send({
				type: "prompt",
				text: trimmed,
				queue,
				attachments: buildPromptAttachments(),
			})
		) {
			// 入全局历史（连续重复不重复入队，已在 pushPromptHistory 内去重）——仅提交成功才记。
			if (trimmed) pushPromptHistory(trimmed);
			// 退出历史导航状态，下次 Up 从最新开始。
			historyIndexRef.current = -1;
			draftRef.current = "";
			setText("");
			onSent();
			// 提交成功 → 把本次使用的模型使用次数 +1（模型下拉按次数排序）。
			const m = modelState?.model;
			if (m) recordModelUsage(`${m.provider}/${m.id}`);
			taRef.current?.focus();
		}
	};

	/** 快捷短语一键发送：直接发出短语文本（带上当前文件附件），不碰输入框草稿。 */
	const sendPhrase = (phrase: string) => {
		const trimmed = phrase.trim();
		if (!connected || !trimmed) return;
		if (send({ type: "prompt", text: trimmed, attachments: buildPromptAttachments() })) {
			if (trimmed) pushPromptHistory(trimmed);
			historyIndexRef.current = -1;
			draftRef.current = "";
			onSent();
			const m = modelState?.model;
			if (m) recordModelUsage(`${m.provider}/${m.id}`);
			// 触屏设备点击快捷短语后不回焦输入框：点按钮时虚拟键盘本未弹出，回焦会
			// 立刻把它弹起来盖住界面（发送按钮/回车路径本就处于键盘开启状态，不受
			// 影响，仍保留 submit() 里的回焦）。桌面端保留回焦，方便直接接着输入。
			if (!IS_TOUCH) taRef.current?.focus();
		}
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing) return;
		// Slash-command picker navigation.
		if (completions && completions.length > 0) {
			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					setCompletionIndex((i) => (i + 1) % completions.length);
					return;
				case "ArrowUp":
					e.preventDefault();
					setCompletionIndex((i) => (i - 1 + completions.length) % completions.length);
					return;
				case "Tab":
				case "Enter":
					e.preventDefault();
					acceptCompletion();
					return;
				case "Escape":
					e.preventDefault();
					setCompletions(null);
					return;
			}
		}
		// Global prompt history cycling (issue #68): Up = older, Down = newer.
		// 不绑定到特定会话；存储在 localStorage，跨对话全局共享。
		// 多行编辑时：仅当光标在首行（Up）/ 末行（Down）才进入历史，避免打断行内光标移动。
		if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			// 修饰键组合不触发历史（避免与快捷键冲突）。
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			const ta = taRef.current;
			if (!ta) return;
			const isUp = e.key === "ArrowUp";
			// 多行时非边界行：走光标移动，不进历史。
			if (isUp && !isCursorAtFirstLine(ta)) return;
			if (!isUp && !isCursorAtLastLine(ta)) return;
			// Down 且当前不在历史中：不消耗，让光标正常移动（末行 Down 本来就是无操作）。
			if (!isUp && historyIndexRef.current === -1) return;
			const history = loadPromptHistory();
			if (history.length === 0) return;
			e.preventDefault();
			if (isUp) {
				if (historyIndexRef.current === -1) {
					draftRef.current = text;
					const idx = history.length - 1;
					historyIndexRef.current = idx;
					const next = history[idx];
					setText(next);
					updateCompletions(next);
					requestAnimationFrame(() => {
						const el = taRef.current;
						if (el) el.selectionStart = el.selectionEnd = next.length;
					});
				} else if (historyIndexRef.current > 0) {
					const idx = historyIndexRef.current - 1;
					historyIndexRef.current = idx;
					const next = history[idx];
					setText(next);
					updateCompletions(next);
					requestAnimationFrame(() => {
						const el = taRef.current;
						if (el) el.selectionStart = el.selectionEnd = next.length;
					});
				}
				// 已在最旧一条：保持不动
			} else {
				// ArrowDown: 往更新方向
				const idx = historyIndexRef.current + 1;
				if (idx < history.length) {
					historyIndexRef.current = idx;
					const next = history[idx];
					setText(next);
					updateCompletions(next);
					requestAnimationFrame(() => {
						const el = taRef.current;
						if (el) el.selectionStart = el.selectionEnd = next.length;
					});
				} else {
					// 越过最新一条：回到草稿（通常是空）
					historyIndexRef.current = -1;
					const draft = draftRef.current;
					setText(draft);
					updateCompletions(draft);
					requestAnimationFrame(() => {
						const el = taRef.current;
						if (el) el.selectionStart = el.selectionEnd = draft.length;
					});
				}
			}
			return;
		}
		// Esc：在历史中时先退出历史并回到草稿
		if (e.key === "Escape" && historyIndexRef.current !== -1) {
			e.preventDefault();
			const draft = draftRef.current;
			historyIndexRef.current = -1;
			setText(draft);
			updateCompletions(draft);
			requestAnimationFrame(() => {
				const el = taRef.current;
				if (el) el.selectionStart = el.selectionEnd = draft.length;
			});
			return;
		}
		// Enter semantics: on touch-first devices (soft keyboard, no physical
		// Shift — see touch-device.ts) Enter inserts a newline and sending goes
		// through the on-screen button (Ctrl/Cmd+Enter also sends). Everywhere
		// else (desktop, incl. Windows 触屏笔记本) plain Enter sends.
		if (e.key === "Enter") {
			if (IS_TOUCH) {
				// Plain Return → default textarea behavior (insert a line break).
				if (!e.shiftKey && !(e.ctrlKey || e.metaKey)) return;
			}
			if (!e.shiftKey) {
				e.preventDefault();
				submit();
			}
		}
	};

	// Send / stop / supplement — rendered once inside the composer toolbar
	// (ChatInput .composer-tools-right).
	const renderActions = () => (
		<div className="inputbox-actions">
			{streaming ? (
				<>
					{text.trim() !== "" && (
						<>
							{/* 插队（steer）：当前回合结算后立刻送达。桌面端等同 Enter；移动端软键盘
							 *  没有 Shift/Ctrl，Enter 被有意留作换行，所以这里是移动端唯一的插队入口。 */}
							<button type="button" className="btn steer" title={t("queueSteerTag")} onClick={() => submit()}>
								<FiZap /> {t("queueSteerTag")}
							</button>
							<button type="button" className="btn supplement" title={t("supplementTip")} onClick={() => submit(true)}>
								<FiSend /> {t("supplement")}
							</button>
						</>
					)}
					<button type="button" className="btn stop" title={t("stopAgent")} onClick={() => send({ type: "abort" })}>
						<FiSquare />
					</button>
				</>
			) : (
				<button
					type="button"
					className="btn send"
					title={t("sendTip")}
					disabled={!connected || (!text.trim() && !attachments.some((a) => a.imageData || a.fileData))}
					onClick={() => submit()}
				>
					<FiArrowUp />
				</button>
			)}
		</div>
	);

	return (
		<div
			className={`inputbar${dragOver ? " drop-active" : ""}`}
			onDragOver={(e) => {
				e.preventDefault();
				e.stopPropagation();
				setDragOver(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) {
					setDragOver(false);
				}
			}}
			onDrop={(e) => {
				e.preventDefault();
				e.stopPropagation();
				setDragOver(false);
				handleFiles(e.dataTransfer?.files ?? null);
			}}
		>
			{dragOver && (
				<div className="drop-overlay">
					<span>📎 {t("dropHereToAttach")}</span>
				</div>
			)}
			{attachments.length > 0 && (
				<div className="attach-row">
					{attachments.map((a) => (
						<span
							key={a.key ?? `${a.path}|${a.mode}|${a.lines ? `${a.lines.start}-${a.lines.end}` : ""}`}
							className={`attach-chip ${a.imageData ? "image" : a.fileData ? "file" : a.mode}`}
							title={
								a.imageData
									? t("attachImage", { name: a.name })
									: a.fileData
										? t("attachFile", { name: a.name })
										: a.isDir
											? t("folderRef", { path: a.path })
											: a.mode === "reference"
												? t("refOnly", { path: a.path })
												: a.mode === "lines" && a.lines
													? t("attachLines", {
															path: a.path,
															start: a.lines.start,
															end: a.lines.end,
														})
													: t("attachContent", { path: a.path })
							}
						>
							{a.imageData ? "🖼" : a.fileData ? "📄" : a.isDir ? "📁" : a.mode === "reference" ? "🔗" : "📎"} {a.name}
							{a.mode === "lines" && a.lines && (
								<span className="attach-range">
									L{a.lines.start}-{a.lines.end}
								</span>
							)}
							<button
								type="button"
								className="attach-remove"
								title={t("removeAttachment")}
								onClick={() => onRemoveAttachment(a.key ?? a.path)}
							>
								×
							</button>
						</span>
					))}
					<span className="attach-hint">{t("attachHint")}</span>
				</div>
			)}
			{completions && completions.length > 0 && (
				<div className="slash-menu" role="listbox" ref={menuRef} aria-label={t("slashCommands")}>
					<div className="slash-menu-hint">
						<span>{t("slashMenuHint")}</span>
						<span className="slash-menu-close" onClick={() => setCompletions(null)}>
							Esc
						</span>
					</div>
					{completions.map((c, i) => (
						<button
							type="button"
							key={c.name}
							className={`slash-item${i === completionIndex ? " active" : ""}`}
							onMouseEnter={() => setCompletionIndex(i)}
							onClick={() => acceptCompletion(c)}
						>
							<span className="slash-name">/{c.name}</span>
							<span className={`slash-source ${c.source}`}>{SOURCE_LABEL[c.source]}</span>
							<span className="slash-desc">
								{slashDesc(c)}
								{c.argumentHint && <span className="slash-hint">{slashHint(c)}</span>}
							</span>
						</button>
					))}
				</div>
			)}
			{showHelp && (
				<div className="modal-backdrop" onClick={() => setShowHelp(false)}>
					<div
						className="slash-help"
						style={helpWidth ? { width: helpWidth } : undefined}
						onClick={(e) => e.stopPropagation()}
					>
						<div className="slash-help-head">
							<span>⚡ {t("slashHelpTitle")}</span>
							<button type="button" className="btn" onClick={() => setShowHelp(false)}>
								{t("close")}
							</button>
						</div>
						<div className="slash-help-body">
							{slashCommands.length === 0 ? (
								<div className="slash-help-empty">{t("slashLoading")}</div>
							) : (
								slashCommands.map((c) => (
									<div className="slash-help-row" key={c.name}>
										<span className="slash-help-cmd">/{c.name}</span>
										<span className={`slash-source ${c.source}`}>{SOURCE_LABEL[c.source]}</span>
										<span className="slash-help-desc">
											{slashDesc(c)}
											{c.argumentHint && <span className="slash-hint">{slashHint(c)}</span>}
										</span>
									</div>
								))
							)}
						</div>
					</div>
				</div>
			)}
			{quickPhrasesEnabled && quickPhrases.length > 0 && (
				<div className="quick-row" aria-label={t("quickPhrases")}>
					{quickPhrases.map((p) => (
						<button
							key={p}
							type="button"
							className="quick-chip"
							title={t("quickPhrasesTip", { text: p })}
							disabled={!connected}
							onClick={() => sendPhrase(p)}
						>
							{p}
						</button>
					))}
				</div>
			)}
			<div className="inputbox">
				<input
					ref={fileInputRef}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						handleFiles(e.target.files);
						e.target.value = ""; // allow re-picking the same file
					}}
				/>
				<textarea
					ref={taRef}
					value={text}
					rows={1}
					placeholder={
						connected ? (streaming ? t("placeholderStreaming") : t("placeholderIdle")) : t("placeholderConnecting")
					}
					disabled={!connected}
					onChange={(e) => {
						// 用户手动编辑则退出历史导航（下次 Up 从最新开始）
						historyIndexRef.current = -1;
						setText(e.target.value);
						updateCompletions(e.target.value);
					}}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
				/>
				{/* 底部工具条（ChatGPT 风格）：附件 / 模型 / 思考强度 在左，
				    发送 / 停止 在右，全部收进输入框容器内。 */}
				<div className="composer-tools">
					<div className="composer-tools-left">
						<button
							type="button"
							className="btn attach-img"
							title={t("uploadFile")}
							disabled={!connected}
							onClick={() => fileInputRef.current?.click()}
						>
							<FiPaperclip />
						</button>
						<button type="button" className="btn tpl-open" title={t("tpl.openPicker")} onClick={openPicker}>
							<FiGrid />
						</button>
						<ModelThinking
							state={modelState}
							models={models}
							modelsLoading={modelsLoading}
							send={send}
							onManageModels={onManageModels}
							providerKeys={providerKeys}
							compact
						/>
					</div>
					<div className="composer-tools-right">{renderActions()}</div>
				</div>
			</div>
		</div>
	);
});
