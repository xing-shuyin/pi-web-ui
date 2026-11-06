import { describe, expect, it } from "vitest";
import { computeFloatingPosition } from "../../web/src/use-floating-panel.js";

describe("computeFloatingPosition", () => {
	const viewport = { width: 1000, height: 800 };

	it("默认右对齐：面板右缘与触发器右缘对齐，挂在下方", () => {
		const anchor = { left: 400, right: 500, top: 100, bottom: 130 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport);
		expect(pos.x).toBe(300);
		expect(pos.y).toBe(136);
	});

	it("左对齐：面板左缘与触发器左缘对齐", () => {
		const anchor = { left: 400, right: 500, top: 100, bottom: 130 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { align: "left" });
		expect(pos.x).toBe(400);
		expect(pos.y).toBe(136);
	});

	it("右边缘超出视口时安全钳制（右侧留出 margin）", () => {
		const anchor = { left: 900, right: 980, top: 100, bottom: 130 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { align: "left", margin: 10 });
		expect(pos.x).toBe(790);
	});

	it("左边缘超出视口时安全钳制（左侧留出 margin）", () => {
		const anchor = { left: 50, right: 100, top: 100, bottom: 130 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { align: "right", margin: 10 });
		expect(pos.x).toBe(10);
	});

	it("下方放不下时自动向上翻转", () => {
		const anchor = { left: 400, right: 500, top: 720, bottom: 750 };
		const panel = { width: 200, height: 150 };

		const pos = computeFloatingPosition(anchor, panel, viewport);
		expect(pos.y).toBe(564);
	});

	it("上下两边都放不下但能在视口内完整展示：钳制在视口底部安全区域", () => {
		const anchor = { left: 400, right: 500, top: 400, bottom: 430 };
		const panel = { width: 200, height: 750 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { margin: 8 });
		expect(pos.y).toBe(42);
	});

	it("面板高度超出视口时贴顶钳制（y = margin，留出空间由内部 max-height 滚动）", () => {
		const anchor = { left: 400, right: 500, top: 400, bottom: 430 };
		const panel = { width: 200, height: 900 };

		const pos = computeFloatingPosition(anchor, panel, viewport, { margin: 8 });
		expect(pos.y).toBe(8);
	});

	it("side='top'：上方放得下在上方，放不下翻转到下方", () => {
		const panel = { width: 200, height: 100 };
		const anchor1 = { left: 400, right: 500, top: 300, bottom: 330 };
		const pos1 = computeFloatingPosition(anchor1, panel, viewport, { side: "top", gap: 5 });
		expect(pos1.y).toBe(300 - 100 - 5);

		const anchor2 = { left: 400, right: 500, top: 50, bottom: 80 };
		const pos2 = computeFloatingPosition(anchor2, panel, viewport, { side: "top", gap: 5 });
		expect(pos2.y).toBe(85);
	});
});
