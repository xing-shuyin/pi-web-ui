import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type AnySessionEntry =
	| SessionEntry
	| {
			id?: string;
			parentId?: string | null;
			type?: string;
			timestamp?: string;
			customType?: string;
			[key: string]: unknown;
	  };

export interface BranchCandidate {
	leafId: string;
	leafEntry: AnySessionEntry;
	totalEntries: number;
	messageCount: number;
	lastMessageTimestamp: number;
	tailTimestamp: number;
	pathIds: string[];
}

export interface LeafCalibrationResult {
	bestLeafId: string;
	currentLeafId: string | null;
	changed: boolean;
	reason?: string;
}

function parseEntryTimestamp(ts?: unknown): number {
	if (typeof ts === "string") {
		const parsed = Date.parse(ts);
		if (!Number.isNaN(parsed)) return parsed;
	} else if (typeof ts === "number" && !Number.isNaN(ts)) {
		return ts;
	}
	return 0;
}

export function findBranchCandidates(entries: AnySessionEntry[]): BranchCandidate[] {
	const validEntries: AnySessionEntry[] = [];
	const byId = new Map<string, AnySessionEntry>();
	const childCount = new Map<string, number>();

	for (const entry of entries) {
		if (!entry || typeof entry.id !== "string" || !entry.id) continue;
		if (entry.type === "session") continue;
		validEntries.push(entry);
		byId.set(entry.id, entry);
	}

	for (const entry of validEntries) {
		const pid = typeof entry.parentId === "string" ? entry.parentId : null;
		if (pid && byId.has(pid)) {
			childCount.set(pid, (childCount.get(pid) ?? 0) + 1);
		}
	}

	const leaves: AnySessionEntry[] = [];
	for (const entry of validEntries) {
		const id = entry.id as string;
		if ((childCount.get(id) ?? 0) === 0) {
			leaves.push(entry);
		}
	}

	if (leaves.length === 0) return [];

	const candidates: BranchCandidate[] = [];
	const timestamps = new WeakMap<AnySessionEntry, number>();
	const timestampOf = (entry: AnySessionEntry): number => {
		const cached = timestamps.get(entry);
		if (cached !== undefined) return cached;
		const timestamp = parseEntryTimestamp(entry.timestamp);
		timestamps.set(entry, timestamp);
		return timestamp;
	};

	for (const leaf of leaves) {
		const leafId = leaf.id as string;
		const path: AnySessionEntry[] = [];
		const visited = new Set<string>();
		let cur: string | null = leafId;

		while (cur !== null && byId.has(cur) && !visited.has(cur)) {
			visited.add(cur);
			const node: AnySessionEntry = byId.get(cur)!;
			path.push(node);
			cur = typeof node.parentId === "string" ? node.parentId : null;
		}

		path.reverse();

		let messageCount = 0;
		let lastMessageTimestamp = 0;

		for (const node of path) {
			if (node.type === "message") {
				messageCount += 1;
				const ts = timestampOf(node);
				if (ts > lastMessageTimestamp) {
					lastMessageTimestamp = ts;
				}
			}
		}

		const tailTimestamp = timestampOf(leaf);

		candidates.push({
			leafId,
			leafEntry: leaf,
			totalEntries: path.length,
			messageCount,
			lastMessageTimestamp,
			tailTimestamp,
			pathIds: path.map((n) => n.id as string),
		});
	}

	return candidates;
}

function findLowestCommonAncestor(branchA: BranchCandidate, branchB: BranchCandidate): string | null {
	const setA = new Set(branchA.pathIds);
	let lca: string | null = null;
	for (const id of branchB.pathIds) {
		if (setA.has(id)) {
			lca = id;
		} else {
			break;
		}
	}
	return lca;
}

export function selectBestSessionLeaf(
	entries: AnySessionEntry[],
	currentLeafId?: string | null,
): LeafCalibrationResult | null {
	let candidates = findBranchCandidates(entries);
	if (candidates.length === 0) return null;

	const reask = [...entries]
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === "pi-web-ui:reask");
	if (reask?.id) {
		const selected = candidates.filter((candidate) => candidate.pathIds.includes(reask.id!));
		if (selected.length > 0) candidates = selected;
	}

	if (candidates.length === 1) {
		const single = candidates[0];
		return {
			bestLeafId: single.leafId,
			currentLeafId: currentLeafId ?? null,
			changed: currentLeafId !== undefined && currentLeafId !== null && currentLeafId !== single.leafId,
		};
	}

	const sorted = [...candidates].sort((a, b) => {
		if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
		if (b.lastMessageTimestamp !== a.lastMessageTimestamp) return b.lastMessageTimestamp - a.lastMessageTimestamp;
		if (b.totalEntries !== a.totalEntries) return b.totalEntries - a.totalEntries;
		return b.tailTimestamp - a.tailTimestamp;
	});

	const bestCandidate = sorted[0];

	if (!currentLeafId) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId: null,
			changed: true,
			reason: "No current leaf specified; selected deepest candidate",
		};
	}

	const currentCandidate = candidates.find((c) => c.leafId === currentLeafId);
	if (!currentCandidate) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId,
			changed: true,
			reason: `Current leaf "${currentLeafId}" not found in branch leaves`,
		};
	}

	if (currentCandidate.leafId === bestCandidate.leafId) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId,
			changed: false,
		};
	}

	const lca = findLowestCommonAncestor(currentCandidate, bestCandidate);
	const lcaIndexCurrent = lca ? currentCandidate.pathIds.indexOf(lca) : -1;
	const currentEntriesAfterLca = lcaIndexCurrent >= 0 ? currentCandidate.pathIds.slice(lcaIndexCurrent + 1) : [];

	const byId = new Map<string, AnySessionEntry>();
	for (const e of entries) {
		if (e && typeof e.id === "string") byId.set(e.id, e);
	}

	let currentMessagesAfterLca = 0;
	for (const id of currentEntriesAfterLca) {
		const node = byId.get(id);
		if (node?.type === "message") currentMessagesAfterLca += 1;
	}

	const lcaIndexBest = lca ? bestCandidate.pathIds.indexOf(lca) : -1;
	const bestEntriesAfterLca = lcaIndexBest >= 0 ? bestCandidate.pathIds.slice(lcaIndexBest + 1) : [];
	let bestMessagesAfterLca = 0;
	for (const id of bestEntriesAfterLca) {
		const node = byId.get(id);
		if (node?.type === "message") bestMessagesAfterLca += 1;
	}

	if (currentMessagesAfterLca === 0 && bestMessagesAfterLca > 0) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId,
			changed: true,
			reason: `Current branch has no messages after divergence (LCA=${lca}), while main branch has ${bestMessagesAfterLca} messages`,
		};
	}

	if (bestCandidate.messageCount > currentCandidate.messageCount) {
		return {
			bestLeafId: bestCandidate.leafId,
			currentLeafId,
			changed: true,
			reason: `Main branch has ${bestCandidate.messageCount} messages vs current branch's ${currentCandidate.messageCount}`,
		};
	}

	return {
		bestLeafId: currentCandidate.leafId,
		currentLeafId,
		changed: false,
	};
}

export function calibrateSessionLeaf(sessionManager: {
	getEntries(): AnySessionEntry[];
	getLeafId(): string | null;
	branch(id: string): void;
}): { changed: boolean; calibratedLeafId?: string; previousLeafId?: string | null; reason?: string } {
	try {
		const entries = sessionManager.getEntries();
		const currentLeafId = sessionManager.getLeafId();
		const result = selectBestSessionLeaf(entries, currentLeafId);
		if (result && result.changed && result.bestLeafId) {
			sessionManager.branch(result.bestLeafId);
			return {
				changed: true,
				calibratedLeafId: result.bestLeafId,
				previousLeafId: currentLeafId,
				reason: result.reason,
			};
		}
		return { changed: false, calibratedLeafId: currentLeafId ?? undefined };
	} catch (err) {
		return { changed: false, calibratedLeafId: sessionManager.getLeafId() ?? undefined, reason: String(err) };
	}
}

export function reorderEntriesForMainBranch<T extends AnySessionEntry>(
	entries: T[],
): { entries: T[]; changed: boolean; reason?: string } {
	if (entries.length <= 1) return { entries, changed: false };

	const nonHeader = entries.filter((e) => e && e.type !== "session" && typeof e.id === "string");
	if (nonHeader.length <= 1) return { entries, changed: false };

	const tail = nonHeader[nonHeader.length - 1];
	const calibration = selectBestSessionLeaf(nonHeader, tail.id);
	if (!calibration || !calibration.changed || !calibration.bestLeafId) {
		return { entries, changed: false };
	}

	const bestLeafId = calibration.bestLeafId;
	const candidates = findBranchCandidates(nonHeader);
	const bestCandidate = candidates.find((c) => c.leafId === bestLeafId);
	if (!bestCandidate) return { entries, changed: false };

	const bestPathSet = new Set(bestCandidate.pathIds);

	const headerEntries: T[] = [];
	const sideEntries: T[] = [];
	const mainEntries: T[] = [];

	for (const e of entries) {
		if (e.type === "session") {
			headerEntries.push(e);
		} else if (e.id && bestPathSet.has(e.id)) {
			mainEntries.push(e);
		} else {
			sideEntries.push(e);
		}
	}

	if (sideEntries.length === 0 || mainEntries.length === 0) {
		return { entries, changed: false };
	}

	const result: T[] = [...headerEntries];
	const placedIds = new Set<string>();
	const placedRefs = new Set<T>(headerEntries);

	const sideChildrenOf = new Map<string, T[]>();
	for (const s of sideEntries) {
		const pid = typeof s.parentId === "string" ? s.parentId : "";
		if (!pid) continue;
		let list = sideChildrenOf.get(pid);
		if (!list) {
			list = [];
			sideChildrenOf.set(pid, list);
		}
		list.push(s);
	}

	const canPlace = (entry: T): boolean => {
		if (placedRefs.has(entry)) return false;
		if (typeof entry.id === "string" && entry.id && placedIds.has(entry.id)) return false;
		return true;
	};

	const markPlaced = (entry: T) => {
		placedRefs.add(entry);
		if (typeof entry.id === "string" && entry.id) {
			placedIds.add(entry.id);
		}
	};

	const placeSideDescendants = (parentId: string) => {
		const children = sideChildrenOf.get(parentId);
		if (!children) return;
		for (const child of children) {
			if (canPlace(child)) {
				markPlaced(child);
				result.push(child);
				if (typeof child.id === "string" && child.id) {
					placeSideDescendants(child.id);
				}
			}
		}
	};

	for (const m of mainEntries) {
		markPlaced(m);
		result.push(m);
		if (typeof m.id === "string" && m.id) {
			placeSideDescendants(m.id);
		}
	}

	for (const s of sideEntries) {
		if (!placedRefs.has(s)) {
			markPlaced(s);
			if (result.length > headerEntries.length + 1) {
				result.splice(result.length - 1, 0, s);
			} else {
				result.push(s);
			}
		}
	}

	if (result.length !== entries.length) {
		return { entries, changed: false };
	}
	const newNonHeader = result.filter((e) => e && e.type !== "session" && typeof e.id === "string");
	const newTail = newNonHeader[newNonHeader.length - 1];
	const successfullyReordered = newTail?.id === bestLeafId;

	if (!successfullyReordered) {
		return { entries, changed: false };
	}

	return {
		entries: result,
		changed: true,
		reason: calibration.reason,
	};
}
