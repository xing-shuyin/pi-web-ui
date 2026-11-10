import { useCallback, useEffect, useRef, useState } from "react";
import { FiCheck, FiCheckCircle, FiClock, FiCopy, FiCpu } from "react-icons/fi";
import { useT } from "../i18n";
import { useCopyFeedback } from "../use-copy-feedback";
import {
	getToolInspectorState,
	isFlowMode,
	openToolInspector,
	retargetToolInspector,
	updateToolInspectorLive,
	type ToolInspectorState,
} from "../tool-inspector-state";
import { CollapsibleHead } from "./CollapsibleHead";
import { HalfRingSpinner } from "./HalfRingSpinner";
import { useSmoothStreamText } from "./StreamMarkdown";
import { formatDuration, formatTimeFull, resolveThinkingTimeRange } from "../tool-time";

const MAX_PREVIEW_LEN = 300;

function stripLeadingGenericHeader(thinking: string): string {
	const lines = thinking.split("\n");
	let startIdx = 0;
	while (startIdx < lines.length) {
		const line = lines[startIdx].trim();
		if (!line) {
			startIdx++;
			continue;
		}
		const stripped = line.replace(/^[#*>\s]+/, "").toLowerCase();
		if (
			stripped === "thinking" ||
			stripped === "thinking:" ||
			stripped === "thinking process" ||
			stripped === "thinking process:" ||
			stripped === "思考" ||
			stripped === "思考过程" ||
			stripped === "思考过程：" ||
			stripped === "思路" ||
			stripped === "思路："
		) {
			startIdx++;
			continue;
		}
		break;
	}
	return lines.slice(startIdx).join("\n");
}

export function stripThinkingMarkers(text: string): string {
	if (!text || !text.includes("[[")) return text;
	return text
		.replace(/\[\[(?:conv|todo|action|suggest|notify|goal):[\s\S]*?\]\]/gu, "")
		.replace(/\[\[(?:conv|todo|action|suggest|notify|goal):[^\]]*$/u, "");
}

export function formatThinkingBody(thinking: string): string {
	const cleaned = stripThinkingMarkers(thinking);
	const normalized = cleaned.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
	const body = stripLeadingGenericHeader(normalized).trim();
	const source = body || normalized.trim();
	if (!source) return "";
	return source.replace(/\n{3,}/g, "\n\n");
}

export function flattenThinkingText(thinking: string): string {
	const cleaned = stripThinkingMarkers(thinking);
	const body = stripLeadingGenericHeader(cleaned).trim();
	const source = body || cleaned.trim();
	if (!source) return "";
	return source
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" ");
}

export function thinkingPreview(thinking: string, streaming?: boolean): string {
	const flat = flattenThinkingText(thinking);
	if (!flat) return "";
	return streaming ? flat.slice(-MAX_PREVIEW_LEN) : flat.slice(0, MAX_PREVIEW_LEN);
}

interface ThinkingBlockProps {
	thinking: string;
	streaming?: boolean;
	wrap?: boolean;
	forceOpen?: boolean;
	startTimestamp?: number;
	endTimestamp?: number;
	durationMs?: number;
	thinkingId?: string;
}

export function ThinkingBlock({
	thinking,
	streaming,
	wrap = true,
	forceOpen = false,
	startTimestamp,
	endTimestamp,
	durationMs: durationMsProp,
	thinkingId,
}: ThinkingBlockProps) {
	const t = useT();
	const [open, setOpen] = useState<boolean | null>(null);
	const expanded = open ?? wrap;
	const shown = expanded || forceOpen;

	const live = !!streaming;
	const liveRef = useRef(live);
	liveRef.current = live;
	const isHidden = () => typeof document !== "undefined" && document.hidden;
	const [draining, setDraining] = useState(() => live && !isHidden());
	useEffect(() => {
		if (live && !isHidden()) setDraining(true);
		else if (!live && isHidden()) setDraining(false);
	}, [live]);
	useEffect(() => {
		if (typeof document === "undefined") return;
		const onVis = () => {
			if (!liveRef.current) setDraining(false);
		};
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, []);
	const handleStreamSettled = useCallback(() => {
		if (!liveRef.current) setDraining(false);
	}, []);
	const activeStream = live || draining;

	const displayedThinking = useSmoothStreamText(thinking, activeStream, !live && draining, handleStreamSettled);
	const bodyText = formatThinkingBody(displayedThinking);
	const preview = thinkingPreview(displayedThinking, activeStream);
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	const copyThinking = () => {
		void copy(thinking);
	};

	const headTitle = shown ? t("collapseMsg") : preview ? `${t("expandMsg")} · ${preview}` : t("expandMsg");

	const rootRef = useRef<HTMLDivElement>(null);
	const isFlow = isFlowMode(rootRef.current);

	const timeRange = resolveThinkingTimeRange(
		startTimestamp,
		durationMsProp ??
			(endTimestamp !== undefined && startTimestamp !== undefined ? endTimestamp - startTimestamp : undefined),
	);
	const displayDuration = timeRange.durationMs !== undefined ? formatDuration(timeRange.durationMs) : "";
	// 流式思考：用本地 tick 显示已用时长（开始时间来自父消息 timestamp）
	const [nowTick, setNowTick] = useState(() => Date.now());
	useEffect(() => {
		if (!activeStream || timeRange.start === undefined) return;
		const id = window.setInterval(() => setNowTick(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [activeStream, timeRange.start]);
	const liveElapsed =
		activeStream && timeRange.start !== undefined ? Math.max(0, nowTick - timeRange.start) : undefined;

	const settledStatus = displayDuration ? `${t("done")} (${displayDuration})` : t("done");
	const livePatch: Partial<ToolInspectorState> = {
		status: activeStream ? t("thinkingNow") : settledStatus,
		statusClass: activeStream ? "run" : "ok",
		duration: displayDuration,
		durationMs: timeRange.durationMs,
		startTimestamp: timeRange.start,
		endTimestamp: timeRange.end,
		output: bodyText || thinking,
		thinking: displayedThinking || thinking,
		streaming: activeStream,
	};
	const livePatchRef = useRef(livePatch);
	livePatchRef.current = livePatch;
	const settledStatusRef = useRef(settledStatus);
	settledStatusRef.current = settledStatus;
	const rawThinkingRef = useRef(thinking);
	rawThinkingRef.current = thinking;
	// 本实例用过的 thinkingId：流式消息落地成持久消息时 message.id 会换壳
	const thinkingIdsRef = useRef<Set<string>>(new Set<string>());
	if (thinkingId) thinkingIdsRef.current.add(thinkingId);

	const handleOpenInspector = () => {
		openToolInspector({
			isThinking: true,
			title: t("toolInspectorThinkingTitle"),
			...livePatch,
			toolCallId: thinkingId,
		});
	};

	// 思考弹窗打开后跟随流式增量。只接管属于自己这条思考的弹窗：
	// 1) id 相同；2) 同一实例自己换过壳的旧 id；3) 同一条思考的续写（弹窗内容是自己内容的前缀）。
	useEffect(() => {
		if (!thinkingId) return;
		const cur = getToolInspectorState();
		if (!cur || !cur.isThinking) return;
		const popupId = cur.toolCallId;
		if (!popupId) return;
		if (popupId !== thinkingId) {
			const shown = formatThinkingBody(cur.thinking || cur.output || "");
			const mine = bodyText || thinking;
			const continues = !!shown && mine.startsWith(shown);
			if (!thinkingIdsRef.current.has(popupId) && !continues) return;
			retargetToolInspector(popupId, thinkingId);
		}
		updateToolInspectorLive(thinkingId, livePatchRef.current, "thinking");
	}, [
		thinkingId,
		displayedThinking,
		bodyText,
		thinking,
		activeStream,
		displayDuration,
		timeRange.start,
		timeRange.end,
		timeRange.durationMs,
		t,
	]);

	// 折叠 / 虚拟化 / 换壳把本实例卸载时，别让弹窗永远停在「思考中」
	useEffect(() => {
		return () => {
			const cur = getToolInspectorState();
			if (!cur || !cur.isThinking || !cur.streaming) return;
			const popupId = cur.toolCallId;
			if (!popupId || !thinkingIdsRef.current.has(popupId)) return;
			const settledText = formatThinkingBody(rawThinkingRef.current);
			updateToolInspectorLive(
				popupId,
				{
					...livePatchRef.current,
					thinking: rawThinkingRef.current || livePatchRef.current.thinking,
					output: settledText || livePatchRef.current.output,
					status: settledStatusRef.current,
					statusClass: "ok",
					streaming: false,
				},
				"thinking",
			);
		};
	}, []);

	const handleToggle = () => {
		if (isFlowMode(rootRef.current)) {
			handleOpenInspector();
			return;
		}
		setOpen(!expanded);
	};

	if (isFlow) {
		return (
			<div
				ref={rootRef}
				className={`thinking ${activeStream ? "live run" : "ok"}`}
				data-thinking={thinking}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					handleOpenInspector();
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						handleOpenInspector();
					}
				}}
				role="button"
				tabIndex={0}
				title={t("toolInspectorThinkingTitle")}
			>
				<div className="thinking-head chead">
					<span className="thinking-icon chead-icon">
						<FiCpu />
					</span>
					<span className="thinking-name chead-title">{t("thinking")}</span>
					<span
						className="thinking-status toolcall-status"
						title={activeStream ? t("thinkingNow") : t("done")}
						aria-label={activeStream ? t("thinkingNow") : t("done")}
					>
						{activeStream ? <HalfRingSpinner className="spin" /> : <FiCheck />}
					</span>
				</div>
			</div>
		);
	}

	return (
		<div
			ref={rootRef}
			className={`thinking ${shown ? "open" : ""} ${activeStream ? "live" : ""} ${activeStream ? "run" : "ok"}`}
			data-thinking={thinking}
			onClick={(e) => {
				if (!isFlowMode(rootRef.current)) return;
				const target = e.target as HTMLElement | null;
				if (target?.closest(".chead-copy, .toolcall-copy, .thinking-copy, a")) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				handleOpenInspector();
			}}
		>
			<CollapsibleHead
				open={!isFlow && shown}
				headClassName={`thinking-head${activeStream ? " thinking-live" : ""}`}
				toggleClassName="thinking-toggle"
				titleText={headTitle}
				onToggle={handleToggle}
				icon={<FiCpu />}
				iconClassName="thinking-icon"
				titleClassName="thinking-label"
				after={
					<>
						<span
							className="thinking-status toolcall-status"
							title={activeStream ? t("thinkingNow") : t("done")}
							aria-label={activeStream ? t("thinkingNow") : t("done")}
						>
							{activeStream ? <HalfRingSpinner className="spin" /> : <FiCheck />}
						</span>
						<button
							type="button"
							className={`chead-copy toolcall-copy thinking-copy${copied ? " copied" : ""}`}
							title={copied ? t("copied") : t("copyMessage")}
							aria-label={t("copyMessage")}
							onClick={(e) => {
								e.stopPropagation();
								copyThinking();
							}}
						>
							{copied ? <FiCheckCircle /> : <FiCopy />}
						</button>
					</>
				}
			>
				{activeStream && shown ? (
					<span className="thinking-live-label">
						{t("thinkingNow")}
						<span className="dots" />
					</span>
				) : activeStream ? (
					preview ? (
						<span className="thinking-preview-live">
							<span className="thinking-preview-viewport">
								<span className="thinking-preview-track">
									{preview}
									<span className="stream-cursor" />
								</span>
							</span>
						</span>
					) : (
						<span className="thinking-live-label">
							{t("thinkingNow")}
							<span className="dots" />
						</span>
					)
				) : preview ? (
					<span className="thinking-summary-text">{preview}</span>
				) : null}
			</CollapsibleHead>
			{!isFlow && shown && (
				<>
					<div className="thinking-body">
						{bodyText}
						{activeStream && <span className="stream-cursor" />}
					</div>
					<div className="toolcall-time-footer thinking-time-footer">
						<FiClock className="toolcall-time-icon" />
						<span className="toolcall-time-text">
							{timeRange.start !== undefined && timeRange.end !== undefined && timeRange.durationMs !== undefined
								? t("toolTimeRange", {
										start: formatTimeFull(timeRange.start),
										end: formatTimeFull(timeRange.end),
										duration: formatDuration(timeRange.durationMs),
									})
								: activeStream && timeRange.start !== undefined && liveElapsed !== undefined
									? t("toolTimeRunning", {
											start: formatTimeFull(timeRange.start),
											duration: formatDuration(liveElapsed),
										})
									: timeRange.start !== undefined
										? formatTimeFull(timeRange.start)
										: ""}
						</span>
					</div>
				</>
			)}
		</div>
	);
}
