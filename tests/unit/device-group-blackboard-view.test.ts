import { describe, expect, it } from "vitest";
import {
	parseMarkdownSections,
	assembleMarkdownSection,
	PRESET_SECTIONS,
} from "../../web/src/components/GroupBlackboardView";

describe("GroupBlackboardView parser & assembler", () => {
	it("parses structured markdown into preset and custom sections", () => {
		const md = `# 系统技术共识 RFC-001
这是项目导言与背景。

## 架构设计
- 微内核架构
- 事件驱动模型

## 接口契约
- POST /api/v1/dispatch
- GET /api/v1/tasks/:id

## 任务分工
- [x] BotA: 实现后端接口
- [ ] BotB: 实现前端组件

## 阻塞与决策
- 决策：采用 SSE 单向流

## 附加部署说明
- Docker 容器镜像规范
`;

		const { preamble, sections } = parseMarkdownSections(md);
		expect(preamble).toContain("这是项目导言与背景");
		expect(sections).toHaveLength(5);

		expect(sections[0].id).toBe("architecture");
		expect(sections[0].title).toBe("架构设计");
		expect(sections[0].content).toContain("微内核架构");

		expect(sections[1].id).toBe("contracts");
		expect(sections[1].title).toBe("接口契约");
		expect(sections[1].content).toContain("POST /api/v1/dispatch");

		expect(sections[2].id).toBe("progress");
		expect(sections[2].title).toBe("任务分工");
		expect(sections[2].content).toContain("BotA: 实现后端接口");

		expect(sections[3].id).toBe("blockers");
		expect(sections[3].title).toBe("阻塞与决策");
		expect(sections[3].content).toContain("决策：采用 SSE 单向流");

		expect(sections[4].id).toContain("custom");
		expect(sections[4].title).toBe("附加部署说明");
		expect(sections[4].content).toContain("Docker 容器镜像规范");
	});

	it("treats plain text without level 1/2 headings as preamble and yields empty sections", () => {
		const plain = "这是没有任何标题的纯文本黑板记录。\n支持完全兼容。";
		const { preamble, sections } = parseMarkdownSections(plain);
		expect(preamble).toBe(plain);
		expect(sections).toHaveLength(0);
	});

	it("updates existing section in place with assembleMarkdownSection", () => {
		const original = `## 架构设计
旧架构内容

## 接口契约
旧接口内容`;

		const updated = assembleMarkdownSection(original, "architecture", "架构设计", "新架构内容 (已更新)");
		expect(updated).toContain("新架构内容 (已更新)");
		expect(updated).toContain("旧接口内容");
		expect(updated).not.toContain("旧架构内容");
	});

	it("appends new section cleanly when it does not exist yet", () => {
		const original = `纯文本前言介绍`;
		const updated = assembleMarkdownSection(original, "contracts", "接口契约", "- POST /api/users");
		expect(updated).toContain("纯文本前言介绍");
		expect(updated).toContain("## 接口契约");
		expect(updated).toContain("- POST /api/users");
	});

	it("handles completely empty initial blackboard when assembling first section", () => {
		const updated = assembleMarkdownSection("", "blockers", "阻塞与决策", "- 暂无已知技术卡点");
		expect(updated).toBe("## 阻塞与决策\n\n- 暂无已知技术卡点");
	});
});
