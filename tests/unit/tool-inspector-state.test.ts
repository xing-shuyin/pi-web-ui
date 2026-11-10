import { afterEach, describe, expect, it } from "vitest";
import {
	closeToolInspector,
	getToolInspectorState,
	isFlowMode,
	openToolInspector,
	retargetToolInspector,
	subscribeToolInspector,
	updateToolInspectorLive,
} from "../../web/src/tool-inspector-state.js";
import { resolveInspectorStatus } from "../../web/src/components/ToolInspectorModal.js";

afterEach(() => {
	closeToolInspector();
});

describe("tool-inspector-state store", () => {
	it("初始状态为 null", () => {
		expect(getToolInspectorState()).toBeNull();
	});

	it("openToolInspector 设置状态并触发订阅回调", () => {
		let notified = 0;
		const unsub = subscribeToolInspector(() => {
			notified++;
		});

		openToolInspector({
			isThinking: false,
			name: "bash",
			title: "bash()",
			status: "已完成",
			statusClass: "ok",
			args: '{"command":"ls"}',
			output: "file.txt",
		});

		expect(notified).toBe(1);
		const s = getToolInspectorState();
		expect(s).not.toBeNull();
		expect(s?.name).toBe("bash");
		expect(s?.status).toBe("已完成");
		expect(s?.isThinking).toBe(false);

		unsub();
	});

	it("closeToolInspector 重置状态为 null 并通知订阅者", () => {
		openToolInspector({
			isThinking: true,
			title: "思考过程",
			output: "深度思考内容...",
		});
		expect(getToolInspectorState()).not.toBeNull();

		let notified = 0;
		const unsub = subscribeToolInspector(() => {
			notified++;
		});

		closeToolInspector();
		expect(getToolInspectorState()).toBeNull();
		expect(notified).toBe(1);

		closeToolInspector();
		expect(notified).toBe(1);

		unsub();
	});

	it("updateToolInspectorLive 在 toolCallId 匹配且种类一致时平滑更新并通知", () => {
		openToolInspector({
			isThinking: false,
			name: "bash",
			title: "bash()",
			status: "执行中...",
			statusClass: "run",
			toolCallId: "call_bash_123",
			output: "line 1\n",
		});

		let notified = 0;
		const unsub = subscribeToolInspector(() => {
			notified++;
		});

		updateToolInspectorLive("call_bash_123", {
			output: "line 1\nline 2\n",
		});
		expect(notified).toBe(1);
		expect(getToolInspectorState()?.output).toBe("line 1\nline 2\n");

		updateToolInspectorLive("call_different_456", {
			output: "should not update",
		});
		expect(notified).toBe(1);
		expect(getToolInspectorState()?.output).toBe("line 1\nline 2\n");

		updateToolInspectorLive("call_bash_123", {
			output: "line 1\nline 2\n",
		});
		expect(notified).toBe(1);

		unsub();
	});

	it("思考弹窗能被思考增量持续刷新（流式思考不能定格在打开时的快照）", () => {
		openToolInspector({
			isThinking: true,
			title: "思考过程",
			statusClass: "run",
			streaming: true,
			toolCallId: "msg_1:thinking:0",
			thinking: "先看",
			output: "先看",
		});

		let notified = 0;
		const unsub = subscribeToolInspector(() => {
			notified++;
		});

		updateToolInspectorLive(
			"msg_1:thinking:0",
			{ thinking: "先看目录", output: "先看目录", streaming: true, statusClass: "run" },
			"thinking",
		);
		expect(notified).toBe(1);
		expect(getToolInspectorState()?.thinking).toBe("先看目录");

		updateToolInspectorLive(
			"msg_1:thinking:0",
			{ thinking: "先看目录，再读文件", output: "先看目录，再读文件", streaming: false, statusClass: "ok" },
			"thinking",
		);
		expect(notified).toBe(2);
		expect(getToolInspectorState()?.streaming).toBe(false);

		unsub();
	});

	it("工具增量不得覆盖已打开的思考弹窗（两条流不串台）", () => {
		openToolInspector({
			isThinking: true,
			title: "思考过程",
			toolCallId: "shared_id",
			thinking: "思考内容",
			output: "思考内容",
		});

		let notified = 0;
		const unsub = subscribeToolInspector(() => {
			notified++;
		});

		updateToolInspectorLive("shared_id", { output: "工具输出" });
		expect(notified).toBe(0);
		expect(getToolInspectorState()?.output).toBe("思考内容");

		unsub();
	});

	it("retargetToolInspector 只迁移同一个弹窗的归属 id", () => {
		openToolInspector({
			isThinking: true,
			toolCallId: "stream-1:thinking:0",
			thinking: "思考",
			output: "思考",
		});

		let notified = 0;
		const unsub = subscribeToolInspector(() => {
			notified++;
		});

		expect(retargetToolInspector("other-id", "a-1:thinking:0")).toBe(false);
		expect(getToolInspectorState()?.toolCallId).toBe("stream-1:thinking:0");
		expect(notified).toBe(0);

		expect(retargetToolInspector("stream-1:thinking:0", "a-1:thinking:0")).toBe(true);
		expect(getToolInspectorState()?.toolCallId).toBe("a-1:thinking:0");
		expect(notified).toBe(1);

		unsub();
	});

	it("思考增量不得覆盖已打开的工具弹窗（两条流不串台）", () => {
		openToolInspector({
			isThinking: false,
			name: "bash",
			toolCallId: "shared_id",
			output: "工具输出",
		});

		let notified = 0;
		const unsub = subscribeToolInspector(() => {
			notified++;
		});

		updateToolInspectorLive("shared_id", { thinking: "思考内容", output: "思考内容" }, "thinking");
		expect(notified).toBe(0);
		expect(getToolInspectorState()?.output).toBe("工具输出");

		unsub();
	});
});

describe("resolveInspectorStatus 检查器状态机单源化", () => {
	const mockT = ((key: string) => {
		const map: Record<string, string> = {
			done: "已完成",
			error: "执行出错",
			running: "执行中...",
		};
		return map[key] || key;
	}) as any;

	it("在 running（正在执行）态下：顶底栏统一显示执行中，严禁出现勾号与已完成", () => {
		const meta = resolveInspectorStatus(
			{
				isThinking: false,
				name: "bash",
				status: "执行中...",
				statusClass: "run",
				output: "19 行输出",
			},
			mockT,
			true,
		);

		expect(meta.isRunning).toBe(true);
		expect(meta.badgeClass).toBe("run");
		expect(meta.statusIcon).toBe("⟳");
		expect(meta.badgeText).toBe("执行中...");
		expect(meta.footerText).toBe("执行中...");
		expect(meta.badgeText).not.toContain("已完成");
		expect(meta.footerText).not.toContain("执行完成");
		expect(meta.statusIcon).not.toBe("✓");
	});

	it("在完成态下：顶底栏显示完成态与耗时", () => {
		const meta = resolveInspectorStatus(
			{
				isThinking: false,
				name: "bash",
				status: "已完成",
				statusClass: "ok",
				duration: "1.2s",
			},
			mockT,
			true,
		);

		expect(meta.isRunning).toBe(false);
		expect(meta.badgeClass).toBe("ok");
		expect(meta.statusIcon).toBe("✓");
		expect(meta.badgeText).toBe("已完成 (1.2s)");
		expect(meta.footerText).toBe("执行完成");
	});

	it("在错误态下：显示失败图标与错误文本", () => {
		const meta = resolveInspectorStatus(
			{
				isThinking: false,
				name: "bash",
				status: "命令执行失败",
				statusClass: "err",
				isError: true,
				exitHint: "exit 127",
			},
			mockT,
			true,
		);

		expect(meta.isRunning).toBe(false);
		expect(meta.badgeClass).toBe("err");
		expect(meta.statusIcon).toBe("✕");
		expect(meta.footerText).toBe("exit 127");
	});
});

describe("isFlowMode 极简行文模式检测", () => {
	afterEach(() => {
		if (typeof document !== "undefined") {
			delete document.documentElement.dataset.theme;
			const link = document.getElementById("theme-stylesheet");
			link?.remove();
		}
	});

	it("在 dataset.theme 匹配 flow 相关主题时返回 true", () => {
		if (typeof document === "undefined") return;

		document.documentElement.dataset.theme = "flow";
		expect(isFlowMode()).toBe(true);

		document.documentElement.dataset.theme = "flow-light";
		expect(isFlowMode()).toBe(true);

		document.documentElement.dataset.theme = "wallpaper-flow";
		expect(isFlowMode()).toBe(true);

		document.documentElement.dataset.theme = "dark";
		expect(isFlowMode()).toBe(false);
	});

	it("在 theme-stylesheet 包含 flow 时返回 true", () => {
		if (typeof document === "undefined") return;

		delete document.documentElement.dataset.theme;
		const link = document.createElement("link");
		link.id = "theme-stylesheet";
		link.href = "/themes/flow.css";
		document.head.appendChild(link);

		expect(isFlowMode()).toBe(true);
	});
});
