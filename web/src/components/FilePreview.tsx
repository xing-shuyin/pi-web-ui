import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
	FiCheck,
	FiCode,
	FiCornerDownLeft,
	FiDownload,
	FiEdit3,
	FiExternalLink,
	FiEye,
	FiLink,
	FiList,
	FiMaximize,
	FiMinimize,
	FiSave,
	FiX,
	FiZoomIn,
	FiZoomOut,
} from "react-icons/fi";
import type { FileContent } from "../types";
import type { UiSlotEntry } from "../ui-slots";
import { assignHeadingIds, shouldShowToc, type TocHeading } from "../preview-toc";
import { Markdown } from "./Markdown";
import { renderMergedToolbar } from "../slot-toolbar";
import { useT } from "../i18n";
import { getClientId } from "../use-chat";
import { withToken } from "../auth-token";
import { appUrl } from "../base-url";
import { appSend } from "../app-globals";
import { formatSize } from "../format-bytes";
import { downloadFile } from "../download";
import { ImageLightbox } from "./ImageLightbox";

const MAX_PREVIEW_LINES = 5000;
const LS_PREVIEW_TOC = "pi-web-ui:preview-toc";

export interface PreviewFile {
	path: string;
	name: string;
}

interface FilePreviewProps {
	file: PreviewFile;
	composerSessionId?: string;
	content: FileContent | null;
	onAddLines: (path: string, name: string, start: number, end: number) => void;
	onAttach: (path: string, name: string, mode: "reference") => void;
	onClose: () => void;
	uiFilePreviewToolbar?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
}

interface Range {
	start: number;
	end: number;
}

export function FilePreview({
	file,
	composerSessionId,
	content,
	onAddLines,
	onAttach,
	onClose,
	uiFilePreviewToolbar,
	onUiAction,
}: FilePreviewProps) {
	const t = useT();
	const [loaded, setLoaded] = useState<FileContent | null>(null);
	const [loading, setLoading] = useState(false);
	const [sel, setSel] = useState<Range | null>(null);
	const [dragging, setDragging] = useState(false);
	const [added, setAdded] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [markdownPreview, setMarkdownPreview] = useState(true);
	const [htmlPreview, setHtmlPreview] = useState(true);
	const [allowJs, setAllowJs] = useState(false);
	const editViewRef = useRef(false);
	const [wrap, setWrap] = useState(true);
	const [fullscreen, setFullscreen] = useState(false);
	const [zoom, setZoom] = useState(100);
	const anchorRef = useRef(0);
	const draggingRef = useRef(false);
	const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveUnknown, setSaveUnknown] = useState(false);
	const savingRef = useRef(false);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (addedTimer.current) clearTimeout(addedTimer.current);
			if (saveTimer.current) clearTimeout(saveTimer.current);
		},
		[],
	);

	useEffect(() => {
		setLoading(true);
		setLoaded(null);
		setSel(null);
		setEditing(false);
		setDraft("");
		setMarkdownPreview(true);
		setHtmlPreview(true);
		setAllowJs(false);
		editViewRef.current = false;
		savingRef.current = false;
		setSaving(false);
		setSaveUnknown(false);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		appSend({ type: "read_file", path: file.path });
	}, [file.path]);

	useEffect(() => {
		if (content && content.path === file.path) {
			setLoaded(content);
			if (!editing) setDraft(content.text);
			setLoading(false);
			if (savingRef.current) {
				savingRef.current = false;
				if (saveTimer.current) clearTimeout(saveTimer.current);
				setSaving(false);
				setSaveUnknown(false);
				setEditing(false);
				setDraft(content.text);
				if (editViewRef.current) {
					if (isMarkdownFile(file.name)) setMarkdownPreview(true);
					if (isHtmlFile(file.name)) setHtmlPreview(true);
				}
				setSel(null);
			}
		}
	}, [content, editing, file.path]);

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

	const canEdit =
		loaded !== null && loaded.kind === "text" && !loaded.binary && !loaded.truncated && !isOfficeFile(file.name);

	const cancelEditing = () => {
		savingRef.current = false;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		setSaving(false);
		setSaveUnknown(false);
		setDraft(loaded?.text ?? "");
		setEditing(false);
		if (editViewRef.current) {
			if (isMarkdownFile(file.name)) setMarkdownPreview(true);
			if (isHtmlFile(file.name)) setHtmlPreview(true);
		}
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
		editViewRef.current = (isMarkdownFile(file.name) && markdownPreview) || (isHtmlFile(file.name) && htmlPreview);
		if (isMarkdownFile(file.name)) setMarkdownPreview(false);
		if (isHtmlFile(file.name)) setHtmlPreview(false);
		setSel(null);
		setDraft(loaded.text);
		setEditing(true);
	};

	const saveEditing = () => {
		if (!editing || !loaded || !canEdit) return;
		if (!appSend({ type: "write_file", path: file.path, text: draft })) return;
		savingRef.current = true;
		setSaveUnknown(false);
		setSaving(true);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			savingRef.current = false;
			setSaving(false);
			setSaveUnknown(true);
		}, 5000);
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
	const kind = loaded?.kind ?? "text";
	const isMarkdown = isMarkdownFile(file.name) || isOfficeFile(file.name);
	const isHtml = isHtmlFile(file.name);
	const isOffice = isOfficeFile(file.name);

	const showMarkdown = isMarkdown && markdownPreview && !editing && kind === "text" && !isBinary;
	const showHtml = isHtml && htmlPreview && !editing && kind === "text" && !isBinary;

	const [tocOpen, setTocOpen] = useState(() => {
		try {
			return localStorage.getItem(LS_PREVIEW_TOC) === "1";
		} catch {
			return false;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(LS_PREVIEW_TOC, tocOpen ? "1" : "0");
		} catch {}
	}, [tocOpen]);
	const [toc, setToc] = useState<TocHeading[]>([]);
	const [tocActive, setTocActive] = useState("");
	const markdownRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const root = markdownRef.current;
		if (!root || !showMarkdown) {
			setToc([]);
			return;
		}
		const nodes = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")];
		const heads = assignHeadingIds(
			nodes.map((el) => ({ level: Number(el.tagName.slice(1)), label: el.textContent ?? "" })),
		);
		nodes.forEach((el, index) => {
			if (!el.id) el.id = heads[index].id;
		});
		setToc(heads);
	}, [showMarkdown, loaded?.text, file.path]);

	useEffect(() => {
		const root = markdownRef.current;
		if (!root || !tocOpen || !shouldShowToc(toc)) return;
		const nodes = toc
			.map((head) => root.querySelector<HTMLElement>(`#${CSS.escape(head.id)}`))
			.filter((el): el is HTMLElement => el !== null);
		if (nodes.length === 0) return;
		const observer = new IntersectionObserver(
			(entries) => {
				const first = entries
					.filter((entry) => entry.isIntersecting)
					.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
				if (first?.target.id) setTocActive(first.target.id);
			},
			{ rootMargin: "0px 0px -70% 0px" },
		);
		for (const node of nodes) observer.observe(node);
		return () => observer.disconnect();
	}, [toc, tocOpen]);
	const fpHostNodes: Record<string, ReactNode> = {
		"host:fp-md":
			isMarkdown && kind === "text" && !isBinary && loaded ? (
				<button
					type="button"
					className={`fp-attach markdown ${markdownPreview ? "on" : ""}`}
					data-tip={markdownPreview ? t("showMarkdownSource") : t("showMarkdownPreview")}
					disabled={editing}
					onClick={() => setMarkdownPreview((value) => !value)}
				>
					{markdownPreview ? <FiEye /> : <FiCode />}
				</button>
			) : null,
		"host:fp-toc":
			showMarkdown && shouldShowToc(toc) ? (
				<button
					type="button"
					className={`fp-attach toc ${tocOpen ? "on" : ""}`}
					data-tip={tocOpen ? t("previewTocHide") : t("previewTocShow")}
					onClick={() => setTocOpen((value) => !value)}
				>
					<FiList />
				</button>
			) : null,
		"host:fp-html":
			isHtml && kind === "text" && !isBinary && loaded ? (
				<button
					type="button"
					className={`fp-attach html ${htmlPreview ? "on" : ""}`}
					data-tip={htmlPreview ? t("showHtmlSource") : t("showHtmlPreview")}
					disabled={editing}
					onClick={() => setHtmlPreview((value) => !value)}
				>
					{htmlPreview ? <FiCode /> : <FiEye />}
				</button>
			) : null,
		"host:fp-edit":
			kind === "text" && !isBinary && loaded ? (
				<button
					type="button"
					className={`fp-attach edit ${editing ? "on" : ""}`}
					data-tip={truncated ? t("fileEditTruncated") : editing ? t("exitEditFile") : t("editFile")}
					disabled={!canEdit && !editing}
					onClick={toggleEditing}
				>
					<FiEdit3 />
				</button>
			) : null,
		"host:fp-wrap":
			kind === "text" && !isBinary && !showMarkdown && !showHtml ? (
				<button
					type="button"
					className={`fp-attach wrap ${wrap ? "on" : ""}`}
					data-tip={wrap ? t("disableWrap") : t("enableWrap")}
					onClick={() => setWrap((w) => !w)}
				>
					<FiCornerDownLeft />
				</button>
			) : null,
		"host:fp-zoom":
			kind === "text" && loaded ? (
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
			) : null,
		"host:fp-download": (
			<button
				type="button"
				className="fp-attach download"
				data-tip={t("downloadFile")}
				onClick={() => void downloadFile(file.path, file.name)}
			>
				<FiDownload />
			</button>
		),
		"host:fp-ref": (
			<button
				type="button"
				className="fp-attach ref"
				data-tip={t("referenceTip")}
				onClick={() => onAttach(file.path, file.name, "reference")}
			>
				<FiLink />
			</button>
		),
		"host:fp-full": (
			<button
				type="button"
				className={`fp-attach full ${fullscreen ? "on" : ""}`}
				data-tip={fullscreen ? t("exitFullscreen") : t("fullscreen")}
				onClick={() => setFullscreen((f) => !f)}
			>
				{fullscreen ? <FiMinimize /> : <FiMaximize />}
			</button>
		),
		"host:fp-close": null,
	};
	const fpEntries: UiSlotEntry[] =
		uiFilePreviewToolbar === undefined
			? [
					"host:fp-md",
					"host:fp-toc",
					"host:fp-html",
					"host:fp-edit",
					"host:fp-wrap",
					"host:fp-zoom",
					"host:fp-download",
					"host:fp-ref",
					"host:fp-full",
				].map((id) => ({ id, source: "host" }) as UiSlotEntry)
			: uiFilePreviewToolbar.filter((e) => !e.hidden && e.id !== "host:fp-close");
	const mediaUrl = (p: string) =>
		withToken(appUrl(`/api/file?clientId=${encodeURIComponent(getClientId())}&path=${encodeURIComponent(p)}`));
	const htmlUrl = (p: string) => {
		const segs = p
			.split("/")
			.map((s) => encodeURIComponent(s))
			.join("/");
		const abs = /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("/");
		const base = abs ? `/api/preview/__abs__/${segs}` : `/api/preview/${segs}`;
		return withToken(appUrl(`${base}?clientId=${encodeURIComponent(getClientId())}${allowJs ? "&allowJs=1" : ""}`));
	};

	if (kind === "image" && !loading) {
		return (
			<ImageLightbox
				src={mediaUrl(file.path)}
				alt={file.name}
				onClose={handleClose}
				composerSessionId={composerSessionId}
			/>
		);
	}

	return (
		<div
			className={`fp-overlay ${fullscreen ? "fullscreen" : ""}`}
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) handleClose();
			}}
		>
			<div
				className={`fp ${fullscreen ? "fullscreen" : ""} ${isOffice ? "is-ppt" : ""}`}
				style={{ "--fp-zoom": zoom / 100 } as CSSProperties}
			>
				<div
					className="fp-head"
					onDoubleClick={(e) => {
						const target = e.target as HTMLElement | null;
						if (target && !target.closest("button, a, input")) {
							setFullscreen((f) => !f);
						}
					}}
				>
					<span className="fp-name" title={file.path}>
						{file.name}
					</span>
					<span className="fp-path">{file.path}</span>
					<span className="fp-meta">
						{loaded && kind === "text" && !isBinary && t("fileLines", { n: lineCount })}
						{loaded && ` · ${formatSize(loaded.size)}`}
					</span>
					<span className="fp-head-actions">{renderMergedToolbar(fpEntries, fpHostNodes, onUiAction)}</span>
					<button type="button" className="fp-close" title={t("close")} aria-label={t("close")} onClick={handleClose}>
						<FiX />
					</button>
				</div>

				{truncated && kind === "text" && !isBinary && (
					<div className="fp-notice">
						{isOfficeFile(file.name) ? t("previewLinesTruncated", { n: lines.length }) : t("previewTruncated")}
					</div>
				)}

				{loading && !loaded && <div className="fp-empty">{t("loading")}</div>}

				{!loading && kind === "none" && !isBinary && <div className="fp-empty">{t("previewNotSupported")}</div>}

				{!loading && kind === "video" && (
					<div className="fp-media-wrap">
						<video className="fp-media" src={mediaUrl(file.path)} controls preload="metadata" />
					</div>
				)}

				{!loading && kind === "audio" && (
					<div className="fp-media-wrap fp-audio-wrap">
						<div className="fp-audio-card">
							<div className="fp-audio-icon" aria-hidden="true">
								🎵
							</div>
							<div className="fp-audio-info">
								<div className="fp-audio-name" title={file.name}>
									{file.name}
								</div>
								{loaded?.size ? <div className="fp-audio-size">{formatSize(loaded.size)}</div> : null}
							</div>
							<audio className="fp-audio-element" src={mediaUrl(file.path)} controls autoPlay preload="metadata" />
						</div>
					</div>
				)}

				{!loading && showHtml && loaded && (
					<div className="fp-html">
						<div className="fp-html-bar">
							<span className="fp-html-hint" title={t(allowJs ? "htmlJsOnTip" : "htmlJsOffTip")}>
								{allowJs ? t("htmlJsOn") : t("htmlJsOff")}
							</span>
							<button
								type="button"
								className={`fp-html-js ${allowJs ? "on" : ""}`}
								data-tip={allowJs ? t("htmlDisableJs") : t("htmlEnableJs")}
								onClick={() => setAllowJs((v) => !v)}
							>
								{allowJs ? t("htmlDisableJs") : t("htmlEnableJs")}
							</button>
							<a
								className="fp-html-btn fp-html-external"
								href={htmlUrl(file.path)}
								target="_blank"
								rel="noopener noreferrer"
								title={t("openInNewTab")}
							>
								<FiExternalLink />
								<span>{t("openInNewTab")}</span>
							</a>
						</div>
						<iframe
							key={allowJs ? "js" : "nojs"}
							className="fp-html-frame"
							src={htmlUrl(file.path)}
							title={file.name}
							sandbox={allowJs ? "allow-scripts" : ""}
							referrerPolicy="no-referrer"
						/>
					</div>
				)}

				{!loading && showMarkdown && loaded && (
					<div className={isOfficeFile(file.name) ? "fp-markdown msg-text fp-office" : "fp-markdown msg-text"}>
						<div className={tocOpen && shouldShowToc(toc) ? "fp-toc-layout" : undefined}>
							{tocOpen && shouldShowToc(toc) && (
								<nav className="fp-toc" aria-label={t("previewTocLabel")}>
									{toc.map((head) => (
										<a
											key={head.id}
											className={`l${Math.min(head.level, 6)}${head.id === tocActive ? " on" : ""}`}
											href={`#${head.id}`}
											title={head.label}
											onClick={(event) => {
												event.preventDefault();
												markdownRef.current
													?.querySelector<HTMLElement>(`#${CSS.escape(head.id)}`)
													?.scrollIntoView({ behavior: "smooth", block: "start" });
											}}
										>
											{head.label}
										</a>
									))}
								</nav>
							)}
							<div className="fp-markdown-zoom" ref={markdownRef}>
								<Markdown text={loaded.text} />
							</div>
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
					<>
						<textarea
							className={`fp-editor ${wrap ? "" : "no-wrap"}`}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							wrap={wrap ? "soft" : "off"}
							spellCheck={false}
							autoFocus
						/>
						{saveUnknown && (
							<div className="fp-notice" role="alert">
								{t("saveResultUnknown")}
							</div>
						)}
					</>
				)}

				{!loading &&
					!showMarkdown &&
					!showHtml &&
					!editing &&
					kind === "text" &&
					!isBinary &&
					loaded &&
					lines.length === 0 && <div className="fp-empty">{t("emptyFile")}</div>}

				{!loading && !showMarkdown && !showHtml && !editing && kind === "text" && !isBinary && lines.length > 0 && (
					<div
						className={`fp-code ${dragging ? "dragging" : ""} ${wrap ? "" : "no-wrap"}`}
						onMouseDown={(e) => {
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

				{(editing || (!showMarkdown && !showHtml && kind === "text")) && (
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
										disabled={saving || draft === (loaded?.text ?? "")}
										onClick={saveEditing}
									>
										<FiSave /> {t("saveFile")}
									</button>
								</div>
							</>
						) : (
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
						)}
					</div>
				)}
			</div>
		</div>
	);
}

function isMarkdownFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function isOfficeFile(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower.endsWith(".docx") ||
		lower.endsWith(".xlsx") ||
		lower.endsWith(".xlsm") ||
		lower.endsWith(".pptx") ||
		lower.endsWith(".pptm") ||
		lower.endsWith(".ppsx") ||
		lower.endsWith(".potx")
	);
}

function isHtmlFile(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml");
}
