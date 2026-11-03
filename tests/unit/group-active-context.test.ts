import { describe, expect, it, vi } from "vitest";
import {
	setActiveGroupRoomData,
	switchActiveGroupRightTab,
	updateActiveGroupField,
	getActiveGroupRightTab,
} from "../../web/src/group-active-context";

describe("group-active-context store", () => {
	it("preserves user selected right tab across repeated room data syncs", () => {
		// 1. 初始化房间数据
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

		// 2. 用户切换到交付待办
		switchActiveGroupRightTab("deliveries", false);

		// 3. 模拟后台轮询 / 鼠标移动导致群组件触发数据同步
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

		// 4. 用户的选择必须严格保持在 deliveries，绝不能被重置为 files
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
