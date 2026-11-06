import { describe, expect, it, vi } from "vitest";
import {
	findBranchCandidates,
	selectBestSessionLeaf,
	type AnySessionEntry,
	type BranchCandidate,
	type LeafCalibrationResult,
} from "../../server/session-branch.js";

function parseEntryTimestamp(ts?: unknown): number {
	if (typeof ts === "string") {
		const parsed = Date.parse(ts);
		if (!Number.isNaN(parsed)) return parsed;
	} else if (typeof ts === "number" && !Number.isNaN(ts)) {
		return ts;
	}
	return 0;
}

function legacyFindBranchCandidates(entries: AnySessionEntry[]): BranchCandidate[] {
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
				const ts = parseEntryTimestamp(node.timestamp);
				if (ts > lastMessageTimestamp) {
					lastMessageTimestamp = ts;
				}
			}
		}

		const tailTimestamp = parseEntryTimestamp(leaf.timestamp);

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

function legacySelectBestSessionLeaf(
	entries: AnySessionEntry[],
	currentLeafId?: string | null,
): LeafCalibrationResult | null {
	const candidates = legacyFindBranchCandidates(entries);
	if (candidates.length === 0) return null;

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

function compare(entries: AnySessionEntry[]) {
	const expected = legacyFindBranchCandidates(entries);
	const actual = findBranchCandidates(entries);
	expect(actual).toEqual(expected);
	actual.forEach((candidate, i) => expect(candidate.leafEntry).toBe(expected[i].leafEntry));
	for (const current of [undefined, null, "missing", ...entries.filter(Boolean).map((e) => e.id)]) {
		expect(selectBestSessionLeaf(entries, current)).toEqual(legacySelectBestSessionLeaf(entries, current));
	}
}

describe("session branch timestamp cache", () => {
	it("preserves malformed graphs, duplicate objects/IDs, negative timestamps and stable ties", () => {
		const duplicate = { id: "same", type: "message", timestamp: "1960-01-01" };
		const fixtures: unknown[][] = [
			[],
			[null, {}, { id: "" }, { id: "header", type: "session" }],
			[duplicate, { ...duplicate, timestamp: "2026-01-01" }, duplicate],
			[
				{ id: "a", parentId: "b" },
				{ id: "b", parentId: "a" },
			],
			[
				{ id: "a", parentId: "b", type: "message", timestamp: -10 },
				{ id: "b", parentId: "a" },
				{ id: "leaf", parentId: "a" },
			],
			[
				{ id: "root", type: "message", timestamp: "1960-01-01" },
				{ id: "first", parentId: "root" },
				{ id: "second", parentId: "root" },
			],
			[
				{ id: "a", parentId: "missing", type: "message", timestamp: "invalid" },
				{ id: "b", type: "message", timestamp: 0 },
				{ id: "c", timestamp: NaN },
			],
		];
		fixtures.forEach((entries) => compare(entries as AnySessionEntry[]));
		const tied = findBranchCandidates(fixtures[5] as AnySessionEntry[]);
		expect(tied.map((c) => c.leafId)).toEqual(["first", "second"]);
		expect(tied[0].lastMessageTimestamp).toBe(0);
		let seed = 567;
		const random = (n: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % n;
		};
		const timestamps = [undefined, "invalid", "1960-01-01", "2026-01-01", -99, 0, NaN, Infinity];
		for (let trial = 0; trial < 120; trial++) {
			const entries = Array.from({ length: 18 }, () => ({
				id: ["", "a", "b", "c", "d", "e", "f"][random(7)],
				parentId: [null, "a", "b", "c", "d", "e", "missing"][random(7)],
				type: ["message", "custom", "session"][random(3)],
				timestamp: timestamps[random(timestamps.length)],
			})) as AnySessionEntry[];
			compare(entries);
		}
	});

	it("parses shared-chain nodes once per call and preserves paths and selection", () => {
		const depth = 600;
		const leaves = 80;
		const entries: AnySessionEntry[] = Array.from({ length: depth }, (_, i) => ({
			id: `m${i}`,
			parentId: i ? `m${i - 1}` : null,
			type: "message",
			timestamp: "2026-01-01",
		}));
		for (let i = 0; i < leaves; i++)
			entries.push({ id: `leaf${i}`, parentId: `m${depth - 1}`, type: "message", timestamp: "2026-01-02" });
		const parse = vi.spyOn(Date, "parse");
		try {
			const oldCandidates = legacyFindBranchCandidates(entries);
			expect(parse).toHaveBeenCalledTimes(leaves * (depth + 2));
			parse.mockClear();
			expect(findBranchCandidates(entries)).toEqual(oldCandidates);
			expect(parse).toHaveBeenCalledTimes(depth + leaves);
			parse.mockClear();
			const oldSelection = legacySelectBestSessionLeaf(entries, "leaf79");
			expect(parse).toHaveBeenCalledTimes(leaves * (depth + 2));
			parse.mockClear();
			expect(selectBestSessionLeaf(entries, "leaf79")).toEqual(oldSelection);
			expect(parse).toHaveBeenCalledTimes(depth + leaves);
		} finally {
			parse.mockRestore();
		}
		entries[0].timestamp = "2030-01-01";
		expect(findBranchCandidates(entries)).toEqual(legacyFindBranchCandidates(entries));
		expect(findBranchCandidates(entries)[0].lastMessageTimestamp).toBe(Date.parse("2030-01-01"));
	});
});
