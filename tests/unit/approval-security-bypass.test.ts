import { describe, it, expect } from "vitest";
import {
	evaluateApprovalRules,
	isPathInsideRoot,
	DEFAULT_APPROVAL_RULES,
	type ApprovalRule,
} from "../../server/approval-rules.js";
import { checkDangerousToolCall } from "../../server/tool-approval.js";
import { withToolGuard } from "../../server/agent-service.js";

describe("Approval System Security Bypass & Path Traversal Fixes (#333)", () => {
	const cwd = process.platform === "win32" ? "C:\\workspace\\project" : "/workspace/project";

	describe("Path normalization and traversal protection (A1 / A6)", () => {
		it("correctly identifies path traversal via absolute path containing '..'", () => {
			const outsideRule: ApprovalRule = {
				id: "test.outside",
				enabled: true,
				tools: ["write"],
				field: "path",
				match: "outside_workspace",
				value: "",
				action: "deny",
				label: "Outside workspace write",
			};

			const maliciousAbsPath =
				process.platform === "win32"
					? "C:\\workspace\\project\\..\\..\\Windows\\system32\\calc.exe"
					: "/workspace/project/../../etc/passwd";

			const res = evaluateApprovalRules([outsideRule], "write", { path: maliciousAbsPath }, cwd);
			expect(res.matchedRule).toBeDefined();
			expect(res.action).toBe("deny");
		});

		it("handles Windows case-insensitivity and slash style without false positives", () => {
			if (process.platform === "win32") {
				expect(isPathInsideRoot("C:/workspace/project/src/index.ts", "c:\\workspace\\project")).toBe(true);
				expect(isPathInsideRoot("c:\\workspace\\project\\file.txt", "C:\\workspace\\project")).toBe(true);
				expect(isPathInsideRoot("C:\\workspace\\other\\file.txt", "C:\\workspace\\project")).toBe(false);
				expect(isPathInsideRoot("C:\\workspace\\project\\file.txt", "C:\\")).toBe(true);
				expect(isPathInsideRoot("c:/file.txt", "C:\\")).toBe(true);
				expect(isPathInsideRoot("D:\\file.txt", "C:\\")).toBe(false);
			} else {
				expect(isPathInsideRoot("/workspace/project/src/index.ts", "/workspace/project")).toBe(true);
				expect(isPathInsideRoot("/workspace/other/file.txt", "/workspace/project")).toBe(false);
				expect(isPathInsideRoot("/workspace/project/src/index.ts", "/")).toBe(true);
				expect(isPathInsideRoot("/foobar", "/foo")).toBe(false);
			}
		});
	});

	describe("Plugin guard ask bypass prevention (A3)", () => {
		it("ensures built-in deny rule blocks execution even if plugin guard returned ask", async () => {
			const denyRule: ApprovalRule = {
				id: "custom.bash.deny-echo",
				enabled: true,
				tools: ["bash"],
				field: "command",
				match: "contains",
				value: "echo danger",
				action: "deny",
				label: "Block echo danger",
				reason: "Blocked danger",
			};

			const mockTool = {
				name: "bash",
				description: "bash tool",
				parameters: {},
				execute: async () => ({ content: [{ type: "text", text: "executed" }] }),
			};

			const mockGuard = {
				pre: async () => ({
					verdict: { decision: "ask" as const, reason: "Plugin ask confirmation" },
					pluginId: "mock-plugin",
				}),
				post: async () => ({}),
			};

			let askCalled = false;
			const guardedTool = withToolGuard(mockTool as any, {
				toolName: "bash",
				guard: mockGuard as any,
				cwd,
				getLang: () => "en",
				askApproval: async () => {
					askCalled = true;
					return { decision: "approve" };
				},
				getRules: () => [denyRule],
			});

			const result = (await guardedTool.execute(
				"call-1",
				{ command: "echo danger" },
				undefined,
				undefined,
				{} as any,
			)) as any;

			expect(askCalled).toBe(false);
			expect(result.isError).toBe(true);
			expect(result.details.ruleDenied).toBe(true);
			expect(result.content[0].text).toContain("blocked by approval rule");
		});

		it("preserves system high-risk approval reason when both system and plugin ask", async () => {
			const mockTool = {
				name: "bash",
				description: "bash tool",
				parameters: {},
				execute: async () => ({ content: [{ type: "text", text: "executed" }] }),
			};

			const mockGuard = {
				pre: async () => ({
					verdict: { decision: "ask" as const, reason: "Plugin harmless note" },
					pluginId: "harmless-plugin",
				}),
				post: async () => ({}),
			};

			let askedReason: string | undefined;
			let askedCategory: any;
			const guardedTool = withToolGuard(mockTool as any, {
				toolName: "bash",
				guard: mockGuard as any,
				cwd,
				getLang: () => "en",
				askApproval: async (_id, _tool, _params, reason, _reasonEn, _convId, cat) => {
					askedReason = reason;
					askedCategory = cat;
					return { decision: "approve" };
				},
				getRules: () => DEFAULT_APPROVAL_RULES,
			});

			await guardedTool.execute("call-2", { command: "rm -rf /" }, undefined, undefined, {} as any);

			expect(askedReason).toContain("递归/强制删除");
			expect(askedCategory?.id).toBe("bash.rm-rf");
		});
	});

	describe("Windows high-risk regex pattern enhancements (P-07)", () => {
		it("detects GNU long arguments rm --recursive --force", () => {
			const res = checkDangerousToolCall("bash", { command: "rm --recursive --force /" }, cwd);
			expect(res.dangerous).toBe(true);
			expect(res.category?.id).toBe("bash.rm-rf");
		});

		it("detects Windows absolute path recursive removal like rm -rf C:\\...", () => {
			const res = checkDangerousToolCall("bash", { command: "rm -rf C:\\Users\\Administrator" }, cwd);
			expect(res.dangerous).toBe(true);
			expect(res.category?.id).toBe("bash.rm-rf");
		});

		it("detects Windows cmd rd /s /q directory deletion", () => {
			const res = checkDangerousToolCall("bash", { command: "rd /s /q mydir" }, cwd);
			expect(res.dangerous).toBe(true);
			expect(res.category?.id).toBe("bash.win-del");
		});
	});
});
