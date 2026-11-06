import { describe, expect, it } from "vitest";
import { buildConversationRows, groupConversations } from "../../web/src/conv-groups.js";
import type { ConversationSummary } from "../../web/src/types.js";

const conv = (id: string, cwd: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
	id,
	title: id,
	cwd,
	messageCount: 1,
	isStreaming: false,
	isSubagent: false,
	...extra,
});

const A = "C:/proj/a";
const B = "C:/proj/b";

describe("groupConversations", () => {
	it("按 cwd 分组，当前项目排最前并标记 isCurrent", () => {
		const groups = groupConversations([conv("c1", A), conv("c2", B)], B, "c2");
		expect(groups.map((g) => g.cwd)).toEqual([B, A]);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("cwd 还没跟上、但 activeId 已在目标项目时，当前项目以 activeId 为准", () => {
		const groups = groupConversations([conv("c1", A), conv("c2", B)], A, "c2");
		expect(groups[0].cwd).toBe(B);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].cwd).toBe(A);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("只有一个项目时（切过去只有一条对话）也认 activeId", () => {
		const groups = groupConversations([conv("c9", A)], B, "c9");
		expect(groups).toHaveLength(1);
		expect(groups[0].isCurrent).toBe(true);
	});

	it("activeId 不在列表里（空白新对话）时只按 cwd 判定", () => {
		const groups = groupConversations([conv("c1", A), conv("c2", B)], A, "c-blank");
		expect(groups[0].cwd).toBe(A);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("子代理挂在父对话的项目下（即使自己 cwd 不同）", () => {
		const groups = groupConversations([conv("p", A), conv("s", B, { isSubagent: true, parentId: "p" })], B, "s");
		expect(groups).toHaveLength(1);
		expect(groups[0].cwd).toBe(A);
		expect(groups[0].convs.map((c) => c.id)).toEqual(["p", "s"]);
		expect(groups[0].isCurrent).toBe(true);
	});

	it("跨目录多级子代理跟随根对话，分组后仍能折叠整棵树", () => {
		const root = conv("root", A);
		const child = conv("child", B, { isSubagent: true, parentId: "root" });
		const grandchild = conv("grandchild", B, { isSubagent: true, parentId: "child", isStreaming: true });
		const leaf = conv("leaf", "C:/worktree", { isSubagent: true, parentId: "grandchild", hasQuestion: true });
		const groups = groupConversations([leaf, grandchild, child, root], B, "leaf");
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ cwd: A, isCurrent: true });
		const expanded = buildConversationRows(groups[0].convs);
		expect(expanded.map((row) => [row.c.id, row.depth])).toEqual([
			["root", 0],
			["child", 1],
			["grandchild", 2],
			["leaf", 3],
		]);
		const collapsed = buildConversationRows(groups[0].convs, new Set(["root"]));
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toMatchObject({ descendantCount: 3, hasStreaming: true, hasQuestion: true });
	});

	it("祖先缺失时跟随可找到的最高父节点，其他任务保持独立", () => {
		const groups = groupConversations(
			[
				conv("leaf", A, { isSubagent: true, parentId: "orphan" }),
				conv("orphan", B, { isSubagent: true, parentId: "missing" }),
				conv("unrelated", A),
			],
			A,
			"leaf",
		);
		expect(groups.map((group) => [group.cwd, group.convs.map((item) => item.id)])).toEqual([
			[B, ["leaf", "orphan"]],
			[A, ["unrelated"]],
		]);
	});

	it("循环父关系不会无限遍历，且分组不依赖列表顺序", () => {
		const a = conv("a", A, { isSubagent: true, parentId: "b" });
		const b = conv("b", B, { isSubagent: true, parentId: "a" });
		for (const list of [
			[a, b],
			[b, a],
		]) {
			const groups = groupConversations(list, B, "b");
			expect(groups).toHaveLength(1);
			expect(groups[0]).toMatchObject({ cwd: A, isCurrent: true });
			expect(buildConversationRows(groups[0].convs)).toHaveLength(2);
		}
	});

	it("空列表 → 空分组", () => {
		expect(groupConversations([], A, "")).toEqual([]);
	});
});

describe("buildConversationRows (issue #564 子代理树展开与折叠)", () => {
	it("保持输入的根对话顺序，常驻和运行标记不改变排位，子代理仍跟随父对话", () => {
		const running = conv("running", A, { isStreaming: true });
		const pinned = conv("pinned", A, { pinned: true });
		const child = conv("child", A, { isSubagent: true, parentId: "pinned" });
		const idle = conv("idle", A);
		const rows = buildConversationRows([running, idle, pinned, child]);

		expect(rows.map((row) => [row.c.id, row.depth])).toEqual([
			["running", 0],
			["idle", 0],
			["pinned", 0],
			["child", 1],
		]);
	});

	it("默认未折叠时展开全部子代理行，深度与父子关系正确", () => {
		const parent = conv("p1", A);
		const kid1 = conv("k1", A, { isSubagent: true, parentId: "p1" });
		const kid2 = conv("k2", A, { isSubagent: true, parentId: "p1" });
		const rows = buildConversationRows([parent, kid1, kid2]);

		expect(rows).toHaveLength(3);
		expect(rows[0].c.id).toBe("p1");
		expect(rows[0].depth).toBe(0);
		expect(rows[0].hasKids).toBe(true);
		expect(rows[0].isCollapsed).toBe(false);
		expect(rows[0].descendantCount).toBe(2);

		expect(rows[1].c.id).toBe("k1");
		expect(rows[1].depth).toBe(1);
		expect(rows[1].hasKids).toBe(false);

		expect(rows[2].c.id).toBe("k2");
		expect(rows[2].depth).toBe(1);
		expect(rows[2].hasKids).toBe(false);
	});

	it("父对话处于折叠状态时：隐藏子代理行，父行包含准确的计数与活跃状态", () => {
		const parent = conv("p1", A);
		const kid1 = conv("k1", A, { isSubagent: true, parentId: "p1", isStreaming: true });
		const kid2 = conv("k2", A, { isSubagent: true, parentId: "p1", hasQuestion: true });
		const kid3 = conv("k3", A, { isSubagent: true, parentId: "p1", error: "failed" });
		const standalone = conv("c2", A);

		const collapsed = new Set(["p1"]);
		const rows = buildConversationRows([parent, kid1, kid2, kid3, standalone], collapsed);

		expect(rows).toHaveLength(2);
		expect(rows[0].c.id).toBe("p1");
		expect(rows[0].hasKids).toBe(true);
		expect(rows[0].isCollapsed).toBe(true);
		expect(rows[0].descendantCount).toBe(3);
		expect(rows[0].hasStreaming).toBe(true);
		expect(rows[0].hasQuestion).toBe(true);
		expect(rows[0].hasError).toBe(true);

		expect(rows[1].c.id).toBe("c2");
		expect(rows[1].hasKids).toBe(false);
	});

	it("深层嵌套（孙代理）递归折叠：折叠父时整棵子树隐藏，计数包含多级后代", () => {
		const parent = conv("p1", A);
		const child = conv("c1", A, { isSubagent: true, parentId: "p1" });
		const grandChild = conv("g1", A, { isSubagent: true, parentId: "c1", isStreaming: true });

		const rowsRootCollapsed = buildConversationRows([parent, child, grandChild], new Set(["p1"]));
		expect(rowsRootCollapsed).toHaveLength(1);
		expect(rowsRootCollapsed[0].descendantCount).toBe(2);
		expect(rowsRootCollapsed[0].hasStreaming).toBe(true);

		const rowsChildCollapsed = buildConversationRows([parent, child, grandChild], new Set(["c1"]));
		expect(rowsChildCollapsed).toHaveLength(2);
		expect(rowsChildCollapsed[0].c.id).toBe("p1");
		expect(rowsChildCollapsed[0].isCollapsed).toBe(false);
		expect(rowsChildCollapsed[1].c.id).toBe("c1");
		expect(rowsChildCollapsed[1].isCollapsed).toBe(true);
		expect(rowsChildCollapsed[1].descendantCount).toBe(1);
		expect(rowsChildCollapsed[1].hasStreaming).toBe(true);
	});

	it("孤儿对话（parentId 指向不存在的会话）安全保底平铺在根层级", () => {
		const orphan = conv("orphan1", A, { isSubagent: true, parentId: "non-existent" });
		const normal = conv("normal1", A);
		const rows = buildConversationRows([orphan, normal]);

		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.c.id)).toEqual(["orphan1", "normal1"]);
		expect(rows.every((r) => r.depth === 0)).toBe(true);
	});
});
