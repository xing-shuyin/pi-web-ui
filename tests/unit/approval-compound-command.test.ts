import { describe, expect, it } from "vitest";
import {
	DEFAULT_APPROVAL_RULES,
	evaluateApprovalRules,
	hasShellCompoundOperator,
	matchApprovalRule,
	type ApprovalRule,
} from "../../server/approval-rules.js";

describe("复合命令连接符防逃逸与白名单降级 (Issue #722)", () => {
	const cwd = "/workspace/project";

	describe("hasShellCompoundOperator", () => {
		it("识别常见的 shell 复合操作符", () => {
			expect(hasShellCompoundOperator("rm safe.log; rm -rf /")).toBe(true);
			expect(hasShellCompoundOperator("git status && rm -rf /")).toBe(true);
			expect(hasShellCompoundOperator("npm test || rm -rf /")).toBe(true);
			expect(hasShellCompoundOperator("echo foo | rm -rf /")).toBe(true);
			expect(hasShellCompoundOperator("echo foo\nrm -rf /")).toBe(true);
			expect(hasShellCompoundOperator("echo $(rm -rf /)")).toBe(true);
			expect(hasShellCompoundOperator("echo `rm -rf /`")).toBe(true);
		});

		it("原子命令不含复合操作符", () => {
			expect(hasShellCompoundOperator("git status")).toBe(false);
			expect(hasShellCompoundOperator("git status --short -b")).toBe(false);
			expect(hasShellCompoundOperator("npm test -- --coverage")).toBe(false);
			expect(hasShellCompoundOperator("rm tmp.log")).toBe(false);
		});
	});

	describe("allow 白名单规则防复合命令逃逸", () => {
		const allowPrefixRule: ApprovalRule = {
			id: "custom.bash.allow-rm-tmp",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "prefix",
			value: "rm tmp.log",
			action: "allow",
			label: "允许清理临时日志",
		};

		const allowContainsRule: ApprovalRule = {
			id: "custom.bash.allow-git-status",
			enabled: true,
			tools: ["bash"],
			field: "command",
			match: "contains",
			value: "git status",
			action: "allow",
			label: "允许 git status",
		};

		it("原子命令正常命中 allow 白名单", () => {
			expect(matchApprovalRule(allowPrefixRule, "bash", { command: "rm tmp.log" }, cwd)).toBe(true);
			expect(matchApprovalRule(allowContainsRule, "bash", { command: "git status" }, cwd)).toBe(true);
			expect(matchApprovalRule(allowContainsRule, "bash", { command: "git status -s" }, cwd)).toBe(true);
		});

		it("包含复合操作符且未完全覆盖整条命令时，禁止白名单命中", () => {
			expect(matchApprovalRule(allowPrefixRule, "bash", { command: "rm tmp.log; rm -rf /" }, cwd)).toBe(false);
			expect(matchApprovalRule(allowContainsRule, "bash", { command: "git status && rm -rf /" }, cwd)).toBe(false);
			expect(matchApprovalRule(allowPrefixRule, "bash", { command: "rm tmp.log\nrm -rf /" }, cwd)).toBe(false);
			expect(matchApprovalRule(allowContainsRule, "bash", { command: "git status | xargs rm -rf" }, cwd)).toBe(false);
			expect(matchApprovalRule(allowContainsRule, "bash", { command: "echo $(rm -rf /) && git status" }, cwd)).toBe(
				false,
			);
		});

		it("复合命令下，白名单降级后后续的高危规则能正常触发阻断/询问", () => {
			const rules: ApprovalRule[] = [allowPrefixRule, ...DEFAULT_APPROVAL_RULES];

			const safeRes = evaluateApprovalRules(rules, "bash", { command: "rm tmp.log" }, cwd);
			expect(safeRes.action).toBe("allow");

			const maliciousRes = evaluateApprovalRules(rules, "bash", { command: "rm tmp.log; rm -rf /" }, cwd);
			expect(maliciousRes.action).toBe("ask");
			expect(maliciousRes.matchedRule?.id).toBe("builtin.bash.rm-rf");
		});

		it("deny 与 ask 规则在复合命令下依然正常捕获", () => {
			const denyRule: ApprovalRule = {
				id: "custom.bash.deny-rm",
				enabled: true,
				tools: ["bash"],
				field: "command",
				match: "contains",
				value: "rm -rf",
				action: "deny",
				label: "禁止 rm -rf",
			};

			expect(matchApprovalRule(denyRule, "bash", { command: "echo ok && rm -rf /" }, cwd)).toBe(true);
		});
	});
});
