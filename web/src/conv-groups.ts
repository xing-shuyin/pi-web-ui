import type { ConversationSummary } from "./types";

interface ConvGroup {
	cwd: string;
	isCurrent: boolean;
	convs: ConversationSummary[];
}

export function groupConversations(
	list: ConversationSummary[],
	currentCwd: string,
	activeConversationId: string,
): ConvGroup[] {
	const byId = new Map(list.map((c) => [c.id, c]));
	const resolvedCwds = new Map<string, string>();
	const groupCwdOf = (c: ConversationSummary): string => {
		const path: ConversationSummary[] = [];
		const positions = new Map<string, number>();
		let current = c;
		let groupCwd: string;
		for (;;) {
			const cached = resolvedCwds.get(current.id);
			if (cached !== undefined) {
				groupCwd = cached;
				break;
			}
			const cycleStart = positions.get(current.id);
			if (cycleStart !== undefined) {
				const cycle = path.slice(cycleStart);
				const anchor = cycle.reduce((a, b) => (a.id < b.id ? a : b));
				groupCwd = anchor.cwd;
				break;
			}
			positions.set(current.id, path.length);
			path.push(current);
			const parent = current.parentId ? byId.get(current.parentId) : undefined;
			if (!parent) {
				groupCwd = current.cwd;
				break;
			}
			current = parent;
		}
		for (const ancestor of path) resolvedCwds.set(ancestor.id, groupCwd);
		return groupCwd;
	};
	const activeConv = list.find((c) => c.id === activeConversationId);
	const effectiveCwd = activeConv ? groupCwdOf(activeConv) : currentCwd;

	const byCwd = new Map<string, ConversationSummary[]>();
	for (const c of list) {
		const groupCwd = groupCwdOf(c);
		const arr = byCwd.get(groupCwd) ?? [];
		arr.push(c);
		byCwd.set(groupCwd, arr);
	}
	const groups: ConvGroup[] = [...byCwd.entries()].map(([cwd, convs]) => ({
		cwd,
		isCurrent: cwd === effectiveCwd,
		convs,
	}));
	groups.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
	return groups;
}

export interface ConvRowItem {
	c: ConversationSummary;
	depth: number;
	hasKids: boolean;
	isCollapsed: boolean;
	descendantCount: number;
	hasStreaming: boolean;
	hasError: boolean;
	hasQuestion: boolean;
}

export function buildConversationRows(
	convs: ConversationSummary[],
	collapsedParentIds: Set<string> = new Set(),
): ConvRowItem[] {
	const byId = new Map(convs.map((x) => [x.id, x]));
	const kids = new Map<string, ConversationSummary[]>();
	const roots: ConversationSummary[] = [];

	for (const x of convs) {
		if (x.parentId && byId.has(x.parentId)) {
			const arr = kids.get(x.parentId) ?? [];
			arr.push(x);
			kids.set(x.parentId, arr);
		} else {
			roots.push(x);
		}
	}

	const getDescendants = (id: string): ConversationSummary[] => {
		const res: ConversationSummary[] = [];
		const queue = [...(kids.get(id) ?? [])];
		const visited = new Set<string>();
		while (queue.length > 0) {
			const item = queue.shift()!;
			if (visited.has(item.id)) continue;
			visited.add(item.id);
			res.push(item);
			const sub = kids.get(item.id);
			if (sub) queue.push(...sub);
		}
		return res;
	};

	const rows: ConvRowItem[] = [];
	const seen = new Set<string>();
	const hidden = new Set<string>();

	const append = (c: ConversationSummary, depth: number) => {
		if (seen.has(c.id) || hidden.has(c.id)) return;
		seen.add(c.id);

		const myKids = kids.get(c.id) ?? [];
		const hasKids = myKids.length > 0;
		const isCollapsed = hasKids && collapsedParentIds.has(c.id);

		let descendantCount = 0;
		let hasStreaming = false;
		let hasError = false;
		let hasQuestion = false;

		if (hasKids) {
			const descendants = getDescendants(c.id);
			descendantCount = descendants.length;
			hasStreaming = descendants.some((d) => d.isStreaming);
			hasError = descendants.some((d) => Boolean(d.error));
			hasQuestion = descendants.some((d) => Boolean(d.hasQuestion));

			if (isCollapsed) {
				for (const d of descendants) {
					hidden.add(d.id);
				}
			}
		}

		rows.push({
			c,
			depth,
			hasKids,
			isCollapsed,
			descendantCount,
			hasStreaming,
			hasError,
			hasQuestion,
		});

		if (!isCollapsed) {
			for (const child of myKids) append(child, depth + 1);
		}
	};

	for (const root of roots) append(root, 0);
	for (const orphan of convs) append(orphan, 0);

	return rows;
}
