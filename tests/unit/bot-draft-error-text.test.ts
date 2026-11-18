/**
 * 「让 AI 起草」失败时要讲人话。
 *
 * 之前的界面直接显示 `Device group request failed (502)`：用户看到 502，
 * 但真正原因（套餐不含这个模型 / 超时 / 模型乱答）全被丢掉了。
 */
import { describe, expect, it } from "vitest";
import { DeviceGroupRequestError } from "../../web/src/components/DeviceGroupSection";
import { botDraftFailureKind, botDraftFailureText } from "../../web/src/bot-create";

const words = {
	"no-model": "起草需要模型：先在模型设置里选一个可用模型。",
	unparsable: "模型返回的内容不是可用的草案，重试一次或改手动填写。",
	timeout: "起草超时了，重试一次或改手动填写。",
	request: "先写一句话描述它，或者改成手动填写。",
	workspace: "当前工作区不能作为 Bot 的项目（主目录、磁盘根目录或数据目录内）。先在左栏切到具体项目再创建。",
	failed: "起草失败（模型调用出错）：{detail}",
};

describe("起草失败文案", () => {
	it("模型层报错把服务端 detail 拼进去", () => {
		const error = new DeviceGroupRequestError(
			502,
			"DRAFT_FAILED",
			"400: Model cat-jam-free isn't included in OpenCode Go.",
		);
		expect(botDraftFailureKind(error)).toBe("failed");
		expect(botDraftFailureText(error, words)).toBe(
			"起草失败（模型调用出错）：400: Model cat-jam-free isn't included in OpenCode Go.",
		);
	});

	it("没有 detail 时不留下空的占位尾巴，但保留 HTTP 状态（区分网关/服务端）", () => {
		expect(botDraftFailureText(new DeviceGroupRequestError(502, "DRAFT_FAILED"), words)).toBe(
			"起草失败（模型调用出错）（HTTP 502）",
		);
	});

	it("超时/解析失败/无模型各走各的文案", () => {
		expect(botDraftFailureKind(new DeviceGroupRequestError(504, "DRAFT_TIMEOUT"))).toBe("timeout");
		expect(botDraftFailureKind(new DeviceGroupRequestError(502, "DRAFT_UNPARSEABLE"))).toBe("unparsable");
		expect(botDraftFailureKind(new DeviceGroupRequestError(409, "DRAFT_NO_MODEL"))).toBe("no-model");
		expect(botDraftFailureText(new DeviceGroupRequestError(504, "DRAFT_TIMEOUT", "aborted"), words)).toBe(
			"起草超时了，重试一次或改手动填写。",
		);
	});

	it("工作区不合法走专门文案，不拼上游英文", () => {
		expect(botDraftFailureKind(new DeviceGroupRequestError(400, "WORKSPACE_INVALID"))).toBe("workspace");
		expect(
			botDraftFailureText(
				new DeviceGroupRequestError(400, "WORKSPACE_INVALID", "Home and volume roots cannot be projects"),
				words,
			),
		).toBe(words.workspace);
	});

	it("非草案错误（网络异常等）落到兜底文案", () => {
		expect(botDraftFailureKind(new Error("Failed to fetch"))).toBe("failed");
		expect(botDraftFailureText(new Error("Failed to fetch"), words)).toBe("起草失败（模型调用出错）");
	});
});
