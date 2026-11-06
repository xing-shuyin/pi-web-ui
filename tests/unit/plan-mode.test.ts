import { describe, expect, it } from "vitest";
import {
	bashCommandIsReadOnly,
	buildPlanModePrompt,
	planModeDenial,
	PLAN_MODE_BLOCKED_TOOL_NAMES,
	PLAN_MODE_SYSTEM_PROMPT,
	syncTerminalReadOnlySchema,
} from "../../server/plan-mode.js";

describe("merged terminal", () => {
	it("allows only read actions and restores the original schema", () => {
		for (const action of ["list", "read", "wait"]) expect(planModeDenial("terminal", { action })).toBeUndefined();
		for (const action of ["create", "close", "input", "key", "", "unknown"])
			expect(planModeDenial("terminal", { action, command: "pwd" })).toBeDefined();
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("terminal")).toBe(false);
		const parameters = {
			type: "object",
			properties: { action: { enum: ["create", "list", "close", "input", "key", "read", "wait"] } },
		};
		const tool = { parameters };
		const session = { _toolRegistry: new Map([["terminal", tool]]) };
		syncTerminalReadOnlySchema(session, true);
		syncTerminalReadOnlySchema(session, true);
		expect(tool.parameters.properties.action.enum).toEqual(["list", "read", "wait"]);
		syncTerminalReadOnlySchema(session, false);
		expect(tool.parameters).toBe(parameters);
	});
});

describe("bashCommandIsReadOnly", () => {
	it("放行只读命令", () => {
		for (const cmd of [
			"ls -la",
			"cat server/index.ts",
			"git status",
			"git diff --stat",
			"git log --oneline -5",
			"rg -n set_plan_mode server",
			"grep -rn foo . | head -20",
			"wc -l server/index.ts",
			"jq .name package.json",
			"find . -name '*.ts' -newer package.json",
			"node --version",
			"pwd && ls",
			"cat a.txt | grep x | wc -l",
			"rg --glob '*.ts' --max-count=3 'hello world' server",
			"git --no-pager diff --name-only",
			"find . -name '*.ts' -maxdepth 3 -print",
		]) {
			expect(bashCommandIsReadOnly(cmd), cmd).toBe(true);
		}
	});

	it("拒绝写操作与命令替换", () => {
		for (const cmd of [
			"",
			"rm -rf dist",
			"mkdir -p out",
			"git commit -m x",
			"git push",
			"npm install",
			"npm run build",
			'node -e \'require("fs").rmSync("x")\'',
			"echo hi > out.txt",
			"cat f | tee g",
			"sed -i 's/a/b/' f.ts",
			"awk '{print > \"f\"}'",
			"find . -name '*.log' -delete",
			"find . -exec touch pwned {} +",
			"find . -name '*.tmp' -execdir rm {} \\;",
			"find . -fprintf /tmp/pwn x",
			"ls $(git rev-parse HEAD)",
			"sleep 5 &",
			"cat <<EOF",
			"python3 script.py",
			"python -v",
			"python3 -v",
		]) {
			expect(bashCommandIsReadOnly(cmd), cmd).toBe(false);
		}
	});

	it("rejects unsupported syntax and command capabilities, not just known payloads", () => {
		for (const cmd of [
			'ls "$(touch pwned)"',
			'cat "`touch pwned`"',
			"ls & touch pwned & pwd",
			"ls &&",
			"| ls",
			"ls || || pwd",
			"ls 'unfinished",
			"ls \\\n&& pwd",
			"ls\r\npwd",
			"ls # comment",
			"ls (pwd)",
			"env ls",
			"command ls",
			"nohup ls",
			"time ls",
			"PATH=evil ls",
			"rg * foo .",
			"git log *",
			"wc -l *.ts",
			"LC_ALL=C sort f.txt",
			"/tmp/ls x",
			"awk 'BEGIN { system(\"touch x\") }'",
			"sed '1e touch x' f",
			"sed -n '1w x' f",
			"sort -o output input",
			"uniq input output",
			"fd -x touch x",
			"fd --exec=touch x",
			"rg --pre=touch foo .",
			"rg --hostname-bin touch foo",
			"yq -i '.a=1' f",
			"git diff --output=x",
			"git log --output x",
			"git -c core.pager=touch log",
			"git --exec-path=/tmp status",
			"git show --ext-diff",
			"git grep --open-files-in-pager=touch foo",
			"git cat-file --filters HEAD:f",
			"find . -fprint x",
			"jq -L /tmp 'include \"evil\"' f",
			"jq 'input' f",
			"rg --new-side-effect-option foo",
			"ls --unknown-option",
		])
			expect(bashCommandIsReadOnly(cmd), cmd).toBe(false);
	});

	it("任何一段写命令即整条拒绝", () => {
		expect(bashCommandIsReadOnly("ls && rm -rf /")).toBe(false);
		expect(bashCommandIsReadOnly("git status; git push")).toBe(false);
		expect(bashCommandIsReadOnly("cat f | tee g")).toBe(false);
	});
});

describe("planModeDenial", () => {
	it("放行只读工具", () => {
		for (const t of ["read", "grep", "ls", "plan_update", "present_files", "scm", "conversation_read", "skill"]) {
			expect(planModeDenial(t, {}), t).toBeUndefined();
		}
	});

	it("fails closed for unknown tools and action tools while retaining query entry points", () => {
		for (const [name, params] of [
			["plugin_delete", {}],
			["mcp_write", {}],
			["", {}],
			["notes", { op: "note_add" }],
			["canvas", { action: "run_all" }],
			["worktree", { action: "create" }],
			["browser_page", { op: "eval" }],
			["browser_page", { op: "click" }],
			["remote_term", { action: "run", cmd: "ls" }],
			["skill", { action: "unknown" }],
			["scm", { action: "commit" }],
			["lsp", { action: "rename" }],
		] as const)
			expect(planModeDenial(name, params), name).toBeDefined();
		for (const [name, params] of [
			["load_tools", {}],
			["tool_search", {}],
			["ask_user_question", {}],
			["notes", { op: "list" }],
			["canvas", { action: "get" }],
			["worktree", { action: "list" }],
			["browser_page", { op: "read" }],
			["skill", { action: "list" }],
			["lsp", { action: "references" }],
			["terminal_wait", {}],
			["claim_files", { action: "list" }],
		] as const)
			expect(planModeDenial(name, params), name).toBeUndefined();
	});

	it("拒绝写类工具并给出计划替代路径", () => {
		const d = planModeDenial("write", { path: "a.ts", content: "x" });
		expect(d?.kind).toBe("write-tool");
		expect(d?.reason).toContain("plan_update");
		expect(d?.reasonEn).toContain("Plan mode");
		expect(planModeDenial("edit_soft", {})?.kind).toBe("write-tool");
		expect(planModeDenial("patch", {})?.kind).toBe("write-tool");
		expect(planModeDenial("git", { command: "commit" })?.kind).toBe("write-tool");
		expect(planModeDenial("eval", { code: "require('fs').writeFileSync('x','y')" })?.kind).toBe("write-tool");
		expect(planModeDenial("codemode", { code: "tools.write({ path: 'a.txt', content: 'x' })" })?.kind).toBe(
			"write-tool",
		);
	});

	it("bash 只放行只读命令", () => {
		expect(planModeDenial("bash", { command: "git diff" })).toBeUndefined();
		const d = planModeDenial("bash", { command: "npm run build" });
		expect(d?.kind).toBe("bash");
		expect(d?.reasonEn).toContain("read-only");
		expect(planModeDenial("bash", {})?.kind).toBe("bash");
	});

	it("拒绝旁路工具（会在别的会话实施）", () => {
		expect(planModeDenial("delegate_task", {})?.kind).toBe("bypass-tool");
		expect(planModeDenial("schedule", {})?.kind).toBe("bypass-tool");
	});

	it("subagent 只放行只读 action，写向 action 一律拒", () => {
		for (const readonly of ["get_result", "list", "templates"]) {
			expect(planModeDenial("subagent", { action: readonly }), readonly).toBeUndefined();
		}
		for (const action of ["spawn", "steer", "stop", "wait_all", "handoff", "erase"]) {
			const d = planModeDenial("subagent", { action });
			expect(d, action).toBeDefined();
			expect(d!.kind).toBe("bypass-tool");
		}
		expect(planModeDenial("subagent", { action: "" })?.kind).toBe("bypass-tool");
		expect(planModeDenial("subagent", {})?.kind).toBe("bypass-tool");
		expect(planModeDenial("subagent", undefined)?.kind).toBe("bypass-tool");
	});

	it("拒绝常驻终端写向工具（terminal_input/terminal_key）", () => {
		for (const [name, params] of [
			["terminal_input", { terminalId: "t1", data: "rm -rf dist" }],
			["terminal_input", { terminalId: "t1", data: "y" }],
			["terminal_key", { terminalId: "t1", key: "Enter" }],
		] as const) {
			const d = planModeDenial(name, params);
			expect(d, name).toBeDefined();
			expect(d!.kind).toBe("write-tool");
			expect(d!.reasonEn).toContain("Plan mode");
		}
	});
});

describe("PLAN_MODE_BLOCKED_TOOL_NAMES（活跃集剥离名单）", () => {
	it("终端写向工具在剥离名单里（只读的 read/list/wait 不在）", () => {
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("terminal_input")).toBe(true);
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("terminal_key")).toBe(true);
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("codemode")).toBe(true);
		for (const readonly of ["terminal_read", "terminal_list", "terminal_wait", "read", "grep"]) {
			expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has(readonly), readonly).toBe(false);
		}
	});

	it("eval 在剥离名单里", () => {
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("eval")).toBe(true);
	});

	it("幽灵名不再出现在剥离名单，真实旁路工具在", () => {
		for (const ghost of [
			"spawn",
			"spawn_agent",
			"subagent_spawn",
			"schedule_agent",
			"host_schedule",
			"create_goal",
			"set_goal",
			"start_goal_wizard",
			"create_conversation",
			"fork_conversation",
			"set_plan_mode",
		]) {
			expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has(ghost), ghost).toBe(false);
		}
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("delegate_task")).toBe(true);
		expect(PLAN_MODE_BLOCKED_TOOL_NAMES.has("schedule")).toBe(true);
	});
});

describe("PLAN_MODE_SYSTEM_PROMPT", () => {
	it("纯英文且含关键约束（工具提示词卫生口径）", () => {
		expect(/[一-鿿]/.test(PLAN_MODE_SYSTEM_PROMPT)).toBe(false);
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("plan_update");
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("do NOT implement");
	});

	it("禁止把实现代码写进回复（禁倾倒整文件/完整函数）", () => {
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("NEVER write the implementation");
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("No file dumps");
	});

	it("小需求可跳过 plan_update 走短计划", () => {
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("skip plan_update entirely");
	});
});

describe("buildPlanModePrompt", () => {
	it("空自定义 = 纯内置默认（两种模式都是）", () => {
		expect(buildPlanModePrompt("append", "")).toBe(PLAN_MODE_SYSTEM_PROMPT);
		expect(buildPlanModePrompt("replace", "   ")).toBe(PLAN_MODE_SYSTEM_PROMPT);
	});

	it("追加模式：内置默认 + 空行 + 自定义", () => {
		expect(buildPlanModePrompt("append", "extra")).toBe(`${PLAN_MODE_SYSTEM_PROMPT}\n\nextra`);
	});

	it("替换模式：只发自定义（非空时）", () => {
		expect(buildPlanModePrompt("replace", "only this")).toBe("only this");
	});
});
