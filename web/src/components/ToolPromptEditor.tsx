import { useEffect, useMemo, useState } from "react";
import { FiEdit3 } from "react-icons/fi";
import { useT } from "../i18n";
import { invalidateToolPrompt, requestToolPrompt, useToolPromptView } from "../tool-prompt-state";
import type { UiToolPromptOverride } from "../types";
import { Modal } from "./Modal";

export function ToolPromptEditor({
	name,
	override,
	onApply,
	onClose,
}: {
	name: string;
	override: UiToolPromptOverride | null;
	onApply: (name: string, override: UiToolPromptOverride | null) => void;
	onClose: () => void;
}) {
	const t = useT();
	const view = useToolPromptView(name);
	const [description, setDescription] = useState(() => override?.description ?? "");
	const [snippet, setSnippet] = useState(() => override?.promptSnippet ?? "");
	const [guidelines, setGuidelines] = useState(() => (override?.promptGuidelines ?? []).join("\n"));

	useEffect(() => {
		requestToolPrompt(name);
	}, [name]);

	const defaultGuidelinesText = useMemo(() => (view?.defaultPromptGuidelines ?? []).join("\n"), [view]);

	const unavailable = view?.status === "unsupported" || view?.status === "missing";

	const save = () => {
		const next: UiToolPromptOverride = {};
		const d = description.trim();
		if (d) next.description = d;
		const s = snippet.trim();
		if (s) next.promptSnippet = s;
		const g = guidelines
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (g.length > 0) next.promptGuidelines = g;
		onApply(name, Object.keys(next).length > 0 ? next : null);
		invalidateToolPrompt(name);
		onClose();
	};

	const reset = () => {
		onApply(name, null);
		invalidateToolPrompt(name);
		onClose();
	};

	return (
		<Modal
			className="tool-prompt-editor"
			title={`${t("toolPromptEdit")} · ${name}`}
			icon={<FiEdit3 />}
			onClose={onClose}
		>
			<div className="tool-prompt-body">
				{unavailable && <p className="set-note">{t("toolPromptUnavailable")}</p>}
				<p className="set-note">{t("toolPromptHint")}</p>

				<label className="tool-prompt-field">
					<span className="set-field-label">{t("toolPromptDescription")}</span>
					<textarea
						className="set-prompt-input"
						rows={5}
						value={description}
						placeholder={view?.defaultDescription ?? ""}
						onChange={(e) => setDescription(e.target.value)}
					/>
					{view?.defaultDescription && (
						<details className="tool-prompt-default">
							<summary>{t("toolPromptDefault")}</summary>
							<pre>{view.defaultDescription}</pre>
						</details>
					)}
				</label>

				<label className="tool-prompt-field">
					<span className="set-field-label">{t("toolPromptSnippet")}</span>
					<input
						type="text"
						className="set-input"
						value={snippet}
						placeholder={view?.defaultPromptSnippet ?? ""}
						onChange={(e) => setSnippet(e.target.value)}
					/>
					{view?.defaultPromptSnippet && (
						<details className="tool-prompt-default">
							<summary>{t("toolPromptDefault")}</summary>
							<pre>{view.defaultPromptSnippet}</pre>
						</details>
					)}
				</label>

				<label className="tool-prompt-field">
					<span className="set-field-label">{t("toolPromptGuidelines")}</span>
					<textarea
						className="set-prompt-input tool-prompt-guidelines"
						rows={4}
						value={guidelines}
						placeholder={defaultGuidelinesText}
						onChange={(e) => setGuidelines(e.target.value)}
					/>
					{defaultGuidelinesText && (
						<details className="tool-prompt-default">
							<summary>{t("toolPromptDefault")}</summary>
							<pre>{defaultGuidelinesText}</pre>
						</details>
					)}
				</label>

				<div className="tool-prompt-actions">
					<button type="button" className="btn" onClick={reset}>
						{t("toolPromptReset")}
					</button>
					<button type="button" className="btn primary" onClick={save}>
						{t("toolPromptSave")}
					</button>
				</div>
			</div>
		</Modal>
	);
}
