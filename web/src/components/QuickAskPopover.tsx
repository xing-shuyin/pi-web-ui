import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiMessageCircle, FiPlus, FiSend, FiX } from "react-icons/fi";
import { appUrl } from "../base-url";
import { useT } from "../i18n";
import { useFloatingPanel } from "../use-floating-panel";
import type { UiSettingsState } from "../types";
import {
	QUICK_ASK_OPEN_EVENT,
	appendQuickAskQuestion,
	explainSelectionPrompt,
	type QuickAskMessage,
	type QuickAskOpenRequest,
} from "../quick-ask";
import { Markdown } from "./Markdown";
import { CopyButton } from "./copy-button";

type Anchor = NonNullable<QuickAskOpenRequest["anchor"]>;

/** A page-local conversation, intentionally independent of the active agent session. */
export function QuickAskPopover({
	settings,
	fallbackModel,
}: {
	settings: UiSettingsState | null;
	fallbackModel?: string;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<Anchor | null>(null);
	const [messages, setMessages] = useState<QuickAskMessage[]>([]);
	const [input, setInput] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [stopped, setStopped] = useState(false);
	const [model, setModel] = useState("");
	const controllerRef = useRef<AbortController | null>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const followRef = useRef(true);
	const { panelRef, style, measure } = useFloatingPanel({
		open,
		anchor,
		align: "right",
		onClose: () => setOpen(false),
		// Remain visible while reading or interacting with the main conversation.
		isInside: () => true,
	});

	const cancel = () => {
		controllerRef.current?.abort();
		controllerRef.current = null;
		setLoading(false);
	};
	const reset = () => {
		cancel();
		setMessages([]);
		setInput("");
		setError(null);
		setStopped(false);
		setModel("");
		followRef.current = true;
		inputRef.current?.focus({ preventScroll: true });
	};
	const run = async (next: QuickAskMessage[]) => {
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;
		setMessages(next);
		setLoading(true);
		setError(null);
		setStopped(false);
		followRef.current = true;
		try {
			const response = await fetch(appUrl("/api/quick-ask"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messages: next, fallbackModel }),
				signal: controller.signal,
			});
			const result = (await response.json()) as { text?: string; model?: string; error?: string };
			if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
			if (controller.signal.aborted) return;
			if (!result.text?.trim()) throw new Error(t("selectionExplainEmpty"));
			setMessages([...next, { role: "assistant", content: result.text }]);
			setModel(result.model ?? "");
		} catch (err) {
			if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (controllerRef.current === controller) {
				controllerRef.current = null;
				setLoading(false);
			}
		}
	};
	const send = () => {
		if (!input.trim() || loading) return;
		void run(appendQuickAskQuestion(messages, input.trim()));
		setInput("");
	};

	useEffect(() => {
		const onOpen = (event: Event) => {
			const request = (event as CustomEvent<QuickAskOpenRequest>).detail;
			setAnchor(
				request.anchor ?? {
					left: window.innerWidth - 64,
					right: window.innerWidth - 20,
					top: window.innerHeight - 180,
					bottom: window.innerHeight - 136,
				},
			);
			setOpen(true);
			if (request.selection !== undefined) {
				setInput("");
				setModel("");
				void run([
					{ role: "user", content: explainSelectionPrompt(settings?.quickAskExplainPrompt, request.selection) },
				]);
			}
		};
		window.addEventListener(QUICK_ASK_OPEN_EVENT, onOpen);
		return () => window.removeEventListener(QUICK_ASK_OPEN_EVENT, onOpen);
		// The event starts a fresh conversation and never needs the current history.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [settings?.quickAskExplainPrompt, fallbackModel, t]);
	useEffect(() => () => controllerRef.current?.abort(), []);
	useEffect(() => {
		if (open) inputRef.current?.focus({ preventScroll: true });
	}, [open]);
	useLayoutEffect(() => {
		if (!open) return;
		measure();
		if (followRef.current && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, messages, loading, error, stopped]);

	return createPortal(
		<>
			{!open && settings?.quickAskEnabled !== false && (
				<button
					type="button"
					className="quick-ask-launcher"
					title={t("quickAskOpen")}
					aria-label={t("quickAskOpen")}
					onClick={(event) => {
						const rect = event.currentTarget.getBoundingClientRect();
						setAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
						setOpen(true);
					}}
				>
					<FiMessageCircle size={20} />
				</button>
			)}
			{open && (
				<div ref={panelRef} className="quick-ask-popover" style={style} role="dialog" aria-label={t("quickAskTitle")}>
					<div className="quick-ask-header">
						<strong>{t("quickAskTitle")}</strong>
						<button
							type="button"
							className="btn-icon"
							title={t("quickAskNewTopic")}
							aria-label={t("quickAskNewTopic")}
							onClick={reset}
						>
							<FiPlus size={16} />
						</button>
						<button
							type="button"
							className="btn-icon"
							title={t("quickAskClose")}
							aria-label={t("quickAskClose")}
							onClick={() => setOpen(false)}
						>
							<FiX size={16} />
						</button>
					</div>
					<div
						ref={bodyRef}
						className="quick-ask-body"
						aria-busy={loading}
						onScroll={() => {
							const body = bodyRef.current;
							if (body) followRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 36;
						}}
					>
						{messages.length === 0 && <p className="quick-ask-empty">{t("quickAskEmpty")}</p>}
						{messages.map((message, index) => (
							<div key={index} className={`quick-ask-message quick-ask-${message.role}`}>
								{message.role === "assistant" ? (
									<>
										<div className="md">
											<Markdown text={message.content} />
										</div>
										<CopyButton text={message.content} />
									</>
								) : (
									<div>{message.content}</div>
								)}
							</div>
						))}
						{loading && <p role="status">{t("quickAskLoading")}</p>}
						{error && (
							<div role="alert" className="quick-ask-error">
								<strong>{t("quickAskError")}</strong>
								<p>{error}</p>
							</div>
						)}
						{stopped && <p role="status">{t("quickAskStopped")}</p>}
						{(error || stopped) && messages.at(-1)?.role === "user" && (
							<button type="button" className="btn" onClick={() => void run(messages)}>
								{t("quickAskRetry")}
							</button>
						)}
					</div>
					<form
						className="quick-ask-composer"
						onSubmit={(event) => {
							event.preventDefault();
							send();
						}}
					>
						<textarea
							ref={inputRef}
							value={input}
							onChange={(event) => setInput(event.target.value)}
							placeholder={t("quickAskPlaceholder")}
							aria-label={t("quickAskInputLabel")}
							rows={2}
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
						<div className="quick-ask-footer">
							<span title={model || settings?.quickAskModel || fallbackModel}>
								{model || settings?.quickAskModel || fallbackModel}
							</span>
							{loading ? (
								<button
									type="button"
									className="btn"
									onClick={() => {
										cancel();
										setStopped(true);
									}}
								>
									{t("quickAskStop")}
								</button>
							) : (
								<button type="submit" className="btn" disabled={!input.trim()} aria-label={t("quickAskSend")}>
									<FiSend size={14} /> {t("quickAskSend")}
								</button>
							)}
						</div>
					</form>
				</div>
			)}
		</>,
		document.body,
	);
}
