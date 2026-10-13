import { memo, useEffect, useState } from "react";
import { FiLock, FiPlus, FiSliders } from "react-icons/fi";
import type { UiAgentPreset } from "../types";
import { isZhLocale, useI18n, useT, type Translate } from "../i18n";
import { appSend } from "../app-globals";
import { focusComposer } from "../composer-bridge";
import { Dropdown, DropdownItem } from "./Dropdown";

/** 当前会话预设（快照 UiState.agentPreset；null = 快照未到）。 */
export interface DshPresetInfo {
	id: string;
	name: string;
	locked: boolean;
}

interface Props {
	preset: DshPresetInfo | null;
	presets: UiAgentPreset[];
	defaultPreset: string;
	/** 空白会话（无消息）→ 允许切换；否则锁定展示。 */
	blank: boolean;
	/** 会话切换时重置下拉框选中值。 */
	conversationId: string;
	/** 紧凑模式：只渲染一个下拉按钮（输入框工具条内，思考强度右侧）。 */
	compact?: boolean;
}

/** 已知内置预设的展示顺序（名录 order 优先，此表兜底；自建按名称排最后）。 */
const KNOWN_ORDER = ["standard", "ptc", "minimal", "cordis"];

/** pi 引擎内置五档的 i18n 键（与权限档 permLabelKey 同一口径）。 */
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

/** 内置预设的文案键；null = 非内置（DSH 运行时/自建预设，走服务端文案）。 */
function presetLabelKey(id: string): PresetLabelKey | null {
	return BUILTIN_LABEL[id] ?? null;
}

function presetDescKey(id: string): PresetDescKey | null {
	return BUILTIN_DESC[id] ?? null;
}

/**
 * 预设文案随界面语言落定：内置五档走 i18n 键（与权限档同口径），
 * 其它预设（DSH 运行时下发、自建）用服务端文案，非中文界面取 nameEn ?? name
 * （与 ui-slots.ts 的 pluginLabel 同一回落约定）。
 * 修的正是「英文界面仍见全功能/极简模式」：服务端只下发中文 name。
 */
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
	// 会话/预设变化时同步下拉框（用户操作中不打断：只在 id 变化时跟）。
	useEffect(() => {
		setSelected(preset?.id ?? defaultPreset);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [conversationId, preset?.id, defaultPreset]);

	if (presets.length === 0) return null;
	const locked = preset?.locked || !blank;
	const ordered = sortAgentPresets(presets);
	const current = ordered.find((p) => p.id === preset?.id);
	const sel = ordered.find((p) => p.id === selected) ?? current;
	// 展示文案：内置五档走 i18n，其余预设用服务端文案（非中文界面取 nameEn）。
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
