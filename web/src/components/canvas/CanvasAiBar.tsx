import { useState } from "react";
import type { CanvasGraph, CanvasNode, CanvasNodeRole } from "../../types";
import { ROLE_METAS, ROLE_FIELDS } from "./CanvasTypes";
import { useCanvasT } from "./canvas-i18n";
import { autoLayout } from "./canvas-p0";

export interface CanvasAiBarProps {
	onApply: (graph: CanvasGraph) => void;
	onSmartGenerate: (text: string) => void;
	smartPending: boolean;
	defaultModel: string;
	defaultCwd?: string;
}

/** 关键词 → 角色映射（中英同义词） */
const RULES: { keys: string[]; role: CanvasNodeRole }[] = [
	{ keys: ["调研", "搜索", "research", "search"], role: "researcher" },
	{ keys: ["规划", "拆解", "plan"], role: "planner" },
	{ keys: ["架构", "选型", "architect"], role: "architect" },
	{ keys: ["测试", "test", "qa"], role: "tester" },
	{ keys: ["审查", "review", "cr", "合规"], role: "reviewer" },
	{ keys: ["文档", "readme", "doc", "writer"], role: "writer" },
	{ keys: ["评估", "打分", "eval"], role: "evaluator" },
	{ keys: ["审批", "人工", "approve", "human"], role: "human" },

	// A keyword alone cannot safely configure a loop or branch.
	{ keys: ["汇总", "合并", "merge"], role: "merge" },
	{ keys: ["编码", "开发", "实现", "重构", "code", "coder", "实现"], role: "coder" },
];

export function pickRole(seg: string): CanvasNodeRole {
	const s = seg.toLowerCase();
	for (const r of RULES) {
		if (r.keys.some((k) => s.includes(k))) return r.role;
	}
	return "coder";
}

/** “调研-编码-审查” / “先A再B然后C” / 换行 / 逗号分段 */
export function splitSteps(text: string): string[] {
	return text
		.split(/[\n；;。]+|[-–>→]+\s*|\s*(?:然后|接着|再|最后)\s*/g)
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && s.length < 80)
		.slice(0, 12);
}

/** P2：一句话生成 DAG（纯前端启发式，零 token、离线可用） */
export function CanvasAiBar({
	onApply,
	onSmartGenerate,
	smartPending,
	defaultModel,
	defaultCwd = ".",
}: CanvasAiBarProps) {
	const t = useCanvasT();
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const handleGenerate = () => {
		const steps = splitSteps(text);
		if (steps.length === 0) return;
		const nodes: CanvasNode[] = [];
		const now = Date.now();
		// 起始触发器
		nodes.push({
			id: `n_${now}_trigger`,
			title: "开始",
			role: "trigger",
			x: 80,
			y: 80,
			width: 300,
			engine: "pi",
			model: defaultModel,
			cwd: defaultCwd,
			useWorktree: false,
			status: "idle",
		});
		steps.forEach((s, i) => {
			const role = pickRole(s);
			const meta = ROLE_METAS[role];
			const nid = `n_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`;
			const node: CanvasNode = {
				id: nid,
				title: s.slice(0, 20) || t(meta.labelZh, meta.labelEn),
				role,
				x: 80,
				y: 80,
				width: 300,
				engine: "pi",
				model: defaultModel,
				cwd: defaultCwd,
				useWorktree: false,
				status: "idle",
			};
			if (meta?.needsLlm) node.instruction = `${s}。参考{{上游摘要}}完成本步，输出结构化交付。`;
			const defaults: Record<string, string | number | boolean> = {};
			for (const f of ROLE_FIELDS[role] ?? []) {
				if (f.default !== undefined) defaults[f.key] = f.default;
			}
			if (Object.keys(defaults).length > 0) node.config = { ...defaults, ...node.config };
			nodes.push(node);
		});
		const laid = autoLayout(
			nodes,
			nodes.slice(1).map((n, i) => ({
				id: `e_${now}_${i}`,
				sourceNodeId: nodes[i].id,
				targetNodeId: n.id,
				type: "handoff" as const,
			})),
		);
		const edges = laid.slice(1).map((n, i) => ({
			id: `e_${now}_${i}`,
			sourceNodeId: laid[i].id,
			targetNodeId: n.id,
			type: "handoff" as const,
		}));
		onApply({
			id: `graph_${now}_${Math.random().toString(36).slice(2, 6)}`,
			name: text.slice(0, 24) || "AI 生成流水线",
			viewport: { x: 60, y: 60, zoom: 1 },
			nodes: laid,
			edges,
			status: "idle",
			executionMode: "real",
			createdAt: now,
			updatedAt: now,
		});
		setOpen(false);
		setText("");
	};
	if (!open) {
		return (
			<button
				type="button"
				className="canvas-ai-fab"
				onClick={() => setOpen(true)}
				title={t(
					"按关键词生成串行步骤，执行前请检查指令",
					"Generate sequential steps from keywords; review instructions before running",
				)}
			>
				{t("✨ 生成流程", "✨ Generate workflow")}
			</button>
		);
	}
	return (
		<div className="canvas-ai-bar">
			<input
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") handleGenerate();
					if (e.key === "Escape") setOpen(false);
				}}
				placeholder="例：先调研方案，再编码实现，然后测试，最后审查汇总"
				autoFocus
			/>
			<button type="button" className="canvas-btn primary" onClick={handleGenerate} disabled={!text.trim()}>
				{t("关键词生成", "From keywords")}
			</button>
			<button
				type="button"
				className="canvas-btn"
				onClick={() => {
					onSmartGenerate(text);
					setOpen(false);
					setText("");
				}}
				disabled={!text.trim() || smartPending}
				title="发给当前对话的 AI，按需求智能拆工作流（回包确认后落图）"
			>
				{smartPending ? t("等待 AI…", "Waiting for AI…") : t("🤖 AI 生成", "🤖 From AI")}
			</button>
			<button type="button" className="canvas-btn" onClick={() => setOpen(false)}>
				{t("取消", "Cancel")}
			</button>
		</div>
	);
}
