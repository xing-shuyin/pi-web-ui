import { describe, expect, it } from "vitest";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { makeAskUserQuestionTool } from "../../server/ask-user-question-tool.js";
import { makeBrowserPageTool } from "../../server/browser-page-tool.js";
import { makeCanvasTool } from "../../server/canvas/canvas-agent-tool.js";
import { makeClaimFilesTool } from "../../server/claim-files-tool.js";
import { makeCompactContextTool } from "../../server/compact-context-tool.js";
import { makeDelegateTaskTool } from "../../server/delegate-task.js";
import { makeEditToolDefinition } from "../../server/edit-tool.js";
import { makeEvalTool } from "../../server/eval-tool.js";
import { makeLspTool } from "../../server/lsp-tool.js";
import { makeMcpManageTool } from "../../server/mcp-agent-tool.js";
import { makePatchTool } from "../../server/patch-tool.js";
import { makePlanUpdateTool } from "../../server/plan-update-tool.js";
import { makePresentFilesTool } from "../../server/present-files-tool.js";
import { makeReadDirTool } from "../../server/read-tool.js";
import { makeSandboxTool } from "../../server/sandbox-tool.js";
import { makeScheduleTool } from "../../server/schedule-agent-tool.js";
import { makeSkillTool } from "../../server/skill-tool.js";
import { makePersistentTerminalTools } from "../../server/terminals.js";
import { makeWorktreeTool } from "../../server/worktree-tool.js";
import {
	BASH_DESCRIPTION,
	BASH_PARAMETERS,
	FIND_DESCRIPTION,
	FIND_PARAMETERS,
	GREP_DESCRIPTION,
	GREP_PARAMETERS,
	LS_DESCRIPTION,
	LS_PARAMETERS,
	POWERSHELL_DESCRIPTION,
	POWERSHELL_PARAMETERS,
	WRITE_DESCRIPTION,
	WRITE_PARAMETERS,
} from "../../server/tool-prompts.js";

/** 装饰性 JSON Schema 关键字：发给模型前一律不出现（约束留在 handler 里）。 */
const DECORATION = [
	"anyOf",
	"oneOf",
	"allOf",
	"minLength",
	"minItems",
	"maxItems",
	"minimum",
	"maximum",
	"patternProperties",
];

function decorations(schema: unknown): string[] {
	const hits: string[] = [];
	const walk = (node: unknown, path: string) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach((item, index) => walk(item, `${path}[${index}]`));
			return;
		}
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (DECORATION.includes(key)) hits.push(`${path}/${key}`);
			if (key === "properties" && value && typeof value === "object") {
				for (const [name, child] of Object.entries(value as Record<string, unknown>)) walk(child, `${path}/${name}`);
				continue;
			}
			walk(value, `${path}/${key}`);
		}
	};
	walk(schema, "");
	return hits;
}

/** 字段名 → 字段说明，扁平化；用来钉住「哪些字段才允许有说明」。 */
function fieldDescriptions(schema: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (node: unknown, path: string) => {
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		const properties = record.properties;
		if (properties && typeof properties === "object") {
			for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
				const here = path ? `${path}.${name}` : name;
				const description = (child as { description?: unknown } | undefined)?.description;
				if (typeof description === "string") out[here] = description;
				walk(child, here);
			}
		}
		if (record.items) walk(record.items, path);
	};
	walk(schema, "");
	return out;
}

function keys(schema: unknown): string[] {
	const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
	return Object.keys(properties ?? {}).sort();
}

function requiredKeys(schema: unknown): string[] {
	const required = (schema as { required?: unknown } | undefined)?.required;
	return Array.isArray(required) ? [...(required as string[])].sort() : [];
}

const pageSession = {
	pageCall: async () => ({ ok: true as const }),
};

// 下面这批工具的宿主只在 execute 里用到；构造 schema 不需要真宿主。
const host = {} as any;
const en = () => "en" as const;
const noop = () => {};

const tools = {
	read: {
		description: makeReadDirTool(process.cwd()).description,
		parameters: makeReadDirTool(process.cwd()).parameters,
	},
	bash: { description: BASH_DESCRIPTION, parameters: BASH_PARAMETERS },
	edit: {
		description: makeEditToolDefinition(process.cwd()).description,
		parameters: makeEditToolDefinition(process.cwd()).parameters,
	},
	write: { description: WRITE_DESCRIPTION, parameters: WRITE_PARAMETERS },
	ask_user_question: (() => {
		const tool = makeAskUserQuestionTool({ askUser: async () => ({}) as never }) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	browser_page: (() => {
		const tool = makeBrowserPageTool(pageSession as never) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	claim_files: (() => {
		const tool = makeClaimFilesTool({
			cwd: () => process.cwd(),
			self: () => ({ convId: "c", title: "t" }),
			store: () => undefined,
		}) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	present_files: (() => {
		const tool = makePresentFilesTool(process.cwd()) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	skill: (() => {
		const tool = makeSkillTool({ listSkills: () => [] }) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	grep: { description: GREP_DESCRIPTION, parameters: GREP_PARAMETERS },
	find: { description: FIND_DESCRIPTION, parameters: FIND_PARAMETERS },
	ls: { description: LS_DESCRIPTION, parameters: LS_PARAMETERS },
	powershell: { description: POWERSHELL_DESCRIPTION, parameters: POWERSHELL_PARAMETERS },
	patch: (() => {
		const tool = makePatchTool({ cwd: process.cwd() }) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	eval: (() => {
		const tool = makeEvalTool({ cwd: process.cwd() }) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	lsp: (() => {
		const tool = makeLspTool({ cwd: process.cwd() }) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	plan_update: (() => {
		const tool = makePlanUpdateTool(host, () => "", noop, noop) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	compact_context: (() => {
		const tool = makeCompactContextTool(host, en) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	sandbox: (() => {
		const tool = makeSandboxTool(host, en) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	worktree: (() => {
		const tool = makeWorktreeTool(host, en) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	schedule: (() => {
		const tool = makeScheduleTool(host, undefined, en) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	mcp_manage: (() => {
		const tool = makeMcpManageTool(host, en) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	canvas: (() => {
		const tool = makeCanvasTool(host, en) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	terminal: (() => {
		const tool = makePersistentTerminalTools(host, process.cwd(), en)[0] as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
	delegate_task: (() => {
		const tool = makeDelegateTaskTool(host, en) as any;
		return { description: tool.description as string, parameters: tool.parameters };
	})(),
} as const;

describe("工具 schema 脱水（只留字段名与类型，说明归唯一归属处）", () => {
	it.each(Object.keys(tools))("%s 的导出参数里没有装饰性约束", (name) => {
		expect(decorations((tools as Record<string, { parameters: unknown }>)[name].parameters)).toEqual([]);
	});

	it("字段说明只留在自解释不了的那几个字段上", () => {
		const expected: Record<string, Record<string, string>> = {
			read: { offset: "1-indexed start line" },
			bash: {
				timeout: "Seconds, default 120; background jobs default to 0 (no limit)",
				persist: "Retain shell state (cd/venv/ssh) in ai-bash terminal",
				background: "Detached: call returns a job id, process keeps running",
			},
			edit: { soft: "Ignore leading whitespace/indentation per line" },
			write: {},
			ask_user_question: {},
			browser_page: { op: expect.any(String), target: "Origin URL or native tabId" } as never,
			claim_files: {},
			present_files: { "items.focus": "Open preview dialog immediately" },
			skill: { name: "Skill name (omit to list catalog)" },
			grep: {},
			find: {},
			ls: {},
			powershell: { timeout: "Seconds" },
			patch: { timeout: "Seconds" },
			eval: { timeout: "Seconds", reset: "Clear variables before running" },
			lsp: {
				action: expect.any(String),
				timeout: "Seconds, default 15",
				allowInstall: "Install missing language server in user space",
			} as never,
			plan_update: {},
			compact_context: {
				focus: "1) Active goal, 2) context to PRESERVE, 3) history to REMOVE or condense",
				keepRecentTokens: "Recent tokens kept verbatim; omit = auto",
			},
			sandbox: { action: expect.any(String) } as never,
			worktree: { action: expect.any(String) } as never,
			schedule: { action: expect.any(String), schedule: expect.any(String) } as never,
			mcp_manage: {
				action: expect.any(String),
				name: "Server id; install derives it from package/url",
				package: "npm package, expands to npx -y <package>",
			} as never,
			canvas: { action: expect.any(String), cwd: expect.any(String) } as never,
			terminal: { action: expect.any(String), data: "Include newline to submit" } as never,
			delegate_task: {
				agent: "Template name from subagent(action='templates')",
				required_tools: "Free text; 'read-only' switches the subagent to a readonly whitelist",
				model: "provider/id; omit to inherit the template and panel model",
				persist: "Keep the session in history",
			} as never,
		};
		for (const [name, tool] of Object.entries(tools)) {
			expect(fieldDescriptions(tool.parameters), name).toEqual(expected[name]);
		}
	});

	it("顶层描述是一行紧凑文案", () => {
		expect(tools.read.description).toBe(
			"Read file text/image or list directory entries ('/' suffix). Truncated to 2000 lines/50KB; use offset/limit to paginate.",
		);
		expect(tools.bash.description).toBe(
			"Run shell command. Do not pipe to head/tail/more/less; use head/tail params instead.",
		);
		expect(tools.edit.description).toBe("Replace unique oldText with newText in a file. Non-overlapping edits only.");
		expect(tools.write.description).toBe("Write or overwrite file content (auto-creates parent dirs).");
		expect(tools.ask_user_question.description).toBe("Ask the user 1-3 questions via interactive dialog.");
		expect(tools.browser_page.description).toBe("Read or act on AI Browser tabs or page-picker.");
		expect(tools.claim_files.description).toBe(
			"Advisory file reservation for parallel runs (auto-releases on run end).",
		);
		expect(tools.present_files.description).toBe("Show workspace files (1-12) as preview cards in chat.");
		expect(tools.skill.description).toBe("Load skill text or list catalog.");
		expect(tools.grep.description).toBe(
			"Search file contents by regex or literal (respects .gitignore, max 100 matches/50KB).",
		);
		expect(tools.find.description).toBe("Find files by glob pattern (respects .gitignore, max 1000 results/50KB).");
	});

	it("read 只声明 path/offset/limit（file_path 别名仍在 prepareArguments 里静默兼容）", () => {
		expect(keys(tools.read.parameters)).toEqual(["limit", "offset", "path"]);
		expect(requiredKeys(tools.read.parameters)).toEqual(["path"]);
	});

	it("枚举类参数显式列出候选值", () => {
		const op = (tools.browser_page.parameters as any).properties.op;
		expect(op.enum).toEqual([
			"status",
			"pages",
			"read",
			"click",
			"type",
			"scroll",
			"goto",
			"wait",
			"eval",
			"shot",
			"snapshot",
		]);
		expect((tools.browser_page.parameters as any).properties.what.enum).toEqual([
			"text",
			"html",
			"title",
			"url",
			"query",
		]);
		expect((tools.claim_files.parameters as any).properties.action.enum).toEqual(["claim", "release", "list"]);
		expect((tools.skill.parameters as any).properties.action.enum).toEqual(["read", "list", "report"]);
	});

	it("action 式工具的候选值写 enum（不再是 anyOf/const 展开）", () => {
		const actions: Record<string, string[]> = {
			sandbox: ["list", "create", "diff", "reset", "persist", "promote", "apply_to_source", "destroy"],
			worktree: ["list", "create", "switch", "remove"],
			schedule: ["create", "list", "cancel"],
			mcp_manage: ["list", "check", "install", "remove", "reload"],
			terminal: ["create", "list", "close", "input", "key", "read", "wait"],
			lsp: [
				"definition",
				"references",
				"hover",
				"diagnostics",
				"documentSymbol",
				"read_symbol",
				"workspaceSymbol",
				"cascade",
			],
		};
		for (const [name, list] of Object.entries(actions)) {
			expect((tools as Record<string, any>)[name].parameters.properties.action.enum, name).toEqual(list);
		}
		// canvas 的 24 个 action 只断言“有 enum 且覆盖全部声明”
		const canvasActions = (tools.canvas.parameters as any).properties.action;
		expect(Array.isArray(canvasActions.enum)).toBe(true);
		expect(canvasActions.enum).toHaveLength(24);
		expect((tools.eval.parameters as any).properties.language.enum).toEqual(["py", "js", "ts"]);
	});

	it("顶层 description ≤ 600；patch 是 Hashline 语法的唯一例外", () => {
		for (const [name, tool] of Object.entries(tools)) {
			if (name === "patch") continue;
			expect(tool.description.length, `${name}: ${tool.description.length}`).toBeLessThanOrEqual(600);
		}
		// Hashline 的 [path#TAG] / PUT / CUT 语法本身就是契约，删了模型就写不出补丁。
		expect(tools.patch.description).toContain("[path#TAG]");
		expect(tools.patch.description.length).toBeLessThanOrEqual(1000);
	});

	it("宿主精简的 write/grep/find/ls/powershell 与 SDK 内置定义的字段名、必填项一致（SDK 增删参数会在这里报红）", () => {
		const cwd = process.cwd();
		const pairs = [
			["write", WRITE_PARAMETERS, createWriteToolDefinition(cwd).parameters],
			["grep", GREP_PARAMETERS, createGrepToolDefinition(cwd).parameters],
			["find", FIND_PARAMETERS, createFindToolDefinition(cwd).parameters],
			["ls", LS_PARAMETERS, createLsToolDefinition(cwd).parameters],
			["powershell", POWERSHELL_PARAMETERS, createPowerShellToolDefinition(cwd).parameters],
		] as const;
		for (const [name, slim, builtin] of pairs) {
			expect(keys(slim), name).toEqual(keys(builtin));
			expect(requiredKeys(slim), name).toEqual(requiredKeys(builtin));
		}
	});

	it("ask_user_question 的导出 schema 不含弹窗专属字段", () => {
		const schema = (tools.ask_user_question.parameters as any).properties.questions;
		expect(Object.keys(schema.items.properties)).toEqual(["id", "question", "detail", "options", "multiSelect"]);
		expect(Object.keys(schema.items.properties.options.items.properties)).toEqual([
			"label",
			"description",
			"recommended",
		]);
	});

	it("read 的 file_path 别名仍在 prepareArguments 里静默兼容", () => {
		const tool = makeReadDirTool(process.cwd()) as any;
		if (typeof tool.prepareArguments !== "function") return;
		expect(tool.prepareArguments({ file_path: "AGENTS.md" })).toEqual({ file_path: "AGENTS.md", path: "AGENTS.md" });
	});
});
