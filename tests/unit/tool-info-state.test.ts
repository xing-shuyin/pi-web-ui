import { afterEach, describe, expect, it } from "vitest";
import { setAppSend } from "../../web/src/app-globals.js";
import {
	closeToolInfo,
	getToolInfoState,
	openToolInfo,
	receiveToolInfo,
	resetToolInfo,
	subscribeToolInfo,
	type ToolInfoPayload,
	toolInfoView,
} from "../../web/src/tool-info-state.js";

let sent: unknown[] = [];

function stubSend() {
	sent = [];
	setAppSend((msg) => {
		sent.push(msg);
		return true;
	});
}

afterEach(() => {
	setAppSend(null);
	resetToolInfo();
});

function payload(over: Partial<ToolInfoPayload> = {}): ToolInfoPayload {
	return { type: "tool_info", name: "bash", found: true, ...over } as ToolInfoPayload;
}

describe("toolInfoView", () => {
	it("unsupported 优先于 missing（「引擎不支持」和「没这个工具」含义不同）", () => {
		expect(toolInfoView(payload({ unsupported: true })).status).toBe("unsupported");
		expect(toolInfoView(payload({ found: false, unsupported: true })).status).toBe("unsupported");
	});

	it("found 不为 true → missing", () => {
		expect(toolInfoView(payload({ found: false })).status).toBe("missing");
		expect(toolInfoView({ type: "tool_info", name: "x" } as ToolInfoPayload).status).toBe("missing");
	});

	it("有定义 → ready，字段齐全", () => {
		const view = toolInfoView(
			payload({
				label: "Shell",
				description: "跑命令",
				promptSnippet: "bash: run a command",
				promptGuidelines: ["别用管道"],
				parameters: { type: "object" },
				active: true,
				source: "builtin",
				scope: "user",
			}),
		);
		expect(view).toEqual({
			name: "bash",
			status: "ready",
			label: "Shell",
			description: "跑命令",
			promptSnippet: "bash: run a command",
			promptGuidelines: ["别用管道"],
			parameters: { type: "object" },
			active: true,
			source: "builtin",
			scope: "user",
		});
	});

	it("可选字段缺省/空值时不出现在视图里（渲染层按有无判空）", () => {
		const view = toolInfoView(payload({ label: "", description: "", source: "" }));
		expect(view).toEqual({ name: "bash", status: "ready" });
		expect("promptGuidelines" in view).toBe(false);
		expect("parameters" in view).toBe(false);
	});

	it("promptGuidelines 空数组忽略、非数组忽略", () => {
		expect(toolInfoView(payload({ promptGuidelines: [] })).promptGuidelines).toBeUndefined();
		expect(toolInfoView(payload({ promptGuidelines: "nope" as unknown as string[] })).promptGuidelines).toBeUndefined();
	});

	it("active 只认布尔：其它真值不当「已启用」", () => {
		expect(toolInfoView(payload({ active: false })).active).toBe(false);
		expect(toolInfoView(payload({ active: "yes" as unknown as boolean })).active).toBeUndefined();
		expect(toolInfoView(payload({ active: 1 as unknown as boolean })).active).toBeUndefined();
	});

	it("parametersDropped 只在 true 时标记", () => {
		expect(toolInfoView(payload({ parametersDropped: true })).parametersDropped).toBe(true);
		expect(toolInfoView(payload({ parametersDropped: false })).parametersDropped).toBeUndefined();
	});

	it("name 不是字符串时回落到空串（脏载荷不炸渲染）", () => {
		expect(toolInfoView({ type: "tool_info", name: 42 } as unknown as ToolInfoPayload).name).toBe("");
	});
});

describe("store：打开 / 应答 / 关闭", () => {
	it("空工具名（含纯空白）什么都不做：不发请求、状态不变", () => {
		stubSend();
		openToolInfo("");
		openToolInfo("   ");
		expect(sent).toEqual([]);
		expect(getToolInfoState()).toBeNull();
	});

	it("打开 = 立刻 loading + 发一条 get_tool_info", () => {
		stubSend();
		openToolInfo("  bash  ");
		expect(sent).toEqual([{ type: "get_tool_info", name: "bash" }]);
		expect(getToolInfoState()).toEqual({ name: "bash", status: "loading" });
	});

	it("应答对上工具名 → 换成 ready 的定义", () => {
		stubSend();
		openToolInfo("bash");
		receiveToolInfo(payload({ description: "跑命令" }));
		expect(getToolInfoState()?.status).toBe("ready");
		expect(getToolInfoState()?.description).toBe("跑命令");
	});

	it("迟到的应答（工具名不符）被忽略，不覆盖当前那条", () => {
		stubSend();
		openToolInfo("read");
		receiveToolInfo(payload({ name: "bash", description: "不该出现" }));
		expect(getToolInfoState()).toEqual({ name: "read", status: "loading" });
	});

	it("关掉弹窗后迟到的应答不会把它重新弹出来", () => {
		stubSend();
		openToolInfo("bash");
		closeToolInfo();
		receiveToolInfo(payload({ description: "跑命令" }));
		expect(getToolInfoState()).toBeNull();
	});

	it("订阅：open / receive / close 各通知一次；已经关着时 close 不再通知", () => {
		stubSend();
		let n = 0;
		const unsub = subscribeToolInfo(() => n++);
		openToolInfo("bash");
		expect(n).toBe(1);
		receiveToolInfo(payload());
		expect(n).toBe(2);
		closeToolInfo();
		expect(n).toBe(3);
		closeToolInfo();
		expect(n).toBe(3);
		unsub();
		openToolInfo("read");
		expect(n).toBe(3);
	});

	it("未打开时快照引用恒定（useSyncExternalStore 不会判定「每次都变」）", () => {
		expect(getToolInfoState()).toBe(getToolInfoState());
		openToolInfo("bash");
		const first = getToolInfoState();
		expect(getToolInfoState()).toBe(first);
		receiveToolInfo(payload());
		const second = getToolInfoState();
		expect(second).not.toBe(first);
		expect(getToolInfoState()).toBe(second);
	});

	it("resetToolInfo 清空（用例之间不串）", () => {
		stubSend();
		openToolInfo("bash");
		resetToolInfo();
		expect(getToolInfoState()).toBeNull();
	});
});
