import { describe, it, expect } from "vitest";
import { buildToolsSchemaText, type ToolSchemaEntry } from "../../server/prompt-composer.js";
import type { UiSettingsState } from "../../server/protocol.js";

describe("DSH 引擎系统提示词与详情功能", () => {
	it("UiSettingsState 契约包含 DSH 提示词展示与配置字段", () => {
		const sampleState: Partial<UiSettingsState> = {
			promptMode: "append",
			customSystemPrompt: "Custom prompt text",
			effectiveSystemPrompt: "Full assembled system prompt",
			toolsSchema: "## bash\nRun shell commands",
			promptSections: [
				{ name: "harness:identity", text: "You are an AI agent", chars: 20 },
				{ name: "pi-webui:custom-prompt", text: "Custom prompt text", chars: 18 },
			],
			promptSourceDefaults: {
				"harness:identity": "You are an AI agent",
			},
		};

		expect(sampleState.promptMode).toBe("append");
		expect(sampleState.customSystemPrompt).toBe("Custom prompt text");
		expect(sampleState.effectiveSystemPrompt).toBe("Full assembled system prompt");
		expect(sampleState.promptSections).toHaveLength(2);
		expect(sampleState.promptSections?.[0].name).toBe("harness:identity");
		expect(sampleState.promptSourceDefaults?.["harness:identity"]).toBe("You are an AI agent");
	});

	it("buildToolsSchemaText 能正确格式化 DSH 运行时的工具列表", () => {
		const sampleTools: ToolSchemaEntry[] = [
			{
				name: "bash",
				description: "Run shell command",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string" },
					},
					required: ["command"],
				},
			},
			{
				name: "read_file",
				description: "Read file contents",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string" },
					},
					required: ["path"],
				},
			},
		];

		const schemaText = buildToolsSchemaText(sampleTools);
		expect(schemaText).toContain("## bash");
		expect(schemaText).toContain("Run shell command");
		expect(schemaText).toContain('"command": {');
		expect(schemaText).toContain("## read_file");
		expect(schemaText).toContain("Parameters (JSON Schema):");
	});

	it("空工具列表时返回空串", () => {
		expect(buildToolsSchemaText([])).toBe("");
	});
});
