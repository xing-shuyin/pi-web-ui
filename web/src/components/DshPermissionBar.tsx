import { memo, useEffect, useState } from "react";
import { FiAlertTriangle, FiShield } from "react-icons/fi";
import type { DshPermissionOption } from "../types";
import { useT } from "../i18n";
import { appSend } from "../app-globals";
import { Dropdown, DropdownItem } from "./Dropdown";

interface Props {
	current: string | null;
	options: DshPermissionOption[];
	defaultPreset: string;
	conversationId: string;
	compact?: boolean;
}

const OFFER_ORDER = ["read-only", "workspace-write-never", "danger-full-access"];

type PermLabelKey = "dshPermReadOnly" | "dshPermWorkspaceWrite" | "dshPermFullAccess";
type PermDescKey = "dshPermReadOnlyDesc" | "dshPermWorkspaceWriteDesc" | "dshPermFullAccessDesc";

export const DSH_PERMISSION_ORDER = ["read-only", "workspace-write-never", "danger-full-access"];

export function permLabelKey(value: string): PermLabelKey {
	if (value === "read-only") return "dshPermReadOnly";
	if (value === "danger-full-access") return "dshPermFullAccess";
	return "dshPermWorkspaceWrite";
}

export function permDescKey(value: string): PermDescKey {
	if (value === "read-only") return "dshPermReadOnlyDesc";
	if (value === "danger-full-access") return "dshPermFullAccessDesc";
	return "dshPermWorkspaceWriteDesc";
}

export const DshPermissionBar = memo(function DshPermissionBar({
	current,
	options,
	defaultPreset,
	conversationId,
	compact = false,
}: Props) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [confirmFull, setConfirmFull] = useState(false);
	useEffect(() => {
		setConfirmFull(false);
		setOpen(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [conversationId]);

	const offered = OFFER_ORDER.filter((v) => options.some((o) => o.value === v));
	if (offered.length === 0) return null;
	const effective = current ?? defaultPreset;
	const isCustom = !!current && !offered.includes(current);

	const pick = (value: string) => {
		if (value === "danger-full-access" && value !== effective && !confirmFull) {
			setConfirmFull(true);
			return;
		}
		setConfirmFull(false);
		setOpen(false);
		if (value !== effective) appSend({ type: "dsh_permission_set", preset: value });
	};

	if (compact) {
		const label = isCustom ? t("dshPermCustom") : t(permLabelKey(effective));
		const title = isCustom ? (current ?? label) : t(permDescKey(effective));
		return (
			<Dropdown
				trigger={
					<>
						<FiShield />
						<span className="chip-sub" title={title}>
							{label}
							{effective === "danger-full-access" && <FiAlertTriangle style={{ marginLeft: 3 }} />}
						</span>
					</>
				}
				open={open}
				onOpenChange={(v) => {
					setOpen(v);
					if (!v) setConfirmFull(false);
				}}
				direction="up"
				align="left"
			>
				{offered.map((v) => (
					<DropdownItem key={v} active={v === effective} title={t(permDescKey(v))} onClick={() => pick(v)}>
						<span className="dd-preset-name">
							{t(permLabelKey(v))}
							{v === defaultPreset && <span className="dd-preset-tag">{t("dshPresetDefaultTag")}</span>}
							{v === "danger-full-access" && <span className="dd-preset-tag warn">{t("dshPermFullAccessTag")}</span>}
						</span>
						<span className="dd-preset-desc">{t(permDescKey(v))}</span>
					</DropdownItem>
				))}
				{confirmFull && <div className="dd-note warn">{t("dshPermConfirmFull")}</div>}
			</Dropdown>
		);
	}

	return (
		<div className="dsh-presetbar" data-testid="dsh-permissionbar">
			<span className="dsh-preset-label">
				<FiShield />
				{t("dshPerm")}
			</span>
			<Dropdown
				trigger={
					<span title={isCustom ? current! : t(permDescKey(effective))}>
						{isCustom ? t("dshPermCustom") : t(permLabelKey(effective))}
						{effective === "danger-full-access" && (
							<span className="dd-preset-tag warn">
								<FiAlertTriangle /> {t("dshPermFullAccessTag")}
							</span>
						)}
					</span>
				}
				open={open}
				onOpenChange={(v) => {
					setOpen(v);
					if (!v) setConfirmFull(false);
				}}
			>
				{offered.map((v) => (
					<DropdownItem key={v} active={v === effective} title={t(permDescKey(v))} onClick={() => pick(v)}>
						<span className="dd-preset-name">
							{t(permLabelKey(v))}
							{v === defaultPreset && <span className="dd-preset-tag">{t("dshPresetDefaultTag")}</span>}
							{v === "danger-full-access" && <span className="dd-preset-tag warn">{t("dshPermFullAccessTag")}</span>}
						</span>
						<span className="dd-preset-desc">{t(permDescKey(v))}</span>
					</DropdownItem>
				))}
			</Dropdown>
			{confirmFull && <span className="dsh-preset-hint warn">{t("dshPermConfirmFull")}</span>}
		</div>
	);
});
