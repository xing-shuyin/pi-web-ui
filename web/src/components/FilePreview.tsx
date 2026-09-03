import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
	FiCheck,
	FiCode,
	FiCornerDownLeft,
	FiEdit3,
	FiEye,
	FiLink,
	FiMaximize,
	FiMinimize,
	FiPlus,
	FiSave,
	FiX,
	FiZoomIn,
	FiZoomOut,
} from "react-icons/fi";
import type { ClientMessage, FileContent } from "../types";
import { Markdown } from "./Markdown";
import { useT } from "../i18n";
import { getClientId } from "../use-chat";
import { withToken } from "../auth-token";
import { appUrl } from "../base-url";

/** Cap rendered lines so a pathological file can't freeze the modal. */
const MAX_PREVIEW_LINES = 5000;

export interface PreviewFile {
	path: string;
	name: string;
}

interface FilePreviewProps {
	file: PreviewFile;
	/** Latest file content from the server (path-matched inside the modal). */
	content: FileContent | null;
	send: (msg: ClientMessage) => boolean;
	/** Add the selected line range as a "lines" attachment to the chat input. */
	onAddLines: (path: string, name: string, start: number, end: number) => void;
	/** Attach the whole file (inline content / path reference) like the row buttons. */
	onAttach: (path: string, name: string, mode: "inline" | "reference") => void;
	onClose: () => void;
}

/** 1-based inclusive line range. */
interface Range {
	start: number;
	end: number;
}

export function FilePreview({ file, content, send, onAddLines, onAttach, onClose }: FilePreviewProps) {
	const t = useT();
	const [loaded, setLoaded] = useState<FileContent | null>(null);
	const [loading, setLoading] = useState(false);
	const [sel, setSel] = useState<Range | null>(null);
	const [dragging, setDragging] = useState(false);
	const [added, setAdded] = useState(false);
	// Editing is deliberately opt-in for every newly opened file.
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	// Markdown files open in rendered view; raw source remains one click away.
	const [markdownPreview, setMarkdownPreview] = useState(true);
	const editViewRef = useRef(false);
	// Word wrap for the text preview (default on).
	const [wrap, setWrap] = useState(true);
	// Fullscreen fills the whole viewport; zoom scales the preview body
	// (font-size for code/editor/hex, CSS zoom for the rendered markdown).
	const [fullscreen, setFullscreen] = useState(false);
	const [zoom, setZoom] = useState(100);
	const anchorRef = useRef(0);
	const draggingRef = useRef(false);
	const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Request content on open / file change (mount included).
	useEffect(() => {
		setLoading(true);
		setLoaded(null);
		setSel(null);
		setEditing(false);
		setDraft("");
		setMarkdownPreview(true);
		editViewRef.current = false;
		send({ type: "read_file", path: file.path });
	}, [file.path, send]);

	// Accept responses only for the file currently shown (stale responses for
	// previously previewed files are ignored).
	useEffect(() => {
		if (content && content.path === file.path) {
			setLoaded(content);
			if (!editing) setDraft(content.text);
			setLoading(false);
		}
	}, [content, editing, file.path]);

	// Escape closes; Ctrl/Cmd+A selects everything in the preview.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				handleClose();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && editing) {
				e.preventDefault();
				saveEditing();
				return;
			}
			const target = e.target as HTMLElement | null;
			const typing =
				target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !typing) {
				e.preventDefault();
				selectAll();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onClose, loaded, editing, draft]);

	// End drag selection on mouseup anywhere.
	useEffect(() => {
		const up = () => {
			draggingRef.current = false;
			setDragging(false);
		};
		window.addEventListener("mouseup", up);
		return () => window.removeEventListener("mouseup", up);
	}, []);

	const lines = useMemo(() => {
		if (!loaded) return [];
		const parts = loaded.text.split("\n");
		// Trailing newline → empty phantom line; drop it so line numbers match
		// what the server counts.
		if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
		return parts.slice(0, MAX_PREVIEW_LINES);
	}, [loaded]);

	const lineCount = loaded?.lines ?? 0;
	const truncatedLines = lineCount > MAX_PREVIEW_LINES;

	const selectLine = (line: number, extend: boolean) => {
		if (extend) {
			const anchor = anchorRef.current > 0 ? anchorRef.current : line;
			setSel({
				start: Math.min(anchor, line),
				end: Math.max(anchor, line),
			});
		} else {
			anchorRef.current = line;
			setSel({ start: line, end: line });
		}
	};

	const selectAll = () => {
		if (lines.length === 0) return;
		anchorRef.current = 1;
		setSel({ start: 1, end: lines.length });
	};

	const addToChat = () => {
		if (!sel) return;
		onAddLines(file.path, file.name, sel.start, sel.end);
		setAdded(true);
		if (addedTimer.current) clearTimeout(addedTimer.current);
		addedTimer.current = setTimeout(() => setAdded(false), 1400);
	};

	const canEdit = loaded !== null && loaded.kind === "text" && !loaded.binary && !loaded.truncated;

	const cancelEditing = () => {
		setDraft(loaded?.text ?? "");
		setEditing(false);
		if (editViewRef.current) setMarkdownPreview(true);
	};

	const toggleEditing = () => {
		if (editing) {
			if (draft !== (loaded?.text ?? "") && !window.confirm(t("discardFileChanges"))) {
				return;
			}
			cancelEditing();
			return;
		}
		if (!canEdit || !loaded) return;
		editViewRef.current = isMarkdownFile(file.name) && markdownPreview;
		if (isMarkdownFile(file.name)) setMarkdownPreview(false);
		setSel(null);
		setDraft(loaded.text);
		setEditing(true);
	};

	const saveEditing = () => {
		if (!editing || !loaded || !canEdit) return;
		if (!send({ type: "write_file", path: file.path, text: draft })) return;
		setEditing(false);
		if (editViewRef.current) setMarkdownPreview(true);
		setSel(null);
	};

	const handleClose = () => {
		if (editing && draft !== (loaded?.text ?? "") && !window.confirm(t("discardFileChanges"))) {
			return;
		}
		onClose();
	};

	const setZoomLevel = (next: number) => {
		setZoom(Math.min(200, Math.max(50, next)));
	};

	const selCount = sel ? sel.end - sel.start + 1 : 0;
	const isBinary = loaded?.binary ?? false;
	const truncated = loaded?.truncated ?? false;
	// Preview category from the server ("text" while loading). Media kinds are
	// streamed over the /api/file HTTP endpoint; "none" is never previewable.
	const kind = loaded?.kind ?? "text";
	const isMarkdown = isMarkdownFile(file.name);
	const showMarkdown = isMarkdown && markdownPreview && !editing && kind === "text" && !isBinary;
	// /api/file resolves against the requesting client's workspace (the opened
	// project), not the server's startup cwd — pass clientId so they can differ.
	const mediaUrl = (p: string) =>
		withToken(appUrl(`/api/file?clientId=${encodeURIComponent(getClientId())}&path=${encodeURIComponent(p)}`));

	return (
		<div
			className={`fp-overlay ${fullscreen ? "fullscreen" : ""}`}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) handleClose();
			}}
		>
			<div className={`fp ${fullscreen ? "fullscreen" : ""}`} style={{ "--fp-zoom": zoom / 100 } as CSSProperties}>
				<div className="fp-head">
					<span className="fp-name" title={file.path}>
						{file.name}
					</span>
					<span className="fp-path">{file.path}</span>
					<span className="fp-meta">
						{loaded && kind === "text" && !isBinary && t("fileLines", { n: lineCount })}
						{loaded && ` · ${formatSize(loaded.size)}`}
					</span>
					<span className="fp-head-actions">
						{isMarkdown && kind === "text" && !isBinary && loaded && (
							<button
								type="button"
								className={`fp-attach markdown ${markdownPreview ? "on" : ""}`}
								data-tip={markdownPreview ? t("showMarkdownSource") : t("showMarkdownPreview")}
								disabled={editing}
								onClick={() => setMarkdownPreview((value) => !value)}
							>
								{markdownPreview ? <FiEye /> : <FiCode />}
							</button>
						)}
						{kind === "text" && !isBinary && loaded && (
							<button
								type="button"
								className={`fp-attach edit ${editing ? "on" : ""}`}
								data-tip={truncated ? t("fileEditTruncated") : editing ? t("exitEditFile") : t("editFile")}
								disabled={!canEdit && !editing}
								onClick={toggleEditing}
							>
								<FiEdit3 />
							</button>
						)}
						{kind === "text" && !isBinary && !showMarkdown && (
							<button
								type="button"
								className={`fp-attach wrap ${wrap ? "on" : ""}`}
								data-tip={wrap ? t("disableWrap") : t("enableWrap")}
								onClick={() => setWrap((w) => !w)}
							>
								<FiCornerDownLeft />
							</button>
						)}
						{kind === "text" && loaded && (
							<span className="fp-zoom">
								<button
									type="button"
									className="fp-attach zoom-out"
									data-tip={t("zoomOut")}
									disabled={zoom <= 50}
									onClick={() => setZoomLevel(zoom - 10)}
								>
									<FiZoomOut />
								</button>
								<button type="button" className="fp-zoom-val" title={t("resetZoom")} onClick={() => setZoom(100)}>
									{zoom}%
								</button>
								<button
									type="button"
									className="fp-attach zoom-in"
									data-tip={t("zoomIn")}
									disabled={zoom >= 200}
									onClick={() => setZoomLevel(zoom + 10)}
								>
									<FiZoomIn />
								</button>
							</span>
						)}
						{kind !== "video" && kind !== "none" && (
							<button
								type="button"
								className="fp-attach inline"
								data-tip={t("attachInlineTip")}
								onClick={() => onAttach(file.path, file.name, "inline")}
							>
								<FiPlus />
							</button>
						)}
						<button
							type="button"
							className="fp-attach ref"
							data-tip={t("referenceTip")}
							onClick={() => onAttach(file.path, file.name, "reference")}
						>
							<FiLink />
						</button>
						<button
							type="button"
							className={`fp-attach full ${fullscreen ? "on" : ""}`}
							data-tip={fullscreen ? t("exitFullscreen") : t("fullscreen")}
							onClick={() => setFullscreen((f) => !f)}
						>
							{fullscreen ? <FiMinimize /> : <FiMaximize />}
						</button>
						<button type="button" className="fp-close" title={t("close")} onClick={handleClose}>
							<FiX />
						</button>
					</span>
				</div>

				{truncated && kind === "text" && !isBinary && <div className="fp-notice">{t("previewTruncated")}</div>}

				{loading && !loaded && <div className="fp-empty">{t("loading")}</div>}

				{!loading && kind === "none" && !isBinary && <div className="fp-empty">{t("previewNotSupported")}</div>}

				{!loading && kind === "image" && (
					<div className="fp-media-wrap">
						<img className="fp-media" src={mediaUrl(file.path)} alt={file.name} />
					</div>
				)}

				{!loading && kind === "video" && (
					<div className="fp-media-wrap">
						<video className="fp-media" src={mediaUrl(file.path)} controls preload="metadata" />
					</div>
				)}

				{!loading && showMarkdown && loaded && (
					<div className="fp-markdown msg-text">
						<div className="fp-markdown-zoom">
							<Markdown text={loaded.text} />
						</div>
					</div>
				)}

				{!loading && isBinary && kind !== "image" && kind !== "video" && loaded && (
					<div className="fp-hex-wrap">
						<div className="fp-notice">
							{t("binaryFile")}
							{loaded.truncated && t("binaryHexTruncated")}
						</div>
						<pre className="fp-hex">{loaded.text}</pre>
					</div>
				)}

				{!loading && editing && kind === "text" && !isBinary && loaded && (
					<textarea
						className={`fp-editor ${wrap ? "" : "no-wrap"}`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						wrap={wrap ? "soft" : "off"}
						spellCheck={false}
						autoFocus
					/>
				)}

				{!loading && !showMarkdown && !editing && kind === "text" && !isBinary && loaded && lines.length === 0 && (
					<div className="fp-empty">{t("emptyFile")}</div>
				)}

				{!loading && !showMarkdown && !editing && kind === "text" && !isBinary && lines.length > 0 && (
					<div
						className={`fp-code ${dragging ? "dragging" : ""} ${wrap ? "" : "no-wrap"}`}
						onMouseDown={(e) => {
							// Block native text selection so click/drag maps to line ranges.
							if (e.button === 0) e.preventDefault();
						}}
					>
						{lines.map((text, i) => {
							const n = i + 1;
							const active = sel !== null && n >= sel.start && n <= sel.end;
							return (
								<div
									key={n}
									className={`fp-line ${active ? "sel" : ""}`}
									onMouseDown={(e) => {
										if (e.button !== 0) return;
										selectLine(n, e.shiftKey);
										draggingRef.current = true;
										setDragging(true);
									}}
									onMouseEnter={() => {
										if (draggingRef.current) selectLine(n, true);
									}}
								>
									<span className="fp-num">{n}</span>
									<span className="fp-code-text">{text}</span>
								</div>
							);
						})}
						{truncatedLines && (
							<div className="fp-lines-note">{t("previewLinesTruncated", { n: MAX_PREVIEW_LINES })}</div>
						)}
					</div>
				)}

				<div className="fp-foot">
					{editing ? (
						<>
							<span className="fp-hint">{t("editFile")}</span>
							<div className="fp-actions">
								<button type="button" className="btn" onClick={toggleEditing}>
									{t("cancel")}
								</button>
								<button
									type="button"
									className="btn primary"
									disabled={draft === (loaded?.text ?? "")}
									onClick={saveEditing}
								>
									<FiSave /> {t("saveFile")}
								</button>
							</div>
						</>
					) : (
						!showMarkdown &&
						kind === "text" && (
							<>
								<span className="fp-hint">
									{sel
										? t("selectedRange", {
												n: selCount,
												start: sel.start,
												end: sel.end,
											})
										: t("selectLinesHint")}
								</span>
								<div className="fp-actions">
									<button type="button" className="btn" disabled={lines.length === 0} onClick={selectAll}>
										{t("selectAll")}
									</button>
									<button type="button" className="btn" disabled={!sel} onClick={() => setSel(null)}>
										{t("clearSelection")}
									</button>
									<button type="button" className="btn primary" disabled={!sel || isBinary} onClick={addToChat}>
										{added ? <FiCheck /> : null}
										{added ? t("addedToChat") : t("addToChat")}
									</button>
								</div>
							</>
						)
					)}
				</div>
			</div>
		</div>
	);
}

function isMarkdownFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}
