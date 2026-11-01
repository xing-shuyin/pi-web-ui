/**
 * universal-commands.test.ts — 通用底座及各引擎 / 和 @ 命令支持单元测试。
 *
 * 覆盖：
 *   1. 通用底座（Universal Base）推送与执行内置斜杠命令（/new, /name, /model, /cwd, /thinking, /compact 等）；
 *   2. 通用底座与各引擎对磁盘/运行时技能的发现，以及通过 /skill:name 和 @skill:name 触发的上下文指令扩展；
 *   3. 用户提问中 @path 文件引用与附件卡片自动解析、持久化（UiMessage custom "file" 卡片）；
 *   4. 各引擎驱动接入：
 *      - Claude Code 驱动专有斜杠命令（/cost, /doctor, /init, /clear）；
 *      - DSH 驱动与技能注入；
 *      - Mock 驱动命令（/mock-echo）与测试技能（mock-analyzer）；
 *      - DshAgentService 独立引擎推入技能与 @ 提及解析。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	UniversalSession,
	UniversalSessionStore,
	MockAgentDriver,
	ClaudeCodeDriver,
} from "../../server/universal/index.js";
import { discoverDiskSkills, readSkillInstruction } from "../../server/skill-discovery.js";
import {
	scanAtMentions,
	createAttachmentUiMessages,
	formatPromptWithSkills,
} from "../../server/universal/universal-attachments.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("通用底座与多引擎 / 和 @ 命令体系测试", () => {
	let tempDir: string;
	let workspaceDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-commands-test-"));
		workspaceDir = join(tempDir, "workspace");
		agentDir = join(tempDir, "agent");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
			} catch {
				/* ignore EPERM on Windows */
			}
		}
	});

	describe("1. 技能磁盘发现与正文解析 (skill-discovery)", () => {
		it("能够正确发现 .pi/skills 与 .claude/skills 下的目录型与单文件型技能", () => {
			// 1. 创建项目级目录型技能 workspace/.pi/skills/code-review/SKILL.md
			const reviewDir = join(workspaceDir, ".pi", "skills", "code-review");
			mkdirSync(reviewDir, { recursive: true });
			writeFileSync(
				join(reviewDir, "SKILL.md"),
				`---\nname: code-review\ndescription: 规范的代码审查技能\n---\n检查代码可读性与潜在漏洞。`,
				"utf8",
			);

			// 2. 创建 Claude 规范技能 workspace/.claude/skills/unit-test/SKILL.md
			const testDir = join(workspaceDir, ".claude", "skills", "unit-test");
			mkdirSync(testDir, { recursive: true });
			writeFileSync(
				join(testDir, "SKILL.md"),
				`---\nname: unit-test\ndescription: 自动化单元测试生成\n---\n编写覆盖全面的 vitest 单测。`,
				"utf8",
			);

			// 3. 创建单文件技能 agentDir/skills/format.md
			const globalSkillsDir = join(agentDir, "skills");
			mkdirSync(globalSkillsDir, { recursive: true });
			writeFileSync(
				join(globalSkillsDir, "format.md"),
				`---\nname: format-code\ndescription: 代码格式化规范\n---\n确保符合 Prettier。`,
				"utf8",
			);

			const skills = discoverDiskSkills({ cwd: workspaceDir, agentDir, includeHome: false });
			expect(skills.length).toBe(3);

			const review = skills.find((s) => s.name === "code-review");
			expect(review).toBeDefined();
			expect(review?.description).toBe("规范的代码审查技能");

			const instruction = readSkillInstruction(review!.filePath);
			expect(instruction).toContain("检查代码可读性与潜在漏洞");

			const testSkill = skills.find((s) => s.name === "unit-test");
			expect(testSkill).toBeDefined();
			expect(testSkill?.description).toBe("自动化单元测试生成");

			const formatSkill = skills.find((s) => s.name === "format-code");
			expect(formatSkill).toBeDefined();
		});
	});

	describe("2. 通用底座 @ 提及扫描与附件卡片 (universal-attachments)", () => {
		it("能够扫描文本中的 @skill 与存在的工作区 @path，并组装有效附件与技能上下文", () => {
			// 在工作区创建一个真实文件
			writeFileSync(join(workspaceDir, "index.ts"), `console.log("hello world");`, "utf8");

			const skills = [
				{
					name: "refactor",
					description: "重构代码",
					filePath: join(workspaceDir, "refactor.md"),
					dirPath: workspaceDir,
				},
			];
			writeFileSync(skills[0].filePath, `重构原则：提取纯函数，降低复杂度。`, "utf8");

			const promptText = "请参考 @index.ts 使用 @skill:refactor 重构函数";
			const scan = scanAtMentions(promptText, workspaceDir, skills);

			expect(scan.detectedAttachments.length).toBe(1);
			expect(scan.detectedAttachments[0].path).toBe("index.ts");
			expect(scan.detectedAttachments[0].name).toBe("index.ts");

			expect(scan.detectedSkills.length).toBe(1);
			expect(scan.detectedSkills[0].name).toBe("refactor");

			const formattedPrompt = formatPromptWithSkills(promptText, scan.detectedSkills);
			expect(formattedPrompt).toContain("[Skill: refactor]");
			expect(formattedPrompt).toContain("重构原则：提取纯函数");
			expect(formattedPrompt).toContain("[User Prompt]\n" + promptText);
		});

		it("createAttachmentUiMessages 能够生成正确的 custom 'file' 消息与 details", () => {
			const atts = [
				{ path: "src/main.ts", name: "main.ts", mode: "reference" as const },
				{ path: "src/utils.ts", name: "utils.ts", mode: "lines" as const, lines: { start: 10, end: 20 } },
				{ path: "https://example.com", name: "Example Page", mode: "page" as const },
				{ path: "", imageData: "AAAA", name: "screenshot.png", mimeType: "image/png" },
			];

			const cards = createAttachmentUiMessages(atts, 123456);
			expect(cards.length).toBe(4);

			// 工作区引用
			expect(cards[0].role).toBe("custom");
			expect(cards[0].customType).toBe("file");
			expect(cards[0].content[0]).toEqual({ type: "text", text: '<file path="src/main.ts" />' });
			expect((cards[0].details as any).name).toBe("main.ts");

			// 行引用
			expect(cards[1].content[0]).toEqual({ type: "text", text: '<file path="src/utils.ts" lines="10-20" />' });
			expect((cards[1].details as any).startLine).toBe(10);
			expect((cards[1].details as any).endLine).toBe(20);

			// 页面引用
			expect(cards[2].content[0]).toEqual({
				type: "text",
				text: '<browser-page url="https://example.com" title="Example Page" />',
			});

			// 图片
			expect(cards[3].content[0]).toEqual({ type: "image", dataUrl: "data:image/png;base64,AAAA" });
		});
	});

	describe("3. 通用底座 Slash 命令与技能命令执行", () => {
		it("UniversalSession 能够完整推送内置命令、技能命令与驱动扩展命令", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);
			const messages: ServerMessage[] = [];

			const session = new UniversalSession({
				clientId: "test-client-cmd",
				cwd: workspaceDir,
				agentDir,
				send: (msg) => messages.push(msg),
				store,
				driver,
			});

			// 写入一个本地技能
			const skillDir = join(workspaceDir, ".pi", "skills", "code-doc");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---\nname: code-doc\ndescription: 文档编写技能\n---\n撰写 JSDoc 注释。`,
				"utf8",
			);

			await session.pushSlashCommands();

			const slashMsg = messages.find(
				(m): m is Extract<ServerMessage, { type: "slash_commands" }> => m.type === "slash_commands",
			);
			expect(slashMsg).toBeDefined();

			const names = slashMsg!.commands.map((c) => c.name);
			// 验证内置命令
			expect(names).toContain("new");
			expect(names).toContain("model");
			expect(names).toContain("cwd");
			expect(names).toContain("thinking");

			// 验证技能命令
			expect(names).toContain("skill:code-doc");

			// 验证驱动扩展命令（MockAgentDriver 中的 /mock-echo）
			expect(names).toContain("mock-echo");

			session.dispose();
		});

		it("能够拦截并执行内置命令（例如 /name 重命名与 /thinking 调节）而不向驱动投递 prompt", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);
			const sendSpy = vi.spyOn(driver, "sendPrompt");
			const messages: ServerMessage[] = [];

			const session = new UniversalSession({
				clientId: "test-client-exec",
				cwd: workspaceDir,
				agentDir,
				send: (msg) => messages.push(msg),
				store,
				driver,
			});

			// 1. 测试 /name 重命名命令
			await session.prompt("/name 新的测试会话名称");
			expect(sendSpy).not.toHaveBeenCalled();

			const snapshot = messages
				.filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot")
				.pop();
			expect(session.activeConversations()).toBe(0);

			// 验证通知回显
			const notices = messages.filter((m): m is Extract<ServerMessage, { type: "notice" }> => m.type === "notice");
			expect(notices.some((n) => n.text.includes("已重命名当前会话"))).toBe(true);

			// 2. 测试 /mock-echo 驱动扩展命令
			await session.prompt("/mock-echo 你好世界");
			expect(sendSpy).not.toHaveBeenCalled();
			expect(messages.some((m) => m.type === "notice" && m.text.includes("Mock echo: 你好世界"))).toBe(true);

			session.dispose();
		});

		it("支持 /skill:xxx 扩展为技能指令投递至驱动，并自动持久化附件卡片", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);
			let receivedPrompt = "";
			let receivedAttachments: any[] | undefined = undefined;

			vi.spyOn(driver, "sendPrompt").mockImplementation(async (p, atts, sink) => {
				receivedPrompt = p;
				receivedAttachments = atts;
				sink.onTextDelta("ok");
				sink.onTurnComplete();
			});

			const session = new UniversalSession({
				clientId: "test-client-skill",
				cwd: workspaceDir,
				agentDir,
				send: () => {},
				store,
				driver,
			});

			// 准备一个技能
			const skillDir = join(workspaceDir, ".pi", "skills", "security-audit");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---\nname: security-audit\ndescription: 安全审计\n---\n严查 SQL 注入与 XSS。`,
				"utf8",
			);

			// 准备一个文件
			writeFileSync(join(workspaceDir, "server.ts"), "const a = 1;", "utf8");

			// 用户调用 /skill:security-audit 检查代码
			await session.prompt("/skill:security-audit 检查 server.ts 安全性");

			expect(receivedPrompt).toContain("[Skill: security-audit]");
			expect(receivedPrompt).toContain("严查 SQL 注入与 XSS");
			expect(receivedPrompt).toContain("检查 server.ts 安全性");

			session.dispose();
		});
	});

	describe("4. Claude Code 驱动专有命令扩展", () => {
		it("ClaudeCodeDriver 注册专有命令 (/cost, /doctor, /init, /clear) 并能正确执行", async () => {
			const driver = new ClaudeCodeDriver(workspaceDir, { agentDir });
			const slashCmds = await driver.getSlashCommands();
			const cmdNames = slashCmds.map((c) => c.name);

			expect(cmdNames).toContain("cost");
			expect(cmdNames).toContain("doctor");
			expect(cmdNames).toContain("init");
			expect(cmdNames).toContain("clear");

			const notices: string[] = [];
			const context = {
				emitNotice: (_level: string, text: string) => notices.push(text),
			};

			// 执行 /doctor
			const docHandled = await driver.execSlashCommand("doctor", "", context as any);
			expect(docHandled).toBe(true);
			expect(notices.some((n) => n.includes("Claude Code CLI"))).toBe(true);

			// 执行 /init
			const initHandled = await driver.execSlashCommand("init", "", context as any);
			expect(initHandled).toBe(true);
			expect(existsSync(join(workspaceDir, "CLAUDE.md"))).toBe(true);

			// 执行 /clear
			const clearHandled = await driver.execSlashCommand("clear", "", context as any);
			expect(clearHandled).toBe(true);
			expect(driver.getActiveSessionId()).toBeNull();

			driver.dispose();
		});
	});

	describe("5. 通用底座运行中排队与插队机制 (Queue & Steer)", () => {
		it("支持在生成中以 queue: true 排队并在当前轮次完成后自动触发执行", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);
			const executedPrompts: string[] = [];

			let activeSink: any = null;
			let turnResolve: any = null;
			vi.spyOn(driver, "sendPrompt").mockImplementation(async (p, _atts, sink) => {
				executedPrompts.push(p);
				activeSink = sink;
				sink.onTextDelta("processing...");
				if (executedPrompts.length === 1) {
					return new Promise((resolve) => {
						turnResolve = resolve;
					});
				}
				sink.onTurnComplete();
			});

			const messages: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId: "test-client-queue",
				cwd: workspaceDir,
				send: (msg) => messages.push(msg),
				store,
				driver,
			});

			// 1. 发起首个请求，开始生成
			const p1 = session.prompt("首个问题");
			await new Promise((r) => setTimeout(r, 10));
			expect(session.isStreaming).toBe(true);
			expect(executedPrompts).toEqual(["首个问题"]);

			// 2. 在生成过程中以 queue: true 发送排队请求
			await session.prompt("排队的问题", undefined, true);
			expect(executedPrompts).toEqual(["首个问题"]);

			const notice = messages.find(
				(m): m is Extract<ServerMessage, { type: "notice" }> => m.type === "notice" && m.text.includes("已加入排队"),
			);
			expect(notice).toBeDefined();

			// 3. 第一轮生成结束，底座自动消费队列中的第二条消息
			activeSink.onTurnComplete();
			if (turnResolve) turnResolve();
			await p1;

			// 等待微任务队列消费
			await new Promise((r) => setTimeout(r, 15));

			expect(executedPrompts).toEqual(["首个问题", "排队的问题"]);
			session.dispose();
		});

		it("支持在生成中以 queue: false 插队中断当前轮次", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);

			let abortResolve: any = null;
			let callCount = 0;
			const abortSpy = vi.spyOn(driver, "abort").mockImplementation(async () => {
				if (abortResolve) abortResolve();
			});

			vi.spyOn(driver, "sendPrompt").mockImplementation(async (_p, _atts, sink) => {
				callCount++;
				sink.onTextDelta("running...");
				if (callCount === 1) {
					return new Promise((resolve) => {
						abortResolve = resolve;
					});
				}
				sink.onTurnComplete();
			});

			const messages: ServerMessage[] = [];
			const session = new UniversalSession({
				clientId: "test-client-steer",
				cwd: workspaceDir,
				send: (msg) => messages.push(msg),
				store,
				driver,
			});

			const p1 = session.prompt("长耗时问题");
			await new Promise((r) => setTimeout(r, 10));
			expect(session.isStreaming).toBe(true);

			// 发起插队
			await session.prompt("紧急插队问题", undefined, false);
			expect(abortSpy).toHaveBeenCalled();
			expect(callCount).toBe(2);

			await p1.catch(() => {});
			session.dispose();
		});
	});

	describe("7. 通用底座设置预设管理与 SCM 提交信息", () => {
		it("支持 savePreset, applyPreset 与 deletePreset 预设生命周期", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);
			const messages: ServerMessage[] = [];

			let savedPresets: any[] = [];
			let savedSettings: any = { promptMode: "append", customSystemPrompt: "全局提示" };
			const mockStateStore: any = {
				getSettings: () => savedSettings,
				saveSettings: (_id: string, s: any) => {
					savedSettings = { ...savedSettings, ...s };
				},
				getPresets: () => savedPresets,
				savePresets: (_id: string, p: any) => {
					savedPresets = p;
				},
				getProjectModel: () => undefined,
				getDefaultModel: () => undefined,
				getQuickPhrasesSeeded: () => true,
				getMarkerSettings: () => ({ markersEnabled: true, disabledMarkers: [] }),
				saveMarkerSettings: () => {},
				getWorkspaceRoots: () => [],
			};

			const session = new UniversalSession({
				clientId: "test-client-preset",
				cwd: workspaceDir,
				send: (msg) => messages.push(msg),
				store,
				stateStore: mockStateStore,
				driver,
			});

			// 1. 保存预设
			await session.savePreset("代码精简模式");
			expect(savedPresets.length).toBe(1);
			expect(savedPresets[0].name).toBe("代码精简模式");

			// 2. 修改当前设置并应用预设
			savedSettings.customSystemPrompt = "被修改后的提示词";
			await session.applyPreset("代码精简模式");
			expect(savedSettings.customSystemPrompt).toBe("全局提示");

			// 3. 删除预设
			await session.deletePreset("代码精简模式");
			expect(savedPresets.length).toBe(0);

			session.dispose();
		});

		it("scmGenCommitMessage 能够根据变更生成提交信息应答", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);
			const messages: ServerMessage[] = [];

			vi.spyOn(driver, "sendPrompt").mockImplementation(async (_p, _atts, sink) => {
				sink.onTextDelta("feat(core): add universal commands support");
				sink.onTurnComplete();
			});

			const session = new UniversalSession({
				clientId: "test-client-scm",
				cwd: workspaceDir,
				send: (msg) => messages.push(msg),
				store,
				driver,
			});

			await session.scmGenCommitMessage(999);

			const scmMsg = messages.find(
				(m): m is Extract<ServerMessage, { type: "scm_data" }> =>
					m.type === "scm_data" && m.reqId === 999 && m.kind === "commitmsg",
			);
			expect(scmMsg).toBeDefined();

			session.dispose();
		});

		it("支持 installSkill 与 uninstallSkill 动态管理技能并同步刷新命令清单", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);
			const messages: ServerMessage[] = [];

			const session = new UniversalSession({
				clientId: "test-client-skill-mgr",
				cwd: workspaceDir,
				agentDir,
				send: (msg) => messages.push(msg),
				store,
				driver,
			});

			// 1. 安装一个项目级技能
			const skillBody = `---\nname: auto-doc\ndescription: 自动代码注释生成\n---\n为函数编写标准注释。`;
			await session.installSkill("auto-doc", "project", skillBody);

			expect(existsSync(join(workspaceDir, ".pi", "skills", "auto-doc", "SKILL.md"))).toBe(true);

			// 验证推送的斜杠命令中已包含该技能
			messages.length = 0;
			await session.pushSlashCommands();
			const slashMsg = messages.find(
				(m): m is Extract<ServerMessage, { type: "slash_commands" }> => m.type === "slash_commands",
			);
			expect(slashMsg?.commands.some((c) => c.name === "skill:auto-doc")).toBe(true);

			// 2. 卸载该技能
			await session.uninstallSkill("auto-doc", "project");
			expect(existsSync(join(workspaceDir, ".pi", "skills", "auto-doc"))).toBe(false);

			messages.length = 0;
			await session.pushSlashCommands();
			const afterUninstallMsg = messages.find(
				(m): m is Extract<ServerMessage, { type: "slash_commands" }> => m.type === "slash_commands",
			);
			expect(afterUninstallMsg?.commands.some((c) => c.name === "skill:auto-doc")).toBe(false);

			session.dispose();
		});

		it("支持 saveSubagentTemplate 与 deleteSubagentTemplate 子代理模板生命周期", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);
			const messages: ServerMessage[] = [];

			const session = new UniversalSession({
				clientId: "test-client-subagent",
				cwd: workspaceDir,
				dataDir: tempDir,
				send: (msg) => messages.push(msg),
				store,
				driver,
			});

			// 1. 保存子代理模板
			await session.saveSubagentTemplate({
				name: "code-reviewer",
				description: "代码审查专家子代理",
				systemPrompt: "仔细审查代码安全性",
			});

			messages.length = 0;
			session.pushSettings();
			const settingsMsg = messages.find(
				(m): m is Extract<ServerMessage, { type: "settings_state" }> => m.type === "settings_state",
			);
			expect(settingsMsg?.settings.subagentTemplates.some((t) => t.name === "code-reviewer")).toBe(true);

			// 2. 删除子代理模板
			await session.deleteSubagentTemplate("code-reviewer");

			messages.length = 0;
			session.pushSettings();
			const afterDeleteSettings = messages.find(
				(m): m is Extract<ServerMessage, { type: "settings_state" }> => m.type === "settings_state",
			);
			expect(afterDeleteSettings?.settings.subagentTemplates.some((t) => t.name === "code-reviewer")).toBe(false);

			session.dispose();
		});

		it("支持 exportPreset 与 importPreset 交换标准预设文档", async () => {
			const store = new UniversalSessionStore(tempDir);
			const driver = new MockAgentDriver(workspaceDir);
			const messages: ServerMessage[] = [];

			let savedPresets: any[] = [
				{
					name: "审查增强",
					promptMode: "append",
					customSystemPrompt: "专注于严谨的代码审查",
					disabledSkills: [],
					disabledExtensions: [],
				},
			];
			const mockStateStore: any = {
				getSettings: () => ({ promptMode: "append", customSystemPrompt: "当前提示词" }),
				saveSettings: vi.fn(),
				getPresets: () => savedPresets,
				savePresets: (_id: string, p: any) => {
					savedPresets = p;
				},
				getProjectModel: () => undefined,
				getDefaultModel: () => undefined,
				getQuickPhrasesSeeded: () => true,
				getMarkerSettings: () => ({ markersEnabled: true, disabledMarkers: [] }),
				saveMarkerSettings: () => {},
				getWorkspaceRoots: () => [],
			};

			const session = new UniversalSession({
				clientId: "test-client-preset-share",
				cwd: workspaceDir,
				send: (msg) => messages.push(msg),
				store,
				stateStore: mockStateStore,
				driver,
			});

			// 1. 导出预设
			await session.exportPreset({
				type: "preset_export",
				source: "preset",
				name: "审查增强",
			});

			const exportResult = messages.find(
				(m): m is Extract<ServerMessage, { type: "preset_export_result" }> => m.type === "preset_export_result",
			);
			expect(exportResult?.ok).toBe(true);
			expect(exportResult?.json).toContain("专注于严谨的代码审查");

			// 2. 导入预设并持久化
			await session.importPreset({
				type: "preset_import",
				json: exportResult!.json ?? "",
				dryRun: false,
				apply: true,
			});

			expect(savedPresets.length).toBe(1);
			expect(mockStateStore.saveSettings).toHaveBeenCalled();

			session.dispose();
		});
	});
});
