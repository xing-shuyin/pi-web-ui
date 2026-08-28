import { memo, useState } from "react";
import {
	FiCheckCircle,
	FiChevronDown,
	FiChevronRight,
	FiCopy,
	FiSquare,
	FiTerminal,
} from "react-icons/fi";
import type { ToolStatus, UiMessage, UiToolCallBlock } from "../types";
import { useT } from "../i18n";
import { Markdown } from "./Markdown";

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
export type KillBashHandler = () => void;

const TOOL_ICONS: Record<string, string> = {
	bash: "$",
	read: "📄",
	write: "✍️",
	edit: "✏️",
	grep: "🔍",
	find: "🧭",
	ls: "📂",
};

function toolIcon(name: string): string {
	return TOOL_ICONS[name] ?? "🛠";
}

/** True when this is a `read` tool call whose target path is a Markdown
 *  file — its output reads much better rendered than as a raw <pre> dump. */
function isMarkdownReadTarget(block: UiToolCallBlock): boolean {
	if (block.name !== "read" || !block.argumentsText) return false;
	try {
		const args = JSON.parse(block.argumentsText) as { path?: unknown };
		return (
			typeof args.path === "string" && /\.(md|markdown)$/i.test(args.path)
		);
	} catch {
		return false;
	}
}

export const ToolCallBlock = memo(function ToolCallBlock({
	block,
	view,
	onKillBash,
	wrap = true,
}: {
	block: UiToolCallBlock;
	view: ToolView;
	/** Kill the running bash command (bash cards only, while running). */
	onKillBash?: KillBashHandler;
	/** 设置面板「完整显示工具」开关：true（开）→ 工具始终完整展开；
	 *  false（关）→ 默认折叠，点击展开。 */
	wrap?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(wrap);
	const [copied, setCopied] = useState(false);
	// Markdown files read by the `read` tool default to rendered preview,
	// same convention as the file preview panel (see FilePreview.tsx).
	const [markdownPreview, setMarkdownPreview] = useState(true);

	const running = !view.result && view.streaming && !view.status;
	const isBashRunning = block.name === "bash" && running;
	const done = view.result !== undefined;
	/** Command finished (tool_status fired) but the authoritative toolResult
	 *  message hasn't landed in a snapshot yet — the model is still chewing on
	 *  the result. */
	const waitingModel = !view.result && !!view.status;
	const isError = view.result?.isError ?? view.status?.isError ?? false;
	const isMarkdown = isMarkdownReadTarget(block);

	const output = view.result
		? view.result.content.map((b) => (b.type === "text" ? b.text : "")).join("")
		: (view.liveOutput ?? "");

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
	const duration =
		waitingModel && view.status?.durationMs !== undefined
			? formatDuration(view.status.durationMs)
			: "";
	if (waitingModel && duration) statusLabel = `${statusLabel} · ${duration}`;

	// tool_status doesn't carry the exit code for successful bash runs (only
	// failures embed "exited with code N" in the error text); show it when known.
	const exitHint =
		waitingModel && view.status?.exitCode !== undefined
			? `exit ${view.status.exitCode}`
			: "";

	const copyArgs = () => {
		if (block.argumentsText) {
			void navigator.clipboard.writeText(block.argumentsText);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		}
	};

	return (
		<div className={`toolcall ${statusClass}`}>
			<div className="toolcall-head">
				<span className="toolcall-icon">{toolIcon(block.name)}</span>
				<span className="toolcall-name">{block.name}</span>
				<span className="toolcall-status">
					{statusLabel}
					{exitHint && <em className="toolcall-exit">{exitHint}</em>}
				</span>
				<span className="toolcall-spacer" />
				{isBashRunning && onKillBash && (
					<button
						type="button"
						className="toolcall-kill"
						title={t("stopBashTip")}
						onClick={onKillBash}
					>
						<FiSquare />
						<span>{t("stopBash")}</span>
					</button>
				)}
				<button
					type="button"
					className="toolcall-copy"
					title={t("copyArgs")}
					onClick={copyArgs}
				>
					{copied ? <FiCheckCircle /> : <FiCopy />}
				</button>
				<button
					type="button"
					className="toolcall-toggle"
					onClick={() => setOpen((v) => !v)}
				>
					{open ? <FiChevronDown /> : <FiChevronRight />}
				</button>
			</div>
			{open && (
				<div className="toolcall-body">
					{block.argumentsText && (
						<div className="toolcall-args">
							{block.name === "bash" && block.argumentsText.startsWith("{") ? (
								<TerminalCommand args={block.argumentsText} />
							) : (
								<pre>{block.argumentsText}</pre>
							)}
						</div>
					)}
					{output.length > 0 && (
						<div className="toolcall-output">
							<div className="toolcall-output-label">
								{isError ? t("errorOutput") : t("output")}
								{(running || waitingModel) && <span className="cursor" />}
								<span className="toolcall-output-spacer" />
								{isMarkdown && !isError && (
									<button
										type="button"
										className="toolcall-md-toggle"
										title={
											markdownPreview
												? t("showMarkdownSource")
												: t("showMarkdownPreview")
										}
										onClick={() => setMarkdownPreview((v) => !v)}
									>
										{markdownPreview ? t("showMarkdownSource") : t("showMarkdownPreview")}
									</button>
								)}
							</div>
							{isMarkdown && markdownPreview && !isError ? (
								<div className="toolcall-markdown">
									<Markdown text={output} />
								</div>
							) : (
								<pre>{output}</pre>
							)}
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
				</div>
			)}
		</div>
	);
});

/** Pretty-print a bash tool call's arguments as a terminal line. */
function TerminalCommand({ args }: { args: string }) {
	let parsed: { command?: string; timeout?: number } | null = null;
	try {
		parsed = JSON.parse(args) as { command?: string; timeout?: number };
	} catch {
		return <pre>{args}</pre>;
	}
	if (typeof parsed.command !== "string") return <pre>{args}</pre>;
	return (
		<div className="termline">
			<FiTerminal className="termline-icon" />
			<code>{parsed.command}</code>
			{typeof parsed.timeout === "number" && (
				<span className="termline-timeout">⏱ {parsed.timeout}s</span>
			)}
		</div>
	);
}

/** "0.3s" / "12.0s" / "1m 05s" — for the tool_status duration hint. */
function formatDuration(ms?: number): string {
	if (ms === undefined) return "";
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const m = Math.floor(totalSec / 60);
	const s = Math.round(totalSec % 60);
	return `${m}m ${String(s).padStart(2, "0")}s`;
}
