import { afterEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { evaluateApprovalRules, DEFAULT_APPROVAL_RULES, type ApprovalRule } from "../../server/approval-rules.js";
import { checkDangerousToolCall } from "../../server/tool-approval.js";
import {
	wrapPatchToolWithPermission,
	wrapWriteToolWithPermission,
	type AskApprovalFn,
} from "../../server/tool-guards.js";
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
	});

	describe("Real-path boundary (#972)：junction/symlink 不得穿透", () => {
		const roots: string[] = [];
		afterEach(() => {
			for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		});

		interface Fixture {
			workspace: string;
			outside: string;
			linkable: boolean;
		}

		function fixture(): Fixture {
			const base = mkdtempSync(join(tmpdir(), "pi-approval-boundary-"));
			roots.push(base);
			const workspace = join(base, "workspace");
			const outside = join(base, "outside");
			mkdirSync(workspace, { recursive: true });
			mkdirSync(outside, { recursive: true });
			writeFileSync(join(outside, "secret.txt"), "top secret");
			let linkable = true;
			try {
				symlinkSync(outside, join(workspace, "link"), process.platform === "win32" ? "junction" : "dir");
			} catch {
				linkable = false;
			}
			return { workspace, outside, linkable };
		}

		const outsideRule: ApprovalRule = {
			id: "builtin.file.outside-workspace",
			enabled: true,
			tools: ["write", "edit", "patch"],
			field: "path",
			match: "outside_workspace",
			value: "",
			action: "ask",
			label: "工作区外写入",
			labelEn: "Write outside workspace",
		};

		/** 区内但也需要问一句的规则（.env），用来把流程推进到「用户编辑参数」分支。 */
		const sensitiveEnvRule: ApprovalRule = {
			id: "builtin.file.sensitive.env",
			enabled: true,
			tools: ["write", "edit", "patch"],
			field: "path",
			match: "regex",
			value: "(^|[\\/\\\\])\\.env(\\.[a-zA-Z0-9_-]+)?$",
			action: "ask",
			label: "敏感配置 (.env)",
			labelEn: "Sensitive config (.env)",
		};

		it("workspace-write-never 下区外链接写入被拒，且不会弹审批", async () => {
			const { workspace, linkable } = fixture();
			if (!linkable) return;
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "written" }] }));
			const ask = vi.fn<AskApprovalFn>(async () => ({ decision: "approve" }));
			const tool = wrapWriteToolWithPermission(
				workspace,
				() => "workspace-write-never",
				() => [],
				() => "en",
				ask,
				() => "conv",
				() => [outsideRule],
				{ name: "write", execute } as unknown as ToolDefinition,
			);

			const res = (await tool.execute(
				"call",
				{ path: join(workspace, "link", "secret.txt"), content: "x" },
				undefined,
				undefined,
				{} as any,
			)) as any;

			expect(res.isError).toBe(true);
			expect(execute).not.toHaveBeenCalled();
			expect(ask).not.toHaveBeenCalled();
		});

		it("`link/../x` 不被折叠成区内路径", async () => {
			const { workspace, linkable } = fixture();
			if (!linkable) return;
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "written" }] }));
			const tool = wrapWriteToolWithPermission(
				workspace,
				() => "workspace-write-never",
				() => [],
				() => "en",
				undefined,
				() => "conv",
				undefined,
				{ name: "write", execute } as unknown as ToolDefinition,
			);

			const res = (await tool.execute(
				"call",
				{ path: `${workspace}${sep}link${sep}..${sep}secret.txt`, content: "x" },
				undefined,
				undefined,
				{} as any,
			)) as any;

			expect(res.isError).toBe(true);
			expect(execute).not.toHaveBeenCalled();
		});

		it("区外不存在的叶子路径也被拒（不让它落到最近存在祖先上碰运气）", async () => {
			const { workspace, outside } = fixture();
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "written" }] }));
			const tool = wrapWriteToolWithPermission(
				workspace,
				() => "workspace-write-never",
				() => [],
				() => "en",
				undefined,
				() => "conv",
				undefined,
				{ name: "write", execute } as unknown as ToolDefinition,
			);

			const res = (await tool.execute(
				"call",
				{ path: join(outside, "nope", "secret.txt"), content: "x" },
				undefined,
				undefined,
				{} as any,
			)) as any;

			expect(res.isError).toBe(true);
			expect(execute).not.toHaveBeenCalled();
		});

		it("区内普通/大小写路径照旧放行", async () => {
			const { workspace } = fixture();
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "written" }] }));
			const tool = wrapWriteToolWithPermission(
				workspace,
				() => "workspace-write-never",
				() => [],
				() => "en",
				undefined,
				() => "conv",
				undefined,
				{ name: "write", execute } as unknown as ToolDefinition,
			);

			const res = (await tool.execute(
				"call",
				{ path: "src/Index.ts", content: "x" },
				undefined,
				undefined,
				{} as any,
			)) as any;
			expect(res.isError).toBeUndefined();
			expect(execute).toHaveBeenCalledTimes(1);

			// 大写路径是不是“同一个目录”由**文件系统**决定：大小写敏感的 FS 上它是区外路径，必须拦。
			writeFileSync(join(workspace, "CaseProbe.txt"), "x");
			const caseInsensitive = existsSync(join(workspace, "caseprobe.txt"));
			const upper = wrapWriteToolWithPermission(
				workspace,
				() => "workspace-write-never",
				() => [],
				() => "en",
				undefined,
				() => "conv",
				undefined,
				{ name: "write", execute } as unknown as ToolDefinition,
			);
			const upperRes = (await upper.execute(
				"call",
				{ path: workspace.toUpperCase(), content: "x" },
				undefined,
				undefined,
				{} as any,
			)) as any;
			expect(execute).toHaveBeenCalledTimes(caseInsensitive ? 2 : 1);
			expect(upperRes.isError === true).toBe(!caseInsensitive);
		});

		it("outside_workspace 规则对链接指向的区外目标仍会拦", () => {
			const { workspace, linkable } = fixture();
			if (!linkable) return;
			const res = evaluateApprovalRules(
				[outsideRule],
				"write",
				{ path: join(workspace, "link", "secret.txt") },
				workspace,
			);
			expect(res.action).toBe("ask");
			expect(res.matchedRule?.id).toBe("builtin.file.outside-workspace");
		});

		it("审批后参数被改成区外路径时，硬门会再跑一次（write）", async () => {
			const { workspace, outside } = fixture();
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "written" }] }));
			const ask = vi.fn<AskApprovalFn>(async () => ({
				decision: "edit",
				editedParams: { path: join(outside, "pwn.txt"), content: "x" },
			}));
			const tool = wrapWriteToolWithPermission(
				workspace,
				() => "workspace-write-never",
				() => [],
				() => "en",
				ask,
				() => "conv",
				() => [sensitiveEnvRule],
				{ name: "write", execute } as unknown as ToolDefinition,
			);

			const res = (await tool.execute("call", { path: ".env", content: "x" }, undefined, undefined, {} as any)) as any;

			expect(ask).toHaveBeenCalledTimes(1);
			expect(res.isError).toBe(true);
			expect(execute).not.toHaveBeenCalled();
		});

		it("审批后补丁被改成区外路径时，硬门会再跑一次（patch）", async () => {
			const { workspace, outside } = fixture();
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "patched" }] }));
			const ask = vi.fn<AskApprovalFn>(async () => ({
				decision: "edit",
				editedParams: { patch: `[${join(outside, "pwn.txt")}#abcd]\nPUT 1.=1:\n+x\n` },
			}));
			const tool = wrapPatchToolWithPermission(
				{ name: "patch", execute } as unknown as ToolDefinition,
				workspace,
				() => "workspace-write-never",
				() => [],
				() => "en",
				ask,
				() => "conv",
				() => [sensitiveEnvRule],
			);

			const res = (await tool.execute(
				"call",
				{ patch: "[.env#abcd]\nPUT 1.=1:\n+x\n" },
				undefined,
				undefined,
				{} as any,
			)) as any;

			expect(ask).toHaveBeenCalledTimes(1);
			expect(res.isError).toBe(true);
			expect(execute).not.toHaveBeenCalled();
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
