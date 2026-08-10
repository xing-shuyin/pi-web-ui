import { useEffect, useRef, useState } from "react";
import { FiSend, FiSquare, FiPaperclip, FiArrowUp } from "react-icons/fi";
import type { ChatState } from "../use-chat";
import type { ClientMessage } from "../types";
import { useT } from "../i18n";
import { isRasterImage } from "../image-paste";

import { ModelThinking } from "./ModelThinking";

interface ChatInputProps {
	chat: ChatState;
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
}

export function ChatInput({
	chat,
	send,
	attachments,
	onRemoveAttachment,
	onAddImageFiles,
	onAddLocalFiles,
	onNotice,
	onSent,
	onManageModels,
}: ChatInputProps) {
	const t = useT();
	const [text, setText] = useState("");
	const [dragOver, setDragOver] = useState(false);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleFiles = (files: FileList | File[] | null) => {
		if (!files || files.length === 0) {
			// A folder drag lands here with an empty FileList — tell the user.
			onNotice("warning", t("foldersNotSupported"));
			return;
		}
		const images = Array.from(files).filter((f) => isRasterImage(f.type));
		const others = Array.from(files).filter((f) => !isRasterImage(f.type));
		if (images.length > 0) onAddImageFiles(images);
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
		onAddImageFiles(images);
	};

	const state = chat.state;
	const streaming = state?.isStreaming ?? false;
	const connected = chat.ready;
	const queueTotal = state ? state.queue.steering + state.queue.followUp : 0;

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

	// Auto-grow the textarea; no scrollbar until it hits the height cap.
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto"; // natural height first, then clamp
		const capped = ta.scrollHeight > 220;
		ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
		ta.style.overflowY = capped ? "auto" : "hidden";
	}, [text]);

	const submit = () => {
		const trimmed = text.trim();
		const hasRawAttach = attachments.some((a) => a.imageData || a.fileData);
		if (!connected || (!trimmed && !hasRawAttach)) return;
		// While the agent is streaming, the server queues this prompt as a
		// steering message (delivered as soon as the current assistant turn
		// settles, skipping remaining tool calls — the pi CLI Enter semantic)
		// and the agent immediately responds to it — see AgentService.prompt()
		// in agent-service.ts.
		if (
			send({
				type: "prompt",
				text: trimmed,
				attachments: attachments.map((a) => {
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
				}),
			})
		) {
			setText("");
			onSent();
			taRef.current?.focus();
		}
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};

	// Send / stop / supplement — rendered twice (desktop row + mobile tools
	// row); CSS hides whichever set doesn't apply at the current width.
	const renderActions = () => (
		<div className="inputbox-actions">
			{streaming ? (
				<>
					{text.trim() !== "" && (
						<button
							type="button"
							className="btn supplement"
							title={t("supplementTip")}
							onClick={submit}
						>
							<FiSend /> {t("supplement")}
						</button>
					)}
					<button
						type="button"
						className="btn stop"
						title={t("stopAgent")}
						onClick={() => send({ type: "abort" })}
					>
						<FiSquare />
					</button>
				</>
			) : (
				<button
					type="button"
					className="btn send"
					title={t("sendTip")}
					disabled={
						!connected ||
						(!text.trim() &&
							!attachments.some((a) => a.imageData || a.fileData))
					}
					onClick={submit}
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
							{a.imageData
								? "🖼"
								: a.fileData
									? "📄"
									: a.isDir
										? "📁"
										: a.mode === "reference"
											? "🔗"
											: "📎"}{" "}
							{a.name}
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
			{streaming && queueTotal > 0 && state && (
				<div className="queue-hint">
					{state.queue.followUp > 0 && (
						<span>{t("followUpQueued", { n: state.queue.followUp })}</span>
					)}
					{state.queue.steering > 0 && (
						<span>{t("steeringQueued", { n: state.queue.steering })}</span>
					)}
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
				<div className="inputbox-row">
					<button
						type="button"
						className="btn attach-img"
						title={t("uploadFile")}
						disabled={!connected}
						onClick={() => fileInputRef.current?.click()}
					>
						<FiPaperclip />
					</button>
					<textarea
						ref={taRef}
						value={text}
						rows={1}
						placeholder={
							connected
								? streaming
									? t("placeholderStreaming")
									: t("placeholderIdle")
								: t("placeholderConnecting")
						}
						disabled={!connected}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
					/>
					{renderActions()}
				</div>
				{/* Mobile second line: model/thinking left, file/send right — the top
				    bar folds those away on phones (styles.css ≤768px). */}
				<div className="input-tools">
					<div className="input-tools-left">
						<ModelThinking
							chat={chat}
							send={send}
							onManageModels={onManageModels}
							compact
						/>
					</div>
					<div className="input-tools-right">
						<button
							type="button"
							className="btn attach-img"
							title={t("uploadFile")}
							disabled={!connected}
							onClick={() => fileInputRef.current?.click()}
						>
							<FiPaperclip />
						</button>
						{renderActions()}
					</div>
				</div>
			</div>
		</div>
	);
}
