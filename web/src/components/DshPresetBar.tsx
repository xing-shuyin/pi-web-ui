import { memo, useEffect, useState } from "react";
import { FiLock, FiPlus, FiSliders } from "react-icons/fi";
import type { UiAgentPreset } from "../types";
import { isZhLocale, useI18n, useT, type Translate } from "../i18n";
import { appSend } from "../app-globals";
import { focusComposer } from "../composer-bridge";
import { Dropdown, DropdownItem } from "./Dropdown";

export interface DshPresetInfo {
	id: string;
	name: string;
	locked: boolean;
}

interface Props {
	preset: DshPresetInfo | null;
	presets: UiAgentPreset[];
	defaultPreset: string;
	blank: boolean;
	conversationId: string;
	compact?: boolean;
}

const KNOWN_ORDER = ["standard", "ptc", "minimal", "cordis"];

type PresetLabelKey = "preset.standard" | "preset.minimal" | "preset.code" | "preset.reader" | "preset.ask";
type PresetDescKey =
	"preset.standardDesc" | "preset.minimalDesc" | "preset.codeDesc" | "preset.readerDesc" | "preset.askDesc";

const BUILTIN_LABEL: Record<string, PresetLabelKey> = {
	standard: "preset.standard",
	minimal: "preset.minimal",
	code: "preset.code",
	reader: "preset.reader",
	ask: "preset.ask",
};

const BUILTIN_DESC: Record<string, PresetDescKey> = {
	standard: "preset.standardDesc",
	minimal: "preset.minimalDesc",
	code: "preset.codeDesc",
	reader: "preset.readerDesc",
	ask: "preset.askDesc",
};

function presetLabelKey(id: string): PresetLabelKey | null {
	return BUILTIN_LABEL[id] ?? null;
}

function presetDescKey(id: string): PresetDescKey | null {
	return BUILTIN_DESC[id] ?? null;
}

export function presetText(p: UiAgentPreset, locale: string, t: Translate): { name: string; description?: string } {
	const zh = isZhLocale(locale);
	const labelKey = presetLabelKey(p.id);
	const descKey = presetDescKey(p.id);
	if (labelKey && descKey) return { name: t(labelKey), description: t(descKey) };
	return {
		name: zh ? (p.name ?? p.id) : (p.nameEn ?? p.name ?? p.id),
		description: zh ? p.description : (p.descriptionEn ?? p.description),
	};
}

export function sortAgentPresets(list: UiAgentPreset[]): UiAgentPreset[] {
	return [...list].sort((a, b) => {
		const ao = Number.isSafeInteger(a.order) ? a.order! : KNOWN_ORDER.indexOf(a.id);
		const bo = Number.isSafeInteger(b.order) ? b.order! : KNOWN_ORDER.indexOf(b.id);
		const ai = ao >= 0 ? ao : 1000;
		const bi = bo >= 0 ? bo : 1000;
		if (ai !== bi) return ai - bi;
		return a.id.localeCompare(b.id);
	});
}

export const DshPresetBar = memo(function DshPresetBar({
	preset,
	presets,
	defaultPreset,
	blank,
	conversationId,
	compact = false,
}: Props) {
	const t = useT();
	const { locale } = useI18n();
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState(preset?.id ?? defaultPreset);
	useEffect(() => {
		setSelected(preset?.id ?? defaultPreset);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [conversationId, preset?.id, defaultPreset]);

	if (presets.length === 0) return null;
	const locked = preset?.locked || !blank;
	const ordered = sortAgentPresets(presets);
	const current = ordered.find((p) => p.id === preset?.id);
	const sel = ordered.find((p) => p.id === selected) ?? current;
	const textOf = (p: UiAgentPreset) => presetText(p, locale, t);
	const currentText = current ? textOf(current) : undefined;

	const pick = (id: string) => {
		setSelected(id);
		setOpen(false);
		if (blank && id !== preset?.id) appSend({ type: "dsh_preset_select", preset: id });
	};

	if (compact) {
		const title = currentText?.description ?? current?.id ?? t("dshPreset");
		return (
			<Dropdown
				trigger={
					<>
						<FiSliders />
						<span className="chip-sub" title={locked ? `${title}（${t("dshPresetLocked")}）` : title}>
							{currentText?.name ?? current?.id ?? preset?.name ?? t("dshPreset")}
							{locked && <FiLock style={{ marginLeft: 3 }} />}
						</span>
					</>
				}
				open={open && !locked}
				onOpenChange={setOpen}
				direction="up"
				align="left"
			>
				{ordered.map((p) => {
					const text = textOf(p);
					return (
						<DropdownItem
							key={p.id}
							active={p.id === preset?.id}
							disabled={!!p.broken}
							title={p.broken ?? text.description ?? p.id}
							onClick={() => pick(p.id)}
						>
							<span className="dd-preset-name">
								{text.name}
								{p.trust === "user" && <span className="dd-preset-tag">{t("dshPresetUser")}</span>}
								{p.id === defaultPreset && <span className="dd-preset-tag">{t("dshPresetDefaultTag")}</span>}
								{p.broken && <span className="dd-preset-tag warn">{t("dshPresetBroken")}</span>}
							</span>
							{text.description && !p.broken && <span className="dd-preset-desc">{text.description}</span>}
						</DropdownItem>
					);
				})}
			</Dropdown>
		);
	}

	return (
		<div className="dsh-presetbar" data-testid="dsh-presetbar">
			<span className="dsh-preset-label">
				<FiSliders />
				{t("dshPreset")}
			</span>
			<Dropdown
				trigger={
					<span title={currentText?.description ?? current?.id ?? ""}>
						{currentText?.name ?? current?.id ?? preset?.name ?? "…"}
						{locked && (
							<span className="dsh-preset-lock" title={t("dshPresetBlankOnly")}>
								<FiLock /> {t("dshPresetLocked")}
							</span>
						)}
					</span>
				}
				open={open && !locked}
				onOpenChange={setOpen}
			>
				{ordered.map((p) => {
					const text = textOf(p);
					return (
						<DropdownItem
							key={p.id}
							active={p.id === preset?.id}
							disabled={!!p.broken}
							title={p.broken ?? text.description ?? p.id}
							onClick={() => pick(p.id)}
						>
							<span className="dd-preset-name">
								{text.name}
								{p.trust === "user" && <span className="dd-preset-tag">{t("dshPresetUser")}</span>}
								{p.id === defaultPreset && <span className="dd-preset-tag">{t("dshPresetDefaultTag")}</span>}
								{p.broken && <span className="dd-preset-tag warn">{t("dshPresetBroken")}</span>}
							</span>
							{text.description && !p.broken && <span className="dd-preset-desc">{text.description}</span>}
						</DropdownItem>
					);
				})}
			</Dropdown>
			{!locked && (
				<span className="dsh-preset-hint" title={t("dshPresetBlankOnly")}>
					{t("dshPresetBlankOnly")}
				</span>
			)}
			{sel?.id === "minimal" && <span className="dsh-preset-hint warn">{t("dshPresetMinimalNote")}</span>}
			<button
				type="button"
				className="chip"
				title={t("dshPresetNewChat")}
				onClick={() => {
					appSend({ type: "new_chat", preset: sel?.id ?? selected });
					focusComposer();
				}}
			>
				<FiPlus /> {t("dshPresetNewChat")}
			</button>
		</div>
	);
});
