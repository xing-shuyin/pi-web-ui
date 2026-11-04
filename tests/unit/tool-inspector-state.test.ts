/**
 * tool-inspector-state 单测（web/src/tool-inspector-state.ts）：
 * 覆盖工具执行详情与思考流检查器弹窗的模块级 store 及 isFlowMode 判定。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	closeToolInspector,
	getToolInspectorState,
	isFlowMode,
	openToolInspector,
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

		// 幂等关闭不重复触发通知
		closeToolInspector();
		expect(notified).toBe(1);

		unsub();
	});

	it("updateToolInspectorLive 仅在 toolCallId 匹配且非思考流时平滑更新并通知", () => {
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

		// 匹配 toolCallId，输出增加
		updateToolInspectorLive("call_bash_123", {
			output: "line 1\nline 2\n",
		});
		expect(notified).toBe(1);
		expect(getToolInspectorState()?.output).toBe("line 1\nline 2\n");

		// 不匹配 toolCallId，不更新也不通知
		updateToolInspectorLive("call_different_456", {
			output: "should not update",
		});
		expect(notified).toBe(1);
		expect(getToolInspectorState()?.output).toBe("line 1\nline 2\n");

		// 字段值无变化，不重复触发通知
		updateToolInspectorLive("call_bash_123", {
			output: "line 1\nline 2\n",
		});
		expect(notified).toBe(1);

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
