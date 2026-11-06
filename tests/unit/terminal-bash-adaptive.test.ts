import { describe, expect, it, vi } from "vitest";
import { makeAdaptiveBashTool } from "../../server/agent-service.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("makeAdaptiveBashTool", () => {
	const createMockTools = () => {
		const killableExec = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "killable" }] });
		const terminalExec = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "terminal" }] });

		const killable: ToolDefinition = {
			name: "bash",
			label: "Bash",
			description: "Killable bash",
			promptSnippet: "bash",
			parameters: {} as never,
			execute: killableExec,
		};

		const terminalBacked: ToolDefinition = {
			name: "bash",
			label: "Bash",
			description: "Terminal bash",
			promptSnippet: "bash",
			parameters: {} as never,
			execute: terminalExec,
		};

		return { killable, terminalBacked, killableExec, terminalExec };
	};

	it("routes to killable when terminalBash is false", async () => {
		const { killable, terminalBacked, killableExec, terminalExec } = createMockTools();
		const tool = makeAdaptiveBashTool(killable, terminalBacked, () => false);

		const res = await tool.execute("call1", { command: "echo 1" } as never, undefined, undefined, {} as never);
		expect(killableExec).toHaveBeenCalledTimes(1);
		expect(terminalExec).not.toHaveBeenCalled();
		expect(res).toEqual({ content: [{ type: "text", text: "killable" }] });
	});

	it("routes correctly when terminalBash is true based on platform and persist", async () => {
		const { killable, terminalBacked, killableExec, terminalExec } = createMockTools();
		const tool = makeAdaptiveBashTool(killable, terminalBacked, () => true);

		if (process.platform === "win32") {
			await tool.execute("call2", { command: "echo 2" } as never, undefined, undefined, {} as never);
			expect(killableExec).toHaveBeenCalledTimes(1);
			expect(terminalExec).not.toHaveBeenCalled();

			await tool.execute("call3", { command: "echo 3", persist: false } as never, undefined, undefined, {} as never);
			expect(killableExec).toHaveBeenCalledTimes(2);
			expect(terminalExec).not.toHaveBeenCalled();

			await tool.execute("call4", { command: "echo 4", persist: true } as never, undefined, undefined, {} as never);
			expect(terminalExec).toHaveBeenCalledTimes(1);
		} else {
			await tool.execute("call2", { command: "echo 2" } as never, undefined, undefined, {} as never);
			expect(terminalExec).toHaveBeenCalledTimes(1);
			expect(killableExec).not.toHaveBeenCalled();
		}
	});
});
