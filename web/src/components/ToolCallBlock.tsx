import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openImageLightbox } from "../image-lightbox-bridge";
import { appResourceCrossOrigin, appResourceUrl } from "../base-url";
import {
	FiArchive,
	FiArrowRight,
	FiBookOpen,
	FiBox,
	FiCheck,
	FiCheckCircle,
	FiCheckSquare,
	FiClock,
	FiCode,
	FiCompass,
	FiCopy,
	FiDatabase,
	FiEdit2,
	FiEdit3,
	FiFilePlus,
	FiFileText,
	FiFolder,
	FiGitBranch,
	FiGlobe,
	FiHelpCircle,
	FiImage,
	FiLayers,
	FiLock,
	FiMail,
	FiMessageSquare,
	FiMinus,
	FiPackage,
	FiSearch,
	FiServer,
	FiSquare,
	FiTerminal,
	FiTool,
	FiUsers,
	FiX,
	FiZap,
} from "react-icons/fi";
import type { ToolStatus, UiImageBlock, UiMessage, UiToolCallBlock } from "../types";
import { isZhLocale, useLocale, useT } from "../i18n";
import { openContextMenu } from "../context-menu-state";
import { openToolInfo } from "../tool-info-state";
import { getToolInspectorState, isFlowMode, openToolInspector, updateToolInspectorLive } from "../tool-inspector-state";
import { CollapsibleHead } from "./CollapsibleHead";
import { HalfRingSpinner } from "./HalfRingSpinner";
import { slotIcon } from "./Message";
import { createHostSlotEntry, type UiSlotEntry } from "../ui-slots";
import {
	parseCodemodeArgs,
	parseDelegateArgs,
	parseQuestionnaireArgs,
	resolveToolHeadline,
	toolArgHints,
	type DelegateField,
} from "../tool-args";
import { PRESENT_FILES_TOOL_NAME } from "../../../server/tool-manager.js";
import { parsePresentArgs, presentCardItems, primaryPreviewItem } from "../present-items";
import { openFilePreview } from "../file-preview-bridge";
import { useCopyFeedback } from "../use-copy-feedback";
import { PresentedFiles } from "./PresentedFiles";
import { QuestionnaireCard } from "./QuestionnaireCard";
import { renderHighlightedCommand } from "../bash-danger";
import { FileChangeCard } from "./FileChangeCard";
import { parseFileMutationArgs } from "../file-diff";

export interface ToolView {
	result?: UiMessage;
	liveOutput?: string;
	streaming: boolean;
	status?: ToolStatus;
}

type KillBashHandler = () => void;

const TOOL_ICONS: Record<string, ReactNode> = {
	bash: <FiTerminal />,
	delegate_task: <FiLayers />,
	conversation: <FiUsers />,
	subagent: <FiUsers />,
	read: <FiFileText />,
	write: <FiEdit3 />,
	edit: <FiEdit2 />,
	edit_soft: <FiEdit2 />,
	patch: <FiFilePlus />,
	grep: <FiSearch />,
	find: <FiCompass />,
	ls: <FiFolder />,
	codemode: <FiZap />,
	eval: <FiCode />,
	lsp: <FiCode />,
	tool_search: <FiSearch />,
	load_tools: <FiPackage />,
	ask_user_question: <FiHelpCircle />,
	[PRESENT_FILES_TOOL_NAME]: <FiImage />,
	browser_page: <FiGlobe />,
	conversation_read: <FiMessageSquare />,
	claim_files: <FiLock />,
	plan_update: <FiCheckSquare />,
	skill: <FiBookOpen />,
	schedule: <FiClock />,
	compact_context: <FiArchive />,
	mcp_manage: <FiBox />,
	sandbox: <FiBox />,
	worktree: <FiGitBranch />,
	sftp: <FiServer />,
	mail: <FiMail />,
	obs_recall: <FiDatabase />,
};

const DEFAULT_TOOL_ICON: ReactNode = <FiTool />;

const TOOL_ICON_CLASSES: Record<string, string> = {
	bash: "toolcall-icon tc-tone-exec",
	sftp: "toolcall-icon tc-tone-exec",
	read: "toolcall-icon tc-tone-read",
	ls: "toolcall-icon tc-tone-read",
	conversation_read: "toolcall-icon tc-tone-read",
	obs_recall: "toolcall-icon tc-tone-read",
	write: "toolcall-icon tc-tone-edit",
	edit: "toolcall-icon tc-tone-edit",
	edit_soft: "toolcall-icon tc-tone-edit",
	patch: "toolcall-icon tc-tone-edit",
	claim_files: "toolcall-icon tc-tone-edit",
	grep: "toolcall-icon tc-tone-search",
	find: "toolcall-icon tc-tone-search",
	tool_search: "toolcall-icon tc-tone-search",
	load_tools: "toolcall-icon tc-tone-search",
	codemode: "toolcall-icon tc-tone-code",
	eval: "toolcall-icon tc-tone-code",
	lsp: "toolcall-icon tc-tone-code",
	skill: "toolcall-icon tc-tone-code",
	compact_context: "toolcall-icon tc-tone-code",
	delegate_task: "toolcall-icon tc-tone-agent",
	conversation: "toolcall-icon tc-tone-agent",
	subagent: "toolcall-icon tc-tone-agent",
	worktree: "toolcall-icon tc-tone-agent",
	plan_update: "toolcall-icon tc-tone-agent",
	schedule: "toolcall-icon tc-tone-agent",
	ask_user_question: "toolcall-icon tc-tone-ui",
	[PRESENT_FILES_TOOL_NAME]: "toolcall-icon tc-tone-ui",
	browser_page: "toolcall-icon tc-tone-ui",
	mail: "toolcall-icon tc-tone-ui",
	mcp_manage: "toolcall-icon tc-tone-ui",
	sandbox: "toolcall-icon tc-tone-ui",
};

const DEFAULT_TOOL_ICON_CLASS = "toolcall-icon tc-tone-default";

function toolIcon(name: string): ReactNode {
	return TOOL_ICONS[name] ?? DEFAULT_TOOL_ICON;
}

function toolIconClass(name: string): string {
	return TOOL_ICON_CLASSES[name] ?? DEFAULT_TOOL_ICON_CLASS;
}

export interface ToolCallBlockProps {
	block: UiToolCallBlock;
	view: ToolView;
	onKillBash?: KillBashHandler;
	wrap?: boolean;
	showImages?: boolean;
	forceOpen?: boolean;
	uiContextToolCall?: UiSlotEntry[];
	uiToolCardFooter?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
}

function tryOpenPresentPreview(argumentsText: string | undefined, details: unknown): boolean {
	const args = parsePresentArgs(argumentsText);
	if (!args) return false;
	const items = presentCardItems(args, details);
	const target = primaryPreviewItem(items);
	if (!target) return false;
	return openFilePreview({ path: target.target, name: target.name });
}

function useToolInspectorLiveSync({
	blockId,
	view,
	statusClass,
	statusLabel,
	duration,
	durationMs,
	exitHint,
	isError,
	isBash,
	onKillBash,
	t,
}: {
	blockId: string;
	view: ToolView;
	statusClass: "ok" | "run" | "err" | "idle";
	statusLabel: string;
	duration: string;
	durationMs?: number;
	exitHint: string;
	isError: boolean;
	isBash: boolean;
	onKillBash?: KillBashHandler;
	t: ReturnType<typeof useT>;
}) {
	useEffect(() => {
		const cur = getToolInspectorState();
		const myToolCallId = view.result?.toolCallId ?? blockId;
		if (!cur || cur.isThinking || (cur.toolCallId !== blockId && cur.toolCallId !== myToolCallId)) {
			return;
		}

		const currentRaw = view.result
			? view.result.content.map((b) => (b.type === "text" ? b.text : "")).join("")
			: (view.liveOutput ?? "");
		const currentOutput = currentRaw.replace(/…\[LIVE_OMIT:(\d+)\]…\n/, (_, n) => t("liveOutputOmitted", { n }));

		const currentImages = (view.result?.content ?? [])
			.filter(
				(b): b is UiImageBlock =>
					b.type === "image" &&
					typeof (b as UiImageBlock).dataUrl === "string" &&
					(((b as UiImageBlock).dataUrl as string).startsWith("data:") ||
						((b as UiImageBlock).dataUrl as string).startsWith("/")),
			)
			.map((b) => b.dataUrl as string);

		updateToolInspectorLive(cur.toolCallId!, {
			status: statusLabel,
			statusClass,
			duration,
			durationMs,
			exitHint,
			rawOutput: currentRaw,
			output: currentOutput,
			details: view.result?.details,
			images: currentImages,
			isError,
			resultTimestamp: view.result?.timestamp,
			onKillBash: isBash ? onKillBash : undefined,
		});
	}, [
		blockId,
		view.liveOutput,
		view.result,
		view.status,
		statusClass,
		statusLabel,
		duration,
		durationMs,
		exitHint,
		isError,
		isBash,
		onKillBash,
		t,
	]);
}

const ToolCallCapsule = memo(function ToolCallCapsule({
	block,
	view,
	onKillBash,
	uiContextToolCall,
	onUiAction,
	rootRef,
}: {
	block: UiToolCallBlock;
	view: ToolView;
	onKillBash?: KillBashHandler;
	uiContextToolCall?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	rootRef: React.RefObject<HTMLDivElement | null>;
}) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const isPresent = block.name === PRESENT_FILES_TOOL_NAME;
	const isBash = block.name === "bash";

	const running = !view.result && view.streaming && !view.status;
	const isBashRunning = isBash && (running || !view.result);
	const done = view.result !== undefined;
	const waitingModel = !view.result && !!view.status;
	const isError = view.result?.isError ?? view.status?.isError ?? false;

	const statusDuration = view.status?.durationMs;
	const resultDuration = (view.result as unknown as { durationMs?: number } | undefined)?.durationMs;
	const durationMs = typeof resultDuration === "number" ? resultDuration : statusDuration;

	const statusClass = isError ? "err" : done ? "ok" : running || waitingModel ? "run" : "idle";
	let statusLabel = isError
		? t("error")
		: done
			? t("done")
			: running
				? t("running")
				: waitingModel
					? t("toolDoneWaitingModel")
					: t("toolQueued");
	const duration = (waitingModel || done) && durationMs !== undefined ? formatDuration(durationMs) : "";
	if ((waitingModel || done) && duration) statusLabel = `${statusLabel} · ${duration}`;

	const exitHint = waitingModel && view.status?.exitCode !== undefined ? `exit ${view.status.exitCode}` : "";
	const hints = toolArgHints(block.argumentsText);
	const headline = resolveToolHeadline({ name: block.name, argumentsText: block.argumentsText, hints });
	const inspectorTitle = headline ? `${block.name}(${headline.text})` : `${block.name}()`;

	useToolInspectorLiveSync({
		blockId: block.id,
		view,
		statusClass,
		statusLabel,
		duration,
		durationMs,
		exitHint,
		isError,
		isBash,
		onKillBash,
		t,
	});

	const hasImages = useMemo(() => {
		const content = view.result?.content;
		if (!Array.isArray(content)) return false;
		return content.some((b) => b.type === "image");
	}, [view.result?.content]);

	const hasMarkdown = useMemo(() => {
		const content = view.result?.content;
		if (!Array.isArray(content)) return false;
		for (const b of content) {
			if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") {
				const str = (b as { text: string }).text;
				if (/(?:```|#\s+|\|\s*[-:]+\s*\|)/m.test(str.slice(0, 500))) return true;
			}
		}
		return false;
	}, [view.result?.content]);

	const onHeadContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		const baseEntries = uiContextToolCall ?? [];
		const entries: UiSlotEntry[] = [];
		if (isBash && onKillBash) {
			entries.push(
				createHostSlotEntry({
					id: "host:kill-bash",
					slot: "contextmenu.toolcall",
					label: isZh ? "结束此 bash 命令" : "Stop bash command",
					icon: "■",
					kind: "action",
					order: -1,
					when: isBashRunning ? undefined : ["disabled"],
				}),
			);
		}
		entries.push(...baseEntries);
		if (entries.length === 0) return;

		e.preventDefault();
		e.stopPropagation();
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.toolcall",
			target: { id: block.id, kind: "toolcall", label: block.name },
			entries,
			onHostAction: (entry) => {
				if (entry.id === "host:kill-bash") {
					onKillBash?.();
					return undefined;
				}
				if (entry.id === "host:tool-info") {
					openToolInfo(block.name);
					return undefined;
				}
				onUiAction?.(entry);
				return undefined;
			},
		});
	};

	const handleOpenInspector = () => {
		const currentRaw = view.result
			? view.result.content.map((b) => (b.type === "text" ? b.text : "")).join("")
			: (view.liveOutput ?? "");
		const currentOutput = currentRaw.replace(/…\[LIVE_OMIT:(\d+)\]…\n/, (_, n) => t("liveOutputOmitted", { n }));

		const currentImages = (view.result?.content ?? [])
			.filter(
				(b): b is UiImageBlock =>
					b.type === "image" &&
					typeof (b as UiImageBlock).dataUrl === "string" &&
					(((b as UiImageBlock).dataUrl as string).startsWith("data:") ||
						((b as UiImageBlock).dataUrl as string).startsWith("/")),
			)
			.map((b) => b.dataUrl as string);

		const currentPresentArgs = isPresent ? parsePresentArgs(block.argumentsText) : null;

		openToolInspector({
			isThinking: false,
			name: block.name,
			title: inspectorTitle,
			status: statusLabel,
			statusClass,
			duration,
			durationMs,
			exitHint,
			hints,
			args: block.argumentsText || "",
			rawOutput: currentRaw,
			output: currentOutput,
			details: view.result?.details,
			images: currentImages,
			isError,
			toolCallId: view.result?.toolCallId ?? block.id,
			resultTimestamp: view.result?.timestamp,
			onKillBash: isBash ? onKillBash : undefined,
			presentData:
				isPresent && currentPresentArgs
					? {
							title: currentPresentArgs.title,
							note: currentPresentArgs.note,
							items: currentPresentArgs.items,
						}
					: null,
		});
	};

	const handleClick = (e?: React.MouseEvent | React.KeyboardEvent) => {
		if (isPresent && !e?.altKey) {
			if (tryOpenPresentPreview(block.argumentsText, view.result?.details)) {
				return;
			}
		}
		handleOpenInspector();
	};

	return (
		<div
			ref={rootRef}
			className={`toolcall ${statusClass}`}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				handleClick(e);
			}}
			onContextMenu={onHeadContextMenu}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					handleClick(e);
				}
			}}
			role="button"
			tabIndex={0}
			title={`${block.name}(${headline ? headline.text : ""}) · ${statusLabel}`}
		>
			<div className="toolcall-head chead">
				<span className={`toolcall-icon chead-icon ${toolIconClass(block.name)}`}>{toolIcon(block.name)}</span>
				<span className="toolcall-name chead-title">{block.name}</span>
				<span
					className="toolcall-status"
					title={exitHint ? `${statusLabel} · ${exitHint}` : statusLabel}
					aria-label={exitHint ? `${statusLabel} · ${exitHint}` : statusLabel}
				>
					{isError ? <FiX /> : done ? <FiCheck /> : running || waitingModel ? <HalfRingSpinner /> : <FiMinus />}
				</span>
				{hasImages && (
					<span className="toolcall-out-badge img" title={t("toolImageZoom")} aria-label="image output">
						<FiImage />
					</span>
				)}
				{hasMarkdown && (
					<span
						className="toolcall-out-badge md"
						title={isZh ? "包含 Markdown 输出" : "Contains Markdown output"}
						aria-label="markdown output"
					>
						<FiFileText />
					</span>
				)}
			</div>
		</div>
	);
});

const ToolCallCard = memo(function ToolCallCard({
	block,
	view,
	onKillBash,
	wrap = true,
	showImages = true,
	forceOpen = false,
	uiContextToolCall,
	uiToolCardFooter,
	onUiAction,
	rootRef,
}: ToolCallBlockProps & { rootRef: React.RefObject<HTMLDivElement | null> }) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const [open, setOpen] = useState<boolean | null>(null);
	const isPresent = block.name === PRESENT_FILES_TOOL_NAME;
	const expanded = open ?? (isPresent ? true : wrap);
	const shown = expanded || forceOpen;
	const { copied, copy } = useCopyFeedback({ duration: 1200 });

	const running = !view.result && view.streaming && !view.status;
	const isBash = block.name === "bash";
	const isBashRunning = isBash && (running || !view.result);
	const done = view.result !== undefined;
	const waitingModel = !view.result && !!view.status;
	const isError = view.result?.isError ?? view.status?.isError ?? false;

	const outputPreRef = useRef<HTMLPreElement>(null);
	const outputStickRef = useRef(true);

	const rawOutput = useMemo(() => {
		if (!shown) return "";
		return view.result
			? view.result.content.map((b) => (b.type === "text" ? b.text : "")).join("")
			: (view.liveOutput ?? "");
	}, [shown, view.result, view.liveOutput]);

	const output = useMemo(() => {
		if (!shown || !rawOutput) return "";
		return rawOutput.replace(/…\[LIVE_OMIT:(\d+)\]…\n/, (_, n) => t("liveOutputOmitted", { n }));
	}, [shown, rawOutput, t]);

	useEffect(() => {
		if (shown && (running || waitingModel) && outputStickRef.current && outputPreRef.current) {
			outputPreRef.current.scrollTop = outputPreRef.current.scrollHeight;
		}
	}, [shown, output, running, waitingModel]);

	const resultImages = useMemo(() => {
		if (!showImages) return [];
		const content = view.result?.content ?? [];
		return content.filter(
			(b): b is UiImageBlock =>
				b.type === "image" &&
				typeof (b as UiImageBlock).dataUrl === "string" &&
				(((b as UiImageBlock).dataUrl as string).startsWith("data:") ||
					((b as UiImageBlock).dataUrl as string).startsWith("/")),
		);
	}, [showImages, view.result]);

	const isDelegate = block.name === "delegate_task";
	const delegateArgs = useMemo(() => {
		if (!isDelegate || !shown) return {};
		return parseDelegateArgs(block.argumentsText);
	}, [isDelegate, shown, block.argumentsText]);

	const isCodemode = block.name === "codemode";
	const codemodeArgs = useMemo(
		() => (isCodemode && shown ? parseCodemodeArgs(block.argumentsText) : null),
		[isCodemode, shown, block.argumentsText],
	);

	const isQuestionnaire = block.name === "ask_user_question";
	const questionnaireArgs = useMemo(
		() => (isQuestionnaire && shown ? parseQuestionnaireArgs(block.argumentsText) : null),
		[isQuestionnaire, shown, block.argumentsText],
	);

	const isFileChange =
		block.name === "edit" || block.name === "write" || block.name === "edit_soft" || block.name === "patch";

	const fileChangeData = useMemo(() => {
		if (!isFileChange) return null;
		return parseFileMutationArgs(block.name, block.argumentsText, view.result?.details, output);
	}, [isFileChange, block.name, block.argumentsText, view.result?.details, output]);

	const hasImages = resultImages.length > 0;
	const hasMarkdown = useMemo(() => {
		const content = view.result?.content;
		if (!Array.isArray(content)) return false;
		for (const b of content) {
			if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") {
				const str = (b as { text: string }).text;
				if (/(?:```|#\s+|\|\s*[-:]+\s*\|)/m.test(str.slice(0, 500))) return true;
			}
		}
		return false;
	}, [view.result?.content]);

	const presentArgs = useMemo(
		() => (isPresent && shown ? parsePresentArgs(block.argumentsText) : null),
		[isPresent, shown, block.argumentsText],
	);

	const detailsConv =
		isDelegate && view.result && typeof view.result.details === "object" && view.result.details !== null
			? ((view.result.details as Record<string, unknown>).convId as string | undefined)
			: undefined;

	const delegateConvId = useMemo(() => {
		if (!isDelegate) return undefined;
		if (detailsConv) return detailsConv;
		const text = view.result?.content?.[0];
		if (text && typeof text === "object" && "text" in text && typeof (text as { text: unknown }).text === "string") {
			return /sa-[0-9a-f]{8}/.exec((text as { text: string }).text)?.[0];
		}
		return undefined;
	}, [isDelegate, detailsConv, view.result?.content]);

	const durationMsRef = useRef<number | undefined>(undefined);
	const statusDuration = view.status?.durationMs;
	const resultDuration = (view.result as unknown as { durationMs?: number } | undefined)?.durationMs;
	useEffect(() => {
		if (statusDuration !== undefined) durationMsRef.current = statusDuration;
		if (typeof resultDuration === "number") durationMsRef.current = resultDuration;
	}, [statusDuration, resultDuration]);
	const durationMs = typeof resultDuration === "number" ? resultDuration : (statusDuration ?? durationMsRef.current);

	const statusClass = isError ? "err" : done ? "ok" : running || waitingModel ? "run" : "idle";
	let statusLabel = isError
		? t("error")
		: done
			? t("done")
			: running
				? t("running")
				: waitingModel
					? t("toolDoneWaitingModel")
					: t("toolQueued");
	const duration = (waitingModel || done) && durationMs !== undefined ? formatDuration(durationMs) : "";
	if ((waitingModel || done) && duration) statusLabel = `${statusLabel} · ${duration}`;

	const exitHint = waitingModel && view.status?.exitCode !== undefined ? `exit ${view.status.exitCode}` : "";

	const hints = toolArgHints(block.argumentsText);
	const bashCommand = block.name === "bash" ? hints.command : undefined;
	const headline = resolveToolHeadline({
		name: block.name,
		argumentsText: block.argumentsText,
		hints,
		isCollapsed: !shown,
	});
	const inspectorTitle = headline ? `${block.name}(${headline.text})` : `${block.name}()`;

	useToolInspectorLiveSync({
		blockId: block.id,
		view,
		statusClass,
		statusLabel,
		duration,
		durationMs,
		exitHint,
		isError,
		isBash,
		onKillBash,
		t,
	});

	const copyArgs = () => {
		if (block.argumentsText) {
			void copy(block.argumentsText);
		}
	};

	const ctxMenuAvailable = (uiContextToolCall ?? []).some((e) => e && e.hidden !== true && e.kind !== "divider");

	const onHeadContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		const el = e.target;
		if (el instanceof Element && el.closest("pre, code, a, input, textarea, [contenteditable='true']")) return;
		const sel = window.getSelection?.();
		if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;

		const baseEntries = uiContextToolCall ?? [];
		const entries: UiSlotEntry[] = [];
		if (isBash && onKillBash) {
			entries.push(
				createHostSlotEntry({
					id: "host:kill-bash",
					slot: "contextmenu.toolcall",
					label: isZh ? "结束此 bash 命令" : "Stop bash command",
					icon: "■",
					kind: "action",
					order: -1,
					when: isBashRunning ? undefined : ["disabled"],
				}),
			);
		}
		entries.push(...baseEntries);
		if (entries.length === 0) return;

		e.preventDefault();
		e.stopPropagation();
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.toolcall",
			target: { id: block.id, kind: "toolcall", label: block.name },
			entries,
			onHostAction: (entry) => {
				if (entry.id === "host:kill-bash") {
					onKillBash?.();
					return undefined;
				}
				if (entry.id === "host:tool-info") {
					openToolInfo(block.name);
					return undefined;
				}
				onUiAction?.(entry);
				return undefined;
			},
		});
	};

	const isFlow = false;

	const handleOpenInspector = () => {
		const currentRaw = view.result
			? view.result.content.map((b) => (b.type === "text" ? b.text : "")).join("")
			: (view.liveOutput ?? "");
		const currentOutput = currentRaw.replace(/…\[LIVE_OMIT:(\d+)\]…\n/, (_, n) => t("liveOutputOmitted", { n }));

		const currentImages = (view.result?.content ?? [])
			.filter(
				(b): b is UiImageBlock =>
					b.type === "image" &&
					typeof (b as UiImageBlock).dataUrl === "string" &&
					(((b as UiImageBlock).dataUrl as string).startsWith("data:") ||
						((b as UiImageBlock).dataUrl as string).startsWith("/")),
			)
			.map((b) => b.dataUrl as string);

		const currentPresentArgs = isPresent ? parsePresentArgs(block.argumentsText) : null;

		openToolInspector({
			isThinking: false,
			name: block.name,
			title: inspectorTitle,
			status: statusLabel,
			statusClass,
			duration,
			durationMs,
			exitHint,
			hints,
			args: block.argumentsText || "",
			rawOutput: currentRaw,
			output: currentOutput,
			details: view.result?.details,
			images: currentImages,
			isError,
			toolCallId: view.result?.toolCallId ?? block.id,
			resultTimestamp: view.result?.timestamp,
			onKillBash: isBash ? onKillBash : undefined,
			presentData:
				isPresent && currentPresentArgs
					? {
							title: currentPresentArgs.title,
							note: currentPresentArgs.note,
							items: currentPresentArgs.items,
						}
					: null,
		});
	};

	const handleFlowClick = (e?: React.MouseEvent | React.KeyboardEvent) => {
		if (isPresent && !e?.altKey) {
			if (tryOpenPresentPreview(block.argumentsText, view.result?.details)) {
				return;
			}
		}
		handleOpenInspector();
	};

	const handleToggle = () => {
		if (isFlowMode(rootRef.current)) {
			handleFlowClick();
			return;
		}
		setOpen(!expanded);
	};

	return (
		<div
			ref={rootRef}
			className={`toolcall ${statusClass}${resultImages.length > 0 ? " has-images" : ""}`}
			onClick={(e) => {
				if (!isFlowMode(rootRef.current)) return;
				const target = e.target as HTMLElement | null;
				if (
					target?.closest("button, a, .toolcall-kill, .toolcall-open, .toolcall-image, .file-diff-action-btn, .btn-tag")
				) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				handleFlowClick(e);
			}}
		>
			<CollapsibleHead
				open={!isFlow && shown}
				headClassName="toolcall-head"
				toggleClassName="toolcall-toggle"
				titleText={shown ? t("collapseMsg") : t("expandMsg")}
				onToggle={handleToggle}
				onHeadContextMenu={onHeadContextMenu}
				icon={toolIcon(block.name)}
				iconClassName={toolIconClass(block.name)}
				titleClassName="toolcall-name"
				after={
					<>
						<span
							className="toolcall-status"
							title={exitHint ? `${statusLabel} · ${exitHint}` : statusLabel}
							aria-label={exitHint ? `${statusLabel} · ${exitHint}` : statusLabel}
						>
							{isError ? <FiX /> : done ? <FiCheck /> : running || waitingModel ? <HalfRingSpinner /> : <FiMinus />}
						</span>
						{hasImages && (
							<span className="toolcall-out-badge img" title={t("toolImageZoom")} aria-label="image output">
								<FiImage />
							</span>
						)}
						{hasMarkdown && (
							<span
								className="toolcall-out-badge md"
								title={isZh ? "包含 Markdown 输出" : "Contains Markdown output"}
								aria-label="markdown output"
							>
								<FiFileText />
							</span>
						)}
						{duration && (
							<span
								className="toolcall-duration toolcall-timeout"
								style={{ marginLeft: -2, fontFamily: "var(--mono)" }}
								title={exitHint ? `${statusLabel} · ${exitHint}` : statusLabel}
							>
								{duration}
							</span>
						)}
						{headline && (
							<span className={headline.className} title={headline.title ?? headline.text}>
								{headline.prefix}
								{headline.text}
							</span>
						)}
						{fileChangeData && (fileChangeData.stats.additions > 0 || fileChangeData.stats.deletions > 0) && (
							<span
								className="toolcall-diff-badge"
								title={`+${fileChangeData.stats.additions} -${fileChangeData.stats.deletions}`}
							>
								{fileChangeData.stats.additions > 0 && <span className="add">+{fileChangeData.stats.additions}</span>}
								{fileChangeData.stats.deletions > 0 && <span className="del">-{fileChangeData.stats.deletions}</span>}
							</span>
						)}
						{hints.timeout && <span className="toolcall-timeout">⏱ {hints.timeout}</span>}
						<span className="toolcall-spacer" />
						{isBashRunning && onKillBash && (
							<button
								type="button"
								className="toolcall-kill"
								title={t("stopBashTip")}
								onClick={(e) => {
									e.stopPropagation();
									onKillBash?.();
								}}
							>
								<FiSquare />
								<span>{t("stopBash")}</span>
							</button>
						)}
						{isDelegate && done && delegateConvId && (
							<button
								type="button"
								className="toolcall-open"
								title={t("delegateOpenSubagent")}
								onClick={(e) => {
									e.stopPropagation();
									window.dispatchEvent(
										new CustomEvent<string>("pi-web-ui:switch-conversation", { detail: delegateConvId }),
									);
								}}
							>
								<FiArrowRight />
								<span>{t("delegateOpenSubagent")}</span>
							</button>
						)}
						<button
							type="button"
							className={`chead-copy toolcall-copy${copied ? " copied" : ""}`}
							title={t("copyArgs")}
							aria-label={t("copyArgs")}
							onClick={(e) => {
								e.stopPropagation();
								copyArgs();
							}}
						>
							{copied ? <FiCheckCircle /> : <FiCopy />}
						</button>
					</>
				}
			>
				{block.name}
			</CollapsibleHead>
			{resultImages.length > 0 && (
				<div className="toolcall-images">
					{resultImages.map((img, i) => {
						const src = (img.dataUrl as string).startsWith("/")
							? appResourceUrl(img.dataUrl as string)
							: (img.dataUrl as string);
						return (
							<button
								key={i}
								type="button"
								className="toolcall-image"
								title={t("toolImageZoom")}
								aria-label={t("toolImageZoom")}
								onClick={(e) => {
									e.stopPropagation();
									openImageLightbox({ src, alt: `tool result image ${i + 1}` });
								}}
							>
								<img
									crossOrigin={appResourceCrossOrigin(src)}
									src={src}
									loading="lazy"
									decoding="async"
									alt={`tool result image ${i + 1}`}
								/>
							</button>
						);
					})}
				</div>
			)}
			{!isFlow && shown && (
				<div className="toolcall-body">
					{isPresent && presentArgs ? (
						<PresentedFiles
							args={presentArgs}
							details={view.result?.details}
							toolCallId={view.result?.toolCallId ?? block.id}
							resultTimestamp={view.result?.timestamp}
						/>
					) : isDelegate ? (
						<DelegateBrief args={delegateArgs} />
					) : isCodemode && codemodeArgs?.code ? (
						<CodemodeCard
							code={codemodeArgs.code}
							options={codemodeArgs.options}
							details={view.result?.details}
							output={output}
						/>
					) : isQuestionnaire && questionnaireArgs ? (
						<QuestionnaireCard
							questions={questionnaireArgs.questions}
							details={view.result?.details}
							output={output}
							isError={isError}
							waiting={running || waitingModel}
						/>
					) : isFileChange ? (
						<FileChangeCard
							toolName={block.name}
							argumentsText={block.argumentsText}
							details={view.result?.details}
							output={output}
							isError={isError}
							onOpenInspector={handleOpenInspector}
						/>
					) : (
						block.argumentsText && (
							<div className="toolcall-args">
								{bashCommand ? <TerminalCommand command={bashCommand} /> : <pre>{block.argumentsText}</pre>}
							</div>
						)
					)}
					{block.name === "tool_search" && <ToolSearchDetails details={view.result?.details} />}
					{output.length > 0 && !(isQuestionnaire && questionnaireArgs) && (
						<div className="toolcall-output">
							<div className="toolcall-output-label">
								{isError ? t("errorOutput") : t("output")}
								{(running || waitingModel) && <span className="cursor" />}
							</div>
							<pre
								ref={outputPreRef}
								onWheel={(e) => {
									if (e.deltaY < 0) {
										outputStickRef.current = false;
									} else if (e.deltaY > 0 && outputPreRef.current) {
										const el = outputPreRef.current;
										if (el.scrollHeight - el.scrollTop - el.clientHeight < 32) {
											outputStickRef.current = true;
										}
									}
								}}
								onScroll={(e) => {
									const el = e.currentTarget;
									if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) {
										outputStickRef.current = true;
									}
								}}
							>
								{output}
							</pre>
						</div>
					)}
					{running && output.length === 0 && (
						<div className="toolcall-waiting">
							<span className="cursor" /> {t("waitingOutput")}
						</div>
					)}
					{waitingModel && output.length === 0 && (
						<div className="toolcall-waiting">
							<span className="cursor" /> {t("waitingModel")}
						</div>
					)}
					{uiToolCardFooter && uiToolCardFooter.length > 0 && (
						<div className="toolcall-footer">
							{uiToolCardFooter
								.filter((e) => e && e.hidden !== true)
								.map((entry, idx) => {
									const label = entry.label || entry.id;
									if (entry.kind === "badge") {
										return (
											<span key={`${entry.id}#${idx}`} className="toolcall-footer-badge" title={label}>
												{entry.badge ?? label}
											</span>
										);
									}
									return (
										<button
											key={`${entry.id}#${idx}`}
											type="button"
											className="toolcall-footer-item"
											title={label}
											onClick={() => onUiAction?.(entry)}
										>
											{entry.icon && slotIcon(entry.icon)}
											<span>{label}</span>
										</button>
									);
								})}
						</div>
					)}
				</div>
			)}
		</div>
	);
});

export const ToolCallBlock = memo(function ToolCallBlock(props: ToolCallBlockProps) {
	const rootRef = useRef<HTMLDivElement>(null);
	const isFlow = isFlowMode(rootRef.current);

	if (isFlow) {
		return (
			<ToolCallCapsule
				block={props.block}
				view={props.view}
				onKillBash={props.onKillBash}
				uiContextToolCall={props.uiContextToolCall}
				onUiAction={props.onUiAction}
				rootRef={rootRef}
			/>
		);
	}
	return <ToolCallCard {...props} rootRef={rootRef} />;
});

export function TerminalCommand({ command }: { command: string }) {
	return (
		<div className="termline">
			<FiTerminal className="termline-icon" />
			<code>{renderHighlightedCommand(command)}</code>
		</div>
	);
}

export function ToolSearchDetails({ details }: { details?: unknown }) {
	const t = useT();
	const loaded = Array.isArray((details as { loaded?: unknown })?.loaded)
		? (details as { loaded: string[] }).loaded
		: [];
	if (loaded.length === 0) return null;
	return (
		<div className="tool-search-loaded-box">
			<span className="tool-search-loaded-label">{t("toolSearchLoaded")}:</span>
			<div className="tool-search-tags">
				{loaded.map((toolName) => (
					<span key={toolName} className="tool-search-tag">
						{toolName}
					</span>
				))}
			</div>
		</div>
	);
}

export function DelegateBrief({ args }: { args: Partial<Record<DelegateField | "agent" | "model", string>> }) {
	const t = useT();
	const sections: { field: DelegateField; label: string }[] = [
		{ field: "task", label: t("delegateSecTask") },
		{ field: "expected_outcome", label: t("delegateSecExpected") },
		{ field: "required_tools", label: t("delegateSecTools") },
		{ field: "must_do", label: t("delegateSecMustDo") },
		{ field: "must_not_do", label: t("delegateSecMustNotDo") },
		{ field: "context", label: t("delegateSecContext") },
	];
	const shown = sections.filter(({ field }) => args[field]?.trim());
	if (shown.length === 0) return null;
	return (
		<div className="delegate-brief">
			{shown.map(({ field, label }) => (
				<div className="delegate-sec" key={field}>
					<div className="delegate-sec-label">{label}</div>
					<div className="delegate-sec-text">{args[field]}</div>
				</div>
			))}
		</div>
	);
}

interface CodemodeCallItem {
	id: string;
	name: string;
	args?: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
}

export function CodemodeCard({
	code,
	options,
	details,
	output,
}: {
	code: string;
	options?: Record<string, unknown>;
	details?: unknown;
	output?: string;
}) {
	const t = useT();
	const callDetails = details as { calls?: CodemodeCallItem[]; fullOutputPath?: string } | undefined;
	const calls = Array.isArray(callDetails?.calls) ? callDetails.calls : [];
	const fullOutputPath = typeof callDetails?.fullOutputPath === "string" ? callDetails.fullOutputPath : undefined;

	const savedImages = useMemo(() => {
		if (!output) return [];
		const regex = /\[Image saved to (.*?) \((.*?)\)\]/g;
		const list: { path: string; info: string }[] = [];
		let match: RegExpExecArray | null;
		while ((match = regex.exec(output)) !== null) {
			list.push({ path: match[1], info: match[2] });
		}
		return list;
	}, [output]);

	return (
		<div className="codemode-card">
			<div className="codemode-sec">
				<div className="codemode-sec-head">
					<span className="codemode-sec-title">{t("codemodeScript")}</span>
					{options && Object.keys(options).length > 0 && (
						<span className="codemode-options-badge">{JSON.stringify(options)}</span>
					)}
				</div>
				<pre className="codemode-code">
					<code>{code}</code>
				</pre>
			</div>

			{calls.length > 0 && (
				<div className="codemode-sec codemode-calls-sec">
					<div className="codemode-sec-head">
						<span className="codemode-sec-title">{t("codemodeNestedCalls")}</span>
						<span className="codemode-count-badge">{calls.length}</span>
					</div>
					<div className="codemode-calls-list">
						{calls.map((c, idx) => (
							<div key={c.id || idx} className={`codemode-call-item status-${c.status}`}>
								<span className="codemode-call-status">
									{c.status === "ok" ? "✓" : c.status === "error" ? "✗" : c.status === "running" ? "…" : "⊘"}
								</span>
								<span className="codemode-call-name">{c.name}</span>
								{c.args && <span className="codemode-call-args">{c.args}</span>}
								{typeof c.durationMs === "number" && (
									<span className="codemode-call-duration">{formatDuration(c.durationMs)}</span>
								)}
								{c.error && <div className="codemode-call-error">{c.error}</div>}
							</div>
						))}
					</div>
				</div>
			)}

			{savedImages.length > 0 && (
				<div className="codemode-sec codemode-images-sec">
					<div className="codemode-sec-head">
						<span className="codemode-sec-title">{t("codemodeSavedImages")}</span>
						<span className="codemode-count-badge">{savedImages.length}</span>
					</div>
					<div className="codemode-images-list">
						{savedImages.map((img, idx) => (
							<div key={idx} className="codemode-image-item">
								<FiImage className="codemode-image-icon" />
								<code className="codemode-image-path" title={img.path}>
									{img.path}
								</code>
								<span className="codemode-image-info">{img.info}</span>
								<button
									type="button"
									className="btn-ghost codemode-image-copy"
									title={t("copy")}
									onClick={(e) => {
										e.stopPropagation();
										void navigator.clipboard.writeText(img.path);
									}}
								>
									<FiCopy />
								</button>
							</div>
						))}
					</div>
				</div>
			)}

			{fullOutputPath && (
				<div className="codemode-full-output">
					<span className="codemode-sec-title">{t("codemodeFullOutput")}:</span>
					<code>{fullOutputPath}</code>
				</div>
			)}
		</div>
	);
}

export function formatDuration(ms?: number): string {
	if (ms === undefined || ms < 0 || !Number.isFinite(ms)) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec % 60);
	return `${m}m ${String(s).padStart(2, "0")}s`;
}
