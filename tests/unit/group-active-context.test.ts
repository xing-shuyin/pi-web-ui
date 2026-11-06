import { describe, expect, it, vi } from "vitest";
import {
	setActiveGroupRoomData,
	switchActiveGroupRightTab,
	updateActiveGroupField,
	getActiveGroupRightTab,
} from "../../web/src/group-active-context";

describe("group-active-context store", () => {
	it("preserves user selected right tab across repeated room data syncs", () => {
		setActiveGroupRoomData({
			roomId: "room-1",
			detail: null,
			devices: [],
			members: [],
			conversations: [],
			attentionCount: 0,
			disabled: false,
			conversationError: "",
		});

		switchActiveGroupRightTab("deliveries", false);

		setActiveGroupRoomData({
			roomId: "room-1",
			detail: null,
			devices: [{ id: "bot-1", name: "win" }],
			members: [{ id: "bot-1", name: "win" }],
			conversations: [],
			attentionCount: 1,
			disabled: false,
			conversationError: "",
		});

		expect(getActiveGroupRightTab()).toBe("deliveries");
	});

	it("auto expands right panel when tab is switched and panel was collapsed", () => {
		const toggleCollapse = vi.fn();
		updateActiveGroupField("onToggleCollapse", toggleCollapse);
		updateActiveGroupField("isRightCollapsed", true);

		switchActiveGroupRightTab("transfers", true);
		expect(toggleCollapse).toHaveBeenCalledTimes(1);
	});
});
