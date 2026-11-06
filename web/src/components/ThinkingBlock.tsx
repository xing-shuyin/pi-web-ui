import { useCallback, useEffect, useRef, useState } from "react";
import { FiCheck, FiCheckCircle, FiCopy, FiCpu } from "react-icons/fi";
import { useT } from "../i18n";
import { useCopyFeedback } from "../use-copy-feedback";
import { isFlowMode, openToolInspector } from "../tool-inspector-state";
import { CollapsibleHead } from "./CollapsibleHead";
import { HalfRingSpinner } from "./HalfRingSpinner";
import { useSmoothStreamText } from "./StreamMarkdown";

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
}

export function ThinkingBlock({ thinking, streaming, wrap = true, forceOpen = false }: ThinkingBlockProps) {
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

	const handleOpenInspector = () => {
		openToolInspector({
			isThinking: true,
			title: t("toolInspectorThinkingTitle"),
			status: activeStream ? t("thinkingNow") : t("done"),
			statusClass: activeStream ? "run" : "ok",
			output: bodyText || thinking,
			thinking,
			streaming: activeStream,
		});
	};

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
					<span className="thinking-name chead-title">think</span>
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
				<span className="thinking-name">think</span>
				{activeStream && shown ? (
					<span className="thinking-live-label">
						{t("thinkingNow")}
						<span className="dots" />
					</span>
				) : activeStream ? (
					preview ? (
						<span className="thinking-preview-live">
							<span className="thinking-preview-prefix"> · </span>
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
					<span className="thinking-summary-text"> · {preview}</span>
				) : null}
			</CollapsibleHead>
			{!isFlow && shown && (
				<div className="thinking-body">
					{bodyText}
					{activeStream && <span className="stream-cursor" />}
				</div>
			)}
		</div>
	);
}
