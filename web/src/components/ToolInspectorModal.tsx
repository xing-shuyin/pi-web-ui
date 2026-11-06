import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openImageLightbox } from "../image-lightbox-bridge";
import { useCopyFeedback } from "../use-copy-feedback";
import {
	FiBookOpen,
	FiCheck,
	FiCode,
	FiCompass,
	FiCopy,
	FiCpu,
	FiEdit2,
	FiEdit3,
	FiFileText,
	FiFolder,
	FiGlobe,
	FiHelpCircle,
	FiLayers,
	FiMaximize2,
	FiMessageSquare,
	FiMinimize2,
	FiPackage,
	FiSearch,
	FiSquare,
	FiTerminal,
	FiUsers,
	FiX,
	FiZap,
} from "react-icons/fi";
import { isZhLocale, useLocale, useT } from "../i18n";
import { closeToolInspector, useToolInspectorState, type ToolInspectorState } from "../tool-inspector-state";
import { openContextMenu } from "../context-menu-state";
import { openToolInfo } from "../tool-info-state";
import { createHostSlotEntry, type UiSlotEntry } from "../ui-slots";
import {
	parseCodemodeArgs,
	parseDelegateArgs,
	parseQuestionnaireArgs,
	resolveToolHeadline,
	toolArgHints,
} from "../tool-args";
import { parsePresentArgs } from "../present-items";
import { openFilePreview } from "../file-preview-bridge";
import { parseFileMutationArgs } from "../file-diff";
import { appResourceCrossOrigin, appResourceUrl } from "../base-url";
import { PresentedFiles } from "./PresentedFiles";
import { QuestionnaireCard } from "./QuestionnaireCard";
import { CodemodeCard, DelegateBrief, TerminalCommand, ToolSearchDetails } from "./ToolCallBlock";
import { Markdown } from "./Markdown";
import { SplitDiffView, UnifiedDiffView, WriteCodeView } from "./FileChangeCard";
import { SubagentInspectorView } from "./SubagentInspectorView";

const TOOL_ICONS: Record<string, ReactNode> = {
	bash: <FiTerminal />,
	skill: <FiBookOpen />,
	read: <FiFileText />,
	write: <FiEdit3 />,
	edit: <FiEdit2 />,
	edit_soft: <FiEdit2 />,
	grep: <FiSearch />,
	find: <FiCompass />,
	codemode: <FiZap />,
	eval: <FiCode />,
	lsp: <FiCode />,
	tool_search: <FiSearch />,
	conversation: <FiUsers />,
	subagent: <FiUsers />,
	delegate_task: <FiLayers />,
	present_files: <FiPackage />,
	browser_search: <FiSearch />,
	browser_use: <FiGlobe />,
	ask_user_question: <FiHelpCircle />,
	conversation_read: <FiMessageSquare />,
};

export function resolveInspectorStatus(
	state: ToolInspectorState,
	t: ReturnType<typeof useT>,
	isZh: boolean,
): {
	isRunning: boolean;
	badgeClass: "run" | "err" | "ok";
	statusIcon: string;
	badgeText: string;
	footerText: string;
} {
	const isError = state.isError ?? false;
	const isRunning = state.statusClass === "run" && !isError;
	const badgeClass: "run" | "err" | "ok" = isError ? "err" : isRunning ? "run" : "ok";
	const statusIcon = isError ? "✕" : isRunning ? "⟳" : "✓";

	let badgeText: string;
	if (isError) {
		badgeText = state.duration ? `${t("error")} (${state.duration})` : t("error");
	} else if (isRunning) {
		badgeText = state.status || (isZh ? "执行中..." : "Running...");
	} else if (state.duration) {
		badgeText = `${t("done")} (${state.duration})`;
	} else {
		badgeText = state.status || t("done");
	}

	let footerText: string;
	if (isError) {
		footerText = state.exitHint || (isZh ? "命令执行失败" : "Execution failed");
	} else if (isRunning) {
		footerText = state.exitHint || (isZh ? "执行中..." : "Running...");
	} else {
		footerText = state.exitHint || (isZh ? "执行完成" : "Execution completed");
	}

	return { isRunning, badgeClass, statusIcon, badgeText, footerText };
}

export function ToolInspectorModal() {
	const state = useToolInspectorState();
	if (!state || typeof document === "undefined") return null;
	return createPortal(<ToolInspectorRouter state={state} />, document.body);
}

function ToolInspectorRouter({ state }: { state: ToolInspectorState }) {
	const [isMaximized, setIsMaximized] = useState(false);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				closeToolInspector();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const onToggleMaximize = () => setIsMaximized((prev) => !prev);

	if (state.isThinking) {
		return <ThinkingInspectorDialog state={state} isMaximized={isMaximized} onToggleMaximize={onToggleMaximize} />;
	}

	const name = state.name || "";

	const isFileChange = name === "edit" || name === "write" || name === "edit_soft" || name === "patch";
	if (isFileChange) {
		return <FileDiffInspectorDialog state={state} isMaximized={isMaximized} onToggleMaximize={onToggleMaximize} />;
	}

	if (name === "bash") {
		return <BashInspectorDialog state={state} isMaximized={isMaximized} onToggleMaximize={onToggleMaximize} />;
	}

	const isReadOrSearch =
		name === "read" || name === "ls" || name === "grep" || name === "find" || name === "tool_search";
	if (isReadOrSearch) {
		return <ReadInspectorDialog state={state} isMaximized={isMaximized} onToggleMaximize={onToggleMaximize} />;
	}

	return <GenericInspectorDialog state={state} isMaximized={isMaximized} onToggleMaximize={onToggleMaximize} />;
}

function ThinkingInspectorDialog({
	state,
	isMaximized,
	onToggleMaximize,
}: {
	state: ToolInspectorState;
	isMaximized: boolean;
	onToggleMaximize: () => void;
}) {
	const t = useT();
	const { copy, copied } = useCopyFeedback({ duration: 1200 });
	const text = state.thinking || state.output || "";
	const chars = text.length;
	const lines = text ? text.split("\n").length : 0;

	return (
		<div
			className={`tool-inspector-backdrop pi-we-inspector-backdrop open${isMaximized ? " is-maximized" : ""}`}
			onClick={(e) => {
				if (e.target === e.currentTarget) closeToolInspector();
			}}
		>
			<div
				className={`tool-inspector-dialog pi-we-inspector-dialog is-file-diff${isMaximized ? " is-maximized" : ""}`}
				role="dialog"
				aria-modal="true"
			>
				<div className="file-diff-inspector-header" onDoubleClick={onToggleMaximize}>
					<div className="file-diff-inspector-title-group">
						<FiCpu className="file-diff-file-icon" />
						<span className="file-diff-path">{t("toolInspectorThinkingSection").replace(/^💭\s*/, "")}</span>
						<span className="file-diff-lang">{t("toolInspectorStats", { chars, lines })}</span>
						<span className={`file-diff-status-pill ${state.streaming ? "run" : "ok"}`}>
							{state.streaming ? "⚡ 思考中..." : "✓ 完成"}
						</span>
					</div>

					<div className="file-diff-inspector-actions">
						<button
							type="button"
							className={`file-diff-action-btn${copied ? " copied" : ""}`}
							title={copied ? t("toolInspectorCopied") : t("toolInspectorCopyAll")}
							onClick={(e) => {
								e.stopPropagation();
								void copy(text);
							}}
						>
							{copied ? <FiCheck /> : <FiCopy />}
						</button>
						<button
							type="button"
							className="file-diff-action-btn"
							title={isMaximized ? t("diffRestoreScreen") : t("diffFullscreen")}
							onClick={(e) => {
								e.stopPropagation();
								onToggleMaximize();
							}}
						>
							{isMaximized ? <FiMinimize2 /> : <FiMaximize2 />}
						</button>
						<button
							type="button"
							className="file-diff-action-btn"
							title={`${t("close")} (ESC)`}
							onClick={(e) => {
								e.stopPropagation();
								closeToolInspector();
							}}
						>
							<FiX />
						</button>
					</div>
				</div>

				<div className="file-diff-inspector-body">
					<div className="thinking-inspector-content">
						{text ? (
							<div className="markdown thinking-markdown">
								<Markdown text={text} />
							</div>
						) : (
							<div className="diff-empty-tip">{t("toolInspectorEmptyThinking")}</div>
						)}
					</div>
				</div>

				<div className="file-diff-inspector-footer">
					<div className="file-diff-footer-status">
						<span className="file-diff-status-icon">💭</span>
						<span className="file-diff-status-text">
							{state.streaming ? "思考分析链路生成中..." : `分析记录共 ${lines} 行`}
						</span>
					</div>
					{state.duration && (
						<div className="file-diff-footer-meta">
							<span>耗时: {state.duration}</span>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function BashInspectorDialog({
	state,
	isMaximized,
	onToggleMaximize,
}: {
	state: ToolInspectorState;
	isMaximized: boolean;
	onToggleMaximize: () => void;
}) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");
	const copyCmd = useCopyFeedback({ duration: 1200 });
	const copyOut = useCopyFeedback({ duration: 1200 });

	const { args = "", output = "", details, isError = false, status, duration, exitHint } = state;
	const hints = state.hints || toolArgHints(args);
	const command = hints.command || (args && !args.startsWith("{") ? args : "");

	const formattedDetails = useMemo(() => {
		if (!details || typeof details !== "object") return "";
		try {
			return JSON.stringify(details, null, 2);
		} catch {
			return "";
		}
	}, [details]);

	const statusMeta = resolveInspectorStatus(state, t, isZh);

	const lines = output ? output.split("\n").length : 0;
	const detailsKeysCount =
		details && typeof details === "object" ? Object.keys(details as Record<string, unknown>).length : 0;

	const handleContextMenu = (e: React.MouseEvent) => {
		const sel = window.getSelection?.()?.toString();
		if (sel && sel.trim().length > 0) return;

		e.preventDefault();
		e.stopPropagation();

		const entries: UiSlotEntry[] = [];
		if (state.onKillBash) {
			entries.push(
				createHostSlotEntry({
					id: "host:kill-bash",
					slot: "contextmenu.toolcall",
					label: isZh ? "结束此 bash 命令" : "Stop bash command",
					icon: "■",
					kind: "action",
					order: -1,
					when: statusMeta.isRunning ? undefined : ["disabled"],
				}),
			);
		}
		if (command) {
			entries.push(
				createHostSlotEntry({
					id: "host:copy-command",
					slot: "contextmenu.toolcall",
					label: isZh ? "复制执行命令" : "Copy command",
					icon: "copy",
					kind: "action",
					order: 1,
				}),
			);
		}
		if (output) {
			entries.push(
				createHostSlotEntry({
					id: "host:copy-output",
					slot: "contextmenu.toolcall",
					label: isZh ? "复制终端输出" : "Copy output",
					icon: "copy",
					kind: "action",
					order: 2,
				}),
			);
		}
		entries.push(
			createHostSlotEntry({
				id: "host:tool-info",
				slot: "contextmenu.toolcall",
				label: isZh ? "工具详细信息" : "Tool Details",
				icon: "info",
				kind: "action",
				order: 3,
			}),
		);

		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.toolcall",
			target: { id: state.toolCallId || "bash", kind: "toolcall", label: "bash" },
			entries,
			onHostAction: (entry) => {
				if (entry.id === "host:kill-bash") {
					state.onKillBash?.();
					return undefined;
				}
				if (entry.id === "host:copy-command") {
					void copyCmd.copy(command);
					return undefined;
				}
				if (entry.id === "host:copy-output") {
					void copyOut.copy(output);
					return undefined;
				}
				if (entry.id === "host:tool-info") {
					openToolInfo("bash");
					return undefined;
				}
				return undefined;
			},
		});
	};

	return (
		<div
			className={`tool-inspector-backdrop pi-we-inspector-backdrop open${isMaximized ? " is-maximized" : ""}`}
			onClick={(e) => {
				if (e.target === e.currentTarget) closeToolInspector();
			}}
		>
			<div
				className={`tool-inspector-dialog pi-we-inspector-dialog is-file-diff${isMaximized ? " is-maximized" : ""}`}
				role="dialog"
				aria-modal="true"
			>
				<div className="file-diff-inspector-header" onDoubleClick={onToggleMaximize}>
					<div className="file-diff-inspector-title-group">
						<FiTerminal className="file-diff-file-icon" />
						<span className="file-diff-path" title={command || "bash"}>
							{command ? `$ ${command}` : "bash"}
						</span>
						{exitHint && <span className="file-diff-lang">{exitHint}</span>}
						<span className={`file-diff-status-pill ${statusMeta.badgeClass}`}>
							{statusMeta.statusIcon} {statusMeta.badgeText}
						</span>
					</div>

					<div className="file-diff-inspector-actions">
						{statusMeta.isRunning && state.onKillBash && (
							<button
								type="button"
								className="file-diff-action-btn kill-btn"
								title={isZh ? "结束此 bash 命令 (Stop)" : "Stop bash command"}
								onClick={(e) => {
									e.stopPropagation();
									state.onKillBash?.();
								}}
							>
								<FiSquare />
								<span className="kill-btn-label">{isZh ? "结束" : "Stop"}</span>
							</button>
						)}
						<div className="btn-group-diff" role="group">
							<button
								type="button"
								className={`btn-tag${viewMode === "preview" ? " active" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									setViewMode("preview");
								}}
							>
								{isZh ? "终端输出" : "Terminal"}
							</button>
							<button
								type="button"
								className={`btn-tag${viewMode === "raw" ? " active" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									setViewMode("raw");
								}}
							>
								{t("diffViewRaw")}
							</button>
						</div>

						{command && (
							<button
								type="button"
								className={`file-diff-action-btn${copyCmd.copied ? " copied" : ""}`}
								title={copyCmd.copied ? t("toolInspectorCopied") : t("toolInspectorCopyArgs")}
								onClick={(e) => {
									e.stopPropagation();
									void copyCmd.copy(command);
								}}
							>
								{copyCmd.copied ? <FiCheck /> : <FiCode />}
							</button>
						)}

						<button
							type="button"
							className={`file-diff-action-btn${copyOut.copied ? " copied" : ""}`}
							title={copyOut.copied ? t("toolInspectorCopied") : t("toolInspectorCopyOutput")}
							onClick={(e) => {
								e.stopPropagation();
								void copyOut.copy(output);
							}}
						>
							{copyOut.copied ? <FiCheck /> : <FiCopy />}
						</button>

						<button
							type="button"
							className="file-diff-action-btn"
							title={isMaximized ? t("diffRestoreScreen") : t("diffFullscreen")}
							onClick={(e) => {
								e.stopPropagation();
								onToggleMaximize();
							}}
						>
							{isMaximized ? <FiMinimize2 /> : <FiMaximize2 />}
						</button>

						<button
							type="button"
							className="file-diff-action-btn"
							title={`${t("close")} (ESC)`}
							onClick={(e) => {
								e.stopPropagation();
								closeToolInspector();
							}}
						>
							<FiX />
						</button>
					</div>
				</div>

				<div className="file-diff-inspector-body">
					{viewMode === "raw" ? (
						<div className="file-diff-raw-body">
							<div className="file-diff-raw-section">
								<div className="file-diff-raw-title">⚡ {t("toolInspectorArgs")}</div>
								<pre className="file-diff-pre">{args || "(无入参参数 / No arguments)"}</pre>
							</div>
							{formattedDetails && (
								<div className="file-diff-raw-section">
									<div className="file-diff-raw-title">
										<span>⚙ {t("toolInspectorDetails")}</span>
										<span className="file-diff-raw-count">{detailsKeysCount} keys</span>
									</div>
									<pre className="file-diff-pre">{formattedDetails}</pre>
								</div>
							)}
						</div>
					) : (
						<div className="bash-terminal-viewport" onContextMenu={handleContextMenu}>
							{command && <TerminalCommand command={command} />}
							<pre className="bash-output-pre">
								{output ||
									(state.statusClass === "run" ? t("toolInspectorRunningOutput") : t("toolInspectorEmptyOutput"))}
							</pre>
						</div>
					)}
				</div>

				<div className="file-diff-inspector-footer">
					<div className={`file-diff-footer-status ${statusMeta.badgeClass}`}>
						<span className={`file-diff-status-icon${statusMeta.isRunning ? " spin" : ""}`}>
							{statusMeta.statusIcon}
						</span>
						<span className="file-diff-status-text">
							{statusMeta.footerText} · {lines} 行输出 · {output.length} 字符
						</span>
					</div>
					<div className="file-diff-footer-meta">
						{detailsKeysCount > 0 && <span>details: {detailsKeysCount} keys</span>}
						{detailsKeysCount > 0 && <span className="meta-sep">|</span>}
						<button
							type="button"
							className="file-diff-footer-link"
							onClick={(e) => {
								e.stopPropagation();
								setViewMode(viewMode === "raw" ? "preview" : "raw");
							}}
						>
							{viewMode === "raw"
								? isZh
									? "返回终端输出"
									: "Back to terminal"
								: isZh
									? "查看完整日志与详情"
									: "View raw & details"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function ReadInspectorDialog({
	state,
	isMaximized,
	onToggleMaximize,
}: {
	state: ToolInspectorState;
	isMaximized: boolean;
	onToggleMaximize: () => void;
}) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");
	const copyOut = useCopyFeedback({ duration: 1200 });

	const { name = "read", args = "", output = "", details, isError = false, status, duration, images } = state;
	const hints = state.hints || toolArgHints(args);
	const targetPath = hints.path || "";
	const targetQuery = hints.query || "";
	const titleText = targetQuery ? (targetPath ? `${targetQuery} (${targetPath})` : targetQuery) : targetPath || name;

	const isImage = useMemo(() => {
		if (images && images.length > 0) return true;
		if (targetPath) {
			const ext = targetPath.split(".").pop()?.toLowerCase();
			return ext && ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"].includes(ext);
		}
		return false;
	}, [images, targetPath]);

	const startLine = useMemo(() => {
		if (!args) return 1;
		try {
			const parsed = JSON.parse(args);
			if (typeof parsed?.offset === "number" && parsed.offset > 0) {
				return parsed.offset;
			}
			if (typeof parsed?.startLine === "number" && parsed.startLine > 0) {
				return parsed.startLine;
			}
		} catch {
			const match = /"(?:offset|startLine|start)"\s*:\s*(\d+)/.exec(args);
			if (match) {
				const n = parseInt(match[1], 10);
				if (n > 0) return n;
			}
		}
		return 1;
	}, [args]);

	const formattedDetails = useMemo(() => {
		if (!details || typeof details !== "object") return "";
		try {
			return JSON.stringify(details, null, 2);
		} catch {
			return "";
		}
	}, [details]);

	const statusMeta = resolveInspectorStatus(state, t, isZh);

	const lines = output ? output.split("\n").length : 0;
	const detailsKeysCount =
		details && typeof details === "object" ? Object.keys(details as Record<string, unknown>).length : 0;

	const handleOpenFile = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!targetPath) return;
		const fileName = targetPath.split("/").pop() || targetPath;
		openFilePreview({ path: targetPath, name: fileName });
	};

	return (
		<div
			className={`tool-inspector-backdrop pi-we-inspector-backdrop open${isMaximized ? " is-maximized" : ""}`}
			onClick={(e) => {
				if (e.target === e.currentTarget) closeToolInspector();
			}}
		>
			<div
				className={`tool-inspector-dialog pi-we-inspector-dialog is-file-diff${isMaximized ? " is-maximized" : ""}`}
				role="dialog"
				aria-modal="true"
			>
				<div className="file-diff-inspector-header" onDoubleClick={onToggleMaximize}>
					<div className="file-diff-inspector-title-group">
						<span className="file-diff-file-icon">{TOOL_ICONS[name] ?? <FiFileText />}</span>
						<span className="file-diff-path" title={titleText}>
							{titleText}
						</span>
						{targetQuery && (
							<span
								className="file-diff-pattern"
								title={isZh ? `搜索表达式: ${targetQuery}` : `Pattern: ${targetQuery}`}
							>
								{name === "grep" ? "REGEX" : "QUERY"}
							</span>
						)}
						{targetPath && (
							<span className="file-diff-lang">{targetPath.split(".").pop()?.toUpperCase() || "FILE"}</span>
						)}
						{startLine > 1 && (
							<span className="file-diff-lang" title={`起始偏移量: 第 ${startLine} 行`}>
								L{startLine}~L{startLine + lines - 1}
							</span>
						)}
						<span className={`file-diff-status-pill ${statusMeta.badgeClass}`}>
							{statusMeta.statusIcon} {statusMeta.badgeText}
						</span>
					</div>

					<div className="file-diff-inspector-actions">
						<div className="btn-group-diff" role="group">
							<button
								type="button"
								className={`btn-tag${viewMode === "preview" ? " active" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									setViewMode("preview");
								}}
							>
								{isZh ? "内容查看" : "Content"}
							</button>
							<button
								type="button"
								className={`btn-tag${viewMode === "raw" ? " active" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									setViewMode("raw");
								}}
							>
								{t("diffViewRaw")}
							</button>
						</div>

						{targetPath && (
							<button type="button" className="file-diff-action-btn" title={t("diffOpenFile")} onClick={handleOpenFile}>
								<FiFolder />
							</button>
						)}

						<button
							type="button"
							className={`file-diff-action-btn${copyOut.copied ? " copied" : ""}`}
							title={copyOut.copied ? t("toolInspectorCopied") : t("toolInspectorCopyOutput")}
							onClick={(e) => {
								e.stopPropagation();
								void copyOut.copy(output);
							}}
						>
							{copyOut.copied ? <FiCheck /> : <FiCopy />}
						</button>

						<button
							type="button"
							className="file-diff-action-btn"
							title={isMaximized ? t("diffRestoreScreen") : t("diffFullscreen")}
							onClick={(e) => {
								e.stopPropagation();
								onToggleMaximize();
							}}
						>
							{isMaximized ? <FiMinimize2 /> : <FiMaximize2 />}
						</button>

						<button
							type="button"
							className="file-diff-action-btn"
							title={`${t("close")} (ESC)`}
							onClick={(e) => {
								e.stopPropagation();
								closeToolInspector();
							}}
						>
							<FiX />
						</button>
					</div>
				</div>

				<div className="file-diff-inspector-body">
					{viewMode === "raw" ? (
						<div className="file-diff-raw-body">
							<div className="file-diff-raw-section">
								<div className="file-diff-raw-title">⚡ {t("toolInspectorArgs")}</div>
								<pre className="file-diff-pre">{args || "(无入参参数 / No arguments)"}</pre>
							</div>
							{formattedDetails && (
								<div className="file-diff-raw-section">
									<div className="file-diff-raw-title">
										<span>⚙ {t("toolInspectorDetails")}</span>
										<span className="file-diff-raw-count">{detailsKeysCount} keys</span>
									</div>
									<pre className="file-diff-pre">{formattedDetails}</pre>
								</div>
							)}
						</div>
					) : (
						<div className="read-inspector-viewport">
							{name === "tool_search" && <ToolSearchDetails details={details} />}
							{isImage && images && images.length > 0 ? (
								<div className="read-image-viewport">
									{images.map((img, i) => {
										const src = img.startsWith("/") ? appResourceUrl(img) : img;
										return (
											<div key={i} className="read-image-container">
												<button
													type="button"
													className="image-preview-trigger"
													title={t("toolImageZoom")}
													onClick={() => openImageLightbox({ src, alt: targetPath || `Image ${i + 1}` })}
												>
													<img
														crossOrigin={appResourceCrossOrigin(src)}
														src={src}
														alt={targetPath || `Image ${i + 1}`}
														className="read-image-item"
													/>
												</button>
											</div>
										);
									})}
									{output && <div className="read-image-caption">{output}</div>}
								</div>
							) : output ? (
								<WriteCodeView content={output} startLine={startLine} />
							) : (
								<div className="diff-empty-tip">
									{state.statusClass === "run" ? t("toolInspectorRunningOutput") : t("toolInspectorEmptyOutput")}
								</div>
							)}
						</div>
					)}
				</div>

				<div className="file-diff-inspector-footer">
					<div className={`file-diff-footer-status ${statusMeta.badgeClass}`}>
						<span className={`file-diff-status-icon${statusMeta.isRunning ? " spin" : ""}`}>
							{statusMeta.statusIcon}
						</span>
						<span className="file-diff-status-text">
							{statusMeta.isRunning ? statusMeta.footerText : t("toolInspectorStats", { chars: output.length, lines })}
						</span>
					</div>
					<div className="file-diff-footer-meta">
						{detailsKeysCount > 0 && <span>details: {detailsKeysCount} keys</span>}
						{detailsKeysCount > 0 && <span className="meta-sep">|</span>}
						<button
							type="button"
							className="file-diff-footer-link"
							onClick={(e) => {
								e.stopPropagation();
								setViewMode(viewMode === "raw" ? "preview" : "raw");
							}}
						>
							{viewMode === "raw" ? (isZh ? "返回内容" : "Back to content") : isZh ? "查看完整参数" : "View raw"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function FileDiffInspectorDialog({
	state,
	isMaximized,
	onToggleMaximize,
}: {
	state: ToolInspectorState;
	isMaximized: boolean;
	onToggleMaximize: () => void;
}) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const [viewMode, setViewMode] = useState<"unified" | "split" | "raw">("unified");
	const { copied, copy } = useCopyFeedback({ duration: 1200 });

	const { name = "edit", args = "", details, output = "", isError = false, status, duration } = state;
	const isEdit = name === "edit" || name === "edit_soft" || name === "patch";
	const data = useMemo(() => parseFileMutationArgs(name, args, details, output), [name, args, details, output]);

	const detailsKeysCount =
		details && typeof details === "object" ? Object.keys(details as Record<string, unknown>).length : 0;

	const formattedDetails = useMemo(() => {
		if (!details || typeof details !== "object") return "";
		try {
			return JSON.stringify(details, null, 2);
		} catch {
			return "";
		}
	}, [details]);

	const statusMeta = resolveInspectorStatus(state, t, isZh);

	const handleCopy = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (data?.isWrite && data.content) {
			void copy(data.content);
		} else if (args) {
			void copy(args);
		}
	};

	const handleOpenFile = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!data?.filePath) return;
		const fileName = data.filePath.split("/").pop() || data.filePath;
		openFilePreview({ path: data.filePath, name: fileName });
	};

	return (
		<div
			className={`tool-inspector-backdrop pi-we-inspector-backdrop open${isMaximized ? " is-maximized" : ""}`}
			onClick={(e) => {
				if (e.target === e.currentTarget) closeToolInspector();
			}}
		>
			<div
				className={`tool-inspector-dialog pi-we-inspector-dialog is-file-diff${isMaximized ? " is-maximized" : ""}`}
				role="dialog"
				aria-modal="true"
			>
				<div className="file-diff-inspector-header" onDoubleClick={onToggleMaximize}>
					<div className="file-diff-inspector-title-group">
						<FiFileText className="file-diff-file-icon" />
						<span className="file-diff-path" title={data?.filePath || name}>
							{data?.filePath || name}
						</span>
						{data?.language && data.language !== "plaintext" && <span className="file-diff-lang">{data.language}</span>}
						{data?.stats.isNewFile ? (
							<span className="file-diff-stat-new">{t("diffNewFile")}</span>
						) : (
							data?.stats.additions !== undefined &&
							(data.stats.additions > 0 || data.stats.deletions > 0) && (
								<span className="file-diff-stat-badge">
									{data.stats.additions > 0 && <span className="add">+{data.stats.additions}</span>}
									{data.stats.deletions > 0 && <span className="del">-{data.stats.deletions}</span>}
								</span>
							)
						)}
						<span className={`file-diff-status-pill ${statusMeta.badgeClass}`}>
							{statusMeta.statusIcon} {statusMeta.badgeText}
						</span>
					</div>

					<div className="file-diff-inspector-actions">
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
								className={`btn-tag${viewMode === "raw" ? " active" : ""}`}
								onClick={(e) => {
									e.stopPropagation();
									setViewMode("raw");
								}}
							>
								{t("diffViewRaw")}
							</button>
						</div>

						<button
							type="button"
							className={`file-diff-action-btn${copied ? " copied" : ""}`}
							title={data?.isWrite ? t("diffCopyContent") : t("diffCopyPatch")}
							aria-label={data?.isWrite ? t("diffCopyContent") : t("diffCopyPatch")}
							onClick={handleCopy}
						>
							{copied ? <FiCheck /> : <FiCopy />}
						</button>

						{data?.filePath && (
							<button
								type="button"
								className="file-diff-action-btn"
								title={t("diffOpenFile")}
								aria-label={t("diffOpenFile")}
								onClick={handleOpenFile}
							>
								<FiFolder />
							</button>
						)}

						<button
							type="button"
							className="file-diff-action-btn"
							title={isMaximized ? t("diffRestoreScreen") : t("diffFullscreen")}
							aria-label={isMaximized ? t("diffRestoreScreen") : t("diffFullscreen")}
							onClick={(e) => {
								e.stopPropagation();
								onToggleMaximize();
							}}
						>
							{isMaximized ? <FiMinimize2 /> : <FiMaximize2 />}
						</button>

						<button
							type="button"
							className="file-diff-action-btn"
							title={`${t("close")} (ESC)`}
							aria-label={t("close")}
							onClick={(e) => {
								e.stopPropagation();
								closeToolInspector();
							}}
						>
							<FiX />
						</button>
					</div>
				</div>

				<div className="file-diff-inspector-body">
					{viewMode === "raw" ? (
						<div className="file-diff-raw-body">
							<div className="file-diff-raw-section">
								<div className="file-diff-raw-title">⚡ {t("toolInspectorArgs")}</div>
								<pre className="file-diff-pre">{args || "(无入参参数 / No arguments)"}</pre>
							</div>
							{formattedDetails && (
								<div className="file-diff-raw-section">
									<div className="file-diff-raw-title">
										<span>⚙ {t("toolInspectorDetails")}</span>
										<span className="file-diff-raw-count">{detailsKeysCount} keys</span>
									</div>
									<pre className="file-diff-pre">{formattedDetails}</pre>
								</div>
							)}
						</div>
					) : data?.isWrite ? (
						<WriteCodeView content={data.content || ""} />
					) : viewMode === "split" ? (
						<SplitDiffView hunks={data?.hunks || []} isStreaming={data?.isStreamingPartial} fallbackText={args} />
					) : (
						<UnifiedDiffView hunks={data?.hunks || []} isStreaming={data?.isStreamingPartial} fallbackText={args} />
					)}
				</div>

				<div className="file-diff-inspector-footer">
					<div className={`file-diff-footer-status ${statusMeta.badgeClass}`}>
						<span className={`file-diff-status-icon${statusMeta.isRunning ? " spin" : ""}`}>
							{statusMeta.statusIcon}
						</span>
						<span className="file-diff-status-text">
							{statusMeta.isRunning
								? statusMeta.footerText
								: output || (isEdit ? (isZh ? "补丁已应用" : "Patch applied") : isZh ? "文件已写入" : "File written")}
						</span>
					</div>
					<div className="file-diff-footer-meta">
						{detailsKeysCount > 0 && <span>details: {detailsKeysCount} keys</span>}
						{detailsKeysCount > 0 && <span className="meta-sep">|</span>}
						<button
							type="button"
							className="file-diff-footer-link"
							onClick={(e) => {
								e.stopPropagation();
								setViewMode(viewMode === "raw" ? "unified" : "raw");
							}}
						>
							{viewMode === "raw" ? (isZh ? "返回差异对比" : "Back to diff") : isZh ? "查看完整日志" : "View raw logs"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function GenericInspectorDialog({
	state,
	isMaximized,
	onToggleMaximize,
}: {
	state: ToolInspectorState;
	isMaximized: boolean;
	onToggleMaximize: () => void;
}) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");
	const copyAll = useCopyFeedback({ duration: 1200 });

	const { name = "tool", args = "", details, output = "", isError = false, status, duration, images } = state;
	const hints = state.hints || toolArgHints(args);
	const headline = resolveToolHeadline({ name, argumentsText: args, hints });
	const displayTitle = headline ? `${name}(${headline.text})` : name ? `${name}()` : t("toolInspectorTitle");

	const formattedDetails = useMemo(() => {
		if (!details || typeof details !== "object") return "";
		try {
			return JSON.stringify(details, null, 2);
		} catch {
			return "";
		}
	}, [details]);

	const statusMeta = resolveInspectorStatus(state, t, isZh);
	const detailsKeysCount =
		details && typeof details === "object" ? Object.keys(details as Record<string, unknown>).length : 0;

	const isPresent = name === "present_files";
	const presentArgs = useMemo(() => (isPresent && args ? parsePresentArgs(args) : null), [isPresent, args]);

	const isDelegate = name === "delegate_task";
	const delegateArgs = useMemo(() => (isDelegate && args ? parseDelegateArgs(args) : {}), [isDelegate, args]);

	const isCodemode = name === "codemode";
	const codemodeArgs = useMemo(() => (isCodemode && args ? parseCodemodeArgs(args) : null), [isCodemode, args]);

	const isQuestionnaire = name === "ask_user_question";
	const questionnaireArgs = useMemo(
		() => (isQuestionnaire && args ? parseQuestionnaireArgs(args) : null),
		[isQuestionnaire, args],
	);

	const isSubagent = name === "subagent" || name === "conversation";

	const hasRichView = Boolean(
		(isPresent && presentArgs) ||
		(isDelegate && Object.keys(delegateArgs).length > 0) ||
		(isCodemode && codemodeArgs?.code) ||
		(isQuestionnaire && questionnaireArgs) ||
		isSubagent,
	);

	return (
		<div
			className={`tool-inspector-backdrop pi-we-inspector-backdrop open${isMaximized ? " is-maximized" : ""}`}
			onClick={(e) => {
				if (e.target === e.currentTarget) closeToolInspector();
			}}
		>
			<div
				className={`tool-inspector-dialog pi-we-inspector-dialog is-file-diff${isMaximized ? " is-maximized" : ""}`}
				role="dialog"
				aria-modal="true"
			>
				<div className="file-diff-inspector-header" onDoubleClick={onToggleMaximize}>
					<div className="file-diff-inspector-title-group">
						<span className="file-diff-file-icon">{TOOL_ICONS[name] ?? <FiPackage />}</span>
						<span className="file-diff-path" title={displayTitle}>
							{displayTitle}
						</span>
						<span className={`file-diff-status-pill ${statusMeta.badgeClass}`}>
							{statusMeta.statusIcon} {statusMeta.badgeText}
						</span>
					</div>

					<div className="file-diff-inspector-actions">
						{hasRichView && (
							<div className="btn-group-diff" role="group">
								<button
									type="button"
									className={`btn-tag${viewMode === "preview" ? " active" : ""}`}
									onClick={(e) => {
										e.stopPropagation();
										setViewMode("preview");
									}}
								>
									{isZh ? "视图" : "View"}
								</button>
								<button
									type="button"
									className={`btn-tag${viewMode === "raw" ? " active" : ""}`}
									onClick={(e) => {
										e.stopPropagation();
										setViewMode("raw");
									}}
								>
									{t("diffViewRaw")}
								</button>
							</div>
						)}

						<button
							type="button"
							className={`file-diff-action-btn${copyAll.copied ? " copied" : ""}`}
							title={copyAll.copied ? t("toolInspectorCopied") : t("toolInspectorCopyAll")}
							onClick={(e) => {
								e.stopPropagation();
								void copyAll.copy(`[Arguments]\n${args}\n\n[Output]\n${output}`);
							}}
						>
							{copyAll.copied ? <FiCheck /> : <FiCopy />}
						</button>

						<button
							type="button"
							className="file-diff-action-btn"
							title={isMaximized ? t("diffRestoreScreen") : t("diffFullscreen")}
							onClick={(e) => {
								e.stopPropagation();
								onToggleMaximize();
							}}
						>
							{isMaximized ? <FiMinimize2 /> : <FiMaximize2 />}
						</button>

						<button
							type="button"
							className="file-diff-action-btn"
							title={`${t("close")} (ESC)`}
							onClick={(e) => {
								e.stopPropagation();
								closeToolInspector();
							}}
						>
							<FiX />
						</button>
					</div>
				</div>

				<div className="file-diff-inspector-body">
					{viewMode === "raw" ? (
						<div className="file-diff-raw-body">
							<div className="file-diff-raw-section">
								<div className="file-diff-raw-title">⚡ {t("toolInspectorArgs")}</div>
								<pre className="file-diff-pre">{args || "(无入参参数 / No arguments)"}</pre>
							</div>
							{formattedDetails && (
								<div className="file-diff-raw-section">
									<div className="file-diff-raw-title">
										<span>⚙ {t("toolInspectorDetails")}</span>
										<span className="file-diff-raw-count">{detailsKeysCount} keys</span>
									</div>
									<pre className="file-diff-pre">{formattedDetails}</pre>
								</div>
							)}
						</div>
					) : (
						<div className="generic-inspector-viewport">
							{isPresent && presentArgs && (
								<PresentedFiles
									args={presentArgs}
									details={details}
									toolCallId={state.toolCallId ?? ""}
									resultTimestamp={state.resultTimestamp}
								/>
							)}
							{isDelegate && <DelegateBrief args={delegateArgs} />}
							{isCodemode && codemodeArgs?.code && (
								<CodemodeCard
									code={codemodeArgs.code}
									options={codemodeArgs.options}
									details={details}
									output={output}
								/>
							)}
							{isQuestionnaire && questionnaireArgs && (
								<QuestionnaireCard
									questions={questionnaireArgs.questions}
									details={details}
									output={output}
									isError={isError}
									waiting={state.statusClass === "run"}
								/>
							)}
							{isSubagent && (
								<SubagentInspectorView
									name={name}
									args={args}
									details={details}
									output={output}
									duration={duration}
									statusClass={state.statusClass}
									isError={isError}
								/>
							)}

							{images && images.length > 0 && (
								<div className="tool-inspector-section pi-we-inspector-section" style={{ padding: "8px 14px" }}>
									<div className="tool-inspector-label-row">
										<span className="tool-inspector-label pi-we-inspector-label">
											{t("toolInspectorImages")} ({images.length})
										</span>
									</div>
									<div className="tool-inspector-images">
										{images.map((image, i) => {
											const src = image.startsWith("/") ? appResourceUrl(image) : image;
											return (
												<button
													key={i}
													type="button"
													className="image-preview-trigger"
													title={t("toolImageZoom")}
													onClick={() => openImageLightbox({ src, alt: `output image ${i + 1}` })}
												>
													<img
														crossOrigin={appResourceCrossOrigin(src)}
														src={src}
														alt={`output image ${i + 1}`}
														loading="lazy"
													/>
												</button>
											);
										})}
									</div>
								</div>
							)}

							{!hasRichView && (
								<pre className="generic-output-pre">
									{output ||
										(state.statusClass === "run" ? t("toolInspectorRunningOutput") : t("toolInspectorEmptyOutput"))}
								</pre>
							)}
						</div>
					)}
				</div>

				<div className="file-diff-inspector-footer">
					<div className={`file-diff-footer-status ${statusMeta.badgeClass}`}>
						<span className={`file-diff-status-icon${statusMeta.isRunning ? " spin" : ""}`}>
							{statusMeta.statusIcon}
						</span>
						<span className="file-diff-status-text">
							{statusMeta.isRunning
								? statusMeta.footerText
								: output
									? `${output.split("\n").length} 行输出 · ${output.length} 字符`
									: statusMeta.footerText}
						</span>
					</div>
					<div className="file-diff-footer-meta">
						{detailsKeysCount > 0 && <span>details: {detailsKeysCount} keys</span>}
						{detailsKeysCount > 0 && <span className="meta-sep">|</span>}
						<button
							type="button"
							className="file-diff-footer-link"
							onClick={(e) => {
								e.stopPropagation();
								setViewMode(viewMode === "raw" ? "preview" : "raw");
							}}
						>
							{viewMode === "raw"
								? isZh
									? "返回视图"
									: "Back to view"
								: isZh
									? "查看完整参数与详情"
									: "View raw & details"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
