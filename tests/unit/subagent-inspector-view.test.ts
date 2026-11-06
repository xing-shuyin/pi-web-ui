import { describe, expect, it } from "vitest";
import { parseSubagentData } from "../../web/src/components/SubagentInspectorView.js";

describe("SubagentInspectorView - parseSubagentData", () => {
	it("正确解析 spawn 入参中的核心规格与提示词", () => {
		const args = JSON.stringify({
			action: "spawn",
			prompt: "请对 PR #838 进行深度审查",
			type: "review",
			template: "code-reviewer",
			model: "anthropic/claude-3-7-sonnet",
			thinking: "high",
			isolation: "worktree",
			cwd: "E:/pi-web-ui",
			notifyOnDone: true,
		});

		const data = parseSubagentData(args, undefined, undefined);
		expect(data.action).toBe("spawn");
		expect(data.prompt).toBe("请对 PR #838 进行深度审查");
		expect(data.type).toBe("review");
		expect(data.template).toBe("code-reviewer");
		expect(data.model).toBe("anthropic/claude-3-7-sonnet");
		expect(data.thinking).toBe("high");
		expect(data.isolation).toBe("worktree");
		expect(data.cwd).toBe("E:/pi-web-ui");
		expect(data.notifyOnDone).toBe(true);
	});

	it("正确合并 get_result 返回的 details 快照与 worktree 隔离分支", () => {
		const args = JSON.stringify({
			action: "get_result",
			runId: "sa-c892fa10",
		});

		const details = {
			convId: "sa-c892fa10",
			executionId: "exec-9910",
			type: "review",
			messageCount: 4,
			state: "completed",
			output: "审查结论：全部通过",
			worktree: {
				branch: "agent/pr-838-isolation",
				path: "E:/pi-web-ui/.worktrees/sa-c892fa10",
				uncommittedCount: 3,
				aheadCount: 1,
				isDirty: false,
			},
		};

		const data = parseSubagentData(args, details, "审查结论：全部通过");
		expect(data.action).toBe("get_result");
		expect(data.convId).toBe("sa-c892fa10");
		expect(data.executionId).toBe("exec-9910");
		expect(data.type).toBe("review");
		expect(data.messageCount).toBe(4);
		expect(data.worktree?.branch).toBe("agent/pr-838-isolation");
		expect(data.worktree?.uncommittedCount).toBe(3);
		expect(data.output).toBe("审查结论：全部通过");
	});

	it("在缺少 details.convId 时从 output 文本成功回退提取 sa-xxxxxxx", () => {
		const args = JSON.stringify({ action: "spawn" });
		const output = "子代理已启动（运行列表可见）：sa-e9102ab3\n类型：explore";

		const data = parseSubagentData(args, undefined, output);
		expect(data.convId).toBe("sa-e9102ab3");
	});

	it("脏 JSON 或空参数时安全回退，不崩溃", () => {
		const data = parseSubagentData("invalid json {abc", null, undefined);
		expect(data.action).toBe("spawn");
		expect(data.prompt).toBeUndefined();
		expect(data.convId).toBeUndefined();
	});
});
