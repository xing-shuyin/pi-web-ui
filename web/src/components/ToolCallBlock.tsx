import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { appUrl } from "../base-url";
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
// 工具定义说明弹窗（模块级 store：卡片只负责发打开请求，弹窗挂在 App 上）。
import { openToolInfo } from "../tool-info-state";
import { isFlowMode, openToolInspector } from "../tool-inspector-state";
import { CollapsibleHead } from "./CollapsibleHead";
import { HalfRingSpinner } from "./HalfRingSpinner";
import { slotIcon } from "./Message";
import type { UiSlotEntry } from "../ui-slots";
import {
	parseCodemodeArgs,
	parseDelegateArgs,
	parseQuestionnaireArgs,
	shortenPath,
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

export interface ToolView {
	/** Tool result message if the tool already finished. */
	result?: UiMessage;
	/** Live output accumulated from tool_delta while running. */
	liveOutput?: string;
	/** True when the session is streaming (tool may still be running). */
	streaming: boolean;
	/** Set the moment tool_execution_end fires (tool_status) — the command
	 *  exited but the model hasn't responded yet. */
	status?: ToolStatus;
}

/** Kill just the running bash command(s) — the agent run itself continues. */
type KillBashHandler = () => void;

/** 模块级静态工具图标节点表：整个生命周期仅创建一次，O(1) 查表复用引用，零 GC 与重排开销。 */
const TOOL_ICONS: Record<string, ReactNode> = {
	bash: <FiTerminal />,
	delegate_task: <FiLayers />,
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

/** 模块级静态工具色系分类表：预拼好 className 字符串，渲染期 O(1) 查表零分配。 */
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
	/** Kill the running bash command (bash cards only, while running). */
	onKillBash?: KillBashHandler;
	/** 设置面板「完整显示工具」开关：true（开）→ 工具始终完整展开；
	 *  false（关）→ 默认折叠，点击展开。 */
	wrap?: boolean;
	/** 设置面板「直接显示工具结果图片」开关：false → 不渲染缩略图
	 *  （快照仍带图；纯展示门，服务端不做开关分支）。 */
	showImages?: boolean;
	/** 会话内搜索打开时强制展开（折叠内容不在 DOM，搜索索引搜到的词会
	 *  “展开后看不到”——见 ThinkingBlock.forceOpen）。 */
	forceOpen?: boolean;
	/** `contextmenu.toolcall` 槽位的最终条目（宿主用 buildUiSlots 算好）：右键**卡头**
	 *  （工具名那一行）时弹宿主唯一的右键菜单。宿主内置的 `host:tool-info` 由本组件
	 *  自己分派（打开定义弹窗），其余条目交回 onUiAction（插件动作）。 */
	uiContextToolCall?: UiSlotEntry[];
	/** 工具卡底部操作条目（tool.card.footer 槽位）。 */
	uiToolCardFooter?: UiSlotEntry[];
	/** 插件条目的动作分发（view 切视图 / action 交给插件）。 */
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
}

/** 极简行文（Flow）模式下尝试直接打开 present_files 的首选预览项，返回是否成功受理。 */
function tryOpenPresentPreview(argumentsText: string | undefined, details: unknown): boolean {
	const args = parsePresentArgs(argumentsText);
	if (!args) return false;
	const items = presentCardItems(args, details);
	const target = primaryPreviewItem(items);
	if (!target) return false;
	return openFilePreview({ path: target.target, name: target.name });
}

/** 极简行文模式（Flow 模式）纯净轻量微胶囊外壳：零多余 DOM，点击按需提取数据并弹出居中检查器 */
const ToolCallCapsule = memo(function ToolCallCapsule({
	block,
	view,
	uiContextToolCall,
	onUiAction,
	rootRef,
}: {
	block: UiToolCallBlock;
	view: ToolView;
	uiContextToolCall?: UiSlotEntry[];
	onUiAction?: (item: UiSlotEntry, value?: string) => void;
	rootRef: React.RefObject<HTMLDivElement | null>;
}) {
	const t = useT();
	const isZh = isZhLocale(useLocale());
	const isPresent = block.name === PRESENT_FILES_TOOL_NAME;

	const running = !view.result && view.streaming && !view.status;
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
	const isSkill = block.name === "skill";

	// 轻量检查输出类型（图片/Markdown），无需在每帧拼接和正则数万字的长文本
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

	const ctxMenuAvailable = (uiContextToolCall ?? []).some((e) => e && e.hidden !== true && e.kind !== "divider");

	const onHeadContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		if (!ctxMenuAvailable) return;
		e.preventDefault();
		e.stopPropagation();
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.toolcall",
			target: { id: block.id, kind: "toolcall", label: block.name },
			entries: uiContextToolCall ?? [],
			onHostAction: (entry) => {
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
		// 点击时按需提取并组装输出与参数，未点击时零多余开销
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
		const inspectorTitle = isSkill && hints.skillName ? `skill(${hints.skillName})` : `${block.name}()`;

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
		// 极简行文模式下，present_files 点击优先直接显示文件预览；按住 Alt 时仍可强制打开检查器
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
			title={
				isSkill && hints.skillName ? `skill(${hints.skillName}) · ${statusLabel}` : `${block.name}() · ${statusLabel}`
			}
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
	// null = 未手动点过 → 跟随开关：wrap=true（开）→ 全部展开；wrap=false（关）→ 全部折叠。
	// 与 ThinkingBlock 一致——开关切换时自动折叠/展开所有未手动点过的工具。
	// 例外：present_files（展示文件）默认展开——它的正文就是内容本身（图片/视频
	// 在折叠态下等于没展示），折叠开关的意图不是「把卡片藏起来」。
	const [open, setOpen] = useState<boolean | null>(null);
	const isPresent = block.name === PRESENT_FILES_TOOL_NAME;
	const expanded = open ?? (isPresent ? true : wrap);
	// 搜索期间 forceOpen 只是“视口展开”，用户 open 状态不受影响
	const shown = expanded || forceOpen;
	const { copied, copy } = useCopyFeedback({ duration: 1200 });

	const running = !view.result && view.streaming && !view.status;
	const isBashRunning = block.name === "bash" && running;
	const done = view.result !== undefined;
	/** Command finished (tool_status fired) but the authoritative toolResult
	 *  message hasn't landed in a snapshot yet — the model is still chewing on
	 *  the result. */
	const waitingModel = !view.result && !!view.status;
	const isError = view.result?.isError ?? view.status?.isError ?? false;

	const outputPreRef = useRef<HTMLPreElement>(null);
	const outputStickRef = useRef(true);

	// 惰性求值：仅在展开态（shown）时才拼接与正则大输出文本，折叠态零开销
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

	/** 工具结果里的图片（web_shot 截图、read 读到的图……）：开关开着就在卡片里
	 *  直接出缩略图（折叠态也可见 —— 「直接显示出来」），点击进灯箱看大图。
	 *  支持 data: 内联图与 CAS 附件短 URL（/api/attachment/）。 */
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

	const [zoomed, setZoomed] = useState<string | null>(null);
	useEffect(() => {
		if (!zoomed) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setZoomed(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [zoomed]);

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

	// 展示文件卡片：参数（路径清单）在流式期间可能是半截 JSON，解析失败就回落到原文展示
	const hasImages = resultImages.length > 0;
	// 轻量探测 Markdown 特征，避免全文本正则扫描
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

	// 跳到子代理对话：首选结果 details 里的 convId（服务端拼装时写入）
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

	// 记录工具执行耗时：
	// 1. 优先取 view.result?.durationMs（若服务端在 toolResult 消息上附带了耗时）
	// 2. 其次取 view.status?.durationMs（流式阶段 tool_status 事件带回的实时耗时）
	// 3. 用 ref 缓存曾经捕获到的 durationMs，确保 status 被 prune 或状态切到 done 后耗时不丢失
	const durationMsRef = useRef<number | undefined>(undefined);
	const statusDuration = view.status?.durationMs;
	const resultDuration = (view.result as unknown as { durationMs?: number } | undefined)?.durationMs;
	// 审查 #7：ref 缓存改在 effect 里写入 —— 渲染期写 ref 在并发渲染下时序不可靠，
	// 提交后再写保证与真实提交内容一致。
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

	// tool_status doesn't carry the exit code for successful bash runs (only
	// failures embed "exited with code N" in the error text); show it when known.
	const exitHint = waitingModel && view.status?.exitCode !== undefined ? `exit ${view.status.exitCode}` : "";

	// 卡头右侧提示：任何工具都从参数里安全取路径/超时（AI 填错也只是不显示，见
	// tool-args.ts）；bash 类的命令行给正文的终端行，折叠时卡头跟一小段预览。
	// delegate_task 额外取 agent 名。
	const hints = toolArgHints(block.argumentsText);
	const bashCommand = block.name === "bash" ? hints.command : undefined;
	// 折叠预览：只取首行（空白压成单空格），80 字截断；多行折成 +N 后缀。
	// 完整命令放 title 悬浮里；展开时正文有完整终端行，这里不再显示。
	const collapsedCmd = !shown && bashCommand ? collapsedBashPreview(bashCommand) : undefined;

	const copyArgs = () => {
		if (block.argumentsText) {
			void copy(block.argumentsText);
		}
	};

	/** 该槽位当前有没有可显示的东西：一条都没有就别抢浏览器菜单（同 Message.tsx 的口径：
	 *  hidden 跳过、divider 不算内容）。 */
	const ctxMenuAvailable = (uiContextToolCall ?? []).some((e) => e && e.hidden !== true && e.kind !== "divider");

	/**
	 * 右键**卡头**（工具名那一行）→ 宿主的通用右键菜单（contextmenu.toolcall 槽位）。
	 *
	 * 与 Message.tsx 的右键消息同款取舍：
	 *  1. 点在 `pre` / `code` / `a` / `input` / `textarea` / contenteditable 上 —— 让浏览器菜单
	 *     干活（复制代码、打开链接、系统粘贴），抢了是净损失（卡头里没有这些，但卡头是
	 *     整张卡的一部分，展开后正文就在下方，保险起见仍然判一下）。
	 *  2. 页面里已有选中文本 —— 用户正在选字准备复制，此时右键的意图是复制/搜索。
	 *  3. 该槽位没有可用条目 —— 没有菜单可给，就别 preventDefault。
	 * 其余情况 preventDefault + stopPropagation：工具卡自己的菜单优先，且不让事件冒到
	 * 整条消息的右键处理上（否则会又弹一个消息菜单把它顶掉）。
	 */
	const onHeadContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
		if (!ctxMenuAvailable) return;
		const el = e.target;
		if (el instanceof Element && el.closest("pre, code, a, input, textarea, [contenteditable='true']")) return;
		const sel = window.getSelection?.();
		if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
		e.preventDefault();
		e.stopPropagation();
		openContextMenu({
			x: e.clientX,
			y: e.clientY,
			slot: "contextmenu.toolcall",
			// target.id = 本次工具调用的 toolCallId（菜单条目的分派要靠它认工具）。
			target: { id: block.id, kind: "toolcall", label: block.name },
			entries: uiContextToolCall ?? [],
			// 宿主内置条目的分派器：工具名只有本组件知道，App 只知道插件动作。
			onHostAction: (entry) => {
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
		// 点击时按需提取并组装输出与参数，未点击时零多余开销
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
		const isSkill = block.name === "skill";
		const inspectorTitle = isSkill && hints.skillName ? `skill(${hints.skillName})` : `${block.name}()`;

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
				if (target?.closest(".toolcall-kill, .toolcall-open, button.toolcall-image, .toolcall-image, a")) {
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
						{collapsedCmd && (
							<span className="toolcall-cmd" title={bashCommand}>
								$ {collapsedCmd}
							</span>
						)}
						{hints.path && (
							<span className="toolcall-path" title={hints.path}>
								{shortenPath(hints.path)}
							</span>
						)}
						{hints.codeLines && (
							<span className="toolcall-timeout" title={`${hints.codeLines} lines`}>
								λ {hints.codeLines}L
							</span>
						)}
						{hints.query && block.name === "tool_search" && (
							<span className="toolcall-query" title={hints.query}>
								{hints.query}
							</span>
						)}
						{hints.questionTitle && isQuestionnaire && (
							<span className="toolcall-query" title={hints.questionTitle}>
								{hints.questionTitle}
							</span>
						)}
						{hints.timeout && <span className="toolcall-timeout">⏱ {hints.timeout}</span>}
						{isDelegate && hints.agent && (
							<span className="toolcall-agent" title={hints.agent}>
								◈ {hints.agent}
							</span>
						)}
						{block.name === "skill" && hints.skillName && (
							<span className="toolcall-skill" title={hints.skillName}>
								{hints.skillName}
							</span>
						)}
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
						{/* 卡头右端**只有复制键**：消息级按钮一律落在消息底部的 .msg-actions 行
				    （纯工具调用的消息没有正文，不渲染那一行）。 */}
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
							? appUrl(img.dataUrl as string)
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
									setZoomed(src);
								}}
							>
								<img src={src} loading="lazy" decoding="async" alt={`tool result image ${i + 1}`} />
							</button>
						);
					})}
				</div>
			)}
			{zoomed &&
				createPortal(
					<div className="img-lightbox" role="dialog" aria-label={t("toolImageZoom")} onClick={() => setZoomed(null)}>
						<button
							type="button"
							className="img-lightbox-close"
							title={t("close")}
							aria-label={t("close")}
							onClick={(e) => {
								e.stopPropagation();
								setZoomed(null);
							}}
						>
							<FiX />
						</button>
						<img src={zoomed} alt="tool result preview" />
					</div>,
					document.body,
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
				uiContextToolCall={props.uiContextToolCall}
				onUiAction={props.onUiAction}
				rootRef={rootRef}
			/>
		);
	}
	return <ToolCallCard {...props} rootRef={rootRef} />;
});

/** Pretty-print a bash tool call's command line as a terminal row. */
export function TerminalCommand({ command }: { command: string }) {
	return (
		<div className="termline">
			<FiTerminal className="termline-icon" />
			<code>{renderHighlightedCommand(command)}</code>
		</div>
	);
}

/** tool_search 结果展示：已被 BM25 检索并加载激活的工具名徽标列表 */
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

/** 派单卡片正文：六段式结构化展示（只渲染非空段；脏参数解析出空对象时回落原文）。 */
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

/** codemode 卡片正文：JavaScript 源码高亮 + 嵌套工具调用列表 + 选项标记 */
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

	// 识别 codemode 脚本输出中保存的图片：[Image saved to <path> (<mimeType>, <size>)]
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

/** 折叠态 bash 命令预览：首行空白归一后取 80 字，多行追加 `+N` 后缀。
 *  输入脏（空串/全空白）返回 undefined——卡头不显示。 */
function collapsedBashPreview(command: string): string | undefined {
	const lines = command.split("\n");
	const first = lines[0].replace(/\s+/g, " ").trim();
	if (!first) return undefined;
	const rest = lines.length - 1;
	const short = first.length > 80 ? `${first.slice(0, 80)}…` : first;
	return rest > 0 ? `${short} +${rest}` : short;
}

/** "45ms" / "1.2s" / "1m 05s" — for tool execution duration. */
export function formatDuration(ms?: number): string {
	if (ms === undefined || ms < 0 || !Number.isFinite(ms)) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec % 60);
	return `${m}m ${String(s).padStart(2, "0")}s`;
}
