import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyDriver } from "../../server/universal/drivers/agy.js";
import type { AgentEventSink } from "../../server/universal/driver-base.js";

function createFakeAgyExecutable(dir: string, scriptBody: string): string {
	const file = join(dir, "fake-agy.mjs");
	writeFileSync(file, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o755 });
	return file;
}

describe("AgyDriver", () => {
	it("parses init, step_update (text + tool), and result usage from stream-json", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agy-driver-test-"));
		try {
			const script = createFakeAgyExecutable(
				dir,
				`
if (process.argv.includes("--version")) {
  console.log("agy 1.2.3");
  process.exit(0);
}
console.log(JSON.stringify({ event: "init", conversation_id: "conv-agy-1", init: { model: "gemini-4-hydrogen-medium" } }));
console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-agy-1", step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "ls" } } } }));
console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-agy-1", step_index: 1, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "ls" }, output: "ok" } } }));
console.log(JSON.stringify({ event: "step_update", step_update: { conversation_id: "conv-agy-1", step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "done" } }));
console.log(JSON.stringify({ event: "result", result: { conversation_id: "conv-agy-1", status: "SUCCESS", usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30 } } }));
`,
			);
			const driver = new AgyDriver(dir, { executablePath: script });
			await driver.setModel("agy/gemini-4-hydrogen-medium");
			const started = vi.fn();
			const textDelta = vi.fn();
			const toolStart = vi.fn();
			const toolEnd = vi.fn();
			const turnComplete = vi.fn();
			const onError = vi.fn();
			const sink: AgentEventSink = {
				onSessionStarted: started,
				onTextDelta: textDelta,
				onThinkingDelta: vi.fn(),
				onToolStart: toolStart,
				onToolEnd: toolEnd,
				onTurnComplete: turnComplete,
				onError,
			};

			await driver.sendPrompt("hello", undefined, sink);

			expect(onError).not.toHaveBeenCalled();
			expect(driver.getActiveSessionId()).toBe("conv-agy-1");
			expect(started).toHaveBeenCalledWith("conv-agy-1");
			expect(toolStart).toHaveBeenCalledWith("conv-agy-1:1", "run_command", { CommandLine: "ls" });
			expect(toolEnd).toHaveBeenCalledWith("conv-agy-1:1", { output: "ok" });
			expect(textDelta).toHaveBeenCalledWith("done");
			expect(turnComplete).toHaveBeenCalledWith({
				model: "gemini-4-hydrogen-medium",
				usage: { inputTokens: 70, cacheReadTokens: 30, outputTokens: 20 },
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
