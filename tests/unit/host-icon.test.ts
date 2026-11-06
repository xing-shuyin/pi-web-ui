import { describe, expect, it } from "vitest";
import { BUILTIN_UI_ITEMS } from "../../web/src/ui-slots.js";
import { HOST_ICON_NAMES } from "../../web/src/host-icon.js";

describe("host icon names", () => {
	it("BUILTIN_UI_ITEMS 里的每个 icon 名字都已登记预览图标", () => {
		const known = new Set(HOST_ICON_NAMES);
		const missing = BUILTIN_UI_ITEMS.map((item) => item.icon).filter(
			(icon): icon is string => typeof icon === "string" && /[a-z]/i.test(icon) && !known.has(icon),
		);
		expect([...new Set(missing)]).toEqual([]);
	});

	it("名字表不含空串（脏值会画成空白节点）", () => {
		expect(HOST_ICON_NAMES.every((n) => n.length > 0)).toBe(true);
	});
});
