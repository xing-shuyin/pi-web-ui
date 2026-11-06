import { describe, expect, it } from "vitest";
import { goalReviewDenial, shouldDeferPromptForReview } from "../../server/goal-review-gate.js";

describe("目标审查闸门 goalReviewDenial", () => {
	it("limits merged terminal to observation", () => {
		for (const action of ["list", "read", "wait"]) expect(goalReviewDenial("terminal", { action })).toBeUndefined();
		for (const action of ["create", "close", "input", "key", "unknown"])
			expect(goalReviewDenial("terminal", { action })).toBeDefined();
	});
	it("写类工具一律拒（write/edit/edit_soft/git 工具/形态变换）", () => {
		for (const name of ["write", "edit", "edit_soft", "apply_patch", "rm", "mkdir", "git", "format"]) {
			const d = goalReviewDenial(name, {});
			expect(d?.kind, name).toBe("write-tool");
			expect(d!.reason).toContain("只回 verdict JSON");
			expect(d!.reasonEn).toContain("verdict JSON");
		}
		expect(goalReviewDenial("eval", {})?.kind).toBe("write-tool");
		for (const name of ["codemode", "mcp_manage", "sandbox"]) {
			expect(goalReviewDenial(name, {})?.kind, name).toBe("write-tool");
		}
	});

	it("只读工具放行（read/grep/scm/present/conversation_read/subagent_get_result）", () => {
		for (const name of [
			"read",
			"grep",
			"scm",
			"present_files",
			"conversation_read",
			"subagent_get_result",
			"subagent_list",
		]) {
			expect(goalReviewDenial(name, {}), name).toBeUndefined();
		}
		expect(goalReviewDenial("subagent", { action: "get_result" })).toBeUndefined();
		expect(goalReviewDenial("subagent", { action: "list" })).toBeUndefined();
		expect(goalReviewDenial("subagent", { action: "templates" })).toBeUndefined();
	});

	it("只读 bash 放行（跑测试/看 diff），写命令拒绝", () => {
		expect(goalReviewDenial("bash", { command: "npm test | tail -20" })).toBeUndefined();
		expect(goalReviewDenial("bash", { command: "git diff HEAD --stat" })).toBeUndefined();
		expect(goalReviewDenial("bash", { command: "npx vitest run tests/unit" })).toBeUndefined();
		expect(goalReviewDenial("bash", { command: "pytest -q && go test ./..." })).toBeUndefined();
		const d = goalReviewDenial("bash", { command: "rm -rf dist" });
		expect(d?.kind).toBe("bash");
		expect(d!.reason).toContain("只允许只读命令");
	});

	it("测试形状只认跑测试：run deploy / node -e 照拒", () => {
		expect(goalReviewDenial("bash", { command: "npm run deploy" })?.kind).toBe("bash");
		expect(goalReviewDenial("bash", { command: 'node -e "console.log(1)"' })?.kind).toBe("bash");
		expect(goalReviewDenial("bash", { command: "npm test; rm -rf /tmp/x" })?.kind).toBe("bash");
	});

	it("保守边界：带重定向的测试命令同样拒（与计划模式同一白名单，模型换写法即可）", () => {
		expect(goalReviewDenial("bash", { command: "npm test 2>&1 | tail -20" })?.kind).toBe("bash");
	});

	it("无命令的终端调用拒绝（交互式用法在审查回合无意义）", () => {
		const d = goalReviewDenial("terminal_bash", {});
		expect(d?.kind).toBe("bash");
	});

	it("派发类工具一律拒（D6：轮次由服务端控制）", () => {
		expect(goalReviewDenial("subagent", { action: "spawn" })?.kind).toBe("dispatch-tool");
		expect(goalReviewDenial("subagent", { action: "wait_all" })?.kind).toBe("dispatch-tool");
		for (const name of ["delegate_task", "schedule"]) {
			const d = goalReviewDenial(name, {});
			expect(d?.kind, name).toBe("dispatch-tool");
		}
	});

	it("幽灵名不再误报", () => {
		for (const ghost of [
			"spawn",
			"spawn_agent",
			"subagent_spawn",
			"spawn_subagent",
			"subagent_steer",
			"subagent_stop",
			"subagent_wait_all",
			"subagent_handoff",
			"schedule_agent",
			"host_schedule",
			"create_goal",
			"set_goal",
			"start_goal_wizard",
			"set_plan_mode",
		]) {
			expect(goalReviewDenial(ghost, {}), ghost).toBeUndefined();
		}
	});

	it("向用户提问拒绝（弹窗无人应答，会把 verdict 拖超时）", () => {
		const d = goalReviewDenial("ask_user_question", { question: "选哪个？" });
		expect(d?.kind).toBe("ask-user");
	});

	it("审查回合插话顺延判定 shouldDeferPromptForReview", () => {
		const base = { queue: false, text: "顺便问下", hasAttachments: false, awaitingVerdict: true };
		expect(shouldDeferPromptForReview({ ...base, queue: false })).toBe(true);
		expect(shouldDeferPromptForReview({ ...base, queue: true })).toBe(false);
		expect(shouldDeferPromptForReview({ ...base, awaitingVerdict: false })).toBe(false);
		expect(shouldDeferPromptForReview({ ...base, queue: false, hasAttachments: true })).toBe(false);
		expect(shouldDeferPromptForReview({ ...base, queue: false, text: "/compact" })).toBe(false);
		expect(shouldDeferPromptForReview({ ...base, text: "   " })).toBe(true);
	});

	it("空名/未知工具放行（白名单制：只拦名单里的）", () => {
		expect(goalReviewDenial("", {})).toBeUndefined();
		expect(goalReviewDenial("some_future_tool", {})).toBeUndefined();
	});
});
