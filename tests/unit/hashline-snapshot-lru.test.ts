import { describe, expect, it } from "vitest";
import { computeFileHash, HashlineSnapshotStore } from "../../server/hashline-engine.js";

describe("HashlineSnapshotStore LRU（audit fix #11）", () => {
	it("单文件快照超过 200 条时驱逐最旧一代", () => {
		const store = new HashlineSnapshotStore();
		const firstHash = store.record("/a.ts", "v0");
		for (let i = 1; i <= 200; i++) store.record("/a.ts", `v${i}`);
		expect(store.get("/a.ts", firstHash)).toBeUndefined();
		expect(store.get("/a.ts", computeFileHash("v200"))).toBe("v200");
	});

	it("get 命中刷新 LRU 序：正在使用的快照不被驱逐", () => {
		const store = new HashlineSnapshotStore();
		const keepHash = store.record("/a.ts", "keep");
		for (let i = 0; i < 199; i++) store.record("/a.ts", `filler-${i}`);
		expect(store.get("/a.ts", keepHash)).toBe("keep");
		store.record("/a.ts", "newest");
		expect(store.get("/a.ts", keepHash)).toBe("keep");
		expect(store.get("/a.ts", computeFileHash("filler-0"))).toBeUndefined();
		expect(store.get("/a.ts", computeFileHash("filler-1"))).toBe("filler-1");
	});

	it("不同文件的 LRU 相互独立", () => {
		const store = new HashlineSnapshotStore();
		store.record("/a.ts", "a-old");
		for (let i = 0; i < 200; i++) store.record("/b.ts", `b-${i}`);
		expect(store.get("/a.ts", computeFileHash("a-old"))).toBe("a-old");
	});

	it("同内容重复 record 不产生重复条目，也不驱逐他人", () => {
		const store = new HashlineSnapshotStore();
		store.record("/a.ts", "same");
		for (let i = 0; i < 199; i++) store.record("/a.ts", `f${i}`);
		store.record("/a.ts", "same");
		expect(store.get("/a.ts", computeFileHash("same"))).toBe("same");
	});
});
