// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	PICK_SECTIONS,
	SECTION_PRESETS,
	applySectionToggle,
	describeSections,
	presetHotkeyIndex,
	presetShortLabel,
	sectionsForDepth,
	type PickSection,
} from "../../plugins/page-picker/extension/src/shared/contract.js";
import { createPresetControls } from "../../plugins/page-picker/extension/src/content/preset-controls.js";

/**
 * 拾取浮条上的「预设 + 逐项勾选」控件（内容脚本的 DOM 部件）。
 *
 * 为什么钉它：六个预设原来**只能在扩展选项页里点**，而「这次只要源码位置」这种判断恰恰是
 * 站在页面上看着元素时才有的 —— 现在这条路径挂在浮条上，它坏了就等于功能没做。
 * 两条最要紧的规矩：
 * - 控件**自己不藏状态**（长什么样全看 render(state)），否则会出现「浮条显示标准、
 *   实际发出去精简」；
 * - **不允许勾到一项不剩**（空列表在契约里会回落标准组合，用户会以为「我全取消了它还发」）。
 *
 * 这里用真 DOM（jsdom）点真按钮，而不是断言实现细节：点击 → 回调 → 再 render 的闭环才是有意义的那部分。
 */

const standard = (): PickSection[] => [...sectionsForDepth("standard")];

function mount(): {
	onPreset: ReturnType<typeof vi.fn>;
	onToggleSection: ReturnType<typeof vi.fn>;
	onRefuseEmpty: ReturnType<typeof vi.fn>;
	controls: ReturnType<typeof createPresetControls>;
} {
	const onPreset = vi.fn();
	const onToggleSection = vi.fn();
	const onRefuseEmpty = vi.fn();
	const controls = createPresetControls({ onPreset, onToggleSection, onRefuseEmpty });
	document.body.innerHTML = "";
	document.body.append(controls.root);
	return { onPreset, onToggleSection, onRefuseEmpty, controls };
}

const chip = (id: string): HTMLButtonElement => {
	const node = document.querySelector<HTMLButtonElement>(`.chip[data-preset="${id}"]`);
	if (!node) throw new Error(`missing chip ${id}`);
	return node;
};
const customChip = (): HTMLElement => {
	const node = document.querySelector<HTMLElement>(".chip.custom");
	if (!node) throw new Error("missing custom chip");
	return node;
};
const box = (key: PickSection): HTMLInputElement => {
	const node = document.getElementById(`pp-sec-${key}`) as HTMLInputElement | null;
	if (!node) throw new Error(`missing checkbox ${key}`);
	return node;
};
const panel = (): HTMLElement => document.querySelector<HTMLElement>(".sections") as HTMLElement;
const summary = (): string => document.querySelector(".sump")?.textContent ?? "";

/** 勾 / 取消勾一个 checkbox（真 DOM 事件，走控件自己的 change 处理）。 */
function toggle(key: PickSection, on: boolean): void {
	box(key).checked = on;
	box(key).dispatchEvent(new Event("change"));
}

describe("预设表与纯逻辑（浮条与选项页共用）", () => {
	it("六个预设各自有唯一短名（浮条上放不下长 label）", () => {
		expect(SECTION_PRESETS.length).toBe(6);
		const shorts = SECTION_PRESETS.map((p) => p.short);
		expect(shorts.every((s) => s.trim().length > 0)).toBe(true);
		expect(new Set(shorts).size).toBe(shorts.length);
		// 短名要短到能塞进一排 chip
		expect(shorts.every((s) => s.length <= 5)).toBe(true);
	});

	it("presetShortLabel：命中预设用短名，混合组合是「自定义」", () => {
		expect(presetShortLabel(standard())).toBe("标准");
		expect(presetShortLabel(["selector", "source"])).toBe("改对地方");
		expect(presetShortLabel(["selector", "text", "skeleton"])).toBe("文案");
		expect(presetShortLabel(["selector", "source", "styles"])).toBe("自定义");
	});

	it("applySectionToggle：加/删都对，且结果一律按 PICK_SECTIONS 规范排序", () => {
		// 故意乱序传入：存储与「是不是某个预设」的比较都不该被顺序影响
		expect(applySectionToggle(["source", "selector"], "text", true)).toEqual(["selector", "source", "text"]);
		expect(applySectionToggle(standard(), "skeleton", false)).toEqual([
			"page",
			"selector",
			"source",
			"text",
			"rules",
			"styles",
		]);
		// 幂等：重复加不重复出现
		expect(applySectionToggle(["selector"], "selector", true)).toEqual(["selector"]);
		// 取消到空也要如实返回（由调用方决定要不要拒绝）
		expect(applySectionToggle(["selector"], "selector", false)).toEqual([]);
		expect(PICK_SECTIONS).toContain("skeleton");
	});

	it("describeSections：一份文案说清「发什么 + 是不是预设」，空列表也不含糊", () => {
		expect(describeSections(standard())).toContain("当前发送：");
		expect(describeSections(standard())).toContain("预设：标准（推荐）");
		expect(describeSections(["selector", "source", "styles"])).toContain("自定义");
		expect(describeSections([])).toContain("回落标准组合");
	});

	it("presetHotkeyIndex：Alt+1~6 认，别的组合键一概不认", () => {
		expect(presetHotkeyIndex({ key: "1", code: "Digit1", altKey: true })).toBe(1);
		expect(presetHotkeyIndex({ key: "6", code: "Digit6", altKey: true })).toBe(6);
		// macOS：Option+1 打出来的是 ¡，key 不是数字，但 code 还是 Digit1
		expect(presetHotkeyIndex({ key: "¡", code: "Digit1", altKey: true })).toBe(1);
		// AZERTY 等布局：code 认不出时靠 key 兜底
		expect(presetHotkeyIndex({ key: "3", code: "Numpad3", altKey: true })).toBe(3);
		expect(presetHotkeyIndex({ key: "7", code: "Digit7", altKey: true })).toBe(0); // 只认 6 个预设
		expect(presetHotkeyIndex({ key: "1", code: "Digit1" })).toBe(0); // 没有 Alt
		expect(presetHotkeyIndex({ key: "1", code: "Digit1", altKey: true, ctrlKey: true })).toBe(0);
		expect(presetHotkeyIndex({ key: "1", code: "Digit1", altKey: true, metaKey: true })).toBe(0);
	});
});

describe("浮条上的预设控件", () => {
	it("六个预设 chip + 逐项勾选面板 + 摘要都渲染出来（面板默认收起，浮条只占一行）", () => {
		const { controls } = mount();
		controls.render({ detail: "standard", sections: standard() });

		expect(document.querySelectorAll(".chip[data-preset]").length).toBe(6);
		expect(document.querySelectorAll(".sections input[type=checkbox]").length).toBe(8);
		expect(panel().classList.contains("hidden")).toBe(true);
		expect(summary()).toContain("预设：标准（推荐）");
		expect(summary()).toContain("采集深浅：标准");
	});

	it("render 反映状态：命中的 chip 高亮、勾选项与存储一致、没命中就露「自定义」", () => {
		const { controls } = mount();
		controls.render({ detail: "compact", sections: standard() });
		expect(chip("standard").classList.contains("active")).toBe(true);
		expect(chip("lean").classList.contains("active")).toBe(false);
		expect(customChip().classList.contains("hidden")).toBe(true);

		controls.render({ detail: "standard", sections: ["selector", "source"] });
		expect(chip("source").classList.contains("active")).toBe(true);
		expect(box("selector").checked).toBe(true);
		expect(box("skeleton").checked).toBe(false);

		controls.render({ detail: "standard", sections: ["selector", "source", "styles"] });
		expect(customChip().classList.contains("hidden")).toBe(false);
		expect(customChip().classList.contains("active")).toBe(true);
	});

	it("点 chip → 回调预设 id（控件自己不猜「点了以后该是什么状态」）", () => {
		const { controls, onPreset } = mount();
		controls.render({ detail: "standard", sections: standard() });

		chip("lean").click();
		chip("styles").click();
		expect(onPreset.mock.calls.map((c) => c[0])).toEqual(["lean", "styles"]);
	});

	it("chip 的悬停说明带完整含义 + 键盘等价物（浮条上没地方写这些）", () => {
		const { controls } = mount();
		controls.render({ detail: "standard", sections: standard() });
		expect(chip("lean").title).toContain("精简（最省上下文）");
		expect(chip("lean").title).toContain("Alt+1");
		expect(chip("text").title).toContain("Alt+6");
	});

	it("摘要行可以挂告警（写回设置失败时用，不拿 toast 遮住浮条）", () => {
		const { controls } = mount();
		controls.render({ detail: "standard", sections: standard(), notice: "没同步到扩展设置（这次的选择只在本页生效）" });
		expect(summary()).toContain("⚠ 没同步到扩展设置");

		// 下一次选择（成功时）不该还挂着上一条告警
		controls.render({ detail: "standard", sections: standard() });
		expect(summary()).not.toContain("⚠");
	});

	it("点「调整项」展开逐项勾选（默认收起）", () => {
		const { controls } = mount();
		controls.render({ detail: "standard", sections: standard() });
		const btn = document.querySelector<HTMLButtonElement>(".link") as HTMLButtonElement;

		btn.click();
		expect(panel().classList.contains("hidden")).toBe(false);
		expect(btn.textContent).toContain("收起");

		btn.click();
		expect(panel().classList.contains("hidden")).toBe(true);
		expect(btn.textContent).toContain("调整项");
	});

	it("勾 / 取消勾一项 → 回调 (key, on)，控件不自己改内容", () => {
		const { controls, onToggleSection } = mount();
		controls.render({ detail: "standard", sections: standard() });

		toggle("skeleton", false);
		toggle("locator", true);
		expect(onToggleSection.mock.calls).toEqual([
			["skeleton", false],
			["locator", true],
		]);
	});

	it("**不允许勾到一项不剩**：拒绝改动、把 checkbox 拨回去、并提示", () => {
		const { controls, onToggleSection, onRefuseEmpty } = mount();
		controls.render({ detail: "standard", sections: ["selector"] });

		toggle("selector", false);

		expect(onToggleSection).not.toHaveBeenCalled(); // 状态没变
		expect(onRefuseEmpty).toHaveBeenCalledWith("selector");
		// 关键：UI 不能停在「看起来取消了」的假状态上（否则用户以为发的东西变了）
		expect(box("selector").checked).toBe(true);

		// 还有别的项时照常允许取消
		controls.render({ detail: "standard", sections: ["selector", "source"] });
		toggle("selector", false);
		expect(onToggleSection).toHaveBeenCalledWith("selector", false);
	});
});
