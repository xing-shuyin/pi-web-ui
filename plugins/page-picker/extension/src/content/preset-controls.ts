/// <reference lib="dom" />

import {
	DETAIL_LABELS,
	PICK_SECTIONS,
	SECTION_INFO,
	SECTION_PRESETS,
	describeSections,
	presetForSections,
	type DetailLevel,
	type PickSection,
} from "../shared/contract.js";
import { getMessage } from "../shared/i18n.js";

export interface PresetControlsState {
	detail: DetailLevel;
	sections: PickSection[];
	notice?: string;
}

export interface PresetControlsHandlers {
	onPreset: (id: string) => void;
	onToggleSection: (key: PickSection, on: boolean) => void;
	onRefuseEmpty?: (key: PickSection) => void;
}

export interface PresetControls {
	root: HTMLElement;
	setPanelOpen: (open: boolean) => void;
	render: (state: PresetControlsState) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") node.className = v;
		else if (k === "text") node.textContent = v;
		else node.setAttribute(k, v);
	}
	for (const child of children) node.append(child);
	return node;
}

export function createPresetControls(handlers: PresetControlsHandlers): PresetControls {
	let current: PresetControlsState = { detail: "standard", sections: [...PICK_SECTIONS] };
	let open = false;

	const row = el("div", { class: "presets" });
	row.append(el("span", { class: "plabel", text: getMessage("preset_label", undefined, "预设") }));

	const chips = SECTION_PRESETS.map((preset, i) => {
		const chip = el("button", {
			class: "chip",
			type: "button",
			"data-preset": preset.id,
			title: `${preset.label} — ${preset.hint}${getMessage("preset_chipShortcut", [String(i + 1)], `（Alt+${i + 1}）`)}`,
			text: preset.short,
		});
		chip.addEventListener("click", () => handlers.onPreset(preset.id));
		row.append(chip);
		return { preset, chip };
	});

	const customChip = el("span", {
		class: "chip custom",
		title: getMessage("preset_customHint", undefined, "当前是自己勾的组合（点上面的 chip 可套预设）"),
		text: getMessage("preset_custom", undefined, "自定义"),
	});
	const panelBtn = el("button", { class: "link", type: "button" });
	const setPanelOpen = (next: boolean): void => {
		open = next;
		panel.classList.toggle("hidden", !open);
		panelBtn.textContent = open
			? getMessage("preset_collapseSections", undefined, "收起 ▴")
			: getMessage("preset_adjustSections", undefined, "调整项 ▾");
		panelBtn.setAttribute("aria-expanded", String(open));
	};
	panelBtn.addEventListener("click", () => setPanelOpen(!open));
	row.append(el("span", { class: "grow" }), customChip, panelBtn);

	const panel = el("div", { class: "sections hidden" });
	const boxes = new Map<PickSection, HTMLInputElement>();
	for (const key of PICK_SECTIONS) {
		const info = SECTION_INFO[key];
		const box = el("input", { type: "checkbox", id: `pp-sec-${key}`, title: info.hint });
		box.addEventListener("change", () => {
			if (!box.checked && current.sections.length <= 1) {
				box.checked = true;
				handlers.onRefuseEmpty?.(key);
				return;
			}
			handlers.onToggleSection(key, box.checked);
		});
		boxes.set(key, box);
		const label = el("label", { class: "sec", title: info.hint }, [box, el("span", { text: info.label })]);
		panel.append(label);
	}

	const summary = el("div", { class: "sump" });
	const root = el("div", { class: "preset-box" }, [row, panel, summary]);

	const render = (state: PresetControlsState): void => {
		current = { detail: state.detail, sections: [...state.sections] };
		const matched = presetForSections(current.sections);
		for (const { preset, chip } of chips) {
			const active = matched?.id === preset.id;
			chip.classList.toggle("active", active);
			chip.setAttribute("aria-pressed", String(active));
		}
		customChip.classList.toggle("hidden", Boolean(matched));
		customChip.classList.toggle("active", !matched);
		for (const [key, box] of boxes) box.checked = current.sections.includes(key);
		const depth = getMessage(
			"preset_depthLabel",
			[DETAIL_LABELS[current.detail]],
			`采集深浅：${DETAIL_LABELS[current.detail]}`,
		);
		const hotkey = getMessage(
			"preset_hotkeyLabel",
			[String(SECTION_PRESETS.length)],
			`Alt+1~${SECTION_PRESETS.length} 切换`,
		);
		const base = matched
			? getMessage(
					"preset_summaryPreset",
					[matched.label, depth, hotkey],
					`预设：${matched.label}｜${depth}｜${hotkey}`,
				)
			: getMessage(
					"preset_summaryCustom",
					[describeSections(current.sections), depth, hotkey],
					`${describeSections(current.sections)}｜${depth}｜${hotkey}`,
				);
		summary.textContent = state.notice ? `${base}｜⚠ ${state.notice}` : base;
	};

	setPanelOpen(false);
	return { root, setPanelOpen, render };
}
