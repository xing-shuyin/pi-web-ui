import { describe, it, expect, vi } from "vitest";
import { sanitizeEvalEnv } from "../../server/eval-tool.js";
import { makePersistentTerminalTools } from "../../server/terminals.js";

describe("Terminal & Eval Sandbox Security Enhancements (#339)", () => {
	it("sanitizes environment variables to prevent API key and credential leakage", () => {
		const mockEnv = {
			PATH: "/usr/bin:/bin",
			HOME: "/home/user",
			OPENAI_API_KEY: "sk-proj-1234567890",
			ANTHROPIC_AUTH_TOKEN: "anthropic-secret-token",
			AWS_SECRET_ACCESS_KEY: "aws-secret-123",
			DB_PASSWORD: "super-secret-password",
			CUSTOM_CREDENTIAL: "my-credentials",
			NODE_ENV: "production",
		};

		const cleaned = sanitizeEvalEnv(mockEnv as any);

		expect(cleaned.PATH).toBe("/usr/bin:/bin");
		expect(cleaned.HOME).toBe("/home/user");
		expect(cleaned.NODE_ENV).toBe("production");

		expect((cleaned as any).OPENAI_API_KEY).toBeUndefined();
		expect((cleaned as any).ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect((cleaned as any).AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect((cleaned as any).DB_PASSWORD).toBeUndefined();
		expect((cleaned as any).CUSTOM_CREDENTIAL).toBeUndefined();
	});

	it("blocks high-risk command input via terminal_input tool", async () => {
		const mockTerminals = {
			inputChecked: vi.fn().mockReturnValue(null),
			noteAgentActivity: vi.fn(),
		};

		const tools = makePersistentTerminalTools(mockTerminals as any, "/workspace", () => "en", {
			checkSafety: (cmd) => {
				if (cmd.includes("rm -rf /")) {
					return { blocked: true, reason: "Dangerous rm -rf / blocked" };
				}
				return {};
			},
		});

		const inputTool = tools.find((t) => t.name === "terminal");
		expect(inputTool).toBeDefined();

		await expect(
			inputTool!.execute(
				"call-safe",
				{ action: "input", terminalId: "term-1", data: "ls -la" },
				undefined,
				undefined,
				{} as any,
			),
		).resolves.toBeDefined();

		await expect(
			inputTool!.execute(
				"call-danger",
				{ action: "input", terminalId: "term-1", data: "rm -rf /\n" },
				undefined,
				undefined,
				{} as any,
			),
		).rejects.toThrow("Dangerous rm -rf / blocked");

		expect(mockTerminals.inputChecked).toHaveBeenCalledWith("term-1", "ls -la");
		expect(mockTerminals.inputChecked).not.toHaveBeenCalledWith("term-1", "rm -rf /\n");
	});
});
