import { describe, expect, it } from "vitest";
import { pickAdoptableOrphan, type OrphanCandidate } from "../../server/agent-service.js";

const cand = (over: Partial<OrphanCandidate> & { id: string }): OrphanCandidate => ({
	live: false,
	pseudo: false,
	streaming: 0,
	adoptable: true,
	activity: 1,
	...over,
});

describe("pickAdoptableOrphan", () => {
	it("空列表返回 null", () => {
		expect(pickAdoptableOrphan([])).toBeNull();
	});

	it("有别的在线浏览器时不认领（issue #10 隔离优先）", () => {
		const cands = [cand({ id: "old", streaming: 2, activity: 100 }), cand({ id: "new-tab", live: true })];
		expect(pickAdoptableOrphan(cands)).toBeNull();
	});

	it("伪客户端的常驻 sink 不算在线（不挡认领，也永远不被认领）", () => {
		const cands = [
			cand({ id: "old", streaming: 1, activity: 10 }),
			cand({ id: "plugin:wx:default", live: true, pseudo: true }),
			cand({ id: "scheduler:task1", live: false, pseudo: true, streaming: 5, activity: 999 }),
		];
		expect(pickAdoptableOrphan(cands)).toBe("old");
	});

	it("无在线时按 streaming 多优先", () => {
		const cands = [
			cand({ id: "idle-old", streaming: 0, activity: 999 }),
			cand({ id: "running-old", streaming: 1, activity: 1 }),
		];
		expect(pickAdoptableOrphan(cands)).toBe("running-old");
	});

	it("streaming 相同按最近活跃优先", () => {
		const cands = [cand({ id: "a", activity: 10 }), cand({ id: "b", activity: 20 })];
		expect(pickAdoptableOrphan(cands)).toBe("b");
	});

	it("纯空白残留（无内容）不认领", () => {
		expect(pickAdoptableOrphan([cand({ id: "blank", adoptable: false })])).toBeNull();
	});

	it("在线的残留不被选中（只看断开的）", () => {
		const cands = [cand({ id: "still-open", live: true, streaming: 3, activity: 50 })];
		expect(pickAdoptableOrphan(cands)).toBeNull();
	});
});
