import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiCopy, FiExternalLink, FiFileText, FiMaximize2, FiMinimize2, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import { openFilePreview } from "../file-preview-bridge";
import { useCopyFeedback } from "../use-copy-feedback";
import { parseFileMutationArgs, type DiffHunk, type DiffLine } from "../file-diff";

export interface FileChangeCardProps {
	toolName: string;
	argumentsText?: string;
	details?: unknown;
	output?: string;
	isError?: boolean;
	onOpenInspector?: () => void;
}

export const FileChangeCard = memo(function FileChangeCard({
	toolName,
	argumentsText,
	details,
	output,
	isError,
	onOpenInspector,
}: FileChangeCardProps) {
	const t = useT();
	const [viewMode, setViewMode] = useState<"unified" | "split" | "raw">("unified");
	const [isFullscreen, setIsFullscreen] = useState(false);
	const { copied, copy } = useCopyFeedback({ duration: 1200 });

	const data = useMemo(
		() => parseFileMutationArgs(toolName, argumentsText, details, output),
		[toolName, argumentsText, details, output],
	);

	const formattedDetails = useMemo(() => {
		if (!details || typeof details !== "object") return "";
		try {
			return JSON.stringify(details, null, 2);
		} catch {
			return "";
		}
	}, [details]);

	useEffect(() => {
		if (!isFullscreen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setIsFullscreen(false);
			}
		};
		window.addEventListener("keydown", onKey, { capture: true });
		return () => window.removeEventListener("keydown", onKey, { capture: true });
	}, [isFullscreen]);

	const handleCopy = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (data?.isWrite && data.content) {
			void copy(data.content);
		} else if (argumentsText) {
			void copy(argumentsText);
		}
	};

	const handleOpenFile = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!data?.filePath) return;
		const name = data.filePath.split("/").pop() || data.filePath;
		openFilePreview({ path: data.filePath, name });
	};

	const handleToggleFullscreen = (e: React.MouseEvent) => {
		e.stopPropagation();
		setIsFullscreen((prev) => !prev);
		onOpenInspector?.();
	};

	if (!data || viewMode === "raw") {
		return (
			<div className="file-diff-raw-wrap">
				<div className="file-diff-toolbar">
					<span className="file-diff-path">{data?.filePath || toolName}</span>
					<div className="file-diff-actions">
						<button
							type="button"
							className={`btn-tag${viewMode === "unified" ? " active" : ""}`}
							onClick={(e) => {
								e.stopPropagation();
								setViewMode("unified");
							}}
						>
							{t("diffViewUnified")}
						</button>
						{!data?.isWrite && (
							<button
								type="button"
								className={`btn-tag${viewMode === "split" ? " active" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									setViewMode("split");
								}}
							>
								{t("diffViewSplit")}
							</button>
						)}
						<button
							type="button"
							className={`btn-tag${(viewMode as string) === "raw" ? " active" : ""}`}
							onClick={(e) => {
								e.stopPropagation();
								setViewMode("raw");
							}}
						>
							{t("diffViewRaw")}
						</button>
						{onOpenInspector && (
							<button
								type="button"
								className="file-diff-action-btn"
								title={t("diffFullscreen")}
								aria-label={t("diffFullscreen")}
								onClick={handleToggleFullscreen}
							>
								<FiMaximize2 />
							</button>
						)}
					</div>
				</div>
				<div className="file-diff-raw-body">
					<div className="file-diff-raw-section">
						<div className="file-diff-raw-title">⚡ {t("toolInspectorArgs")}</div>
						<pre className="file-diff-pre">{argumentsText || "(无入参参数 / No arguments)"}</pre>
					</div>
					{formattedDetails && (
						<div className="file-diff-raw-section">
							<div className="file-diff-raw-title">
								<span>⚙ {t("toolInspectorDetails")}</span>
								<span className="file-diff-raw-count">{Object.keys(details as object).length} keys</span>
							</div>
							<pre className="file-diff-pre">{formattedDetails}</pre>
						</div>
					)}
				</div>
			</div>
		);
	}

	const renderContent = () => {
		return data.isWrite ? (
			<WriteCodeView content={data.content || ""} />
		) : viewMode === "split" ? (
			<SplitDiffView hunks={data.hunks} isStreaming={data.isStreamingPartial} fallbackText={argumentsText} />
		) : (
			<UnifiedDiffView hunks={data.hunks} isStreaming={data.isStreamingPartial} fallbackText={argumentsText} />
		);
	};

	return (
		<>
			<div className={`file-diff-card${isError ? " is-err" : ""}`}>
				<div className="file-diff-toolbar">
					<div className="file-diff-info">
						<FiFileText className="file-diff-file-icon" />
						<span className="file-diff-path" title={data.filePath}>
							{data.filePath || toolName}
						</span>
						{data.language && data.language !== "plaintext" && <span className="file-diff-lang">{data.language}</span>}
						{data.isStreamingPartial && <span className="file-diff-streaming-badge">{t("diffStreaming")}</span>}
						{data.stats.isNewFile ? (
							<span className="file-diff-stat-new">{t("diffNewFile")}</span>
						) : (
							(data.stats.additions > 0 || data.stats.deletions > 0) && (
								<span className="file-diff-stat-badge">
									{data.stats.additions > 0 && <span className="add">+{data.stats.additions}</span>}
									{data.stats.deletions > 0 && <span className="del">-{data.stats.deletions}</span>}
								</span>
							)
						)}
					</div>

					<div className="file-diff-actions">
						<div className="btn-group-diff" role="group">
							<button
								type="button"
								className={`btn-tag${viewMode === "unified" ? " active" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									setViewMode("unified");
								}}
							>
								{t("diffViewUnified")}
							</button>
							{!data.isWrite && (
								<button
									type="button"
									className={`btn-tag${viewMode === "split" ? " active" : ""}`}
									onClick={(e) => {
										e.stopPropagation();
										setViewMode("split");
									}}
								>
									{t("diffViewSplit")}
								</button>
							)}
							<button
								type="button"
								className={`btn-tag${(viewMode as string) === "raw" ? " active" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									setViewMode("raw");
								}}
							>
								{t("diffViewRaw")}
							</button>
						</div>

						{data.filePath && (
							<button
								type="button"
								className="file-diff-action-btn"
								title={t("diffOpenFile")}
								aria-label={t("diffOpenFile")}
								onClick={handleOpenFile}
							>
								<FiExternalLink />
							</button>
						)}

						<button
							type="button"
							className="file-diff-action-btn"
							title={t("diffFullscreen")}
							aria-label={t("diffFullscreen")}
							onClick={handleToggleFullscreen}
						>
							<FiMaximize2 />
						</button>

						<button
							type="button"
							className={`file-diff-action-btn${copied ? " copied" : ""}`}
							title={data.isWrite ? t("diffCopyContent") : t("diffCopyPatch")}
							aria-label={data.isWrite ? t("diffCopyContent") : t("diffCopyPatch")}
							onClick={handleCopy}
						>
							{copied ? <FiCheck /> : <FiCopy />}
						</button>
					</div>
				</div>

				<div className="file-diff-body">{renderContent()}</div>
			</div>

			{isFullscreen &&
				createPortal(
					<div
						className="file-diff-fullscreen-backdrop"
						role="dialog"
						aria-modal="true"
						onClick={(e) => {
							if (e.target === e.currentTarget) setIsFullscreen(false);
						}}
					>
						<div className="file-diff-fullscreen-dialog">
							<div className="file-diff-fullscreen-header">
								<div className="file-diff-info">
									<FiFileText className="file-diff-file-icon" />
									<span className="file-diff-path" title={data.filePath}>
										{data.filePath || toolName}
									</span>
									{data.language && data.language !== "plaintext" && (
										<span className="file-diff-lang">{data.language}</span>
									)}
									{data.stats.isNewFile ? (
										<span className="file-diff-stat-new">{t("diffNewFile")}</span>
									) : (
										(data.stats.additions > 0 || data.stats.deletions > 0) && (
											<span className="file-diff-stat-badge">
												{data.stats.additions > 0 && <span className="add">+{data.stats.additions}</span>}
												{data.stats.deletions > 0 && <span className="del">-{data.stats.deletions}</span>}
											</span>
										)
									)}
								</div>

								<div className="file-diff-actions">
									<div className="btn-group-diff" role="group">
										<button
											type="button"
											className={`btn-tag${viewMode === "unified" ? " active" : ""}`}
											onClick={(e) => {
												e.stopPropagation();
												setViewMode("unified");
											}}
										>
											{t("diffViewUnified")}
										</button>
										{!data.isWrite && (
											<button
												type="button"
												className={`btn-tag${viewMode === "split" ? " active" : ""}`}
												onClick={(e) => {
													e.stopPropagation();
													setViewMode("split");
												}}
											>
												{t("diffViewSplit")}
											</button>
										)}
										<button
											type="button"
											className={`btn-tag${(viewMode as string) === "raw" ? " active" : ""}`}
											onClick={(e) => {
												e.stopPropagation();
												setViewMode("raw");
											}}
										>
											{t("diffViewRaw")}
										</button>
									</div>

									{data.filePath && (
										<button
											type="button"
											className="file-diff-action-btn"
											title={t("diffOpenFile")}
											aria-label={t("diffOpenFile")}
											onClick={handleOpenFile}
										>
											<FiExternalLink />
										</button>
									)}

									<button
										type="button"
										className={`file-diff-action-btn${copied ? " copied" : ""}`}
										title={data.isWrite ? t("diffCopyContent") : t("diffCopyPatch")}
										aria-label={data.isWrite ? t("diffCopyContent") : t("diffCopyPatch")}
										onClick={handleCopy}
									>
										{copied ? <FiCheck /> : <FiCopy />}
									</button>

									<button
										type="button"
										className="file-diff-action-btn"
										title={`${t("diffRestoreScreen")} (ESC)`}
										aria-label={t("diffRestoreScreen")}
										onClick={(e) => {
											e.stopPropagation();
											setIsFullscreen(false);
										}}
									>
										<FiMinimize2 />
									</button>

									<button
										type="button"
										className="file-diff-action-btn"
										title={`${t("close")} (ESC)`}
										aria-label={t("close")}
										onClick={(e) => {
											e.stopPropagation();
											setIsFullscreen(false);
										}}
									>
										<FiX />
									</button>
								</div>
							</div>

							<div className="file-diff-fullscreen-body">{renderContent()}</div>
						</div>
					</div>,
					document.body,
				)}
		</>
	);
});

export function WriteCodeView({ content, startLine = 1 }: { content: string; startLine?: number }) {
	const lines = useMemo(() => (content ? content.split("\n") : []), [content]);

	return (
		<div className="diff-code-table">
			{lines.map((line, idx) => (
				<div key={idx} className="diff-code-row">
					<span className="diff-line-num">{startLine + idx}</span>
					<span className="diff-line-text">{line || " "}</span>
				</div>
			))}
		</div>
	);
}

export function UnifiedDiffView({
	hunks,
	isStreaming,
	fallbackText,
}: {
	hunks: DiffHunk[];
	isStreaming?: boolean;
	fallbackText?: string;
}) {
	const t = useT();
	if (hunks.length === 0) {
		if (isStreaming) {
			return <div className="diff-empty-tip">⚡ {t("diffStreaming")}</div>;
		}
		if (fallbackText) {
			return <pre className="file-diff-pre">{fallbackText}</pre>;
		}
		return <div className="diff-empty-tip">{t("diffEmptyHunks")}</div>;
	}

	return (
		<div className="diff-unified-view">
			{hunks.map((hunk, hIdx) => (
				<div key={hIdx} className="diff-hunk-section">
					<div className="diff-hunk-header">
						<span className="diff-hunk-text">{hunk.header}</span>
					</div>
					{hunk.lines.map((line, lIdx) => (
						<DiffLineRow key={lIdx} line={line} />
					))}
				</div>
			))}
		</div>
	);
}

function DiffLineRow({ line }: { line: DiffLine }) {
	const gutter = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
	const lineNum = line.type === "del" ? line.oldLineNum : line.newLineNum;

	return (
		<div className={`diff-line-row ${line.type}`}>
			<span className="diff-gutter-num">{lineNum ?? ""}</span>
			<span className="diff-gutter-sym">{gutter}</span>
			<span className="diff-line-content">
				{line.tokens && line.tokens.length > 0
					? line.tokens.map((token, i) => (
							<span
								key={i}
								className={token.type === "add" ? "char-add" : token.type === "del" ? "char-del" : undefined}
							>
								{token.text}
							</span>
						))
					: line.content || " "}
			</span>
		</div>
	);
}

export function SplitDiffView({
	hunks,
	isStreaming,
	fallbackText,
}: {
	hunks: DiffHunk[];
	isStreaming?: boolean;
	fallbackText?: string;
}) {
	const t = useT();
	const leftColRef = useRef<HTMLDivElement>(null);
	const rightColRef = useRef<HTMLDivElement>(null);
	const syncingDirection = useRef<"left" | "right" | null>(null);

	if (hunks.length === 0) {
		if (isStreaming) {
			return <div className="diff-empty-tip">⚡ {t("diffStreaming")}</div>;
		}
		if (fallbackText) {
			return <pre className="file-diff-pre">{fallbackText}</pre>;
		}
		return <div className="diff-empty-tip">{t("diffEmptyHunks")}</div>;
	}

	const onLeftScroll = (e: React.UIEvent<HTMLDivElement>) => {
		if (syncingDirection.current === "right") return;
		syncingDirection.current = "left";
		if (rightColRef.current) {
			rightColRef.current.scrollTop = e.currentTarget.scrollTop;
		}
		requestAnimationFrame(() => {
			syncingDirection.current = null;
		});
	};

	const onRightScroll = (e: React.UIEvent<HTMLDivElement>) => {
		if (syncingDirection.current === "left") return;
		syncingDirection.current = "right";
		if (leftColRef.current) {
			leftColRef.current.scrollTop = e.currentTarget.scrollTop;
		}
		requestAnimationFrame(() => {
			syncingDirection.current = null;
		});
	};

	const parsedHunks = useMemo(() => {
		return hunks.map((hunk) => {
			const pairs: Array<{ left?: DiffLine; right?: DiffLine }> = [];
			let i = 0;
			while (i < hunk.lines.length) {
				const cur = hunk.lines[i];
				if (cur.type === "context") {
					pairs.push({ left: cur, right: cur });
					i++;
				} else if (cur.type === "del") {
					const next = hunk.lines[i + 1];
					if (next && next.type === "add") {
						pairs.push({ left: cur, right: next });
						i += 2;
					} else {
						pairs.push({ left: cur, right: undefined });
						i++;
					}
				} else if (cur.type === "add") {
					pairs.push({ left: undefined, right: cur });
					i++;
				} else {
					i++;
				}
			}
			return { header: hunk.header, pairs };
		});
	}, [hunks]);

	return (
		<div className="diff-split-container">
			<div ref={leftColRef} className="diff-split-column left" onScroll={onLeftScroll}>
				<div className="diff-split-pane-header">
					<span className="diff-header-text">BEFORE (ORIGINAL)</span>
				</div>
				<div className="diff-split-lines">
					{parsedHunks.map((hunk, hIdx) => (
						<div key={hIdx} className="diff-split-hunk-group">
							<div className="diff-split-hunk-bar">
								<span className="diff-hunk-text">{hunk.header}</span>
							</div>
							{hunk.pairs.map((pair, pIdx) => (
								<div key={pIdx} className={`diff-split-line-box${pair.left ? ` ${pair.left.type}` : " empty"}`}>
									<div className="diff-split-gutter">
										<span className="diff-gutter-num">{pair.left?.oldLineNum ?? ""}</span>
										<span className="diff-gutter-sym">{pair.left?.type === "del" ? "-" : " "}</span>
									</div>
									<span className="diff-line-code">
										{pair.left?.tokens && pair.left.tokens.length > 0
											? pair.left.tokens.map((token, k) => (
													<span key={k} className={token.type === "del" ? "char-del" : undefined}>
														{token.text}
													</span>
												))
											: pair.left?.content || " "}
									</span>
								</div>
							))}
						</div>
					))}
				</div>
			</div>

			<div className="diff-split-divider" />

			<div ref={rightColRef} className="diff-split-column right" onScroll={onRightScroll}>
				<div className="diff-split-pane-header">
					<span className="diff-header-text">AFTER (MODIFIED)</span>
				</div>
				<div className="diff-split-lines">
					{parsedHunks.map((hunk, hIdx) => (
						<div key={hIdx} className="diff-split-hunk-group">
							<div className="diff-split-hunk-bar">
								<span className="diff-hunk-text">{hunk.header}</span>
							</div>
							{hunk.pairs.map((pair, pIdx) => (
								<div key={pIdx} className={`diff-split-line-box${pair.right ? ` ${pair.right.type}` : " empty"}`}>
									<div className="diff-split-gutter">
										<span className="diff-gutter-num">{pair.right?.newLineNum ?? ""}</span>
										<span className="diff-gutter-sym">{pair.right?.type === "add" ? "+" : " "}</span>
									</div>
									<span className="diff-line-code">
										{pair.right?.tokens && pair.right.tokens.length > 0
											? pair.right.tokens.map((token, k) => (
													<span key={k} className={token.type === "add" ? "char-add" : undefined}>
														{token.text}
													</span>
												))
											: pair.right?.content || " "}
									</span>
								</div>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
