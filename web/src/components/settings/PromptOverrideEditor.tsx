import type { MutableRefObject, ReactNode } from "react";
import { useT } from "../../i18n";
import { FieldRow } from "./FieldRow";

/** 提示词覆盖编辑器（追加/替换模式 + 失焦提交）。 */
export function PromptOverrideEditor({
	mode,
	onModeChange,
	draft,
	onDraftChange,
	defaultPrompt,
	placeholder,
	rows = 4,
	onCommit,
	modeLabel,
	hint,
	focusRef,
}: {
	mode: "append" | "replace";
	onModeChange: (m: "append" | "replace") => void;
	draft: string;
	onDraftChange: (v: string) => void;
	defaultPrompt?: string;
	placeholder?: string;
	rows?: number;
	onCommit: (mode: "append" | "replace", text: string) => void;
	modeLabel?: string;
	hint?: ReactNode;
	focusRef?: MutableRefObject<boolean>;
}) {
	const t = useT();

	const commit = (targetMode: "append" | "replace", targetDraft: string) => {
		const text = targetMode === "replace" && defaultPrompt && targetDraft === defaultPrompt ? "" : targetDraft;
		onCommit(targetMode, text);
	};

	return (
		<>
			<FieldRow label={modeLabel ?? t("visionBridgePromptMode")}>
				<select
					className="set-select"
					value={mode}
					onChange={(e) => {
						const m = e.target.value as "append" | "replace";
						onModeChange(m);
						commit(m, draft);
					}}
				>
					<option value="append">{t("promptModeAppend")}</option>
					<option value="replace">{t("promptModeReplace")}</option>
				</select>
			</FieldRow>
			<textarea
				className="set-prompt-input"
				rows={rows}
				placeholder={placeholder}
				value={draft}
				onFocus={() => {
					if (focusRef) focusRef.current = true;
				}}
				onBlur={() => {
					if (focusRef) focusRef.current = false;
					commit(mode, draft);
				}}
				onChange={(e) => onDraftChange(e.target.value)}
			/>
			{hint && <p className="set-hint">{hint}</p>}
		</>
	);
}
