import { BaseAgentDriver, type AgentCapabilities, type AgentEventSink } from "../driver-base.js";
import type { PromptAttachment, SlashCommandInfo } from "../../protocol.js";

export class MockAgentDriver extends BaseAgentDriver {
	readonly id = "mock";
	readonly name = "Mock Agent";
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: false,
		supportsHistoryEdit: false,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: true,
	};

	private aborted = false;
	private sessionCounter = 0;

	async createSession(): Promise<string> {
		return `mock-session-${++this.sessionCounter}`;
	}

	async resumeSession(_sessionId: string): Promise<void> {}

	async sendPrompt(prompt: string, _attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void> {
		this.aborted = false;

		sink.onThinkingDelta("Thinking about how to handle: ");
		if (this.aborted) return;
		sink.onThinkingDelta(prompt);
		if (this.aborted) return;

		if (prompt.includes("tool")) {
			const callId = `call_${Date.now()}`;
			sink.onToolStart(callId, "bash", { command: "echo hello world" });
			if (this.aborted) return;
			sink.onToolEnd(callId, { output: "hello world\n" });
			if (this.aborted) return;
		}

		sink.onTextDelta("Response: ");
		if (this.aborted) return;
		sink.onTextDelta(`I have processed your request: "${prompt}".`);
		if (this.aborted) return;

		sink.onTurnComplete({
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 40,
				cacheWriteTokens: 10,
				costUSD: 0.005,
			},
			costUSD: 0.005,
			contextTokens: 150,
			model: "mock-model-v1",
		});
	}

	async abort(): Promise<void> {
		this.aborted = true;
	}

	async listModels(): Promise<Array<{ id: string; name: string }>> {
		return [
			{ id: "mock-model-v1", name: "Mock Model v1" },
			{ id: "mock-model-v2", name: "Mock Model v2" },
		];
	}

	override async getSlashCommands(): Promise<SlashCommandInfo[]> {
		return [
			{
				name: "mock-echo",
				description: "测试 Mock 驱动命令回显",
				descriptionEn: "Test Mock driver command echo",
				source: "extension",
				argumentHint: "[text]",
			},
		];
	}

	override async execSlashCommand(
		name: string,
		args: string,
		context?: {
			emitNotice?: (level: "info" | "warning" | "error", text: string, textEn?: string) => void;
			sink?: AgentEventSink;
		},
	): Promise<boolean> {
		if (name === "mock-echo") {
			context?.emitNotice?.("info", `Mock echo: ${args}`, `Mock echo: ${args}`);
			return true;
		}
		return false;
	}

	override async getSkills(): Promise<Array<{ name: string; description: string; filePath?: string }>> {
		return [
			{
				name: "mock-analyzer",
				description: "Mock 示例代码分析技能",
				filePath: "",
			},
		];
	}

	dispose(): void {
		this.aborted = true;
	}
}
