import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en, zh, LanguageProvider, registerLocale, useT, type Translate } from "../../web/src/i18n";
import { getSquadTemplates } from "../../web/src/components/canvas/CanvasTemplates";
import { getRoleMetas, getRoleFields } from "../../web/src/components/canvas/CanvasTypes";
import { canvasCondition } from "../../server/canvas/canvas-scheduler";
import { getPstackSkills } from "../../web/src/components/canvas/pstack-skills-data";
import { CanvasToolbar } from "../../web/src/components/canvas/CanvasToolbar";
import { CanvasNodeCard } from "../../web/src/components/canvas/CanvasNodeCard";
import type { CanvasGraph, CanvasNode } from "../../server/protocol";

const codes = ["zh", "en", "de", "es", "fr", "it", "ja", "ko", "pt", "ru", "tr", "zh-TW", "zh-Hant", "zh-HK"];
const root = join(import.meta.dirname, "../..");
const userTitle = "User title / 用户命名";

function dictionary(module: string, locale: string): Record<string, string> {
	return JSON.parse(readFileSync(join(root, "web/src/i18n/messages", module, `${locale}.json`), "utf8"));
}

const node: CanvasNode = {
	id: "localize-node",
	title: userTitle,
	role: "trigger",
	x: 0,
	y: 0,
	engine: "pi",
	model: "",
	cwd: ".",
	useWorktree: false,
	status: "running",
	currentAction: "Legacy status should be replaced by the structured message",
	currentActionMessage: { key: "canvas.runtime.action.completed", vars: { engine: "pi" } },
};
const graph: CanvasGraph = {
	id: "localize-graph",
	name: "User graph / 用户画布",
	nodes: [node],
	edges: [],
	viewport: { x: 0, y: 0, zoom: 1 },
	status: "idle",
	createdAt: 0,
	updatedAt: 0,
};
const noop = () => {};

function CanvasProbe() {
	const t = useT();
	return createElement(
		Fragment,
		null,
		createElement(CanvasToolbar, {
			graph,
			graphList: [{ id: graph.id, name: graph.name, nodeCount: 1, edgeCount: 0, updatedAt: 0 }],
			onSelectGraph: noop,
			onCreateGraph: noop,
			onRenameGraph: noop,
			onDeleteGraph: noop,
			onAddNode: noop,
			customCards: [],
			onApplyTemplate: noop,
			onRunAll: noop,
			onStopAll: noop,
			onResetStatus: noop,
			onSave: noop,
			onFitView: noop,
			onUndo: noop,
			onRedo: noop,
			onDuplicate: noop,
			onAutoLayout: noop,
			zoom: 1,
			onZoomChange: noop,
			onResetViewport: noop,
		}),
		createElement(CanvasNodeCard, {
			node,
			isSelected: false,
			zoom: 1,
			models: [],
			projects: [],
			onSelect: noop,
			onUpdate: noop,
			onRun: noop,
			onStop: noop,
			onDelete: noop,
			onOpenDrawer: noop,
			onStartConnect: noop,
			onEndConnect: noop,
		}),
		createElement(
			"p",
			null,
			t("canvas.runtime.action.starting", { engine: "pi", model: "test-model", role: "test-role" }),
		),
	);
}

function textOf(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replaceAll("&amp;", "&")
		.replaceAll("&quot;", '"')
		.replaceAll("&#x27;", "'");
}

afterEach(() => vi.unstubAllGlobals());

describe("Canvas locale rendering", () => {
	it("keeps Pstack descriptions and execution content in English across UI languages", () => {
		const chinese: Translate = (key) => zh[key];
		const english: Translate = (key) => en[key];
		const chineseSkills = getPstackSkills(chinese);
		const englishSkills = getPstackSkills(english);
		expect(chineseSkills).toHaveLength(englishSkills.length);
		for (const [index, skill] of chineseSkills.entries()) {
			expect(skill.description).toBe(englishSkills[index].description);
			expect(skill.content).toBe(englishSkills[index].content);
			expect(skill.description + skill.content).not.toMatch(/[\u4e00-\u9fff]/);
		}
		const chineseRoles = getRoleMetas(chinese);
		const englishRoles = getRoleMetas(english);
		for (const [role, meta] of Object.entries(chineseRoles)) {
			expect(meta.defaultInstruction).toBe(englishRoles[role as keyof typeof englishRoles].defaultInstruction);
			expect(meta.defaultInstruction).not.toMatch(/[\u4e00-\u9fff]/);
		}
		const chineseTemplates = getSquadTemplates(chinese);
		const englishTemplates = getSquadTemplates(english);
		for (const [index, template] of chineseTemplates.entries()) {
			const instructions = template.createGraph().nodes.map((entry) => entry.instruction ?? "");
			expect(instructions).toEqual(englishTemplates[index].createGraph().nodes.map((entry) => entry.instruction ?? ""));
			expect(instructions.join("\n")).not.toMatch(/[\u4e00-\u9fff]/);
		}
	});

	it("uses English keywords for new condition nodes without changing branch evaluation", () => {
		const translate: Translate = (key) => en[key];
		const keywords = getRoleFields(translate).condition.find((field) => field.key === "condition")?.default;
		expect(keywords).toBe("reject/fail");
		const condition: CanvasNode = { ...node, role: "condition", config: { condition: keywords } };
		expect(canvasCondition({ ...condition, lastOutputSummary: "Task failed" }, graph)).toBe(true);
		expect(canvasCondition({ ...condition, lastOutputSummary: "Task completed successfully" }, graph)).toBe(false);
	});

	it.each(codes)("renders the %s module through the shared provider and preserves user content", (locale) => {
		const strings = { ...dictionary("canvas", locale), ...dictionary("canvas-runtime", locale) };
		if (locale !== "zh" && locale !== "en") registerLocale({ code: locale, nativeName: locale, strings });
		vi.stubGlobal("localStorage", { getItem: () => locale });
		const html = renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(CanvasProbe) }));
		const text = textOf(html);
		expect(text).toContain(strings["canvas.toolbar.runWorkflow"]);
		expect(text).toContain(strings["canvas.runtime.action.completed"].replaceAll("{engine}", "pi"));
		expect(text).toContain(
			strings["canvas.runtime.action.starting"]
				.replaceAll("{engine}", "pi")
				.replaceAll("{model}", "test-model")
				.replaceAll("{role}", "test-role"),
		);
		expect(html).toContain(userTitle);
		expect(html).toContain(graph.name);
		expect(html).not.toContain(node.currentAction);
		expect(text).not.toContain("canvas.runtime.");
	});
});
