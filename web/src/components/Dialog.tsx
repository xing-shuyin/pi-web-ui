import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { useEscapeKey } from "../shortcut-stack";
import { Markdown } from "./Markdown";

interface DialogProps {
	dialog: {
		id: number;
		kind: "select" | "confirm" | "input";
		title: string;
		args: unknown[];
	};
}

/**
 * Bridges extension `ui.select/confirm/input` calls to an inline panel
 * rendered above the chat input (non-modal — the conversation stays visible).
 * Resolves via dialog_response; cancel/Esc resolves with null.
 */
export function Dialog({ dialog }: DialogProps) {
	const t = useT();
	const [inputValue, setInputValue] = useState("");
	const [sel, setSel] = useState(0);

	const respond = (value: string | boolean | null) => {
		appSend({ type: "dialog_response", id: dialog.id, value });
	};

	useEffect(() => {
		setInputValue("");
		setSel(0);
	}, [dialog.id]);
	// 审查 #12：Esc 改走 shortcut-stack 分层栈 —— 裸 document 监听会抢走
	// 叠在上面的模态弹窗的 Esc（与 Modal.tsx 同一调度，内层优先）。
	useEscapeKey(() => respond(null));

	const options = Array.isArray(dialog.args[0]) ? (dialog.args[0] as string[]) : [];
	const message = typeof dialog.args[0] === "string" ? (dialog.args[0] as string) : "";

	// 标题处理：如果 title 包含换行，提取首行作为顶栏紧凑单行概要，完整内容放在滚动正文区
	const titleText = dialog.title && dialog.title !== t("pluginRequest") ? dialog.title : "";
	const headTitle = titleText ? titleText.split("\n")[0].trim() : "";

	useEffect(() => {
		if (dialog.kind !== "select" || options.length === 0) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSel((s) => (s + 1) % options.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSel((s) => (s - 1 + options.length) % options.length);
			} else if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				if (options[sel] !== undefined) {
					respond(options[sel]);
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

			{dialog.kind === "select" && (
				<>
					{titleText && (
						<div className="dialog-prompt dialog-body">
							<Markdown text={titleText} rawHtml />
						</div>
					)}
					<div className="dialog-options">
						{options.map((opt, i) => (
							<button
								type="button"
								key={i}
								className={`dialog-option ${i === sel ? "sel" : ""}`}
								onMouseEnter={() => setSel(i)}
								onClick={() => respond(opt)}
							>
								<Markdown text={opt} rawHtml />
							</button>
						))}
						{options.length === 0 && <div className="dialog-hint">{t("noOptions")}</div>}
					</div>
				</>
			)}

			{dialog.kind === "confirm" && (
				<div className="dialog-body">
					{titleText && (titleText.includes("\n") || titleText.length > 50 || !message) && (
						<div className="dialog-prompt">
							<Markdown text={titleText} rawHtml />
						</div>
					)}
					{message && <Markdown text={message} rawHtml />}
					<div className="dialog-actions">
						<button type="button" className="btn" onClick={() => respond(false)}>
							{t("cancel")}
						</button>
						<button type="button" className="btn primary" onClick={() => respond(true)}>
							{t("ok")}
						</button>
					</div>
				</div>
			)}

			{dialog.kind === "input" && (
				<div className="dialog-body">
					{titleText && (
						<div className="dialog-prompt">
							<Markdown text={titleText} rawHtml />
						</div>
					)}
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
					<div className="dialog-actions">
						<button type="button" className="btn" onClick={() => respond(null)}>
							{t("cancel")}
						</button>
						<button type="button" className="btn primary" onClick={() => respond(inputValue)}>
							{t("ok")}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
