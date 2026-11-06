import { describe, expect, it } from "vitest";
import { computeDropdownShift, computePortalDropdownPosition } from "../../web/src/components/Dropdown";

describe("computeDropdownShift (Issue #252)", () => {
	it("在视口内正常容纳时无需平移 (shift === 0)", () => {
		const shiftLeft = computeDropdownShift({
			align: "left",
			triggerLeft: 500,
			triggerRight: 600,
			menuWidth: 450,
			viewportWidth: 1920,
		});
		expect(shiftLeft).toBe(0);

		const shiftRight = computeDropdownShift({
			align: "right",
			triggerLeft: 1500,
			triggerRight: 1600,
			menuWidth: 450,
			viewportWidth: 1920,
		});
		expect(shiftRight).toBe(0);
	});

	it("向左溢出时（Issue #252 经典复现场景：中窄屏/靠左触发器 + align=right），向右平移钳制在 margin 内", () => {
		const shift = computeDropdownShift({
			align: "right",
			triggerLeft: 100,
			triggerRight: 220,
			menuWidth: 550,
			viewportWidth: 900,
			margin: 8,
		});
		expect(shift).toBe(338);
		expect(220 - 550 + shift).toBe(8);
	});

	it("align=left 且触发器靠左但依然溢出左边界时，向右平移到 margin", () => {
		const shift = computeDropdownShift({
			align: "left",
			triggerLeft: -50,
			triggerRight: 50,
			menuWidth: 400,
			viewportWidth: 800,
			margin: 8,
		});
		expect(shift).toBe(58);
		expect(-50 + shift).toBe(8);
	});

	it("向右溢出时，向左平移钳制在视口右边缘内", () => {
		const shift = computeDropdownShift({
			align: "left",
			triggerLeft: 500,
			triggerRight: 600,
			menuWidth: 400,
			viewportWidth: 800,
			margin: 8,
		});
		expect(shift).toBe(-108);
		expect(500 + shift + 400).toBe(800 - 8);
	});

	it("菜单宽度大于视口可用宽度时，优先保证左侧在视野内 (left === margin)", () => {
		const shift = computeDropdownShift({
			align: "left",
			triggerLeft: 100,
			triggerRight: 200,
			menuWidth: 600,
			viewportWidth: 500,
			margin: 8,
		});
		expect(shift).toBe(-92);
		expect(100 + shift).toBe(8);
	});

	it("非正常尺寸（menuWidth <= 0 或 viewportWidth <= 0）时不产生平移", () => {
		expect(
			computeDropdownShift({
				align: "left",
				triggerLeft: 100,
				triggerRight: 200,
				menuWidth: 0,
				viewportWidth: 800,
			}),
		).toBe(0);

		expect(
			computeDropdownShift({
				align: "left",
				triggerLeft: 100,
				triggerRight: 200,
				menuWidth: 400,
				viewportWidth: 0,
			}),
		).toBe(0);
	});
});

describe("computePortalDropdownPosition (侧边栏与 Portal 菜单定位)", () => {
	const viewport = { viewportWidth: 1200, viewportHeight: 800 };
	const menu = { menuWidth: 340, menuHeight: 300 };

	it("左侧停靠栏 (direction=right): 默认在触发器右侧向内展开，垂直与触发器顶部平齐", () => {
		const pos = computePortalDropdownPosition({
			triggerRect: { left: 4, right: 34, top: 100, bottom: 130 },
			...menu,
			...viewport,
			direction: "right",
			gap: 6,
			margin: 8,
		});

		expect(pos.left).toBe(40);
		expect(pos.top).toBe(100);
	});

	it("左侧停靠栏 (direction=right): 靠近屏幕底部时，自动向上平移以贴底", () => {
		const pos = computePortalDropdownPosition({
			triggerRect: { left: 4, right: 34, top: 650, bottom: 680 },
			...menu,
			...viewport,
			direction: "right",
			gap: 6,
			margin: 8,
		});

		expect(pos.left).toBe(40);
		expect(pos.top).toBe(492);
	});

	it("右侧停靠栏 (direction=left): 默认在触发器左侧向内展开，垂直与触发器顶部平齐", () => {
		const pos = computePortalDropdownPosition({
			triggerRect: { left: 1166, right: 1196, top: 120, bottom: 150 },
			...menu,
			...viewport,
			direction: "left",
			gap: 6,
			margin: 8,
		});

		expect(pos.left).toBe(820);
		expect(pos.top).toBe(120);
	});

	it("右侧停靠栏 (direction=left): 左侧放不下且右侧放得下时，自动翻转到右侧", () => {
		const pos = computePortalDropdownPosition({
			triggerRect: { left: 200, right: 230, top: 150, bottom: 180 },
			...menu,
			...viewport,
			direction: "left",
			gap: 6,
			margin: 8,
		});

		expect(pos.left).toBe(236);
		expect(pos.top).toBe(150);
	});

	it("底栏 (direction=up): 默认在触发器上方弹出，上方不足时自动翻转到下方", () => {
		const posUp = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 750, bottom: 780 },
			...menu,
			...viewport,
			direction: "up",
			align: "left",
			gap: 6,
			margin: 8,
		});
		expect(posUp.top).toBe(750 - 300 - 6);
		expect(posUp.left).toBe(500);

		const posFlip = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 100, bottom: 130 },
			...menu,
			...viewport,
			direction: "up",
			align: "left",
			gap: 6,
			margin: 8,
		});
		expect(posFlip.top).toBe(130 + 6);
		expect(posFlip.left).toBe(500);
	});

	it("底栏 (direction=up): 居中输入框大弹窗（两边均不足），留在空间更大一侧并限制 maxHeight 防溢出", () => {
		const posCenter = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 450, bottom: 485 },
			menuWidth: 450,
			menuHeight: 600,
			viewportWidth: 1200,
			viewportHeight: 800,
			direction: "up",
			align: "left",
			gap: 6,
			margin: 8,
		});
		expect(posCenter.top).toBe(8);
		expect(posCenter.maxHeight).toBe(436);
		expect(posCenter.left).toBe(500);
		expect(posCenter.top).toBeGreaterThanOrEqual(8);
		expect(posCenter.top + (posCenter.maxHeight ?? 0) + 6).toBeLessThanOrEqual(450);
	});

	it("底栏 (direction=up): 触发器偏上居中且下方空间更大时，翻转到下方并限制 maxHeight", () => {
		const posFlipDown = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 300, bottom: 335 },
			menuWidth: 450,
			menuHeight: 600,
			viewportWidth: 1200,
			viewportHeight: 800,
			direction: "up",
			align: "left",
			gap: 6,
			margin: 8,
		});
		expect(posFlipDown.top).toBe(341);
		expect(posFlipDown.maxHeight).toBe(451);
		expect(posFlipDown.top + (posFlipDown.maxHeight ?? 0)).toBeLessThanOrEqual(800 - 8);
	});

	it("顶栏 (direction=down): 默认在触发器下方弹出，下方不足时自动翻转到上方", () => {
		const posDown = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 10, bottom: 40 },
			...menu,
			...viewport,
			direction: "down",
			align: "right",
			gap: 6,
			margin: 8,
		});
		expect(posDown.top).toBe(40 + 6);
		expect(posDown.left).toBe(600 - 340);

		const posFlip = computePortalDropdownPosition({
			triggerRect: { left: 500, right: 600, top: 600, bottom: 630 },
			...menu,
			...viewport,
			direction: "down",
			align: "right",
			gap: 6,
			margin: 8,
		});
		expect(posFlip.top).toBe(600 - 300 - 6);
		expect(posFlip.left).toBe(600 - 340);
	});

	it("异常尺寸（非正数尺寸）安全容错", () => {
		const posZero = computePortalDropdownPosition({
			triggerRect: { left: 50, right: 80, top: 100, bottom: 130 },
			menuWidth: 0,
			menuHeight: 0,
			viewportWidth: 800,
			viewportHeight: 600,
		});
		expect(posZero.left).toBe(50);
		expect(posZero.top).toBe(136);
	});
});
