/**
 * 确认/取消草案失败要讲人话，并且能指出下一步（勾工具 / 改工作目录 / 稍后再试）。
 *
 * 之前这条路径把原因写进列表错误横幅，但横幅只渲染「加载失败 + 重试」，后端原因被丢掉了；
 * 现在草案区顶部直接显示可读原因（`detail` 优先，其次 `code`），因此文案映射必须独立可测。
 */
import { describe, expect, it } from "vitest";
import { DeviceGroupRequestError } from "../../web/src/components/DeviceGroupSection";
import { botDraftActionErrorText, botDraftActionFailureKind } from "../../web/src/bot-draft-action";

const words = {
	"needs-approval": "高权限工具没有全部勾上",
	"cwd-invalid": "工作目录无效",
	busy: "Bot 正在执行任务",
	missing: "草案已过期",
	failed: "操作失败",
};

describe("确认/取消草案的失败文案", () => {
	it("后端 detail 优先原样展示", () => {
		const error = new DeviceGroupRequestError(409, "BOT_BUSY", "Bot is busy; wait for all execution to stop");
		expect(botDraftActionErrorText(error, words)).toBe("Bot is busy; wait for all execution to stop");
	});

	it("没有 detail 时按 code 给出可操作原因", () => {
		expect(botDraftActionFailureKind(new DeviceGroupRequestError(409, "DRAFT_NEEDS_APPROVAL"))).toBe("needs-approval");
		expect(botDraftActionErrorText(new DeviceGroupRequestError(409, "DRAFT_NEEDS_APPROVAL"), words)).toBe(
			"高权限工具没有全部勾上",
		);
		expect(botDraftActionErrorText(new DeviceGroupRequestError(400, "BOT_CWD_INVALID"), words)).toBe("工作目录无效");
		expect(botDraftActionErrorText(new DeviceGroupRequestError(409, "BOT_BUSY"), words)).toBe("Bot 正在执行任务");
		expect(botDraftActionErrorText(new DeviceGroupRequestError(404, "DRAFT_MISSING"), words)).toBe("草案已过期");
	});

	it("未知 code 落到兜底文案并带上 code", () => {
		expect(botDraftActionFailureKind(new DeviceGroupRequestError(500, "BOT_PANEL_FAILED"))).toBe("failed");
		expect(botDraftActionErrorText(new DeviceGroupRequestError(500, "BOT_PANEL_FAILED"), words)).toBe(
			"操作失败（BOT_PANEL_FAILED）",
		);
		expect(botDraftActionErrorText(new DeviceGroupRequestError(500, ""), words)).toBe("操作失败");
	});

	it("非接口异常（网络/超时）保留原文但带兜底前缀", () => {
		expect(botDraftActionFailureKind(new Error("Failed to fetch"))).toBe("failed");
		expect(botDraftActionErrorText(new Error("Failed to fetch"), words)).toBe("操作失败：Failed to fetch");
		expect(botDraftActionErrorText(undefined, words)).toBe("操作失败");
	});
});
