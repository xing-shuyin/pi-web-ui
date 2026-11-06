import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	FiArrowUp,
	FiChevronDown,
	FiFileText,
	FiGlobe,
	FiLock,
	FiMessageCircle,
	FiMoreHorizontal,
	FiPlus,
	FiSquare,
	FiX,
	FiZap,
} from "react-icons/fi";
import { appUrl } from "../base-url";
import { useI18n, useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";
import type { UiSettingsState } from "../types";
import { useFloatingPanel } from "../use-floating-panel";
import { useDraggablePopover } from "../use-draggable-popover";
import {
	QUICK_ASK_OPEN_EVENT,
	appendQuickAskQuestion,
	explainSelectionPrompt,
	readQuickAskResponse,
	translateSelectionPrompt,
	QUICK_ASK_LANGUAGE_LABELS,
	type QuickAskAttachment,
	type QuickAskReferenceSource,
	type QuickAskMessage,
	type QuickAskOpenRequest,
} from "../quick-ask";
import {
	QUICK_ASK_MAX_ATTACHMENTS,
	QuickAskAttachmentError,
	loadQuickAskFile,
	loadQuickAskFolder,
	loadQuickAskReference,
	quickAskBudgetError,
} from "../quick-ask-context";
import { QuickAskAttachButton, QuickAskReferenceChips } from "./QuickAskAttachments";
import { Markdown } from "./Markdown";
import { CopyButton } from "./copy-button";

export function QuickAskPopover({
	settings,
	fallbackModel,
	currentConversation,
	clientId,
}: {
	settings: UiSettingsState | null;
	fallbackModel?: string;
	currentConversation?: QuickAskReferenceSource;
	clientId?: string;
}) {
	const t = useT();
	const { locale } = useI18n();
	const [open, setOpen] = useState(false);
	const drag = useDraggablePopover(open);
	const launcherDrag = useDraggablePopover<HTMLButtonElement>(!open && settings?.quickAskEnabled !== false);
	const [messages, setMessages] = useState<QuickAskMessage[]>([]);
	const [selection, setSelection] = useState("");
	const [sourceExpanded, setSourceExpanded] = useState(false);
	const [inputExpanded, setInputExpanded] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [stopped, setStopped] = useState(false);
	const [unread, setUnread] = useState(false);
	const [model, setModel] = useState("");
	const [mode, setMode] = useState<"ask" | "explain" | "translate">("ask");
	const selectionAction = useRef<"explain" | "translate">("explain");
	const [target, setTarget] = useState(settings?.quickAskTranslateTarget || "auto");
	const [attachments, setAttachments] = useState<QuickAskAttachment[]>([]);
	const attachmentsRef = useRef<QuickAskAttachment[]>([]);
	const referenceEpoch = useRef(0);
	const referenceControllers = useRef(new Set<AbortController>());
	const [referencesLoading, setReferencesLoading] = useState(0);
	const [referenceError, setReferenceError] = useState<string | null>(null);
	const controllerRef = useRef<AbortController | null>(null);
	const retryRef = useRef<QuickAskMessage[] | null>(null);
	const flushRef = useRef<(() => void) | null>(null);
	const frameRef = useRef<number | null>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const launcherRef = launcherDrag.panelRef;
	const closeRef = useRef<HTMLButtonElement>(null);
	const menuTriggerRef = useRef<HTMLButtonElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const followRef = useRef(true);
	const scrollTopRef = useRef(0);
	const openRef = useRef(open);

	const close = () => {
		if (bodyRef.current) scrollTopRef.current = bodyRef.current.scrollTop;
		setMenuOpen(false);
		setOpen(false);
	};
	useEscapeKey(close, open);
	const menu = useFloatingPanel({
		open: open && menuOpen,
		anchor: menuTriggerRef,
		onClose: () => setMenuOpen(false),
	});
	const cancel = () => {
		flushRef.current?.();
		flushRef.current = null;
		controllerRef.current?.abort();
		controllerRef.current = null;
		setLoading(false);
	};
	const clearReferences = () => {
		referenceEpoch.current++;
		for (const controller of referenceControllers.current) controller.abort();
		referenceControllers.current.clear();
		attachmentsRef.current = [];
		setAttachments([]);
		setReferencesLoading(0);
		setReferenceError(null);
	};
	const reset = () => {
		cancel();
		clearReferences();
		setMode("ask");
		retryRef.current = null;
		setMessages([]);
		setSelection("");
		setSourceExpanded(false);
		setInputExpanded(true);
		setMenuOpen(false);
		setInput("");
		setError(null);
		setStopped(false);
		setUnread(false);
		setModel("");
		followRef.current = true;
		scrollTopRef.current = 0;
		inputRef.current?.focus({ preventScroll: true });
	};
	const run = async (next: QuickAskMessage[]) => {
		cancel();
		const controller = new AbortController();
		controllerRef.current = controller;
		retryRef.current = next;
		setMessages(next);
		setLoading(true);
		setError(null);
		setStopped(false);
		setUnread(false);
		followRef.current = true;
		let text = "";
		const isCurrent = () => controllerRef.current === controller && !controller.signal.aborted;
		const flush = () => {
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
			if (isCurrent() && text) setMessages([...next, { role: "assistant", content: text }]);
		};
		flushRef.current = flush;
		try {
			const response = await fetch(appUrl("/api/quick-ask"), {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
				body: JSON.stringify({ messages: next, fallbackModel }),
				signal: controller.signal,
			});
			await readQuickAskResponse(response, (event) => {
				if (!isCurrent()) return;
				if (event.type === "start") setModel(event.model);
				if (event.type === "delta") {
					text += event.text;
					if (frameRef.current === null) frameRef.current = requestAnimationFrame(flush);
				}
				if (event.type === "done") {
					text = event.text;
					setModel(event.model);
					flush();
					if (!openRef.current) setUnread(true);
				}
			});
		} catch (err) {
			if (isCurrent()) {
				const message = err instanceof Error ? err.message : String(err);
				setError(message === "Model returned no answer" ? t("selectionExplainEmpty") : message);
			}
		} finally {
			if (controllerRef.current === controller) {
				flush();
				flushRef.current = null;
				controllerRef.current = null;
				setLoading(false);
			}
		}
	};
	const send = (question = input.trim()) => {
		if (!question || controllerRef.current || referenceControllers.current.size) return;
		const next = appendQuickAskQuestion(messages, question, attachmentsRef.current);
		const budgetError = quickAskBudgetError(next);
		if (budgetError) {
			setReferenceError(t(budgetError));
			return;
		}
		setMode("ask");
		setInputExpanded(true);
		void run(next);
		setInput("");
	};
	const addReferences = async (load: (signal: AbortSignal) => Promise<QuickAskAttachment[]>) => {
		const epoch = referenceEpoch.current;
		const controller = new AbortController();
		referenceControllers.current.add(controller);
		setOpen(true);
		setUnread(false);
		setMenuOpen(false);
		setReferencesLoading((count) => count + 1);
		setReferenceError(null);
		try {
			const incoming = await load(controller.signal);
			if (epoch !== referenceEpoch.current || controller.signal.aborted) return;
			const next = [...attachmentsRef.current];
			for (const item of incoming) {
				const index = next.findIndex((previous) => previous.id === item.id);
				if (index < 0) next.push(item);
				else next[index] = item;
			}
			if (next.length > QUICK_ASK_MAX_ATTACHMENTS) throw new QuickAskAttachmentError("quickAskTooManyReferences");
			attachmentsRef.current = next;
			setAttachments(next);
			setInputExpanded(true);
		} catch (err) {
			if (epoch === referenceEpoch.current && !controller.signal.aborted) {
				setReferenceError(
					err instanceof QuickAskAttachmentError ? t(err.code) : err instanceof Error ? err.message : String(err),
				);
			}
		} finally {
			referenceControllers.current.delete(controller);
			if (epoch === referenceEpoch.current) setReferencesLoading((count) => Math.max(0, count - 1));
		}
	};
	const attachReference = (source: QuickAskReferenceSource) => {
		const scope =
			source.kind === "conversation"
				? settings?.quickAskConversationScope || "recent"
				: source.kind === "directory"
					? settings?.quickAskFolderScope || "listing"
					: undefined;
		return addReferences(async (signal) => [await loadQuickAskReference(source, { scope, clientId, signal })]);
	};
	const attachFiles = (files: File[]) =>
		addReferences(async (signal) => {
			if (files.length > QUICK_ASK_MAX_ATTACHMENTS) throw new QuickAskAttachmentError("quickAskTooManyReferences");
			const loaded: QuickAskAttachment[] = [];
			for (const file of files) loaded.push(await loadQuickAskFile(file, { signal, clientId }));
			return loaded;
		});
	const attachFolder = (files: File[]) => {
		const scope = settings?.quickAskFolderScope || "listing";
		return addReferences(async (signal) => [await loadQuickAskFolder(files, { scope, clientId, signal })]);
	};
	const startSelection = (
		text: string,
		action: "explain" | "translate",
		language = settings?.quickAskTranslateTarget || "auto",
	) => {
		if (action === "translate" && settings?.quickAskTranslateEnabled === false) return;
		if (!text.trim()) {
			setReferenceError(t("quickAskEmptySelection"));
			return;
		}
		selectionAction.current = action;
		clearReferences();
		setOpen(true);
		setMode(action);
		setTarget(language);
		setSelection(text);
		setSourceExpanded(action === "translate" && Boolean(settings?.quickAskShowOriginal));
		setInputExpanded(false);
		setMenuOpen(false);
		setInput("");
		setModel("");
		scrollTopRef.current = 0;
		void run([
			{
				role: "user",
				content:
					action === "translate"
						? translateSelectionPrompt(settings, text, locale, language)
						: explainSelectionPrompt(settings?.quickAskExplainPrompt, text),
			},
		]);
	};

	useEffect(() => {
		const onOpen = (event: Event) => {
			const request = (event as CustomEvent<QuickAskOpenRequest>).detail;
			setOpen(true);
			setUnread(false);
			if (request.reference) void attachReference(request.reference);
			else if (request.selection !== undefined) startSelection(request.selection, request.action || "explain");
		};
		window.addEventListener(QUICK_ASK_OPEN_EVENT, onOpen);
		return () => window.removeEventListener(QUICK_ASK_OPEN_EVENT, onOpen);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		settings?.quickAskExplainPrompt,
		settings?.quickAskTranslatePrompt,
		settings?.quickAskTranslateTarget,
		settings?.quickAskTranslateStyle,
		settings?.quickAskTranslateEnabled,
		settings?.quickAskShowOriginal,
		settings?.quickAskConversationScope,
		settings?.quickAskFolderScope,
		fallbackModel,
		clientId,
		locale,
		t,
	]);
	useEffect(
		() => () => {
			referenceEpoch.current++;
			for (const pending of referenceControllers.current) pending.abort();
			referenceControllers.current.clear();
			const controller = controllerRef.current;
			controllerRef.current = null;
			flushRef.current = null;
			controller?.abort();
			if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
		},
		[],
	);
	useLayoutEffect(() => {
		openRef.current = open;
		if (open) {
			setUnread(false);
			(inputRef.current || closeRef.current)?.focus({ preventScroll: true });
			if (bodyRef.current) bodyRef.current.scrollTop = scrollTopRef.current;
		} else if (document.activeElement === document.body) {
			launcherRef.current?.focus({ preventScroll: true });
		}
	}, [open]);
	useLayoutEffect(() => {
		if (open && inputExpanded) inputRef.current?.focus({ preventScroll: true });
	}, [open, inputExpanded]);
	useLayoutEffect(() => {
		if (menuOpen) menu.panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
	}, [menuOpen, menu.panelRef]);
	useLayoutEffect(() => {
		if (open && followRef.current && bodyRef.current) {
			bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
		}
	}, [open, messages, loading, error, stopped, sourceExpanded]);

	const modelLabel = model || settings?.quickAskModel || fallbackModel || t("quickAskFollowModel");
	const latestAnswer = messages.findLast((message) => message.role === "assistant");
	const hasAnswer = messages.at(-1)?.role === "assistant";
	const showInput = inputExpanded || messages.length === 0;
	return createPortal(
		<>
			{!open && settings?.quickAskEnabled !== false && (
				<button
					ref={launcherRef}
					type="button"
					className={`quick-ask-launcher${loading ? " is-loading" : ""}${unread ? " has-answer" : ""}${launcherDrag.dragging ? " is-dragging" : ""}`}
					style={launcherDrag.style}
					title={unread ? t("quickAskReady") : loading ? t("quickAskLoading") : t("quickAskOpen")}
					aria-label={t("quickAskOpen")}
					onPointerDown={launcherDrag.onPointerDown}
					onPointerMove={launcherDrag.onPointerMove}
					onPointerUp={launcherDrag.onPointerUp}
					onPointerCancel={launcherDrag.onPointerCancel}
					onLostPointerCapture={launcherDrag.onLostPointerCapture}
					onClickCapture={launcherDrag.onClickCapture}
					onClick={() => setOpen(true)}
				>
					<FiMessageCircle size={20} />
					{(loading || unread) && <span className="quick-ask-launcher-dot" aria-hidden="true" />}
					{unread && (
						<span className="quick-ask-launcher-status" role="status">
							{t("quickAskReady")}
						</span>
					)}
				</button>
			)}
			{open && (
				<div
					ref={drag.panelRef}
					style={drag.style}
					className={`quick-ask-popover${drag.dragging ? " is-dragging" : ""}`}
					role="dialog"
					aria-modal="false"
					aria-label={t("quickAskTitle")}
				>
					<div
						className="quick-ask-header"
						onPointerDown={(event) => {
							if (drag.onPointerDown(event)) setMenuOpen(false);
						}}
						onPointerMove={drag.onPointerMove}
						onPointerUp={drag.onPointerUp}
						onPointerCancel={drag.onPointerCancel}
						onLostPointerCapture={drag.onLostPointerCapture}
					>
						{mode === "translate" ? (
							<FiGlobe className="quick-ask-symbol" size={14} aria-hidden="true" />
						) : (
							<FiZap className="quick-ask-symbol" size={14} aria-hidden="true" />
						)}
						<strong className="quick-ask-heading">
							{t(mode === "translate" ? "quickAskTranslation" : "quickAskTitle")}
						</strong>
						{mode === "translate" && (
							<select
								className="quick-ask-target"
								value={target}
								aria-label={t("quickAskTargetLanguage")}
								disabled={settings?.quickAskTranslateEnabled === false}
								onChange={(event) =>
									startSelection(
										selection,
										"translate",
										event.target.value as UiSettingsState["quickAskTranslateTarget"],
									)
								}
							>
								{Object.entries(QUICK_ASK_LANGUAGE_LABELS).map(([value, label]) => (
									<option value={value} key={value}>
										{value === "auto" ? t("quickAskTargetAuto") : label}
									</option>
								))}
							</select>
						)}
						{selection && (
							<button
								type="button"
								className={`quick-ask-source-toggle${mode === "translate" ? " is-translation" : ""}`}
								title={sourceExpanded ? t("quickAskCollapseSource") : t("quickAskExpandSource")}
								aria-label={sourceExpanded ? t("quickAskCollapseSource") : t("quickAskExpandSource")}
								aria-expanded={sourceExpanded}
								aria-controls="quick-ask-source"
								onClick={() => setSourceExpanded(!sourceExpanded)}
							>
								{mode === "translate" ? <FiFileText size={12} aria-hidden="true" /> : <span>{selection}</span>}
								<FiChevronDown size={11} aria-hidden="true" />
							</button>
						)}
						<div className="quick-ask-header-actions">
							<button
								type="button"
								className="btn-icon"
								title={t("quickAskNewTopic")}
								aria-label={t("quickAskNewTopic")}
								onClick={reset}
							>
								<FiPlus size={15} aria-hidden="true" />
							</button>
							<button
								ref={menuTriggerRef}
								type="button"
								className="btn-icon"
								title={t("quickAskMore")}
								aria-label={t("quickAskMore")}
								aria-expanded={menuOpen}
								aria-haspopup="dialog"
								aria-controls="quick-ask-menu"
								onClick={() => setMenuOpen(!menuOpen)}
							>
								<FiMoreHorizontal size={15} />
							</button>
							<button
								ref={closeRef}
								type="button"
								className="btn-icon"
								title={t("quickAskClose")}
								aria-label={t("quickAskClose")}
								onClick={close}
							>
								<FiX size={14} />
							</button>
						</div>
					</div>
					<QuickAskReferenceChips
						attachments={attachments}
						onRemove={(id) => {
							const next = attachmentsRef.current.filter((item) => item.id !== id);
							attachmentsRef.current = next;
							setAttachments(next);
						}}
					/>
					{selection && sourceExpanded && (
						<div id="quick-ask-source" className="quick-ask-context-text">
							{selection}
						</div>
					)}
					<div
						ref={bodyRef}
						id="quick-ask-answer"
						className="quick-ask-body"
						aria-busy={loading}
						onScroll={() => {
							const body = bodyRef.current;
							if (body) {
								followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 36;
								scrollTopRef.current = body.scrollTop;
							}
						}}
					>
						{messages.length === 0 && attachments.length > 0 && (
							<p className="quick-ask-reference-empty">{t("quickAskReferenceEmpty")}</p>
						)}
						{messages.length === 0 && attachments.length === 0 && (
							<div className="quick-ask-empty">
								<strong>{t("quickAskEmptyTitle")}</strong>
								<p>{t("quickAskEmpty")}</p>
							</div>
						)}
						{messages.map((message, index) => (
							<div key={index} className={`quick-ask-message quick-ask-${message.role}`}>
								{message.role === "assistant" ? (
									<>
										<div
											className={`quick-ask-answer${loading && index === messages.length - 1 ? " is-streaming" : ""}`}
										>
											<Markdown text={message.content} />
										</div>
										{(!loading || index < messages.length - 1) && <CopyButton text={message.content} />}
									</>
								) : (
									<>
										<QuickAskReferenceChips attachments={message.attachments || []} />
										<div>
											{index === 0 && selection
												? t(selectionAction.current === "translate" ? "quickAskTranslate" : "quickAskExplainQuestion")
												: message.content}
										</div>
									</>
								)}
							</div>
						))}
						{referencesLoading > 0 && (
							<p role="status" className="quick-ask-reference-status">
								{t("quickAskReferenceLoading")}
							</p>
						)}
						{referenceError && (
							<p role="alert" className="quick-ask-reference-error">
								{t("quickAskReferenceError")}: {referenceError}
							</p>
						)}
						{loading && (
							<p role="status" className="quick-ask-stream-status">
								<span aria-hidden="true" />
								{t("quickAskLoading")}
							</p>
						)}
						{error && (
							<div role="alert" className="quick-ask-error">
								<strong>{t("quickAskError")}</strong>
								<p>{error}</p>
							</div>
						)}
						{stopped && (
							<p role="status" className="quick-ask-stopped">
								{t("quickAskStopped")}
							</p>
						)}
						{(error || stopped) && retryRef.current && (
							<button type="button" className="quick-ask-chip" onClick={() => void run(retryRef.current!)}>
								{t("quickAskRetry")}
							</button>
						)}
						{!loading && !error && !stopped && hasAnswer && (
							<div className="quick-ask-suggestions">
								<button type="button" className="quick-ask-chip" onClick={() => send(t("quickAskExample"))}>
									{t("quickAskExample")}
								</button>
								<button type="button" className="quick-ask-chip" onClick={() => send(t("quickAskSummarize"))}>
									{t("quickAskSummarize")}
								</button>
							</div>
						)}
					</div>
					<div className="quick-ask-actions">
						<QuickAskAttachButton
							currentConversation={currentConversation}
							disabled={referencesLoading > 0}
							onReference={(source) => void attachReference(source)}
							onFiles={(files) => void attachFiles(files)}
							onFolder={(files) => void attachFolder(files)}
						/>
						{messages.length > 0 && (
							<>
								<button
									type="button"
									className="quick-ask-ask"
									aria-expanded={showInput}
									aria-controls="quick-ask-composer"
									onClick={() => setInputExpanded(!showInput)}
								>
									<FiMessageCircle size={12} aria-hidden="true" />
									{showInput ? t("quickAskHideInput") : t("quickAskAsk")}
								</button>
								{loading && (
									<button
										type="button"
										className="quick-ask-stop"
										title={t("quickAskStop")}
										aria-label={t("quickAskStop")}
										onClick={() => {
											cancel();
											setStopped(true);
										}}
									>
										<FiSquare size={10} aria-hidden="true" />
										{t("quickAskStop")}
									</button>
								)}
							</>
						)}
					</div>
					{showInput && (
						<form
							id="quick-ask-composer"
							className="quick-ask-composer"
							onSubmit={(event) => {
								event.preventDefault();
								send();
							}}
						>
							<div className="quick-ask-input-wrap">
								<textarea
									ref={inputRef}
									value={input}
									onChange={(event) => setInput(event.target.value)}
									placeholder={hasAnswer ? t("quickAskFollowUp") : t("quickAskPlaceholder")}
									aria-label={t("quickAskInputLabel")}
									rows={input.includes("\n") ? 2 : 1}
									onKeyDown={(event) => {
										if (
											event.key === "Enter" &&
											!event.shiftKey &&
											!event.nativeEvent.isComposing &&
											event.nativeEvent.keyCode !== 229
										) {
											event.preventDefault();
											send();
										}
									}}
								/>
								<button
									type="submit"
									className="quick-ask-send"
									disabled={loading || referencesLoading > 0 || !input.trim()}
									title={t("quickAskSend")}
									aria-label={t("quickAskSend")}
								>
									<FiArrowUp size={14} />
								</button>
							</div>
						</form>
					)}
				</div>
			)}
			{open && menuOpen && (
				<div
					ref={menu.panelRef}
					id="quick-ask-menu"
					className="quick-ask-menu"
					style={menu.style}
					role="dialog"
					aria-label={t("quickAskMore")}
				>
					{latestAnswer && (
						<div className="quick-ask-menu-row">
							<span>{t("copy")}</span>
							<CopyButton text={latestAnswer.content} />
						</div>
					)}
					<div className="quick-ask-model" title={modelLabel}>
						<FiZap size={11} aria-hidden="true" />
						<span>{modelLabel}</span>
					</div>
					<div className="quick-ask-scope">
						<FiLock size={10} aria-hidden="true" />
						<span>{t("quickAskScope")}</span>
					</div>
				</div>
			)}
		</>,
		document.body,
	);
}
