import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
	FiBookOpen,
	FiCheck,
	FiChevronDown,
	FiChevronRight,
	FiClock,
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
	FiMessageSquare,
	FiPackage,
	FiSearch,
	FiTerminal,
	FiUsers,
	FiX,
	FiZap,
} from "react-icons/fi";
import { useT } from "../i18n";
import { closeToolInspector, useToolInspectorState, type ToolInspectorState } from "../tool-inspector-state";
import { parseCodemodeArgs, parseDelegateArgs, parseQuestionnaireArgs, toolArgHints } from "../tool-args";
import { parsePresentArgs } from "../present-items";
import { PresentedFiles } from "./PresentedFiles";
import { QuestionnaireCard } from "./QuestionnaireCard";
import { CodemodeCard, DelegateBrief, TerminalCommand, ToolSearchDetails } from "./ToolCallBlock";
import { Markdown } from "./Markdown";

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
	subagent: <FiUsers />,
	delegate_task: <FiLayers />,
	present_files: <FiPackage />,
	browser_search: <FiSearch />,
	browser_use: <FiGlobe />,
	ask_user_question: <FiHelpCircle />,
	conversation_read: <FiMessageSquare />,
};

export function ToolInspectorModal() {
	const state = useToolInspectorState();
	if (!state || typeof document === "undefined") return null;
	return createPortal(<ToolInspectorDialog state={state} />, document.body);
}

function ToolInspectorDialog({ state }: { state: ToolInspectorState }) {
	const t = useT();

	const [currentMode, setCurrentMode] = useState<"preview" | "raw">("preview");
	const [copiedAll, setCopiedAll] = useState(false);
	const [copiedArgs, setCopiedArgs] = useState(false);
	const [copiedOutput, setCopiedOutput] = useState(false);
	const [copiedPath, setCopiedPath] = useState(false);
	const [copiedCmd, setCopiedCmd] = useState(false);
	const [detailsExpanded, setDetailsExpanded] = useState(false);

	// ESC 键关闭
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

	const isPresent = state.name === "present_files";
	const isDelegate = state.name === "delegate_task";
	const isCodemode = state.name === "codemode";
	const isQuestionnaire = state.name === "ask_user_question";
	const isBash = state.name === "bash";
	const isSkill = state.name === "skill";

	const presentArgs = useMemo(
		() => (isPresent && state.args ? parsePresentArgs(state.args) : null),
		[isPresent, state.args],
	);

	const delegateArgs = useMemo(
		() => (isDelegate && state.args ? parseDelegateArgs(state.args) : {}),
		[isDelegate, state.args],
	);

	const codemodeArgs = useMemo(
		() => (isCodemode && state.args ? parseCodemodeArgs(state.args) : null),
		[isCodemode, state.args],
	);

	const questionnaireArgs = useMemo(
		() => (isQuestionnaire && state.args ? parseQuestionnaireArgs(state.args) : null),
		[isQuestionnaire, state.args],
	);

	// 解析参数对象
	const parsedArgsObj = useMemo(() => {
		if (!state.args || typeof state.args !== "string") return null;
		try {
			const parsed = JSON.parse(state.args);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {}
		return null;
	}, [state.args]);

	const {
		isThinking,
		name,
		title,
		status,
		statusClass,
		duration,
		exitHint,
		hints: propHints,
		args,
		output,
		details,
		images,
		isError,
		toolCallId,
		resultTimestamp,
		thinking,
	} = state;

	// 优先从 propHints 取，没有则从 args 现解析
	const hints = propHints || toolArgHints(args);

	// 提取关键文件路径（read, write, edit, grep 等）
	const targetPath =
		(typeof parsedArgsObj?.path === "string" ? parsedArgsObj.path : undefined) ||
		(typeof parsedArgsObj?.file_path === "string" ? parsedArgsObj.file_path : undefined) ||
		hints?.path;

	// 提取搜索 pattern / query
	const targetQuery =
		(typeof parsedArgsObj?.pattern === "string" ? parsedArgsObj.pattern : undefined) ||
		(typeof parsedArgsObj?.query === "string" ? parsedArgsObj.query : undefined) ||
		hints?.query;

	// 提取 bash 命令
	const targetCommand =
		hints?.command ||
		(typeof parsedArgsObj?.command === "string" ? parsedArgsObj.command : undefined) ||
		(isBash ? args : undefined);

	// 提取行号范围（针对 read offset / limit）
	let rangeHint: string | null = null;
	if (parsedArgsObj && (parsedArgsObj.offset !== undefined || parsedArgsObj.limit !== undefined)) {
		const offset = Number(parsedArgsObj.offset) || 1;
		const limit = parsedArgsObj.limit !== undefined ? Number(parsedArgsObj.limit) : undefined;
		if (limit !== undefined) {
			rangeHint = `行 ${offset} ~ ${offset + limit - 1}`;
		} else {
			rangeHint = `从第 ${offset} 行开始`;
		}
	}

	const handleCopyAll = () => {
		let text = "";
		if (isThinking) {
			text = thinking || output || "";
		} else {
			if (targetPath) text += `[Path]\n${targetPath}\n\n`;
			if (targetCommand) text += `[Command]\n${targetCommand}\n\n`;
			if (args) text += `[Arguments]\n${args}\n\n`;
			if (output) text += `[Output]\n${output}\n`;
		}
		if (!text) return;
		void navigator.clipboard?.writeText(text);
		setCopiedAll(true);
		setTimeout(() => setCopiedAll(false), 1200);
	};

	const handleCopyArgs = () => {
		if (!args) return;
		void navigator.clipboard?.writeText(args);
		setCopiedArgs(true);
		setTimeout(() => setCopiedArgs(false), 1200);
	};

	const handleCopyOutput = () => {
		if (!output) return;
		void navigator.clipboard?.writeText(output);
		setCopiedOutput(true);
		setTimeout(() => setCopiedOutput(false), 1200);
	};

	const handleCopyPath = (path: string) => {
		void navigator.clipboard?.writeText(path);
		setCopiedPath(true);
		setTimeout(() => setCopiedPath(false), 1200);
	};

	const handleCopyCmd = (cmd: string) => {
		void navigator.clipboard?.writeText(cmd);
		setCopiedCmd(true);
		setTimeout(() => setCopiedCmd(false), 1200);
	};

	let formattedArgs = args || "";
	try {
		if (typeof args === "string" && (args.trim().startsWith("{") || args.trim().startsWith("["))) {
			formattedArgs = JSON.stringify(JSON.parse(args), null, 2);
		}
	} catch {}

	let formattedDetails = "";
	if (details && typeof details === "object" && Object.keys(details).length > 0) {
		try {
			formattedDetails = JSON.stringify(details, null, 2);
		} catch {}
	}

	const toolIconNode = isThinking ? <FiCpu /> : name && TOOL_ICONS[name] ? TOOL_ICONS[name] : <FiPackage />;

	const badgeText = duration ? `${status || t("done")} · ${duration}` : status || t("done");
	const badgeClass = statusClass || (isError ? "err" : "ok");

	const outputChars = output ? output.length : 0;
	const outputLines = output ? output.split("\n").length : 0;
	const statsText = output ? t("toolInspectorStats", { chars: outputChars, lines: outputLines }) : "";

	const hasRichView =
		(isPresent && presentArgs) ||
		(isDelegate && Object.keys(delegateArgs).length > 0) ||
		(isCodemode && codemodeArgs?.code) ||
		(isQuestionnaire && questionnaireArgs) ||
		(isBash && targetCommand);

	return (
		<div
			className="tool-inspector-backdrop pi-we-inspector-backdrop open"
			onClick={(e) => {
				if (e.target === e.currentTarget) closeToolInspector();
			}}
		>
			<div className="tool-inspector-dialog pi-we-inspector-dialog" role="dialog" aria-modal="true">
				{/* 顶栏 Header */}
				<div className="tool-inspector-header pi-we-inspector-header">
					<div className="tool-inspector-title-group pi-we-inspector-title-group">
						<div className="tool-inspector-icon pi-we-inspector-icon">{toolIconNode}</div>
						<div className="tool-inspector-title pi-we-inspector-title">
							{isThinking
								? t("toolInspectorThinkingTitle")
								: title ||
									(name
										? isSkill && hints?.skillName
											? `skill(${hints.skillName})`
											: `${name}()`
										: t("toolInspectorTitle"))}
						</div>
						<div className={`tool-inspector-badge pi-we-inspector-badge ${badgeClass}`}>{badgeText}</div>
						{exitHint && <div className="tool-inspector-badge pi-we-inspector-badge">{exitHint}</div>}
					</div>
					<div className="tool-inspector-actions pi-we-inspector-actions">
						{hasRichView && (
							<button
								type="button"
								className="tool-inspector-btn pi-we-inspector-btn"
								onClick={() => setCurrentMode(currentMode === "preview" ? "raw" : "preview")}
							>
								{currentMode === "preview" ? t("toolInspectorToggleRaw") : t("toolInspectorTogglePreview")}
							</button>
						)}
						<button type="button" className="tool-inspector-btn pi-we-inspector-btn" onClick={handleCopyAll}>
							{copiedAll ? (
								<>
									<FiCheck /> {t("toolInspectorCopied")}
								</>
							) : (
								<>
									<FiCopy /> {t("toolInspectorCopyAll")}
								</>
							)}
						</button>
						<button
							type="button"
							className="tool-inspector-btn tool-inspector-close pi-we-inspector-btn pi-we-inspector-close"
							onClick={closeToolInspector}
							title={`${t("close")} (ESC)`}
							aria-label={t("close")}
						>
							<FiX />
						</button>
					</div>
				</div>

				{/* 醒目的核心上下文横幅（Hero Banner）：针对文件、命令或搜索词直接大字呈现 */}
				{!isThinking && targetPath && (
					<div className="tool-inspector-hero-banner">
						<div className="tool-inspector-hero-icon">
							<FiFolder />
						</div>
						<div className="tool-inspector-hero-content">
							<div className="tool-inspector-hero-label">
								<span>目标文件路径 (Target File Path)</span>
								{rangeHint && <span className="tool-inspector-hero-tag">{rangeHint}</span>}
								{hints?.codeLines !== undefined && (
									<span className="tool-inspector-hero-tag">λ {hints.codeLines} L</span>
								)}
							</div>
							<div className="tool-inspector-hero-val" title={targetPath}>
								{targetPath}
							</div>
						</div>
						<button
							type="button"
							className="tool-inspector-hero-copy-btn"
							onClick={() => handleCopyPath(targetPath)}
							title="复制文件路径"
						>
							{copiedPath ? <FiCheck /> : <FiCopy />}
							<span>{copiedPath ? "已复制" : "复制路径"}</span>
						</button>
					</div>
				)}

				{!isThinking && !targetPath && targetQuery && (
					<div className="tool-inspector-hero-banner">
						<div className="tool-inspector-hero-icon">
							<FiSearch />
						</div>
						<div className="tool-inspector-hero-content">
							<div className="tool-inspector-hero-label">检索关键词 / 模式 (Pattern)</div>
							<div className="tool-inspector-hero-val">{targetQuery}</div>
						</div>
					</div>
				)}

				{!isThinking && isBash && targetCommand && (
					<div className="tool-inspector-hero-banner tool-inspector-hero-bash">
						<div className="tool-inspector-hero-icon">
							<FiTerminal />
						</div>
						<div className="tool-inspector-hero-content">
							<div className="tool-inspector-hero-label">执行命令行 (Shell Command)</div>
							<div className="tool-inspector-hero-val tool-inspector-mono">{targetCommand}</div>
						</div>
						<button
							type="button"
							className="tool-inspector-hero-copy-btn"
							onClick={() => handleCopyCmd(targetCommand)}
							title="复制命令行"
						>
							{copiedCmd ? <FiCheck /> : <FiCopy />}
							<span>{copiedCmd ? "已复制" : "复制代码"}</span>
						</button>
					</div>
				)}

				{/* 次要元数据标签条（Meta Chips Strip）：展示 Agent、Skill、超时、退出码等 */}
				{!isThinking && (hints?.agent || (isSkill && hints?.skillName) || hints?.timeout || exitHint) && (
					<div className="tool-inspector-meta-strip">
						{hints?.agent && (
							<div className="tool-inspector-chip" title={hints.agent}>
								<FiUsers className="tool-inspector-chip-icon" />
								<span>Agent: {hints.agent}</span>
							</div>
						)}
						{isSkill && hints?.skillName && (
							<div className="tool-inspector-chip" title={`Skill: ${hints.skillName}`}>
								<FiBookOpen className="tool-inspector-chip-icon" />
								<span>Skill: {hints.skillName}</span>
							</div>
						)}
						{hints?.timeout && (
							<div className="tool-inspector-chip" title={`超时设置: ${hints.timeout}`}>
								<FiClock className="tool-inspector-chip-icon" />
								<span>超时: {hints.timeout}</span>
							</div>
						)}
					</div>
				)}

				{/* 正文区域 */}
				<div className="tool-inspector-body pi-we-inspector-body">
					{isThinking ? (
						<div className="tool-inspector-section pi-we-inspector-section">
							<div className="tool-inspector-label-row">
								<span className="tool-inspector-label pi-we-inspector-label">{t("toolInspectorThinkingSection")}</span>
								{thinking && (
									<span className="tool-inspector-subinfo">
										{t("toolInspectorStats", { chars: thinking.length, lines: thinking.split("\n").length })}
									</span>
								)}
							</div>
							<div className="tool-inspector-thinking-container">
								{thinking || output ? (
									<div className="markdown thinking-markdown">
										<Markdown text={thinking || output || ""} />
									</div>
								) : (
									<div className="tool-inspector-empty-tip">{t("toolInspectorEmptyThinking")}</div>
								)}
							</div>
						</div>
					) : currentMode === "preview" && hasRichView ? (
						<div className="tool-inspector-rich-wrap">
							{/* bash 富终端行展示 */}
							{isBash && targetCommand && (
								<div className="tool-inspector-section pi-we-inspector-section">
									<div className="tool-inspector-label-row">
										<span className="tool-inspector-label pi-we-inspector-label">
											<FiTerminal /> Bash Command
										</span>
									</div>
									<TerminalCommand command={targetCommand} />
								</div>
							)}

							{/* present_files 原生富卡片展示 */}
							{isPresent && presentArgs && (
								<PresentedFiles
									args={presentArgs}
									details={details}
									toolCallId={toolCallId ?? ""}
									resultTimestamp={resultTimestamp}
								/>
							)}

							{/* delegate_task 派单卡片展示 */}
							{isDelegate && <DelegateBrief args={delegateArgs} />}

							{/* codemode 卡片展示 */}
							{isCodemode && codemodeArgs?.code && (
								<CodemodeCard
									code={codemodeArgs.code}
									options={codemodeArgs.options}
									details={details}
									output={output}
								/>
							)}

							{/* ask_user_question 问卷卡片展示 */}
							{isQuestionnaire && questionnaireArgs && (
								<QuestionnaireCard
									questions={questionnaireArgs.questions}
									details={details}
									output={output}
									isError={isError}
									waiting={statusClass === "run"}
								/>
							)}

							{/* tool_search 扩展卡片展示 */}
							{name === "tool_search" && <ToolSearchDetails details={details} />}

							{/* 图片输出 */}
							{images && images.length > 0 && (
								<div className="tool-inspector-section pi-we-inspector-section" style={{ marginTop: 12 }}>
									<div className="tool-inspector-label-row">
										<span className="tool-inspector-label pi-we-inspector-label">
											{t("toolInspectorImages")} ({images.length})
										</span>
									</div>
									<div className="tool-inspector-images pi-we-inspector-images">
										{images.map((src, i) => (
											<a key={i} href={src} target="_blank" rel="noreferrer" title="点击新窗口打开图片">
												<img src={src} alt={`output image ${i + 1}`} loading="lazy" />
											</a>
										))}
									</div>
								</div>
							)}

							{/* 结果输出区 */}
							{!(isQuestionnaire && questionnaireArgs) && (
								<div className="tool-inspector-section pi-we-inspector-section" style={{ marginTop: 12 }}>
									<div className="tool-inspector-label-row">
										<span className="tool-inspector-label pi-we-inspector-label">
											{isError ? t("toolInspectorError") : t("toolInspectorOutput")}
										</span>
										<div className="tool-inspector-label-actions">
											{statsText && <span className="tool-inspector-subinfo">{statsText}</span>}
											{output && (
												<button
													type="button"
													className="tool-inspector-btn-sm"
													onClick={handleCopyOutput}
													title={t("toolInspectorCopyOutput")}
												>
													{copiedOutput ? `✓ ${t("toolInspectorCopied")}` : t("toolInspectorCopyOutput")}
												</button>
											)}
										</div>
									</div>
									<pre className="tool-inspector-codeblock pi-we-inspector-codeblock">
										{output ||
											(statusClass === "run" ? t("toolInspectorRunningOutput") : t("toolInspectorEmptyOutput"))}
									</pre>
								</div>
							)}
						</div>
					) : (
						/* 常规视图或 Raw 视图：全面展示 Arguments、Images、Output */
						<div className="tool-inspector-raw-wrap">
							{/* 入参区 */}
							{formattedArgs && (
								<div className="tool-inspector-section pi-we-inspector-section">
									<div className="tool-inspector-label-row">
										<span className="tool-inspector-label pi-we-inspector-label">{t("toolInspectorArgs")}</span>
										<button
											type="button"
											className="tool-inspector-btn-sm"
											onClick={handleCopyArgs}
											title={t("toolInspectorCopyArgs")}
										>
											{copiedArgs ? `✓ ${t("toolInspectorCopied")}` : t("toolInspectorCopyArgs")}
										</button>
									</div>
									<pre className="tool-inspector-codeblock pi-we-inspector-codeblock">{formattedArgs}</pre>
								</div>
							)}

							{/* 图片区 */}
							{images && images.length > 0 && (
								<div className="tool-inspector-section pi-we-inspector-section">
									<div className="tool-inspector-label-row">
										<span className="tool-inspector-label pi-we-inspector-label">
											{t("toolInspectorImages")} ({images.length})
										</span>
									</div>
									<div className="tool-inspector-images pi-we-inspector-images">
										{images.map((src, i) => (
											<a key={i} href={src} target="_blank" rel="noreferrer" title="点击新窗口打开图片">
												<img src={src} alt={`output image ${i + 1}`} loading="lazy" />
											</a>
										))}
									</div>
								</div>
							)}

							{/* 输出区 */}
							<div className="tool-inspector-section pi-we-inspector-section">
								<div className="tool-inspector-label-row">
									<span className="tool-inspector-label pi-we-inspector-label">
										{isError ? t("toolInspectorError") : t("toolInspectorOutput")}
									</span>
									<div className="tool-inspector-label-actions">
										{statsText && <span className="tool-inspector-subinfo">{statsText}</span>}
										{output && (
											<button
												type="button"
												className="tool-inspector-btn-sm"
												onClick={handleCopyOutput}
												title={t("toolInspectorCopyOutput")}
											>
												{copiedOutput ? `✓ ${t("toolInspectorCopied")}` : t("toolInspectorCopyOutput")}
											</button>
										)}
									</div>
								</div>
								<pre className="tool-inspector-codeblock pi-we-inspector-codeblock">
									{output || (statusClass === "run" ? t("toolInspectorRunningOutput") : t("toolInspectorEmptyOutput"))}
								</pre>
							</div>
						</div>
					)}

					{/* 结构化 Details 展开面板（若有服务端扩展数据） */}
					{formattedDetails && (
						<div className="tool-inspector-details-card">
							<button
								type="button"
								className="tool-inspector-details-toggle"
								onClick={() => setDetailsExpanded(!detailsExpanded)}
							>
								{detailsExpanded ? <FiChevronDown /> : <FiChevronRight />}
								<span>{t("toolInspectorDetails")}</span>
								<span className="tool-inspector-details-count">{Object.keys(details as object).length} keys</span>
							</button>
							{detailsExpanded && (
								<pre className="tool-inspector-codeblock tool-inspector-details-code">{formattedDetails}</pre>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
