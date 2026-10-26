import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeSubagentTool, type SubagentToolHost, type SubagentSnapshot } from "../../server/subagents.js";
import {
	createSubagentWorktree,
	finalizeSubagentWorktree,
	withRepoLock,
	ensureWorktreeExcluded,
	normalizeWirePath,
} from "../../server/worktree-service.js";

const exec = promisify(execFile);

describe("Subagent Worktree Isolation (Issue #728)", () => {
	describe("Tool Schema & Parameter Validation", () => {
		it("subagent 工具 schema 包含 isolation 参数，支持 worktree 与 none", () => {
			const host: SubagentToolHost = {
				spawnSubagent: vi.fn(async () => "sa-test-123"),
				getSubagent: vi.fn(() => undefined),
				listSubagents: vi.fn(() => []),
				steerSubagent: vi.fn(async () => {}),
				stopSubagent: vi.fn(async () => {}),
				handoffSubagent: vi.fn(async () => {}),
				listTemplates: vi.fn(() => []),
				isTemplateUsable: vi.fn(() => false),
			};
			const tool = makeSubagentTool(host, () => "en");
			expect(tool.parameters).toBeDefined();
			const props = (tool.parameters as any).properties;
			expect(props.isolation).toBeDefined();
			expect(props.isolation.enum).toEqual(["worktree", "none"]);
		});

		it("传入不支持的 isolation 模式时返回明确错误提示", async () => {
			const host: SubagentToolHost = {
				spawnSubagent: vi.fn(async () => "sa-test-123"),
				getSubagent: vi.fn(() => undefined),
				listSubagents: vi.fn(() => []),
				steerSubagent: vi.fn(async () => {}),
				stopSubagent: vi.fn(async () => {}),
				handoffSubagent: vi.fn(async () => {}),
				listTemplates: vi.fn(() => []),
				isTemplateUsable: vi.fn(() => false),
			};
			const tool = makeSubagentTool(host, () => "zh");
			const res = (await tool.execute!(
				"call_1",
				{ action: "spawn", prompt: "test task", isolation: "docker" } as any,
				undefined,
				undefined,
				{ cwd: "/test" } as any,
			)) as any;
			expect(res.content[0].text).toContain("不支持的隔离模式");
			expect(host.spawnSubagent).not.toHaveBeenCalled();
		});

		it("传入 isolation: 'worktree' 时透传给 host.spawnSubagent", async () => {
			const host: SubagentToolHost = {
				spawnSubagent: vi.fn(async () => "sa-test-123"),
				getSubagent: vi.fn(() => undefined),
				listSubagents: vi.fn(() => []),
				steerSubagent: vi.fn(async () => {}),
				stopSubagent: vi.fn(async () => {}),
				handoffSubagent: vi.fn(async () => {}),
				listTemplates: vi.fn(() => []),
				isTemplateUsable: vi.fn(() => false),
			};
			const tool = makeSubagentTool(host, () => "zh");
			const res = (await tool.execute!(
				"call_1",
				{ action: "spawn", prompt: "test task", isolation: "worktree" } as any,
				undefined,
				undefined,
				{ cwd: "/test" } as any,
			)) as any;
			expect(host.spawnSubagent).toHaveBeenCalledWith(
				"test task",
				"general",
				"/test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"worktree",
			);
			expect(res.content[0].text).toContain("工作树隔离：已启用");
			expect(res.details.isolation).toBe("worktree");
		});
	});

	describe("get_result 与 wait_all 的工作树状态汇报", () => {
		it("get_result 针对已自动清理的工作树给出无改动清理说明", async () => {
			const snapshot: SubagentSnapshot = {
				convId: "sa-clean-123",
				type: "explore",
				title: "调研",
				prompt: "调研任务",
				state: "done",
				streaming: false,
				messageCount: 3,
				output: "调研完成，没有改动文件",
				worktree: {
					path: "/repo/.worktrees/sa-clean-123",
					branch: "subagent/sa-clean-123",
					cleanedUp: true,
				},
			};
			const host: SubagentToolHost = {
				spawnSubagent: vi.fn(async () => "sa-clean-123"),
				getSubagent: vi.fn(() => snapshot),
				listSubagents: vi.fn(() => [snapshot]),
				steerSubagent: vi.fn(async () => {}),
				stopSubagent: vi.fn(async () => {}),
				handoffSubagent: vi.fn(async () => {}),
				listTemplates: vi.fn(() => []),
				isTemplateUsable: vi.fn(() => false),
				finalizeSubagentWorktree: vi.fn(async () => {}),
			};
			const tool = makeSubagentTool(host, () => "zh");
			const res = (await tool.execute!(
				"call_2",
				{ action: "get_result", runId: "sa-clean-123" } as any,
				undefined,
				undefined,
				{ cwd: "/test" } as any,
			)) as any;
			expect(host.finalizeSubagentWorktree).toHaveBeenCalledWith("sa-clean-123");
			expect(res.content[0].text).toContain("无文件修改，临时工作树与分支已自动清理");
		});

		it("get_result 针对保留改动的工作树汇报分支、改动量及合并/清理指引", async () => {
			const snapshot: SubagentSnapshot = {
				convId: "sa-dirty-456",
				type: "implement",
				title: "修改",
				prompt: "修改任务",
				state: "done",
				streaming: false,
				messageCount: 5,
				output: "已完成代码修改",
				worktree: {
					path: "/repo/.worktrees/sa-dirty-456",
					branch: "subagent/sa-dirty-456",
					cleanedUp: false,
					isDirty: true,
					uncommittedCount: 3,
					aheadCount: 1,
				},
			};
			const host: SubagentToolHost = {
				spawnSubagent: vi.fn(async () => "sa-dirty-456"),
				getSubagent: vi.fn(() => snapshot),
				listSubagents: vi.fn(() => [snapshot]),
				steerSubagent: vi.fn(async () => {}),
				stopSubagent: vi.fn(async () => {}),
				handoffSubagent: vi.fn(async () => {}),
				listTemplates: vi.fn(() => []),
				isTemplateUsable: vi.fn(() => false),
				finalizeSubagentWorktree: vi.fn(async () => {}),
			};
			const tool = makeSubagentTool(host, () => "zh");
			const res = (await tool.execute!(
				"call_3",
				{ action: "get_result", runId: "sa-dirty-456" } as any,
				undefined,
				undefined,
				{ cwd: "/test" } as any,
			)) as any;
			expect(res.content[0].text).toContain("代码改动已保留供审阅");
			expect(res.content[0].text).toContain("subagent/sa-dirty-456");
			expect(res.content[0].text).toContain("3 个未提交文件修改，领先 1 个提交");
			expect(res.content[0].text).toContain("git merge subagent/sa-dirty-456");
		});
	});

	describe("Git Worktree 真实生命周期测试（沙箱仓库）", () => {
		let testRepoDir: string;

		beforeEach(async () => {
			testRepoDir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
			// 初始化 git 仓库并打一个初始提交
			await exec("git", ["init", "-b", "main"], { cwd: testRepoDir });
			await exec("git", ["config", "user.name", "Tester"], { cwd: testRepoDir });
			await exec("git", ["config", "user.email", "tester@example.com"], { cwd: testRepoDir });
			writeFileSync(join(testRepoDir, "README.md"), "# Test Repo\n", "utf-8");
			await exec("git", ["add", "README.md"], { cwd: testRepoDir });
			await exec("git", ["commit", "-m", "initial commit"], { cwd: testRepoDir });
		});

		afterEach(() => {
			try {
				rmSync(testRepoDir, { recursive: true, force: true });
			} catch {}
		});

		it("非 Git 仓库抛出明确错误", async () => {
			const nonGitDir = mkdtempSync(join(tmpdir(), "pi-nongit-"));
			try {
				await expect(createSubagentWorktree(nonGitDir, "sa-999", () => "zh")).rejects.toThrow("不是 Git 仓库");
				await expect(createSubagentWorktree(nonGitDir, "sa-999", () => "en")).rejects.toThrow("not a Git repository");
			} finally {
				rmSync(nonGitDir, { recursive: true, force: true });
			}
		});

		it("创建隔离工作树：自动创建分支、工作树目录并追加 .git/info/exclude", async () => {
			const subagentId = "sa-abc12345";
			const wt = await createSubagentWorktree(testRepoDir, subagentId);

			expect(existsSync(wt.worktreePath)).toBe(true);
			expect(wt.branch).toBe(`subagent/${subagentId}`);
			expect(wt.baseCommit).toHaveLength(40);
			expect(wt.subagentCwd).toBe(wt.worktreePath);

			// 验证 .git/info/exclude 包含了 .worktrees/
			const excludeFile = join(testRepoDir, ".git", "info", "exclude");
			expect(existsSync(excludeFile)).toBe(true);
			const excludeContent = readFileSync(excludeFile, "utf-8");
			expect(excludeContent).toContain(".worktrees");

			// 验证在工作树中能正常读取已有文件
			expect(existsSync(join(wt.worktreePath, "README.md"))).toBe(true);
		});

		it("终态判定：当子代理未修改任何文件时，自动删除工作树与临时分支", async () => {
			const subagentId = "sa-clean-run";
			const wt = await createSubagentWorktree(testRepoDir, subagentId);
			expect(existsSync(wt.worktreePath)).toBe(true);

			// 执行 finalizeSubagentWorktree（无任何写入或 commit）
			const finalized = await finalizeSubagentWorktree(wt);
			expect(finalized.finalized).toBe(true);
			expect(finalized.cleanedUp).toBe(true);
			expect(finalized.isDirty).toBe(false);
			expect(finalized.uncommittedCount).toBe(0);

			// 工作树目录已被物理移除
			expect(existsSync(wt.worktreePath)).toBe(false);

			// 临时分支已被删除
			const { stdout: branches } = await exec("git", ["branch"], { cwd: testRepoDir });
			expect(branches).not.toContain(`subagent/${subagentId}`);
		});

		it("终态判定：当子代理产生未提交修改时，保留工作树与分支", async () => {
			const subagentId = "sa-with-changes";
			const wt = await createSubagentWorktree(testRepoDir, subagentId);

			// 模拟子代理修改文件
			writeFileSync(join(wt.worktreePath, "new-file.txt"), "hello from subagent\n", "utf-8");

			const finalized = await finalizeSubagentWorktree(wt);
			expect(finalized.finalized).toBe(true);
			expect(finalized.cleanedUp).toBe(false);
			expect(finalized.isDirty).toBe(true);
			expect(finalized.uncommittedCount).toBe(1);

			// 工作树目录依然存在
			expect(existsSync(wt.worktreePath)).toBe(true);

			// 分支依然存在
			const { stdout: branches } = await exec("git", ["branch"], { cwd: testRepoDir });
			expect(branches).toContain(`subagent/${subagentId}`);
		});

		it("终态判定：当子代理进行了 commit 时，保留工作树与分支", async () => {
			const subagentId = "sa-with-commits";
			const wt = await createSubagentWorktree(testRepoDir, subagentId);

			// 模拟子代理提交修改
			writeFileSync(join(wt.worktreePath, "committed.txt"), "new feature\n", "utf-8");
			await exec("git", ["add", "committed.txt"], { cwd: wt.worktreePath });
			await exec("git", ["commit", "-m", "feat: new feature"], { cwd: wt.worktreePath });

			const finalized = await finalizeSubagentWorktree(wt);
			expect(finalized.finalized).toBe(true);
			expect(finalized.cleanedUp).toBe(false);
			expect(finalized.aheadCount).toBe(1);

			// 工作树与分支依然保留
			expect(existsSync(wt.worktreePath)).toBe(true);
		});
	});

	describe("仓库级 Mutex 串行保护", () => {
		it("对同一仓库的并发任务按顺序串行执行", async () => {
			const order: number[] = [];
			const repoPath = "/dummy/repo";

			const task1 = withRepoLock(repoPath, async () => {
				await new Promise((r) => setTimeout(r, 50));
				order.push(1);
			});
			const task2 = withRepoLock(repoPath, async () => {
				order.push(2);
			});

			await Promise.all([task1, task2]);
			expect(order).toEqual([1, 2]);
		});
	});
});
