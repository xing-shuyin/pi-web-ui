/**
 * canvas-pstack-skills.test.ts — Pstack 58 个 Skills 与 Skill 灵魂角色在画布协同中的单元测试。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PSTACK_SKILLS, PSTACK_SKILLS_MAP, PSTACK_CATEGORIES } from "../../server/canvas/pstack-skills-data.js";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";
import { makeCanvasTool } from "../../server/canvas/canvas-agent-tool.js";
import { createDefaultCanvasGraph, saveCanvasGraph } from "../../server/canvas/canvas-store.js";
import { ROLE_METAS, ROLE_FIELDS, ROLE_IO_HELP } from "../../web/src/components/canvas/CanvasTypes.js";
import { SQUAD_TEMPLATES } from "../../web/src/components/canvas/CanvasTemplates.js";
import type { CanvasGraph, ServerMessage } from "../../server/protocol.js";

describe("Pstack 58 Skills Catalog", () => {
	it("应完整收录来自官方 cursor/plugins/pstack/skills 的 58 个技能", () => {
		expect(PSTACK_SKILLS.length).toBe(58);
		expect(Object.keys(PSTACK_SKILLS_MAP).length).toBe(58);
	});

	it("核心技能元数据应齐全且具有可读中文名与图标", () => {
		const coreKeys = [
			"poteto-mode",
			"unslop",
			"principle-fix-root-causes",
			"principle-prove-it-works",
			"architect",
			"tdd",
			"arena",
			"interrogate",
			"statechart",
			"no-comments",
		];
		for (const key of coreKeys) {
			const item = PSTACK_SKILLS_MAP[key];
			expect(item, `skill ${key} 应存在`).toBeDefined();
			expect(item.id).toBe(key);
			expect(item.nameZh.length).toBeGreaterThan(1);
			expect(item.content.length).toBeGreaterThan(100);
			expect(item.icon).toBeTruthy();
			expect(item.category).toBeTruthy();
		}
	});

	it("应划分为 6 大领域分类", () => {
		const categories = Object.keys(PSTACK_CATEGORIES);
		expect(categories).toContain("core");
		expect(categories).toContain("architecture");
		expect(categories).toContain("principles");
		expect(categories).toContain("quality");
		expect(categories).toContain("verification");
		expect(categories).toContain("communication");
	});
});

describe("Canvas Roles: pstack & skill", () => {
	it("前端 ROLE_METAS 应包含 pstack 与 skill 角色", () => {
		expect(ROLE_METAS.pstack).toBeDefined();
		expect(ROLE_METAS.pstack.group).toBe("agent");
		expect(ROLE_METAS.pstack.needsLlm).toBe(true);
		expect(ROLE_METAS.pstack.icon).toBe("🥔");

		expect(ROLE_METAS.skill).toBeDefined();
		expect(ROLE_METAS.skill.group).toBe("agent");
		expect(ROLE_METAS.skill.needsLlm).toBe(true);
		expect(ROLE_METAS.skill.icon).toBe("✨");
	});

	it("前端 ROLE_FIELDS 应为 pstack 导出 58 个 skill 下拉选项", () => {
		const pstackFields = ROLE_FIELDS.pstack;
		expect(pstackFields.length).toBeGreaterThan(0);
		const skillField = pstackFields.find((f) => f.key === "skill");
		expect(skillField).toBeDefined();
		expect(skillField?.kind).toBe("select");
		expect(skillField?.options?.length).toBe(58);
		expect(skillField?.default).toBe("poteto-mode");

		const skillRoleFields = ROLE_FIELDS.skill;
		const skillNameField = skillRoleFields.find((f) => f.key === "skillName");
		expect(skillNameField).toBeDefined();
		expect(skillNameField?.kind).toBe("select");
		expect(skillNameField?.options && skillNameField.options.length).toBeGreaterThan(0);
	});

	it("前端 ROLE_IO_HELP 应包含两个新角色的输入输出帮助", () => {
		expect(ROLE_IO_HELP.pstack).toBeDefined();
		expect(ROLE_IO_HELP.skill).toBeDefined();
	});

	it("SQUAD_TEMPLATES 应包含开箱即用的 Pstack 深度工程战队预设", () => {
		const pstackTemplate = SQUAD_TEMPLATES.find((t) => t.id === "pstack_rigorous");
		expect(pstackTemplate).toBeDefined();
		const graph = pstackTemplate!.createGraph();
		expect(graph.nodes.length).toBe(5);
		const pstackNodes = graph.nodes.filter((n) => n.role === "pstack");
		expect(pstackNodes.length).toBe(4);
	});
});

describe("Canvas Tool & Orchestrator Execution for pstack and skill roles", () => {
	let tempDir: string;
	let orchestrator: CanvasOrchestrator;
	const events: ServerMessage[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-canvas-pstack-test-"));
		events.length = 0;
		orchestrator = new CanvasOrchestrator(tempDir, tempDir);
		orchestrator.setBroadcaster((msg) => events.push(msg));
	});

	afterEach(() => {
		orchestrator.stopAll("g_pstack_exec");
		orchestrator.stopAll("g_skill_exec");
		orchestrator.stopAll("test_tool_graph");
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("makeCanvasTool 允许创建和识别 pstack 与 skill 角色的节点", async () => {
		const g = createDefaultCanvasGraph("test_tool_graph");
		saveCanvasGraph(tempDir, g);

		const tool = makeCanvasTool({
			dataDir: tempDir,
			lang: () => "zh",
		});

		// 1. 添加 pstack 节点
		const addRes = await tool.execute(
			"call_1",
			{
				action: "add_node",
				graphId: "test_tool_graph",
				title: "Unslop Specialist",
				role: "pstack",
				instruction: "清理代码中的废话",
			},
			undefined as any,
			undefined as any,
			{} as any,
		);
		const text1 = String((addRes as any)?.content?.[0]?.text);
		expect(text1).toContain("Unslop Specialist");

		// 2. 添加 skill 节点
		const addSkillRes = await tool.execute(
			"call_2",
			{
				action: "add_node",
				graphId: "test_tool_graph",
				title: "Soul Specialist",
				role: "skill",
				instruction: "以技能灵魂执行任务",
			},
			undefined as any,
			undefined as any,
			{} as any,
		);
		const text2 = String((addSkillRes as any)?.content?.[0]?.text);
		expect(text2).toContain("Soul Specialist");
	});

	it("pstack 节点调度时，Prompt 中应注入所选 Skill 的工作依据与规约", async () => {
		const graph: CanvasGraph = {
			id: "g_pstack_exec",
			name: "Pstack Test",
			viewport: { x: 0, y: 0, zoom: 1 },
			status: "idle",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			nodes: [
				{
					id: "n_pstack_fix",
					title: "直击根因",
					role: "pstack",
					x: 0,
					y: 0,
					engine: "pi",
					model: "mock/model",
					cwd: ".",
					useWorktree: false,
					config: { skill: "principle-fix-root-causes" },
					instruction: "深入排查竞态根因",
					status: "idle",
				},
			],
			edges: [],
		};

		saveCanvasGraph(tempDir, graph);
		await orchestrator.runNode(graph, "n_pstack_fix");

		const promptLog = orchestrator.getNodeLog(graph.id, "n_pstack_fix").find((e) => e.kind === "prompt");
		expect(promptLog?.text).toContain("【Pstack 严谨工程专项工作依据");
		expect(promptLog?.text).toContain("principle-fix-root-causes");
		expect(promptLog?.text).toContain("深入优先、拒绝 AI 废话（Unslop）");
		expect(promptLog?.text).toContain("拿实证说话");
		expect(promptLog?.text).toContain("深入排查竞态根因");
		orchestrator.stopAll(graph.id);
	});

	it("skill 节点调度时，Prompt 中应注入技能之魂 (Soul of Skill)", async () => {
		const graph: CanvasGraph = {
			id: "g_skill_exec",
			name: "Skill Test",
			viewport: { x: 0, y: 0, zoom: 1 },
			status: "idle",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			nodes: [
				{
					id: "n_skill_node",
					title: "技能节点",
					role: "skill",
					x: 0,
					y: 0,
					engine: "pi",
					model: "mock/model",
					cwd: ".",
					useWorktree: false,
					config: { skillName: "bro" },
					instruction: "极简直白沟通",
					status: "idle",
				},
			],
			edges: [],
		};

		saveCanvasGraph(tempDir, graph);
		await orchestrator.runNode(graph, "n_skill_node");

		const promptLog = orchestrator.getNodeLog(graph.id, "n_skill_node").find((e) => e.kind === "prompt");
		expect(promptLog?.text).toContain("【技能之魂 (Soul of Skill)");
		expect(promptLog?.text).toContain("bro");
		expect(promptLog?.text).toContain("极简直白沟通");
		orchestrator.stopAll(graph.id);
	});
});
