/**
 * universal-skill-scanner.test.ts — 通用多智能体技能扫描维护体系单元测试。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as discovery from "../../server/skill-discovery.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverDiskSkills,
	isSkillStillOnDisk,
	mergeSkillCollections,
	parseSkillFrontmatter,
} from "../../server/skill-discovery.js";
import {
	generateSkillsReport,
	scanAllAgentSkills,
	syncAgentSkills,
	verifySkillFile,
} from "../../server/skill-maintenance.js";
import { makeSkillTool } from "../../server/skill-tool.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: vi.fn(actual.mkdirSync),
		copyFileSync: vi.fn(actual.copyFileSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

describe("Universal Multi-Agent Skills Scanner", () => {
	let tempRoot: string;
	let fakeHome: string;
	let fakeAgentDir: string;
	let projectCwd: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-universal-skills-test-"));
		fakeHome = join(tempRoot, "home");
		fakeAgentDir = join(fakeHome, ".pi", "agent");
		projectCwd = join(tempRoot, "workspace", "repo", "subproject");

		mkdirSync(fakeHome, { recursive: true });
		mkdirSync(fakeAgentDir, { recursive: true });
		mkdirSync(projectCwd, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(fs.mkdirSync).mockReset();
		vi.mocked(fs.copyFileSync).mockReset();
		vi.mocked(fs.writeFileSync).mockReset();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	function syncFixture(name = "bundle", standalone = false) {
		const source = join(projectCwd, ".claude", "skills", "bundle");
		mkdirSync(join(source, "scripts"), { recursive: true });
		mkdirSync(join(source, "references"), { recursive: true });
		mkdirSync(join(source, "assets", "nested"), { recursive: true });
		const filePath = join(source, standalone ? "legacy.md" : "SKILL.md");
		writeFileSync(filePath, `---\nname: ${name}\ndescription: Bundle fixture\n---\nRead references/guide.md`);
		writeFileSync(join(source, "scripts", "run.sh"), "echo bundle");
		writeFileSync(join(source, "references", "guide.md"), "Bundled guide");
		writeFileSync(join(source, "assets", "nested", "binary.dat"), Buffer.from([0, 128, 255]));
		vi.spyOn(discovery, "discoverDiskSkills").mockReturnValue([
			{ name, description: "Bundle fixture", filePath, dirPath: source, source: "claude", scope: "project" },
		]);
		return { source, filePath, targetDir: join(projectCwd, ".pi", "skills") };
	}

	it("copies the complete skill bundle with relative resources and binary assets", () => {
		const { source, filePath, targetDir } = syncFixture();
		const result = syncAgentSkills({ cwd: projectCwd, targetDir });
		const destination = join(targetDir, "bundle");
		expect(result.synced).toEqual([{ name: "bundle", from: filePath, to: join(destination, "SKILL.md") }]);
		for (const resource of ["SKILL.md", "scripts/run.sh", "references/guide.md", "assets/nested/binary.dat"]) {
			expect(readFileSync(join(destination, resource))).toEqual(readFileSync(join(source, resource)));
		}
		expect(lstatSync(destination).isSymbolicLink()).toBe(false);
	});

	it("links the directory so bundled resources and subsequent edits stay available", () => {
		const { source, targetDir } = syncFixture();
		expect(syncAgentSkills({ cwd: projectCwd, targetDir, mode: "symlink" }).synced).toHaveLength(1);
		const destination = join(targetDir, "bundle");
		expect(lstatSync(destination).isSymbolicLink()).toBe(true);
		expect(realpathSync(destination)).toBe(realpathSync(source));
		writeFileSync(join(source, "references", "guide.md"), "Updated guide");
		expect(readFileSync(join(destination, "references", "guide.md"), "utf8")).toBe("Updated guide");
	});

	it("keeps standalone Markdown skills as individual files", () => {
		const { filePath, targetDir } = syncFixture("legacy", true);
		expect(syncAgentSkills({ cwd: projectCwd, targetDir }).synced).toEqual([
			{ name: "legacy", from: filePath, to: join(targetDir, "legacy.md") },
		]);
		expect(readdirSync(targetDir)).toEqual(["legacy.md"]);
		expect(readFileSync(join(targetDir, "legacy.md"))).toEqual(readFileSync(filePath));
	});

	it.each(["directory", "file", "dangling link"])("does not overwrite a conflicting %s", (kind) => {
		const { targetDir } = syncFixture();
		mkdirSync(targetDir, { recursive: true });
		const destination = join(targetDir, "bundle");
		if (kind === "directory") {
			mkdirSync(destination);
			writeFileSync(join(destination, "keep.txt"), "keep");
		} else if (kind === "file") writeFileSync(destination, "keep");
		else symlinkSync(join(tempRoot, "missing"), destination, process.platform === "win32" ? "junction" : "dir");
		const before = lstatSync(destination);
		const result = syncAgentSkills({ cwd: projectCwd, targetDir });
		expect(result.synced).toEqual([]);
		expect(result.skipped[0].reason).toBe("Destination already exists");
		expect(lstatSync(destination).isSymbolicLink()).toBe(before.isSymbolicLink());
		if (kind === "directory") expect(readdirSync(destination)).toEqual(["keep.txt"]);
		if (kind === "file") expect(readFileSync(destination, "utf8")).toBe("keep");
	});

	it.each(["../escape", "..\\escape", ".", "..", "/absolute", "C:escape", "trailing."])(
		"rejects unsafe frontmatter name %s",
		(name) => {
			const { targetDir } = syncFixture(name);
			const result = syncAgentSkills({ cwd: projectCwd, targetDir });
			expect(result.synced).toEqual([]);
			expect(result.skipped[0].reason).toBe("Invalid skill name");
			expect(existsSync(targetDir)).toBe(false);
		},
	);

	it("does not confuse a sibling path prefix with a contained source", () => {
		const { source } = syncFixture();
		const targetDir = join(projectCwd, ".claude", "skills", "bun");
		expect(syncAgentSkills({ cwd: projectCwd, targetDir }).synced).toHaveLength(1);
		expect(readFileSync(join(targetDir, "bundle", "SKILL.md"))).toEqual(readFileSync(join(source, "SKILL.md")));
	});

	it.each(["copy", "symlink"] as const)(
		"rejects recursive targets in %s mode, including missing paths below junctions",
		(mode) => {
			const { source } = syncFixture();
			const alias = join(tempRoot, "source-alias");
			symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");
			for (const base of [source, alias]) {
				const targetDir = join(base, "not-created", "skills");
				const result = syncAgentSkills({ cwd: projectCwd, targetDir, mode });
				expect(result.synced).toEqual([]);
				expect(result.skipped[0].reason).toBe("Target directory is inside source skill");
				expect(existsSync(join(source, "not-created"))).toBe(false);
			}
		},
	);

	it("recognizes source skills already contained in a target reached through a junction", () => {
		const { source } = syncFixture();
		const targetDir = join(tempRoot, "target-alias");
		symlinkSync(join(source, ".."), targetDir, process.platform === "win32" ? "junction" : "dir");
		const result = syncAgentSkills({ cwd: projectCwd, targetDir });
		expect(result.synced).toEqual([]);
		expect(result.skipped[0].reason).toBe("Already in target directory");
	});

	it("copies internal directory links without creating cycles or losing resources", () => {
		const { source, targetDir } = syncFixture();
		symlinkSync(
			join(source, "references"),
			join(source, "guide-alias"),
			process.platform === "win32" ? "junction" : "dir",
		);
		expect(syncAgentSkills({ cwd: projectCwd, targetDir }).synced).toHaveLength(1);
		expect(readFileSync(join(targetDir, "bundle", "guide-alias", "guide.md"), "utf8")).toBe("Bundled guide");
	});

	it("leaves a destination created after the conflict check untouched", () => {
		const { targetDir } = syncFixture();
		const destination = join(targetDir, "bundle");
		const originalMkdir = vi.mocked(fs.mkdirSync).getMockImplementation()!;
		vi.mocked(fs.mkdirSync).mockImplementation(((path: fs.PathLike, options?: any) => {
			if (path === destination) {
				originalMkdir(destination);
				writeFileSync(join(destination, "keep.txt"), "concurrent writer");
			}
			return originalMkdir(path, options);
		}) as typeof fs.mkdirSync);
		const result = syncAgentSkills({ cwd: projectCwd, targetDir });
		expect(result.synced).toEqual([]);
		expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("concurrent writer");
	});

	it("dry run reports the final instruction path without creating anything", () => {
		const { targetDir } = syncFixture();
		const result = syncAgentSkills({ cwd: projectCwd, targetDir, dryRun: true });
		expect(result.synced[0].to).toBe(join(targetDir, "bundle", "SKILL.md"));
		expect(existsSync(targetDir)).toBe(false);
	});

	it.each([false, true])("removes partial copies after an IO failure (standalone=%s)", (standalone) => {
		const { source, targetDir } = syncFixture("bundle", standalone);
		if (standalone) {
			const originalWrite = vi.mocked(fs.writeFileSync).getMockImplementation()!;
			vi.mocked(fs.writeFileSync).mockImplementation((...args) => {
				originalWrite(...args);
				throw new Error("Injected IO failure after write");
			});
		} else {
			const originalCopy = vi.mocked(fs.copyFileSync).getMockImplementation()!;
			vi.mocked(fs.copyFileSync).mockImplementation((...args) => {
				originalCopy(...args);
				throw new Error("Injected IO failure after write");
			});
		}
		const result = syncAgentSkills({ cwd: projectCwd, targetDir });
		expect(result.synced).toEqual([]);
		expect(result.skipped[0].reason).toContain("Injected IO failure");
		expect(readdirSync(targetDir)).toEqual([]);
		expect(existsSync(join(source, standalone ? "legacy.md" : "SKILL.md"))).toBe(true);
	});

	it.each(["escape", "cycle"])("rejects resource directory links that %s and cleans up the bundle", (kind) => {
		const { source, targetDir } = syncFixture();
		const linked = kind === "cycle" ? source : fakeHome;
		symlinkSync(linked, join(source, "resources-link"), process.platform === "win32" ? "junction" : "dir");
		const result = syncAgentSkills({ cwd: projectCwd, targetDir });
		expect(result.synced).toEqual([]);
		expect(result.skipped[0].reason).toMatch(/escapes source|Recursive/);
		expect(readdirSync(targetDir)).toEqual([]);
	});

	it("Frontmatter 解析与边界回退", () => {
		// 1. 标准 YAML frontmatter
		const standard = `---
name: my-awesome-skill
description: Useful instructions for testing
disable-model-invocation: true
allowed-tools: bash, read
---
# Body
Some content here.`;
		const res1 = parseSkillFrontmatter(standard, "fallback");
		expect(res1.name).toBe("my-awesome-skill");
		expect(res1.description).toBe("Useful instructions for testing");
		expect(res1.disableModelInvocation).toBe(true);
		expect(res1.allowedTools).toEqual(["bash", "read"]);

		// 2. 缺少 description 时，回退取正文首段非标题文字
		const noDesc = `---
name: no-desc-skill
---
This is the first paragraph describing the skill.
Another line.`;
		const res2 = parseSkillFrontmatter(noDesc, "fallback");
		expect(res2.name).toBe("no-desc-skill");
		expect(res2.description).toBe("This is the first paragraph describing the skill.");

		// 3. 无 frontmatter 时，回退提取 Markdown 一级标题
		const pureMd = `# Specialized Diagnostic Protocol\nInstructions...`;
		const res3 = parseSkillFrontmatter(pureMd, "fallback-file");
		expect(res3.name).toBe("fallback-file");
		expect(res3.description).toBe("Specialized Diagnostic Protocol");
	});

	it("能够全源扫描识别来自各类 Agent 的技能（Pi, Claude, Agents, Cursor 等）", () => {
		// 1. 本地 Pi 技能 (.pi/skills/pi-local/SKILL.md)
		const piLocalDir = join(projectCwd, ".pi", "skills", "pi-local");
		mkdirSync(piLocalDir, { recursive: true });
		writeFileSync(join(piLocalDir, "SKILL.md"), `---\nname: pi-local\ndescription: Pi Project Skill\n---\nBody`);

		// 2. 本地 Claude Code 技能 (.claude/skills/claude-helper.md)
		const claudeProjectDir = join(projectCwd, ".claude", "skills");
		mkdirSync(claudeProjectDir, { recursive: true });
		writeFileSync(
			join(claudeProjectDir, "claude-helper.md"),
			`---\nname: claude-helper\ndescription: Claude Helper Skill\n---\nBody`,
		);

		// 3. 本地 Universal Agent 技能 (.agents/skills/agent-arch/SKILL.md)
		const agentLocalDir = join(projectCwd, ".agents", "skills", "agent-arch");
		mkdirSync(agentLocalDir, { recursive: true });
		writeFileSync(
			join(agentLocalDir, "SKILL.md"),
			`---\nname: agent-arch\ndescription: Universal Agent Arch\n---\nBody`,
		);

		// 4. 全局 Claude Code 技能 (~/.claude/skills/claude-global.md)
		const claudeGlobalDir = join(fakeHome, ".claude", "skills");
		mkdirSync(claudeGlobalDir, { recursive: true });
		writeFileSync(
			join(claudeGlobalDir, "claude-global.md"),
			`---\nname: claude-global\ndescription: Global Claude Skill\n---\nBody`,
		);

		// 5. 全局 Cursor 技能 (~/.cursor/skills/cursor-debug/SKILL.md)
		const cursorGlobalDir = join(fakeHome, ".cursor", "skills", "cursor-debug");
		mkdirSync(cursorGlobalDir, { recursive: true });
		writeFileSync(
			join(cursorGlobalDir, "SKILL.md"),
			`---\nname: cursor-debug\ndescription: Cursor Debugging Skill\n---\nBody`,
		);

		const discovered = discoverDiskSkills({
			cwd: projectCwd,
			agentDir: fakeAgentDir,
			homeDir: fakeHome,
			includeHome: true,
		});

		const names = discovered.map((s) => s.name);
		expect(names).toContain("pi-local");
		expect(names).toContain("claude-helper");
		expect(names).toContain("agent-arch");
		expect(names).toContain("claude-global");
		expect(names).toContain("cursor-debug");

		const claudeSkill = discovered.find((s) => s.name === "claude-helper");
		expect(claudeSkill?.source).toBe("claude");
		expect(claudeSkill?.scope).toBe("project");

		const cursorSkill = discovered.find((s) => s.name === "cursor-debug");
		expect(cursorSkill?.source).toBe("cursor");
		expect(cursorSkill?.scope).toBe("global");
	});

	it("祖先链回溯发现仓库根目录的技能（Monorepo / Worktree 场景）", () => {
		// 在 repo 根目录（projectCwd 的上一级）创建 .git 与 .pi/skills
		const repoRoot = join(tempRoot, "workspace", "repo");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		const rootSkillDir = join(repoRoot, ".pi", "skills", "repo-root-skill");
		mkdirSync(rootSkillDir, { recursive: true });
		writeFileSync(
			join(rootSkillDir, "SKILL.md"),
			`---\nname: repo-root-skill\ndescription: Shared Repo Skill\n---\nRoot Instructions`,
		);

		const discovered = discoverDiskSkills({
			cwd: projectCwd, // 子目录
			agentDir: fakeAgentDir,
			includeHome: false,
			scanAncestors: true,
		});

		const rootSkill = discovered.find((s) => s.name === "repo-root-skill");
		expect(rootSkill).toBeDefined();
		expect(rootSkill?.scope).toBe("ancestor");
		expect(rootSkill?.depth).toBe(1);
	});

	it("同名技能的优先级决议：项目级优先于全局级，Pi 优先于外部 Agent", () => {
		// 在全局与本地同时放置同名技能 "code-reviewer"
		const globalDir = join(fakeAgentDir, "skills", "code-reviewer");
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(
			join(globalDir, "SKILL.md"),
			`---\nname: code-reviewer\ndescription: Global Code Reviewer\n---\nGlobal`,
		);

		const localDir = join(projectCwd, ".pi", "skills", "code-reviewer");
		mkdirSync(localDir, { recursive: true });
		writeFileSync(
			join(localDir, "SKILL.md"),
			`---\nname: code-reviewer\ndescription: Local Project Reviewer\n---\nLocal`,
		);

		const discovered = discoverDiskSkills({
			cwd: projectCwd,
			agentDir: fakeAgentDir,
			homeDir: fakeHome,
			includeHome: true,
		});

		const chosen = discovered.find((s) => s.name === "code-reviewer");
		expect(chosen).toBeDefined();
		expect(chosen?.description).toBe("Local Project Reviewer");
		expect(chosen?.scope).toBe("project");
	});

	it("mergeSkillCollections 能够将多 Agent 技能无缝注入 SDK 技能列表", () => {
		const existingSdkSkills = [
			{ name: "sdk-builtin", description: "Builtin", filePath: "/path/to/sdk-builtin/SKILL.md" },
		];

		const multiAgentDiscovered = [
			{
				name: "claude-analysis",
				description: "Claude Analyzer",
				filePath: "/path/to/claude/SKILL.md",
				dirPath: "/path/to/claude",
				source: "claude" as const,
				scope: "global" as const,
			},
		];

		const merged = mergeSkillCollections(existingSdkSkills, multiAgentDiscovered);
		expect(merged.length).toBe(2);
		expect(merged.map((s) => s.name)).toEqual(["claude-analysis", "sdk-builtin"]);
		expect(merged.find((s) => s.name === "claude-analysis")?.filePath).toBe("/path/to/claude/SKILL.md");
	});

	it("isSkillStillOnDisk 正确验证不同 Agent 技能的物理存在性", () => {
		const claudeDir = join(projectCwd, ".claude", "skills");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(join(claudeDir, "existing-skill.md"), `Content`);

		expect(isSkillStillOnDisk("existing-skill", { cwd: projectCwd, agentDir: fakeAgentDir })).toBe(true);
		expect(isSkillStillOnDisk("deleted-skill", { cwd: projectCwd, agentDir: fakeAgentDir })).toBe(false);
	});

	it("整合后的技能能被 skill 工具精确调用并读取正文，且支持维护报告查询", async () => {
		// 创建一个真实的技能文件
		const skillPath = join(projectCwd, ".agents", "skills", "test-agent-skill", "SKILL.md");
		mkdirSync(join(projectCwd, ".agents", "skills", "test-agent-skill"), { recursive: true });
		writeFileSync(
			skillPath,
			`---\nname: test-agent-skill\ndescription: Agent Integration Test\n---\n# Specialist Instructions\nExecute step A and B.`,
		);

		const mockHost = {
			listSkills: () => [
				{
					name: "test-agent-skill",
					description: "Agent Integration Test",
					filePath: skillPath,
					source: "agents",
					scope: "project",
				},
			],
		};

		const tool = makeSkillTool(mockHost, () => "zh");

		// 1. 模型按名读取正文
		const callRes = await tool.execute(
			"call_1",
			{ name: "test-agent-skill" },
			undefined as any,
			undefined as any,
			{} as any,
		);
		const content = (callRes as any).content[0].text;
		expect(content).toContain('<skill name="test-agent-skill"');
		expect(content).toContain("Specialist Instructions");

		// 2. 查看多智能体维护报告
		const reportRes = await tool.execute("call_2", { action: "report" }, undefined as any, undefined as any, {} as any);
		const reportText = (reportRes as any).content[0].text;
		expect(reportText).toContain("跨智能体技能整合报告");
		expect(reportText).toContain("AGENTS: 1");
		expect(reportText).toContain("test-agent-skill");
	});

	it("通用维护工具层：scanAllAgentSkills, verifySkillFile 与 syncAgentSkills", () => {
		// 创建一个合法技能与一个超限技能
		const skillsDir = join(projectCwd, ".claude", "skills");
		mkdirSync(skillsDir, { recursive: true });

		const validSkillFile = join(skillsDir, "valid.md");
		writeFileSync(validSkillFile, `---\nname: valid\ndescription: Good skill\n---\nInstructions`);

		const oversizedSkillFile = join(skillsDir, "oversized.md");
		writeFileSync(oversizedSkillFile, "A".repeat(9000)); // 超过 8KB

		// 1. 扫描与维护报告
		const scan = scanAllAgentSkills({ cwd: projectCwd, agentDir: fakeAgentDir, includeHome: false });
		expect(scan.totalUnique).toBeGreaterThanOrEqual(2);
		expect(scan.bySource.claude).toBeGreaterThanOrEqual(2);

		const report = generateSkillsReport(scan, "zh");
		expect(report).toContain("跨智能体全源技能扫描与维护报告");
		expect(report).toContain("CLAUDE:");

		// 2. 健康检查
		const health1 = verifySkillFile(validSkillFile);
		expect(health1.valid).toBe(true);
		expect(health1.exceedsBudget).toBe(false);

		const health2 = verifySkillFile(oversizedSkillFile);
		expect(health2.valid).toBe(false);
		expect(health2.exceedsBudget).toBe(true);

		// 3. 跨 Agent 技能物理同步（将 Claude 技能同步至 .pi/skills）
		const targetPiDir = join(projectCwd, ".pi", "skills");
		const syncRes = syncAgentSkills({
			cwd: projectCwd,
			targetDir: targetPiDir,
			mode: "copy",
		});
		expect(syncRes.synced.length).toBeGreaterThanOrEqual(1);
	});
});
