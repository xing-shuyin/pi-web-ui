import { describe, expect, it } from "vitest";
import {
	resolveSecurityMode,
	parseRequiredTools,
	subagentSecurityDenial,
	withSubagentSecurityGate,
	type SubagentSecurityMode,
} from "../../server/subagent-security-gate.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("subagent-security-gate", () => {
	it("keeps legacy terminal allowlists action scoped", () => {
		const allowed = new Set(["terminal_read"]);
		expect(parseRequiredTools("terminal_read", ["terminal"]).allowedTools).toEqual(["terminal_read"]);
		expect(subagentSecurityDenial("normal", "terminal", { action: "read" }, allowed)).toBeUndefined();
		expect(subagentSecurityDenial("normal", "terminal", { action: "input" }, allowed)).toBeDefined();
		for (const mode of ["readonly", "verify"] as const) {
			for (const action of ["list", "read", "wait"])
				expect(subagentSecurityDenial(mode, "terminal", { action })).toBeUndefined();
			for (const action of ["create", "close", "input", "key", "unknown"])
				expect(subagentSecurityDenial(mode, "terminal", { action, command: "pwd" })).toBeDefined();
		}
	});
	describe("resolveSecurityMode", () => {
		it("prefers template securityMode when explicitly configured", () => {
			expect(resolveSecurityMode("custom", { securityMode: "readonly" })).toBe("readonly");
			expect(resolveSecurityMode("explore", { securityMode: "verify" })).toBe("verify");
			expect(resolveSecurityMode("general", { securityMode: "normal" })).toBe("normal");
		});

		it("infers verify mode from keywords in template name or type", () => {
			expect(resolveSecurityMode("review")).toBe("verify");
			expect(resolveSecurityMode("code-review")).toBe("verify");
			expect(resolveSecurityMode("audit")).toBe("verify");
			expect(resolveSecurityMode(undefined, { name: "security-audit" })).toBe("verify");
		});

		it("infers readonly mode from keywords in template name or type", () => {
			expect(resolveSecurityMode("explore")).toBe("readonly");
			expect(resolveSecurityMode("scout")).toBe("readonly");
			expect(resolveSecurityMode("research")).toBe("readonly");
			expect(resolveSecurityMode("oracle")).toBe("readonly");
			expect(resolveSecurityMode("librarian")).toBe("readonly");
			expect(resolveSecurityMode("reader")).toBe("readonly");
		});

		it("falls back to normal when no keywords match", () => {
			expect(resolveSecurityMode("implement")).toBe("normal");
			expect(resolveSecurityMode("general")).toBe("normal");
			expect(resolveSecurityMode("")).toBe("normal");
			expect(resolveSecurityMode(undefined)).toBe("normal");
		});
	});

	describe("parseRequiredTools", () => {
		it("parses comma-separated and space-separated tool names", () => {
			const res = parseRequiredTools("read, grep, find");
			expect(res.allowedTools).toEqual(["read", "grep", "find"]);
		});

		it("keeps terminal distinct from bash", () => {
			const res = parseRequiredTools("read, terminal, grep");
			expect(res.allowedTools).toEqual(["read", "terminal", "grep"]);
		});

		it("identifies read-only request phrases", () => {
			const res = parseRequiredTools("read-only tools: read, grep");
			expect(res.requestedReadOnly).toBe(true);
			expect(res.allowedTools).toEqual(["read", "grep"]);
		});

		it("filters against available tools list", () => {
			const available = ["read", "grep", "terminal"];
			const res = parseRequiredTools("read, grep, write, terminal", available);
			expect(res.allowedTools).toEqual(["read", "grep", "terminal"]);
			expect(res.unrecognized).toEqual(["write"]);
		});

		it("handles empty or blank inputs gracefully", () => {
			expect(parseRequiredTools("")).toEqual({});
			expect(parseRequiredTools(null)).toEqual({});
		});
	});

	describe("subagentSecurityDenial", () => {
		describe("normal mode", () => {
			it("allows write tools and normal bash commands", () => {
				expect(subagentSecurityDenial("normal", "write", { path: "a.ts" })).toBeUndefined();
				expect(subagentSecurityDenial("normal", "edit", {})).toBeUndefined();
				expect(subagentSecurityDenial("normal", "bash", { command: "npm run build" })).toBeUndefined();
			});

			it("still enforces allowedTools if provided", () => {
				const allowed = new Set(["read", "grep"]);
				const denied = subagentSecurityDenial("normal", "write", {}, allowed);
				expect(denied).toBeDefined();
				expect(denied?.kind).toBe("not-allowed-tool");
			});
		});

		it("restricted modes reject unknown tools even when named in an explicit allowlist", () => {
			for (const mode of ["readonly", "verify"] as const) {
				for (const name of ["plugin_write", "mcp_delete", "", "eval"]) {
					expect(subagentSecurityDenial(mode, name, {}, new Set([name]))).toBeDefined();
				}
				expect(subagentSecurityDenial(mode, "notes", { op: "note_add" })).toBeDefined();
				expect(subagentSecurityDenial(mode, "notes", { op: "list" })).toBeUndefined();
				expect(subagentSecurityDenial(mode, "load_tools", {})).toBeUndefined();
				expect(subagentSecurityDenial(mode, "lsp", { action: "references" })).toBeUndefined();
				for (const command of [
					"npm test & touch pwned & pwd",
					'npm test "$(touch x)"',
					"npm test &&",
					"npm test\\\n; pwd",
				]) {
					expect(subagentSecurityDenial(mode, "bash", { command }), command).toBeDefined();
				}
			}
		});

		describe("readonly mode", () => {
			it("blocks write tools", () => {
				expect(subagentSecurityDenial("readonly", "write", {})?.kind).toBe("write-tool");
				expect(subagentSecurityDenial("readonly", "edit", {})?.kind).toBe("write-tool");
				expect(subagentSecurityDenial("readonly", "edit_soft", {})?.kind).toBe("write-tool");
				expect(subagentSecurityDenial("readonly", "codemode", {})?.kind).toBe("write-tool");
				expect(subagentSecurityDenial("readonly", "powershell", {})?.kind).toBe("write-tool");
			});

			it("blocks interactive terminal tools", () => {
				expect(subagentSecurityDenial("readonly", "terminal_input", {})?.kind).toBe("terminal-input");
				expect(subagentSecurityDenial("readonly", "terminal_key", {})?.kind).toBe("terminal-input");
				expect(subagentSecurityDenial("readonly", "terminal_create", {})?.kind).toBe("terminal-input");
			});

			it("blocks subagent dispatch tools", () => {
				expect(subagentSecurityDenial("readonly", "delegate_task", {})?.kind).toBe("dispatch-tool");
				expect(subagentSecurityDenial("readonly", "subagent", { action: "spawn" })?.kind).toBe("dispatch-tool");
				expect(subagentSecurityDenial("readonly", "subagent", { action: "steer" })?.kind).toBe("dispatch-tool");
			});

			it("allows read-only subagent actions", () => {
				expect(subagentSecurityDenial("readonly", "subagent", { action: "get_result" })).toBeUndefined();
				expect(subagentSecurityDenial("readonly", "subagent", { action: "list" })).toBeUndefined();
			});

			it("allows read-only bash commands", () => {
				expect(subagentSecurityDenial("readonly", "bash", { command: "git diff" })).toBeUndefined();
				expect(subagentSecurityDenial("readonly", "bash", { command: "git log -n 5" })).toBeUndefined();
				expect(subagentSecurityDenial("readonly", "bash", { command: "cat file.txt" })).toBeUndefined();
				expect(subagentSecurityDenial("readonly", "bash", { command: "grep foo bar.ts" })).toBeUndefined();
			});

			it("blocks destructive or test-running bash commands in readonly mode", () => {
				expect(subagentSecurityDenial("readonly", "bash", { command: "rm -rf foo" })?.kind).toBe("bash-write");
				expect(subagentSecurityDenial("readonly", "bash", { command: "echo hello > file.txt" })?.kind).toBe(
					"bash-write",
				);
				expect(subagentSecurityDenial("readonly", "bash", { command: "npm test" })?.kind).toBe("bash-write");
			});
		});

		describe("verify mode", () => {
			it("blocks write tools and interactive terminals", () => {
				expect(subagentSecurityDenial("verify", "write", {})?.kind).toBe("write-tool");
				expect(subagentSecurityDenial("verify", "edit", {})?.kind).toBe("write-tool");
				expect(subagentSecurityDenial("verify", "terminal_input", {})?.kind).toBe("terminal-input");
			});

			it("allows read-only commands AND test runner suites", () => {
				expect(subagentSecurityDenial("verify", "bash", { command: "git diff" })).toBeUndefined();
				expect(subagentSecurityDenial("verify", "bash", { command: "npm test" })).toBeUndefined();
				expect(subagentSecurityDenial("verify", "bash", { command: "npx vitest run" })).toBeUndefined();
				expect(subagentSecurityDenial("verify", "bash", { command: "pytest" })).toBeUndefined();
			});

			it("blocks destructive write bash commands in verify mode", () => {
				expect(subagentSecurityDenial("verify", "bash", { command: "rm file.txt" })?.kind).toBe("bash-write");
				expect(subagentSecurityDenial("verify", "bash", { command: "git commit -m 'oops'" })?.kind).toBe("bash-write");
				expect(subagentSecurityDenial("verify", "bash", { command: "npm test > output.txt" })?.kind).toBe("bash-write");
			});
		});
	});

	describe("withSubagentSecurityGate wrapper", () => {
		it("intercepts forbidden tool calls with error content and details", async () => {
			let executed = false;
			const tool: ToolDefinition = {
				name: "write",
				label: "Write file",
				description: "write file",
				parameters: {},
				execute: async () => {
					executed = true;
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			} as any;

			let currentMode: SubagentSecurityMode = "readonly";
			const wrapped = withSubagentSecurityGate(
				tool,
				() => ({ mode: currentMode }),
				() => "en",
			);

			const result = (await wrapped.execute("call-1", { path: "test.txt" }, undefined, undefined, {} as any)) as {
				isError?: boolean;
				details?: Record<string, unknown>;
				content: Array<{ type: string; text: string }>;
			};

			expect(executed).toBe(false);
			expect(result.isError).toBe(true);
			expect(result.details?.guardDenied).toBe(true);
			expect(result.details?.subagentSecurityDenied).toBe(true);
			expect(result.content[0]?.text).toContain("Restricted subagent (readonly)");

			currentMode = "normal";
			const allowedResult = (await wrapped.execute(
				"call-2",
				{ path: "test.txt" },
				undefined,
				undefined,
				{} as any,
			)) as {
				content: Array<{ type: string; text: string }>;
			};
			expect(executed).toBe(true);
			expect(allowedResult.content[0]?.text).toBe("ok");
		});
	});
});
