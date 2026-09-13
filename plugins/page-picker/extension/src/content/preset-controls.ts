/// <reference lib="dom" />
/**
 * 拾取浮条里的「预设 + 逐项勾选」控件（content script 的 DOM 部件）。
 *
 * 为什么要有它：**六个预设原来只能在扩展选项页里点** —— 而「这次只要源码位置」「这次只看样式」
 * 这种判断，恰恰是站在页面上看着元素时才有的，为了改一个勾选去开 chrome://extensions 太远。
 * 现在浮条上直接切：chip 一键套预设，展开还能像选项页那样逐项勾。
 *
 * 三条纪律（都是会踩的坑）：
 * 1. **状态由外面给**：控件自己不藏状态，长什么样完全由 `render(state)` 决定 —— 否则
 *    「浮条显示标准、实际发出去的是精简」这种不一致迟早出现；
 * 2. **不允许勾到一项不剩**：空列表在契约里会回落成标准组合，用户会看到「我明明全取消了
 *    它还敢发」。取消最后一项直接拒绝 + 提示，比事后悄悄回落可预期；
 * 3. 交互全走回调（不碰 chrome.*、不碰采集器）—— 这样它能在 jsdom 里被完整单测
 *    （tests/unit/page-picker-preset-ui.test.ts）。
 */

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

export interface PresetControlsState {
	/** 采集深浅（由预设决定；逐项勾选不改它）。 */
	detail: DetailLevel;
	/** 当前要发的信息项（规范顺序，非空）。 */
	sections: PickSection[];
	/** 可选告警（比如「没同步到扩展设置」）—— 挂在摘要行尾，不用 toast 遮住浮条。 */
	notice?: string;
}

export interface PresetControlsHandlers {
	/** 点了某个预设 chip（id 来自 SECTION_PRESETS）。 */
	onPreset: (id: string) => void;
	/** 勾 / 取消某一项（只在这份组合合法时回调）。 */
	onToggleSection: (key: PickSection, on: boolean) => void;
	/** 想取消最后一项被拒：不改状态，提示一句就行。 */
	onRefuseEmpty?: (key: PickSection) => void;
}

export interface PresetControls {
	/** 塞进浮条：预设行 + 可折叠的勾选面板 + 一行摘要。 */
	root: HTMLElement;
	/** 展开 / 收起逐项勾选面板（默认收起：六个 chip 能解决绝大多数情况）。 */
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

/**
 * 造一套控件。返回的 `root` 由调用方插进浮条；所有状态变化都会回调出去，
 * 控件自己只负责「画」和「把点击翻译成回调」。
 */
export function createPresetControls(handlers: PresetControlsHandlers): PresetControls {
	let current: PresetControlsState = { detail: "standard", sections: [...PICK_SECTIONS] };
	let open = false;

	const row = el("div", { class: "presets" });
	row.append(el("span", { class: "plabel", text: "预设" }));

	const chips = SECTION_PRESETS.map((preset, i) => {
		const chip = el("button", {
			class: "chip",
			type: "button",
			"data-preset": preset.id,
			// 悬停能看到完整解释 + 键盘等价物（浮条上一行说明放不下这些）
			title: `${preset.label} — ${preset.hint}（Alt+${i + 1}）`,
			text: preset.short,
		});
		chip.addEventListener("click", () => handlers.onPreset(preset.id));
		row.append(chip);
		return { preset, chip };
	});

	// 当前组合谁也匹配不上时露个脸：让用户知道「你现在不是任何预设」
	const customChip = el("span", {
		class: "chip custom",
		title: "当前是自己勾的组合（点上面的 chip 可套预设）",
		text: "自定义",
	});
	// 「调整项」放右边，点开才是逐项勾选（浮条默认只占一行）
	const panelBtn = el("button", { class: "link", type: "button" });
	const setPanelOpen = (next: boolean): void => {
		open = next;
		panel.classList.toggle("hidden", !open);
		panelBtn.textContent = open ? "收起 ▴" : "调整项 ▾";
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
				box.checked = true; // 拒绝 → 把 UI 拨回去，不留「看起来取消了」的假状态
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
		// 摘要：命中预设时不再罗列每一项（chip 已经高亮了，罗列会白白撑成两行），
		// 但「采多深」要报 —— 逐项勾选只改内容项，深浅只由预设决定，用户得看得见这一点。
		const depth = `采集深浅：${DETAIL_LABELS[current.detail]}`;
		// 键盘入口写在这一行（信息条不可点、没地方挂 tooltip，chips 的悬停说明也只有鼠标能看见）
		const hotkey = `Alt+1~${SECTION_PRESETS.length} 切换`;
		const base = matched
			? `预设：${matched.label}｜${depth}｜${hotkey}` // 项数由预设决定，不必再报一遍
			: `${describeSections(current.sections)}｜${depth}｜${hotkey}`;
		summary.textContent = state.notice ? `${base}｜⚠ ${state.notice}` : base;
	};

	setPanelOpen(false);
	return { root, setPanelOpen, render };
}
