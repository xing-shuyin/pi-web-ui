import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { parseWorktreePorcelain, normalizeWirePath } from "../../server/worktree-service.js";
import { makeWorktreeTool, WORKTREE_TOOL_NAME } from "../../server/worktree-tool.js";

const exec = promisify(execFile);
const tmpRoots: string[] = [];

afterEach(() => {
	for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 真 git 仓库 + 一个已注册 worktree（#973 的归属校验只能靠 `git worktree list` 判）。 */
async function gitFixture(): Promise<{ root: string; registered: string }> {
	const root = mkdtempSync(join(tmpdir(), "pi-wt-switch-"));
	tmpRoots.push(root);
	await exec("git", ["init", "-b", "main"], { cwd: root });
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
	writeFileSync(join(root, "tracked.txt"), "base");
	await exec("git", ["add", "."], { cwd: root });
	await exec("git", ["commit", "-m", "base"], { cwd: root });
	const registered = join(root, "wt-registered");
	await exec("git", ["worktree", "add", registered, "-b", "feat/registered"], { cwd: root });
	return { root, registered };
}

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

	it("switch 到已注册 worktree 才放行（#973）", async () => {
		const { root, registered } = await gitFixture();
		let currentCwd = root;
		const switchedTo: string[] = [];
		const tool = makeWorktreeTool(
			{
				getCwd: () => currentCwd,
				setCwd: async (newCwd) => {
					currentCwd = newCwd;
					switchedTo.push(newCwd);
				},
			},
			() => "en",
		);

		const res = await tool.execute("call-1", { action: "switch", path: registered }, undefined, undefined, {} as any);

		expect((res.details as { error?: string }).error).toBeUndefined();
		expect((res.details as { path?: string }).path).toBe(normalizeWirePath(registered));
		expect(currentCwd).toBe(normalizeWirePath(registered));
		expect(switchedTo).toHaveLength(1);
	});

	it("switch 到未注册目录被拒且 cwd 不变（~/.ssh 这类目录进不去）", async () => {
		const { root } = await gitFixture();
		const arbitrary = mkdtempSync(join(tmpdir(), "pi-wt-arbitrary-"));
		tmpRoots.push(arbitrary);
		let currentCwd = root;
		const tool = makeWorktreeTool(
			{
				getCwd: () => currentCwd,
				setCwd: async (newCwd) => {
					currentCwd = newCwd;
				},
			},
			() => "en",
		);

		const res = await tool.execute("call-1", { action: "switch", path: arbitrary }, undefined, undefined, {} as any);

		expect((res.details as { error?: string }).error).toContain("not a registered Git worktree");
		expect(currentCwd).toBe(root);
	});

	it("cwd 不是 git 仓库时 switch 被拒", async () => {
		const plain = mkdtempSync(join(tmpdir(), "pi-wt-norepo-"));
		const target = mkdtempSync(join(tmpdir(), "pi-wt-target-"));
		tmpRoots.push(plain, target);
		mkdirSync(join(target, "sub"), { recursive: true });
		let currentCwd = plain;
		const tool = makeWorktreeTool(
			{
				getCwd: () => currentCwd,
				setCwd: async (newCwd) => {
					currentCwd = newCwd;
				},
			},
			() => "en",
		);

		const res = await tool.execute("call-1", { action: "switch", path: target }, undefined, undefined, {} as any);

		expect((res.details as { error?: string }).error).toContain("not a Git repository");
		expect(currentCwd).toBe(plain);
	});

	it("create(switchTo) 同样过注册校验后才切 cwd", async () => {
		const { root } = await gitFixture();
		let currentCwd = root;
		const tool = makeWorktreeTool(
			{
				getCwd: () => currentCwd,
				setCwd: async (newCwd) => {
					currentCwd = newCwd;
				},
			},
			() => "en",
		);

		const created = join(root, "wt-created");
		const res = await tool.execute(
			"call-1",
			{ action: "create", path: created, newBranch: "feat/created", switchTo: true },
			undefined,
			undefined,
			{} as any,
		);

		expect((res.details as { error?: string }).error).toBeUndefined();
		expect(currentCwd).toBe(normalizeWirePath(created));
	});
});
