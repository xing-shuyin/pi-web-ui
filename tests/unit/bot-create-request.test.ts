// @vitest-environment jsdom
/**
 * 「手动填写」= 就地弹窗：左栏的加号不该把用户送去设备中心再送回来。
 * 这里守两件事：请求只走本视图事件（不再调 `openBotManagement`），订阅/退订成对。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../web/src/components/DeviceGroupSection", () => ({
	DEVICE_GROUPS_CHANGED: "pi-web-ui:device-groups-changed",
	deviceGroupRequest: vi.fn(),
}));
vi.mock("../../web/src/bot-chat", () => ({ openBotManagement: vi.fn() }));

const { requestBotCreate, subscribeBotCreateRequest } = await import("../../web/src/bot-create");
const { openBotManagement } = await import("../../web/src/bot-chat");

describe("手动新建 Bot 的请求", () => {
	it("请求只在当前视图派发，不再切设备中心", () => {
		const handler = vi.fn();
		const off = subscribeBotCreateRequest(handler);
		requestBotCreate();
		expect(handler).toHaveBeenCalledTimes(1);
		expect(openBotManagement).not.toHaveBeenCalled();
		off();
	});

	it("退订后不再收到请求", () => {
		const handler = vi.fn();
		const off = subscribeBotCreateRequest(handler);
		off();
		requestBotCreate();
		expect(handler).not.toHaveBeenCalled();
	});
});
