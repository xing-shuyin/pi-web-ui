import { describe, expect, it } from "vitest";
import { HistoryStack, type GraphSnap } from "../../web/src/components/canvas/canvas-p0.js";
import type { CanvasNode, CanvasEdge } from "../../web/src/types.js";

const makeNode = (id: string, title = "test"): CanvasNode =>
	({
		id,
		title,
		role: "coder",
		x: 100,
		y: 100,
		status: "idle",
		engine: "pi",
		model: "gpt-4o",
		cwd: ".",
		useWorktree: false,
	}) as CanvasNode;

const makeEdge = (id: string, sourceNodeId: string, targetNodeId: string): CanvasEdge => ({
	id,
	sourceNodeId,
	targetNodeId,
	type: "handoff",
});

describe("HistoryStack - 画布撤销/重做栈", () => {
	it("支持删除连线后的撤销（undo）恢复被删连线", () => {
		const stack = new HistoryStack(50);
		const n1 = makeNode("n1");
		const n2 = makeNode("n2");
		const e1 = makeEdge("e1", "n1", "n2");

		const initialSnap: GraphSnap = {
			nodes: [n1, n2],
			edges: [e1],
		};

		stack.push(initialSnap);
		expect(stack.canUndo).toBe(true);

		const afterDeleteSnap: GraphSnap = {
			nodes: [n1, n2],
			edges: [],
		};

		const undone = stack.undo(afterDeleteSnap);
		expect(undone).not.toBeNull();
		expect(undone?.edges).toHaveLength(1);
		expect(undone?.edges[0].id).toBe("e1");
		expect(stack.canRedo).toBe(true);

		const redone = stack.redo(undone!);
		expect(redone).not.toBeNull();
		expect(redone?.edges).toHaveLength(0);
	});

	it("支持添加连线与更新连线的撤销恢复", () => {
		const stack = new HistoryStack(50);
		const n1 = makeNode("n1");
		const n2 = makeNode("n2");
		const initial: GraphSnap = { nodes: [n1, n2], edges: [] };

		stack.push(initial);
		const afterAdd: GraphSnap = {
			nodes: [n1, n2],
			edges: [makeEdge("e1", "n1", "n2")],
		};

		const undoneAdd = stack.undo(afterAdd);
		expect(undoneAdd?.edges).toHaveLength(0);

		const redoneAdd = stack.redo(undoneAdd!);
		expect(redoneAdd?.edges).toHaveLength(1);
	});

	it("新操作发生后清空重做历史（future）", () => {
		const stack = new HistoryStack(50);
		const snap1: GraphSnap = { nodes: [makeNode("n1")], edges: [] };
		const snap2: GraphSnap = { nodes: [makeNode("n1"), makeNode("n2")], edges: [] };
		const snap3: GraphSnap = { nodes: [makeNode("n3")], edges: [] };

		stack.push(snap1);
		stack.undo(snap2);
		expect(stack.canRedo).toBe(true);

		stack.push(snap3);
		expect(stack.canRedo).toBe(false);
		expect(stack.redo(snap3)).toBeNull();
	});

	it("支持 clear 清理栈（用于切换工程隔离）", () => {
		const stack = new HistoryStack(50);
		stack.push({ nodes: [makeNode("n1")], edges: [] });
		expect(stack.canUndo).toBe(true);

		stack.clear();
		expect(stack.canUndo).toBe(false);
		expect(stack.canRedo).toBe(false);
		expect(stack.undo({ nodes: [], edges: [] })).toBeNull();
	});

	it("遵守有界容量限制（超过上限丢弃最旧快照）", () => {
		const stack = new HistoryStack(3);
		stack.push({ nodes: [makeNode("n1")], edges: [] });
		stack.push({ nodes: [makeNode("n2")], edges: [] });
		stack.push({ nodes: [makeNode("n3")], edges: [] });
		stack.push({ nodes: [makeNode("n4")], edges: [] });

		const u1 = stack.undo({ nodes: [makeNode("current")], edges: [] });
		expect(u1?.nodes[0].id).toBe("n4");
		const u2 = stack.undo(u1!);
		expect(u2?.nodes[0].id).toBe("n3");
		const u3 = stack.undo(u2!);
		expect(u3?.nodes[0].id).toBe("n2");
		const u4 = stack.undo(u3!);
		expect(u4).toBeNull();
	});

	it("支持节点位置移动（拖拽）后的撤销恢复到原坐标", () => {
		const stack = new HistoryStack(50);
		const initialNode = makeNode("n1");
		initialNode.x = 100;
		initialNode.y = 120;

		stack.push({ nodes: [initialNode], edges: [] });

		const movedNode = { ...initialNode, x: 380, y: 460 };
		const currentSnap: GraphSnap = { nodes: [movedNode], edges: [] };

		const undone = stack.undo(currentSnap);
		expect(undone).not.toBeNull();
		expect(undone?.nodes[0].x).toBe(100);
		expect(undone?.nodes[0].y).toBe(120);

		const redone = stack.redo(undone!);
		expect(redone).not.toBeNull();
		expect(redone?.nodes[0].x).toBe(380);
		expect(redone?.nodes[0].y).toBe(460);
	});

	it("相同快照连续 push 时自动去重，避免撤销时产生空步（假撤销）", () => {
		const stack = new HistoryStack(50);
		const snap = { nodes: [makeNode("n1")], edges: [] };

		stack.push(snap);
		stack.push(snap);
		stack.push({ nodes: [makeNode("n1")], edges: [] });

		const u1 = stack.undo({ nodes: [makeNode("n2")], edges: [] });
		expect(u1).not.toBeNull();
		expect(u1?.nodes[0].id).toBe("n1");

		const u2 = stack.undo(u1!);
		expect(u2).toBeNull();
	});

	it("完整多步交互流程：添加节点 -> 连线 -> 删除连线 -> 移动节点，支持连续逐步撤销与重做", () => {
		const stack = new HistoryStack(50);
		const n1 = makeNode("n1");
		const n2 = makeNode("n2");

		const step0: GraphSnap = { nodes: [n1], edges: [] };

		stack.push(step0);
		const step1: GraphSnap = { nodes: [n1, n2], edges: [] };

		stack.push(step1);
		const e1 = makeEdge("e1", "n1", "n2");
		const step2: GraphSnap = { nodes: [n1, n2], edges: [e1] };

		stack.push(step2);
		const step3: GraphSnap = { nodes: [n1, n2], edges: [] };

		stack.push(step3);
		const movedN2 = { ...n2, x: 500, y: 500 };
		const step4: GraphSnap = { nodes: [n1, movedN2], edges: [] };

		const backToStep3 = stack.undo(step4);
		expect(backToStep3?.nodes.find((n) => n.id === "n2")?.x).toBe(100);
		expect(backToStep3?.edges).toHaveLength(0);

		const backToStep2 = stack.undo(backToStep3!);
		expect(backToStep2?.edges).toHaveLength(1);
		expect(backToStep2?.edges[0].id).toBe("e1");

		const backToStep1 = stack.undo(backToStep2!);
		expect(backToStep1?.edges).toHaveLength(0);
		expect(backToStep1?.nodes).toHaveLength(2);

		const backToStep0 = stack.undo(backToStep1!);
		expect(backToStep0?.nodes).toHaveLength(1);
		expect(backToStep0?.nodes[0].id).toBe("n1");

		expect(stack.canUndo).toBe(false);
		expect(stack.undo(backToStep0!)).toBeNull();

		const forwardTo1 = stack.redo(backToStep0!);
		expect(forwardTo1?.nodes).toHaveLength(2);

		const forwardTo2 = stack.redo(forwardTo1!);
		expect(forwardTo2?.edges).toHaveLength(1);

		const forwardTo3 = stack.redo(forwardTo2!);
		expect(forwardTo3?.edges).toHaveLength(0);

		const forwardTo4 = stack.redo(forwardTo3!);
		expect(forwardTo4?.nodes.find((n) => n.id === "n2")?.x).toBe(500);

		expect(stack.canRedo).toBe(false);
		expect(stack.redo(forwardTo4!)).toBeNull();
	});
});
