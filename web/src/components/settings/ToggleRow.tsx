import type { ReactNode } from "react";
import { useT } from "../../i18n";
import { HintTip } from "../HintTip";

/** 设置项开关行：标题、说明、可选操作与拨动开关。 */
export function ToggleRow({
	title,
	subtitle,
	tip,
	enabled,
	onToggle,
	action,
	disabled,
	onInfoClick,
	infoTitle,
}: {
	title: ReactNode;
	subtitle?: string;
	tip?: string;
	enabled: boolean;
	onToggle: () => void;
	action?: ReactNode;
	disabled?: boolean;
	onInfoClick?: () => void;
	infoTitle?: string;
}) {
	const t = useT();
	return (
		<div className="set-row">
			<div
				className={`set-row-info${onInfoClick ? " clickable" : ""}`}
				onClick={onInfoClick}
				title={infoTitle}
				style={onInfoClick ? { cursor: "pointer" } : undefined}
			>
				<div className="set-row-name">
					{title}
					{tip && <HintTip text={tip} />}
				</div>
				{subtitle && <div className="set-row-desc">{subtitle}</div>}
			</div>
			{action}
			<button
				type="button"
				className={`set-switch ${enabled ? "on" : ""}`}
				role="switch"
				aria-label={typeof title === "string" ? title : undefined}
				aria-checked={enabled}
				disabled={disabled}
				title={enabled ? t("settingsEnabled") : t("settingsDisabled")}
				onClick={disabled ? undefined : onToggle}
			>
				<span className="set-switch-knob" />
			</button>
		</div>
	);
}
