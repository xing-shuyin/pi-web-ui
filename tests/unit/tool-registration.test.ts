/**
 * 注册→目录守卫（静态源码检查，不启动服务）。
 *
 * 为什么需要：claim_files 当年就是从这里漏的——在 agent-service.ts 的 customTools
 * 里注册了，却没进 AGENT_TOOL_CATALOG，全程静默，没有任何测试变红。
 * settings-tool-rows 只守「目录→设置行」，不管「注册→目录」。
 *
 * 规则：agent-service.ts 里调用的每个 make*Tool(s) 工厂，必须在 FACTORY_TOOLS 里
 * 登记它的产出；每个产出的工具名要么在目录里（可开关），要么在 INTRINSIC 内核
 * 白名单里（bash/read：覆盖 SDK 内置，关了 agent 就残，不给关；锁死、永不入目录）。
 * 加新工具 = 在这里给它的工厂登记一行，逼着你当场决定：入目录还是内核。
 * 插件工具走 enabledPluginToolDefs 动态区，不经过 make*Tool 调用，不管。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AGENT_TOOL_CATALOG,
	ASK_USER_QUESTION_TOOL_NAME,
	BROWSER_PAGE_TOOL_NAME,
	CLAIM_FILES_TOOL_NAME,
	CONVERSATION_READ_TOOL_NAME,
	DELEGATE_TASK_TOOL_NAME,
	EDIT_SOFT_TOOL_NAME,
	EVAL_TOOL_NAME,
	MARKERS_LIST_TOOL_NAME,
	PRESENT_FILES_TOOL_NAME,
	SCHEDULE_CANCEL_TOOL_NAME,
	SCHEDULE_LIST_TOOL_NAME,
	SCHEDULE_TASK_TOOL_NAME,
	SKILL_TOOL_NAME,
	SUBAGENT_TOOL_NAMES,
	TERMINAL_TOOL_NAMES,
} from "../../server/tool-manager.js";

const AGENT_SERVICE_SRC = readFileSync(join(__dirname, "..", "..", "server", "agent-service.ts"), "utf8");

/** 注册了但永远不给开关的内核工具（覆盖 SDK 内置；目录里有它们 = 用户能把 agent 变砖）。 */
const INTRINSIC = new Set(["bash", "read"]);

/** 工厂 → 它注册的工具名（与各工厂的 name: 对齐；makeSubagentTools 产出 7 个子代理工具，见 subagents.ts）。 */
const FACTORY_TOOLS: Record<string, string[]> = {
	makeAdaptiveBashTool: ["bash"],
	makeKillableBashTool: ["bash"],
	makeTerminalBashTool: ["bash"],
	makePersistentTerminalTools: [...TERMINAL_TOOL_NAMES],
	makeReadDirTool: ["read"],
	makeEditSoftTool: [EDIT_SOFT_TOOL_NAME],
	makeSubagentTools: [...SUBAGENT_TOOL_NAMES],
	makeDelegateTaskTool: [DELEGATE_TASK_TOOL_NAME],
	makeMarkersListTool: [MARKERS_LIST_TOOL_NAME],
	makeAskUserQuestionTool: [ASK_USER_QUESTION_TOOL_NAME],
	makeBrowserPageTool: [BROWSER_PAGE_TOOL_NAME],
	makeConversationReadTool: [CONVERSATION_READ_TOOL_NAME],
	makeClaimFilesTool: [CLAIM_FILES_TOOL_NAME],
	makePresentFilesTool: [PRESENT_FILES_TOOL_NAME],
	makeSkillTool: [SKILL_TOOL_NAME],
	makeScheduleTools: [SCHEDULE_TASK_TOOL_NAME, SCHEDULE_LIST_TOOL_NAME, SCHEDULE_CANCEL_TOOL_NAME],
	makeEvalTool: [EVAL_TOOL_NAME],
};

/** agent-service.ts 里实际调用的工厂（去注释、防定义行，只认 `makeXxxTool(` 调用）。 */
function calledFactories(): Set<string> {
	const lines = AGENT_SERVICE_SRC.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((l) => !/^\s*(\/\/|\*)/.test(l) && !/function\s+make/.test(l))
		.map((l) => l.replace(/\/\/.*$/, ""));
	const found = new Set<string>();
	for (const m of lines.join("\n").matchAll(/\b(make[A-Za-z]*Tools?)\(/g)) found.add(m[1]);
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

	it("每个产出的工具名都有归属：目录 或 内核白名单", () => {
		const known = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));
		const homeless: string[] = [];
		for (const [factory, tools] of Object.entries(FACTORY_TOOLS)) {
			for (const name of tools) {
				if (!known.has(name) && !INTRINSIC.has(name)) homeless.push(`${name}（来自 ${factory}）`);
			}
		}
		expect(
			homeless,
			`以下工具注册了却无处可去：${homeless.join("、")}（进 AGENT_TOOL_CATALOG 或 INTRINSIC，二选一）`,
		).toEqual([]);
	});

	it("目录里的每个工具都被某个工厂注册（反向：有目录无注册 = 开关摆设）", () => {
		const produced = new Set(Object.values(FACTORY_TOOLS).flat());
		const unregistered = AGENT_TOOL_CATALOG.map((t) => t.name).filter((n) => !produced.has(n));
		expect(
			unregistered,
			`以下工具在目录里、却没有任何工厂注册它：${unregistered.join(", ")}（开关开了也没东西可开）`,
		).toEqual([]);
	});

	it("bash/read 永不入目录（关了 agent 就残，不给关）", () => {
		const known = new Set(AGENT_TOOL_CATALOG.map((t) => t.name));
		expect([...INTRINSIC].filter((n) => known.has(n))).toEqual([]);
	});
});
