import type { Translate } from "../../i18n";
import type { CanvasGraph, CanvasNodeRole } from "../../types";
import { autoLayout } from "./canvas-p0";

export interface SquadTemplate {
	id: string;
	title: string;
	desc: string;
	createGraph: () => CanvasGraph;
}
function sequential(name: string, steps: { title: string; role: CanvasNodeRole; instruction?: string }[]): CanvasGraph {
	const now = Date.now();
	const id = `graph_${now}_${Math.random().toString(36).slice(2, 8)}`;
	const nodes: CanvasGraph["nodes"] = steps.map((s, i) => ({
		...s,
		id: `${id}_n${i}`,
		x: 80,
		y: 80,
		width: 300,
		engine: "pi",
		model: "",
		cwd: ".",
		useWorktree: false,
		status: "idle",
	}));
	const edges: CanvasGraph["edges"] = nodes.slice(1).map((n, i) => ({
		id: `${id}_e${i}`,
		sourceNodeId: nodes[i].id,
		targetNodeId: n.id,
		type: nodes[i].role === "human" ? "approve" : "handoff",
		sourcePort: nodes[i].role === "human" ? "approve" : "result",
		targetPort: "contract",
	}));
	return {
		id,
		name,
		nodes: autoLayout(nodes, edges),
		edges,
		viewport: { x: 60, y: 60, zoom: 1 },
		status: "idle",
		executionMode: "real",
		createdAt: now,
		updatedAt: now,
	};
}
export function getSquadTemplates(t: Translate): SquadTemplate[] {
	return [
		{
			id: "pstack_rigorous",
			title: t("canvas.template.pstack_rigorous.title"),
			desc: t("canvas.template.pstack_rigorous.desc"),
			createGraph: () =>
				sequential(t("canvas.template.pstack_rigorous.name"), [
					{
						title: t("canvas.template.pstack_rigorous.step0.title"),
						role: "pstack",
						instruction:
							"Clarify requirements, dependencies, and verifiable acceptance criteria. Do not assume isolated workspaces.",
					},
					{
						title: t("canvas.template.pstack_rigorous.step1.title"),
						role: "pstack",
						instruction:
							"Implement the upstream plan in the shared directory. Preserve other changes and report evidence.",
					},
					{
						title: t("canvas.template.pstack_rigorous.step2.title"),
						role: "pstack",
						instruction: "Run relevant tests. Report actual results and unverified areas.",
					},
					{
						title: t("canvas.template.pstack_rigorous.step3.title"),
						role: "pstack",
						instruction: "Check implementation and test evidence, identify gaps, and hand off for human acceptance.",
					},
					{ title: t("canvas.template.pstack_rigorous.step4.title"), role: "human" },
				]),
		},
		{
			id: "sequential-delivery",
			title: t("canvas.template.sequential-delivery.title"),
			desc: t("canvas.template.sequential-delivery.desc"),
			createGraph: () =>
				sequential(t("canvas.template.sequential-delivery.name"), [
					{ title: t("canvas.template.sequential-delivery.step0.title"), role: "trigger" },
					{
						title: t("canvas.template.sequential-delivery.step1.title"),
						role: "planner",
						instruction:
							"Clarify requirements, scope, and acceptance criteria. Execute every step sequentially in the shared working directory.",
					},
					{
						title: t("canvas.template.sequential-delivery.step2.title"),
						role: "coder",
						instruction:
							"Implement from {{upstream}}. Preserve others' changes and report modifications and limitations.",
					},
					{
						title: t("canvas.template.sequential-delivery.step3.title"),
						role: "tester",
						instruction:
							"Run the tests needed for the task and upstream delivery. Report commands, actual results, and uncovered areas. Record failures explicitly; do not claim they passed.",
					},
					{
						title: t("canvas.template.sequential-delivery.step4.title"),
						role: "reviewer",
						instruction:
							"Inspect actual changes and test evidence. Identify unmet acceptance criteria and submit them for a human decision.",
					},
					{ title: t("canvas.template.sequential-delivery.step5.title"), role: "human" },
					{ title: t("canvas.template.sequential-delivery.step6.title"), role: "end" },
				]),
		},
		{
			id: "research-qa",
			title: t("canvas.template.research-qa.title"),
			desc: t("canvas.template.research-qa.desc"),
			createGraph: () =>
				sequential(t("canvas.template.research-qa.name"), [
					{ title: t("canvas.template.research-qa.step0.title"), role: "trigger" },
					{
						title: t("canvas.template.research-qa.step1.title"),
						role: "researcher",
						instruction: "Collect verifiable materials. Distinguish evidence, inference, and unknowns.",
					},
					{
						title: t("canvas.template.research-qa.step2.title"),
						role: "writer",
						instruction: "Write a report from {{upstream}}, preserving sources and uncertainty.",
					},
					{
						title: t("canvas.template.research-qa.step3.title"),
						role: "reviewer",
						instruction: "Check sources and requirements item by item. List errors, omissions, and unverified areas.",
					},
					{ title: t("canvas.template.research-qa.step4.title"), role: "human" },
					{ title: t("canvas.template.research-qa.step5.title"), role: "end" },
				]),
		},
	];
}
