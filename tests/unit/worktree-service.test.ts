import { describe, expect, it } from "vitest";
import { parseWorktreePorcelain, normalizeWirePath } from "../../server/worktree-service.js";
import { makeWorktreeTool, WORKTREE_TOOL_NAME } from "../../server/worktree-tool.js";

describe("Git Worktree 解析器", () => {
	it("正确解析 git worktree list --porcelain 输出格式", () => {
		const sampleOutput = `worktree /path/to/main-repo
HEAD 0123456789abcdef0123456789abcdef01234567
branch refs/heads/main

worktree /path/to/worktree-feat-pr1
HEAD abcdef0123456789abcdef0123456789abcdef01
branch refs/heads/feat/pr1

worktree /path/to/detached-wt
HEAD fedcba9876543210fedcba9876543210fedcba98
detached
locked reason for lock
`;

		const parsed = parseWorktreePorcelain(sampleOutput);
		expect(parsed).toHaveLength(3);

		expect(parsed[0].branch).toBe("main");
		expect(parsed[0].head).toBe("0123456789abcdef0123456789abcdef01234567");
		expect(parsed[0].detached).toBe(false);

		expect(parsed[1].branch).toBe("feat/pr1");
		expect(parsed[1].detached).toBe(false);

		expect(parsed[2].branch).toBeUndefined();
		expect(parsed[2].detached).toBe(true);
		expect(parsed[2].locked).toBe("reason for lock");
	});

	it("处理空输入或异常文本", () => {
		expect(parseWorktreePorcelain("")).toEqual([]);
		expect(parseWorktreePorcelain("\n\n   \n")).toEqual([]);
	});
});

describe("Worktree 工具定义与执行", () => {
	it("工具元数据与定义符合规范", () => {
		let currentCwd = "/path/to/repo";
		const tool = makeWorktreeTool(
			{
				getCwd: () => currentCwd,
				setCwd: async (newCwd) => {
					currentCwd = newCwd;
				},
			},
			() => "en",
		);

		expect(tool.name).toBe(WORKTREE_TOOL_NAME);
		expect(tool.label).toBe("Manage Git worktrees");
		expect(tool.description).toBeTruthy();
		expect(tool.promptSnippet).toBeTruthy();
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
	});

	it("执行 switch 切换工作区目录", async () => {
		let currentCwd = "/path/to/repo";
		const tool = makeWorktreeTool(
			{
				getCwd: () => currentCwd,
				setCwd: async (newCwd) => {
					currentCwd = newCwd;
				},
			},
			() => "en",
		);

		const res = await tool.execute(
			"call-1",
			{
				action: "switch",
				path: "/path/to/worktree-1",
			},
			undefined,
			undefined,
			{} as any,
		);

		expect(res.details).toBeDefined();
		expect((res.details as { path?: string }).path).toBe(normalizeWirePath("/path/to/worktree-1"));
		expect(currentCwd).toBe(normalizeWirePath("/path/to/worktree-1"));
	});
});
