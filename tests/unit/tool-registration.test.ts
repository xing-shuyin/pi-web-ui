import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AGENT_TOOL_CATALOG,
	ASK_USER_QUESTION_TOOL_NAME,
	BROWSER_PAGE_TOOL_NAME,
	BROWSER_SCRIPT_TOOL_NAME,
	CANVAS_TOOL_NAME,
	CLAIM_FILES_TOOL_NAME,
	CODEMODE_TOOL_NAME,
	COMPACT_CONTEXT_TOOL_NAME,
	CONVERSATION_READ_TOOL_NAME,
	DELEGATE_TASK_TOOL_NAME,
	DEVICE_COLLAB_TOOL_NAME,
	EVAL_TOOL_NAME,
	GROUP_BOT_TOOL_CATALOG,
	LSP_TOOL_NAME,
	MCP_MANAGE_TOOL_NAME,
	SANDBOX_TOOL_NAME,
	WORKTREE_TOOL_NAME,
	LOAD_TOOLS_TOOL_NAME,
	PATCH_TOOL_NAME,
	PLAN_UPDATE_TOOL_NAME,
	PRESENT_FILES_TOOL_NAME,
	SCHEDULE_TOOL_NAME,
	SKILL_TOOL_NAME,
	CONVERSATION_TOOL_NAME,
	COMMUNICATE_TOOL_NAME,
	TERMINAL_TOOL_NAMES,
	TOOL_SEARCH_TOOL_NAME,
} from "../../server/tool-manager.js";

it("merges transcript inspection into the conversation catalog entry", () => {
	expect(AGENT_TOOL_CATALOG.some((tool) => tool.name === "conversation_read")).toBe(false);
	expect(AGENT_TOOL_CATALOG.filter((tool) => tool.name === "conversation")).toHaveLength(1);
	expect(AGENT_SERVICE_SRC).toContain("customTools: mergeConversationTools([");
});

it("registers exactly one terminal catalog entry", () => {
	expect(TERMINAL_TOOL_NAMES).toEqual(["terminal"]);
	expect(AGENT_TOOL_CATALOG.filter((t) => t.name.startsWith("terminal")).map((t) => t.name)).toEqual(["terminal"]);
});

const AGENT_SERVICE_SRC = readFileSync(join(__dirname, "..", "..", "server", "agent-service.ts"), "utf8");

const INTRINSIC = new Set(["bash", "read", "edit"]);

const HARNESS = new Set([LOAD_TOOLS_TOOL_NAME]);

const BOT_ONLY = new Set(GROUP_BOT_TOOL_CATALOG.map((t) => t.name));

const FACTORY_TOOLS: Record<string, string[]> = {
	makeAdaptiveBashTool: ["bash"],
	makeKillableBashTool: ["bash"],
	makeTerminalBashTool: ["bash"],
	makePersistentTerminalTools: [...TERMINAL_TOOL_NAMES],
	makeReadDirTool: ["read"],
	makeEditToolDefinition: ["edit"],
	makeSubagentTools: [CONVERSATION_TOOL_NAME],
	makeCommunicateTool: [COMMUNICATE_TOOL_NAME],
	makeDelegateTaskTool: [DELEGATE_TASK_TOOL_NAME],
	makeAskUserQuestionTool: [ASK_USER_QUESTION_TOOL_NAME],
	makeBrowserPageTool: [BROWSER_PAGE_TOOL_NAME],
	makeBrowserScriptTool: [BROWSER_SCRIPT_TOOL_NAME],
	makeConversationReadTool: [CONVERSATION_READ_TOOL_NAME],
	makeClaimFilesTool: [CLAIM_FILES_TOOL_NAME],
	makePlanUpdateTool: [PLAN_UPDATE_TOOL_NAME],
	makePresentFilesTool: [PRESENT_FILES_TOOL_NAME],
	makeSkillTool: [SKILL_TOOL_NAME],
	makeCompactContextTool: [COMPACT_CONTEXT_TOOL_NAME],
	makeScheduleTool: [SCHEDULE_TOOL_NAME],
	makeEvalTool: [EVAL_TOOL_NAME],
	makePatchTool: [PATCH_TOOL_NAME],
	makeLspTool: [LSP_TOOL_NAME],
	makeMcpManageTool: [MCP_MANAGE_TOOL_NAME],
	makeSandboxTool: [SANDBOX_TOOL_NAME],
	makeWorktreeTool: [WORKTREE_TOOL_NAME],
	makeDeviceCollabTool: [DEVICE_COLLAB_TOOL_NAME],
	makeCanvasTool: [CANVAS_TOOL_NAME],
	makeLoadToolsTool: [LOAD_TOOLS_TOOL_NAME],
	createCodemodeExtension: [CODEMODE_TOOL_NAME],
	createToolSearchExtension: [TOOL_SEARCH_TOOL_NAME],
};

function calledFactories(): Set<string> {
	const lines = AGENT_SERVICE_SRC.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((l) => !/^\s*(\/\/|\*)/.test(l) && !/function\s+make/.test(l))
		.map((l) => l.replace(/\/\/.*$/, ""));
	const found = new Set<string>();
	for (const m of lines
		.join("\n")
		.matchAll(/\b(make[A-Za-z]*Tools?|createCodemodeExtension|createToolSearchExtension)\(/g))
		found.add(m[1]);
	return found;
}

describe("注册→目录", () => {
	it("每个注册工厂都在对照表里登记（新工厂必须当场分类：入目录还是内核）", () => {
		const unknown = [...calledFactories()].filter((f) => !(f in FACTORY_TOOLS));
		expect(
			unknown,
			`以下工厂在 agent-service.ts 里注册了工具，却没在 FACTORY_TOOLS 登记：${unknown.join(", ")}（入目录 or 内核白名单，二选一）`,
		).toEqual([]);
	});

	it("每个产出的工具名都有归属：目录、内核白名单或群组运行态专用", () => {
		const known = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));
		const homeless: string[] = [];
		for (const [factory, tools] of Object.entries(FACTORY_TOOLS)) {
			for (const name of tools) {
				if (!known.has(name) && !INTRINSIC.has(name) && !HARNESS.has(name) && !BOT_ONLY.has(name)) {
					homeless.push(`${name}（来自 ${factory}）`);
				}
			}
		}
		expect(
			homeless,
			`以下工具注册了却无处可去：${homeless.join("、")}（进 AGENT_TOOL_CATALOG、INTRINSIC 或 GROUP_BOT_TOOL_CATALOG）`,
		).toEqual([]);
	});

	it("device_collab 作为群组专用运行时工具，不进普通用户 Web 设置目录", () => {
		expect(AGENT_TOOL_CATALOG.some((tool) => tool.name === DEVICE_COLLAB_TOOL_NAME)).toBe(false);
		expect(GROUP_BOT_TOOL_CATALOG.some((tool) => tool.name === DEVICE_COLLAB_TOOL_NAME)).toBe(true);
	});

	it("agent-service 仅在 botExecution 存在时才条件注入 makeDeviceCollabTool", () => {
		expect(AGENT_SERVICE_SRC).toMatch(/\.\.\.\(this\.botExecution\s*\?\s*\[makeDeviceCollabTool\(\)\]\s*:\s*\[\]\)/);
	});

	it("目录里的每个工具都被某个工厂注册（反向：有目录无注册 = 开关摆设）", () => {
		const produced = new Set(Object.values(FACTORY_TOOLS).flat());
		const unregistered = AGENT_TOOL_CATALOG.map((t) => t.name).filter((n) => !produced.has(n));
		expect(
			unregistered,
			`以下工具在目录里、却没有任何工厂注册它：${unregistered.join(", ")}（开关开了也没东西可开）`,
		).toEqual([]);
	});

	it("核心内置工具不入目录（它们走设置页「核心工具」区，不占 OTHER_AGENT_TOOLS 目录行）", () => {
		const known = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));
		expect([...INTRINSIC].filter((n) => known.has(n))).toEqual([]);
	});

	it("所有 Type.Unsafe 参数均显式声明 type（防 Moonshot 等严格端点 HTTP 400，#590）", () => {
		const serverDir = join(__dirname, "..", "..", "server");
		const missingType: string[] = [];
		for (const file of readdirSync(serverDir).filter((f) => f.endsWith(".ts"))) {
			const src = readFileSync(join(serverDir, file), "utf8");
			for (const m of src.matchAll(/Type\.Unsafe(?:<[^>]*>)?\(\s*\{([\s\S]*?)\}\s*\)/g)) {
				const body = m[1];
				if (!/\btype\s*:/.test(body)) {
					const line = src.slice(0, m.index ?? 0).split("\n").length;
					missingType.push(`${file}:${line}`);
				}
			}
		}
		expect(
			missingType,
			`以下 Type.Unsafe({...}) 缺少显式 type 字段，会导致严格校验端点返回 HTTP 400：${missingType.join(", ")}`,
		).toEqual([]);
	});
});
