import { describe, expect, it } from "vitest";
import { normalizePathKey } from "../../server/client-state.js";
import { filterForkedParentSessions } from "../../server/session-parser.js";

type Info = { path: string; parentSessionPath?: string; tag?: number };

function legacyFilter<T extends Info>(infos: T[], showForkedParents = false): T[] {
	if (showForkedParents || infos.length <= 1) return infos;
	const byKey = new Map<string, T>();
	for (const info of infos) byKey.set(normalizePathKey(info.path), info);
	const childrenOf = new Map<string, Set<string>>();
	for (const info of infos) {
		if (typeof info.parentSessionPath !== "string" || !info.parentSessionPath) continue;
		const childKey = normalizePathKey(info.path);
		const parentKey = normalizePathKey(info.parentSessionPath);
		if (!parentKey || parentKey === childKey || !byKey.has(parentKey)) continue;
		let set = childrenOf.get(parentKey);
		if (!set) {
			set = new Set<string>();
			childrenOf.set(parentKey, set);
		}
		set.add(childKey);
	}
	if (childrenOf.size === 0) return infos;
	const canReachLeaf = new Set<string>();
	for (const key of byKey.keys()) {
		const children = childrenOf.get(key);
		if (!children || children.size === 0) canReachLeaf.add(key);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const [parentKey, children] of childrenOf.entries()) {
			if (canReachLeaf.has(parentKey)) continue;
			for (const childKey of children) {
				if (canReachLeaf.has(childKey)) {
					canReachLeaf.add(parentKey);
					changed = true;
					break;
				}
			}
		}
	}
	const kept = infos.filter((info) => {
		const key = normalizePathKey(info.path);
		const children = childrenOf.get(key);
		if (!children || children.size === 0) return true;
		return !canReachLeaf.has(key);
	});
	return kept.length > 0 ? kept : infos;
}

function check(infos: Info[], showForkedParents = false) {
	const before = infos.map((info) => ({ ...info }));
	const expected = legacyFilter(infos, showForkedParents);
	const actual = filterForkedParentSessions(infos, showForkedParents);
	expect(actual).toEqual(expected);
	expect(actual === infos).toBe(expected === infos);
	actual.forEach((info, index) => expect(info).toBe(expected[index]));
	expect(infos).toEqual(before);
}

describe("fork filter linear propagation", () => {
	it("matches the old algorithm for every directed graph on four nodes, in both edge orders", () => {
		const paths = ["/fork/a", "/fork/b", "/fork/c", "/fork/d"];
		const edges = paths.flatMap((parentSessionPath) =>
			paths.filter((path) => path !== parentSessionPath).map((path) => ({ path, parentSessionPath })),
		);
		for (let mask = 0; mask < 2 ** edges.length; mask++) {
			const selected = edges.filter((_, bit) => mask & (1 << bit));
			check([...paths.map((path) => ({ path })), ...selected]);
			check([...selected].reverse().concat(paths.map((path) => ({ path, parentSessionPath: path }))));
		}
	});

	it("preserves normalized aliases, repeated edges, self links, missing parents and record order", () => {
		const variants = ["C:\\Fork\\A.jsonl", "c:/fork/a.jsonl", "C:/FORK//A.jsonl"];
		for (const path of variants) {
			for (const parentSessionPath of variants) {
				const infos = [
					{ path, tag: 1 },
					{ path: "c:/fork/b.jsonl", parentSessionPath, tag: 2 },
					{ path: "C:\\FORK\\B.jsonl", parentSessionPath, tag: 3 },
					{ path: "c:/fork/b.jsonl", parentSessionPath: "c:/fork/b.jsonl", tag: 4 },
					{ path: "c:/fork/c.jsonl", parentSessionPath: "c:/missing.jsonl", tag: 5 },
				];
				check(infos);
				check(infos, true);
				expect(filterForkedParentSessions(infos).map((info) => info.tag)).toEqual([2, 3, 4, 5]);
			}
		}
	});

	it("preserves original-array return semantics, including cycles that keep all rows in a new array", () => {
		for (const infos of [
			[],
			[{ path: "/a", parentSessionPath: "/a" }],
			[{ path: "/a" }, { path: "/b", parentSessionPath: "/missing" }],
			[{ path: "/a", parentSessionPath: "/a" }, { path: "/b" }],
			[
				{ path: "/a", parentSessionPath: "/b" },
				{ path: "/b", parentSessionPath: "/a" },
			],
		]) {
			check(infos);
			check(infos, true);
		}
	});

	it("bounds Set.has calls linearly on adversarial long chains without leaking instrumentation", () => {
		const originalHas = Set.prototype.has;
		for (const size of [1024, 4096, 16384]) {
			const infos = Array.from({ length: size }, (_, index) => ({
				path: `/chain/${index}`,
				parentSessionPath: index ? `/chain/${index - 1}` : undefined,
			}));
			let calls = 0;
			let actual: Info[];
			try {
				Set.prototype.has = function <T>(this: Set<T>, value: T): boolean {
					calls++;
					return originalHas.call(this, value);
				};
				// No awaits or assertions while the global prototype is instrumented.
				actual = filterForkedParentSessions(infos);
			} finally {
				Set.prototype.has = originalHas;
			}
			expect(Set.prototype.has).toBe(originalHas);
			expect(actual).toEqual([infos[size - 1]]);
			expect(actual[0]).toBe(infos[size - 1]);
			expect(calls).toBeGreaterThan(0);
			expect(calls).toBeLessThanOrEqual(4 * size);
		}
	});
});
