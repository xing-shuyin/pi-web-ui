import { useEffect, useMemo, useState } from "react";
import {
	FiAlertTriangle,
	FiCheck,
	FiChevronDown,
	FiChevronUp,
	FiCopy,
	FiCornerDownRight,
	FiTerminal,
} from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { useEscapeKey } from "../shortcut-stack";
import { composeToComposer, focusComposer } from "../composer-bridge";
import { Markdown } from "./Markdown";
import { useCopyFeedback } from "../use-copy-feedback";

interface DialogProps {
	dialog: {
		id: number;
		kind: "select" | "confirm" | "input";
		title: string;
		args: unknown[];
		code?: {
			content: string;
			language?: string;
			hasRisk?: boolean;
		};
	};
}

export function isAffirmativeOption(opt: string): boolean {
	const trimmed = opt.trim().toLowerCase();
	return /^(yes|allow|approve|confirm|ok|是|允许|同意|确认|放行)/i.test(trimmed);
}

export function isNegativeOption(opt: string): boolean {
	const trimmed = opt.trim().toLowerCase();
	return /^(no|deny|reject|cancel|block|否|拒绝|取消|阻止)/i.test(trimmed);
}

export function parseCommandPrompt(text: string): {
	hasRisk: boolean;
	intro: string;
	command: string | null;
	outro: string;
} {
	if (!text) {
		return { hasRisk: false, intro: "", command: null, outro: "" };
	}

	const hasRisk =
		/⚠️|danger|warning|高危|危险/i.test(text) ||
		/\b(rm\s+-[a-zA-Z]*r[a-zA-Z]*f|chmod\s+(-R\s+)?777|mkfs|dd\s+if=|chown\s+-R|> \/dev\/|sudo\s+rm|drop\s+database|truncate\s+table)\b/i.test(
			text,
		);

	const fenceMatch = text.match(/([\s\S]*?)```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)```([\s\S]*)/);
	if (fenceMatch) {
		return {
			hasRisk,
			intro: fenceMatch[1].trim(),
			command: fenceMatch[2].trim(),
			outro: fenceMatch[3].trim(),
		};
	}

	const lines = text.split("\n");
	let cmdStart = -1;
	let cmdEnd = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		const isCmdLine =
			/^(printf|rm|npm|npx|git|pnpm|yarn|docker|curl|cat|sh|bash|sudo|cp|mv|find|kill|echo|node|python|cargo|make|set|export|source|env|touch|mkdir|chmod|chown)\b/i.test(
				trimmed,
			) ||
			/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed) ||
			(line.startsWith("  ") && trimmed.length > 0) ||
			line.startsWith("$ ");

		if (isCmdLine) {
			if (cmdStart === -1) cmdStart = i;
			cmdEnd = i;
		} else if (cmdStart !== -1 && trimmed.length > 0) {
			break;
		}
	}

	if (cmdStart !== -1 && (cmdEnd > cmdStart || /command|命令/i.test(text))) {
		const introLines = lines.slice(0, cmdStart).join("\n").trim();
		const cmdLines = lines
			.slice(cmdStart, cmdEnd + 1)
			.map((l) => (l.startsWith("$ ") ? l.slice(2) : l.startsWith("  ") ? l.trimStart() : l))
			.join("\n")
			.trim();
		const outroLines = lines
			.slice(cmdEnd + 1)
			.join("\n")
			.trim();

		if (cmdLines.length > 0) {
			return {
				hasRisk,
				intro: introLines,
				command: cmdLines,
				outro: outroLines,
			};
		}
	}

	return { hasRisk, intro: text, command: null, outro: "" };
}

export function CommandInspectorBox({ command, hasRisk }: { command: string; hasRisk?: boolean }) {
	const t = useT();
	const { copied, copy } = useCopyFeedback({ duration: 2000 });
	const [expanded, setExpanded] = useState(false);

	const lines = useMemo(() => command.split("\n"), [command]);
	const isLong = lines.length > 8;

	const handleCopy = () => {
		void copy(command);
	};

	return (
		<div className={`dialog-cmd-box ${hasRisk ? "has-risk" : ""}`}>
			{hasRisk && (
				<div className="dialog-cmd-risk">
					<FiAlertTriangle />
					<span>{t("cmdInspectorRisk")}</span>
				</div>
			)}
			<div className="dialog-cmd-head">
				<div className="dialog-cmd-tag">
					<FiTerminal />
					<span>{t("cmdInspectorTitle")}</span>
					<span className="dialog-cmd-badge">{t("cmdInspectorLines", { n: lines.length })}</span>
				</div>
				<div className="dialog-cmd-actions">
					{isLong && (
						<button
							type="button"
							className="cmd-btn-text"
							onClick={() => setExpanded((v) => !v)}
							title={expanded ? t("cmdInspectorCollapse") : t("cmdInspectorExpand")}
						>
							{expanded ? <FiChevronUp /> : <FiChevronDown />}
							<span>{expanded ? t("cmdInspectorCollapse") : t("cmdInspectorExpand")}</span>
						</button>
					)}
					<button type="button" className="cmd-btn-text" onClick={handleCopy} title={t("copy")}>
						{copied ? <FiCheck /> : <FiCopy />}
						<span>{copied ? t("cmdCopied") : t("copy")}</span>
					</button>
				</div>
			</div>
			<div className={`dialog-cmd-code ${expanded ? "expanded" : ""}`}>
				<pre>
					<code>
						{lines.map((line, idx) => (
							<div key={idx} className="dialog-cmd-line">
								<span className="cmd-line-num">{idx + 1}</span>
								<span className="cmd-line-text">{line}</span>
							</div>
						))}
					</code>
				</pre>
			</div>
		</div>
	);
}

export function DialogPromptContent({
	text,
	structuredCode,
}: {
	text: string;
	structuredCode?: { content: string; language?: string; hasRisk?: boolean };
}) {
	const parsed = useMemo(() => {
		if (structuredCode) {
			return {
				hasRisk: structuredCode.hasRisk ?? false,
				intro: text,
				command: structuredCode.content,
				outro: "",
			};
		}
		return parseCommandPrompt(text);
	}, [text, structuredCode]);

	if (!parsed.command) {
		return (
			<div className="dialog-prompt dialog-body">
				<Markdown text={text} rawHtml disableMath />
			</div>
		);
	}

	return (
		<div className="dialog-prompt dialog-body">
			{parsed.intro && <Markdown text={parsed.intro} rawHtml disableMath />}
			<CommandInspectorBox command={parsed.command} hasRisk={parsed.hasRisk} />
			{parsed.outro && <Markdown text={parsed.outro} rawHtml disableMath />}
		</div>
	);
}

export function Dialog({ dialog }: DialogProps) {
	const t = useT();
	const [inputValue, setInputValue] = useState("");
	const [sel, setSel] = useState(0);
	const [showRejectInput, setShowRejectInput] = useState(false);
	const [rejectNote, setRejectNote] = useState("");

	const respond = (value: string | boolean | null) => {
		appSend({ type: "dialog_response", id: dialog.id, value });
	};

	useEffect(() => {
		setInputValue("");
		setSel(0);
		setShowRejectInput(false);
		setRejectNote("");
	}, [dialog.id]);

	useEscapeKey(() => respond(null));

	const options = Array.isArray(dialog.args[0]) ? (dialog.args[0] as string[]) : [];
	const message = typeof dialog.args[0] === "string" ? (dialog.args[0] as string) : "";

	const titleText = dialog.title && dialog.title !== t("pluginRequest") ? dialog.title : "";
	const headTitle = titleText ? titleText.split("\n")[0].trim() : "";

	const hasNegative = options.some(isNegativeOption);
	const negativeOpt = options.find(isNegativeOption) ?? options[options.length - 1] ?? "No";

	const handleRejectWithNote = () => {
		const note = rejectNote.trim();
		if (note) {
			composeToComposer({
				text: `${t("rejectFeedbackPrefix")}${note}\n`,
			});
			focusComposer();
		}
		respond(negativeOpt);
	};

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA") return;

			if (dialog.kind === "select") {
				if (options.length === 0) return;
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setSel((s) => (s + 1) % options.length);
				} else if (e.key === "ArrowUp") {
					e.preventDefault();
					setSel((s) => (s - 1 + options.length) % options.length);
				} else if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					if (options[sel] !== undefined) respond(options[sel]);
				} else if ((e.key === "y" || e.key === "Y") && !e.ctrlKey && !e.metaKey && !e.altKey) {
					const affIdx = options.findIndex(isAffirmativeOption);
					if (affIdx >= 0) {
						e.preventDefault();
						respond(options[affIdx]);
					}
				} else if ((e.key === "n" || e.key === "N") && !e.ctrlKey && !e.metaKey && !e.altKey) {
					const negIdx = options.findIndex(isNegativeOption);
					if (negIdx >= 0) {
						e.preventDefault();
						respond(options[negIdx]);
					}
				}
			} else if (dialog.kind === "confirm") {
				if ((e.key === "y" || e.key === "Y" || e.key === "Enter") && !e.ctrlKey && !e.metaKey && !e.altKey) {
					e.preventDefault();
					respond(true);
				} else if ((e.key === "n" || e.key === "N") && !e.ctrlKey && !e.metaKey && !e.altKey) {
					e.preventDefault();
					respond(false);
				}
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [dialog.kind, dialog.id, options, sel]);

	return (
		<div className="dialog-inline" data-dialog-kind={dialog.kind}>
			<div className="dialog-head">
				<span className="dialog-badge">{t("pluginRequest")}</span>
				{headTitle && (
					<span className="dialog-title" title={titleText}>
						{headTitle}
					</span>
				)}
				<button type="button" className="dialog-dismiss" title={t("cancel")} onClick={() => respond(null)}>
					✕
				</button>
			</div>

			<div className="dialog-scroll-body">
				{dialog.kind === "select" && <DialogPromptContent text={titleText} structuredCode={dialog.code} />}

				{dialog.kind === "confirm" && (
					<>
						{titleText && (titleText.includes("\n") || titleText.length > 50 || !message || dialog.code) && (
							<DialogPromptContent text={titleText} structuredCode={dialog.code} />
						)}
						{message && (
							<div className="dialog-prompt dialog-body">
								<Markdown text={message} rawHtml disableMath />
							</div>
						)}
					</>
				)}

				{dialog.kind === "input" && (
					<>
						{titleText && <DialogPromptContent text={titleText} structuredCode={dialog.code} />}
						<input
							className="dialog-input"
							value={inputValue}
							placeholder={message || t("inputPlaceholder")}
							autoFocus
							onChange={(e) => setInputValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.nativeEvent.isComposing) {
									respond(inputValue);
								}
							}}
						/>
					</>
				)}
			</div>

			<div className="dialog-footer">
				{dialog.kind === "select" && (
					<>
						<div className="dialog-options">
							{options.map((opt, i) => {
								const isAffirmative = isAffirmativeOption(opt);
								const isNegative = isNegativeOption(opt);
								const shortcutKey = isAffirmative ? "Y" : isNegative ? "N" : undefined;
								return (
									<button
										type="button"
										key={i}
										className={`dialog-option ${i === sel ? "sel" : ""} ${isAffirmative ? "opt-affirmative" : ""} ${isNegative ? "opt-negative" : ""}`}
										onMouseEnter={() => setSel(i)}
										onClick={() => respond(opt)}
									>
										<span className="dialog-option-text">
											<Markdown text={opt} rawHtml disableMath />
										</span>
										{shortcutKey && <kbd className="dialog-opt-badge">{shortcutKey}</kbd>}
									</button>
								);
							})}
							{options.length === 0 && <div className="dialog-hint">{t("noOptions")}</div>}
						</div>

						{hasNegative && (
							<div className="dialog-reject-box">
								{!showRejectInput ? (
									<button type="button" className="dialog-reject-toggle" onClick={() => setShowRejectInput(true)}>
										<FiCornerDownRight />
										<span>{t("rejectWithNote")}</span>
									</button>
								) : (
									<div className="dialog-reject-input-row">
										<input
											className="dialog-input dialog-reject-input"
											value={rejectNote}
											placeholder={t("rejectNotePlaceholder")}
											autoFocus
											onChange={(e) => setRejectNote(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter" && !e.nativeEvent.isComposing) {
													handleRejectWithNote();
												} else if (e.key === "Escape") {
													setShowRejectInput(false);
												}
											}}
										/>
										<button type="button" className="btn btn-sm" onClick={handleRejectWithNote}>
											{t("rejectWithNoteSubmit")}
										</button>
										<button
											type="button"
											className="btn btn-sm ghost-btn"
											title={t("cancel")}
											onClick={() => setShowRejectInput(false)}
										>
											✕
										</button>
									</div>
								)}
							</div>
						)}
					</>
				)}

				{dialog.kind === "confirm" && (
					<div className="dialog-actions">
						<button type="button" className="btn" onClick={() => respond(false)}>
							{t("cancel")} <kbd className="dialog-opt-badge">N</kbd>
						</button>
						<button type="button" className="btn primary" onClick={() => respond(true)}>
							{t("ok")} <kbd className="dialog-opt-badge">Y</kbd>
						</button>
					</div>
				)}

				{dialog.kind === "input" && (
					<div className="dialog-actions">
						<button type="button" className="btn" onClick={() => respond(null)}>
							{t("cancel")}
						</button>
						<button type="button" className="btn primary" onClick={() => respond(inputValue)}>
							{t("ok")}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
