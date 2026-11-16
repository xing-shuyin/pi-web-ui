import { memo, useState } from "react";
import { FiAlertTriangle, FiShield } from "react-icons/fi";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { Dropdown, DropdownItem } from "./Dropdown";

interface Props {
	/** Current effective mode reported by the engine. */
	current: string | null;
	/** Legal modes, in the order the CLI documents them. */
	modes: string[];
	compact?: boolean;
}

/** Modes that drop the guard rails; show a warning marker like the DSH danger preset. */
const DANGEROUS = new Set(["bypassPermissions"]);

/**
 * Claude Code permission mode picker for the composer chip row.
 *
 * Mirrors DshPermissionBar: the engine owns the value, this only sends the choice.
 */
export const ClaudePermissionBar = memo(function ClaudePermissionBar({ current, modes, compact = false }: Props) {
	const t = useT();
	const [open, setOpen] = useState(false);
	if (!current || modes.length === 0) return null;

	const pick = (mode: string) => {
		setOpen(false);
		if (mode !== current) appSend({ type: "claude_permission_mode", mode });
	};

	const label = (
		<>
			<FiShield />
			<span className="chip-sub" title={t("claudePermDefaultDesc")}>
				{current}
				{DANGEROUS.has(current) && <FiAlertTriangle style={{ marginLeft: 3 }} />}
			</span>
		</>
	);

	if (compact) {
		return (
			<Dropdown trigger={label} open={open} onOpenChange={setOpen} direction="up" align="left">
				{modes.map((mode) => (
					<DropdownItem key={mode} active={mode === current} onClick={() => pick(mode)}>
						<span className="dd-preset-name">
							{mode}
							{DANGEROUS.has(mode) && <span className="dd-preset-tag warn">{t("claudePermBypassTag")}</span>}
						</span>
					</DropdownItem>
				))}
			</Dropdown>
		);
	}

	return (
		<div className="dsh-presetbar">
			<Dropdown trigger={label} open={open} onOpenChange={setOpen} direction="down" align="left">
				{modes.map((mode) => (
					<DropdownItem key={mode} active={mode === current} onClick={() => pick(mode)}>
						{mode}
					</DropdownItem>
				))}
			</Dropdown>
		</div>
	);
});
