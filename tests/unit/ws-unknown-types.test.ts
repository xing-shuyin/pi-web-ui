import { beforeEach, describe, expect, it } from "vitest";
import {
	MAX_UNKNOWN_WS_TYPES,
	UNKNOWN_WS_WARN_INTERVAL_MS,
	recordUnknownWsType,
	resetUnknownWsTypes,
	unknownWsCounts,
} from "../../server/ws-unknown-types.js";

beforeEach(() => {
	resetUnknownWsTypes();
});

describe("recordUnknownWsType", () => {
	it("首次 warn 并从 1 开始计数", () => {
		expect(recordUnknownWsType("bogus_type_xyz", 0)).toEqual({ count: 1, warn: true });
	});

	it("同 type 一分钟内只 warn 一次，但计数照加", () => {
		recordUnknownWsType("bogus_type_xyz", 0);
		expect(recordUnknownWsType("bogus_type_xyz", 1_000)).toEqual({ count: 2, warn: false });
		expect(recordUnknownWsType("bogus_type_xyz", UNKNOWN_WS_WARN_INTERVAL_MS)).toEqual({
			count: 3,
			warn: true,
		});
	});

	it("不同 type 各自计数、各自节流", () => {
		recordUnknownWsType("aaa", 0);
		expect(recordUnknownWsType("bbb", 0)).toEqual({ count: 1, warn: true });
		expect(unknownWsCounts().get("aaa")).toBe(1);
		expect(unknownWsCounts().get("bbb")).toBe(1);
	});

	it("返回快照拷贝：调用方改不动内部表", () => {
		recordUnknownWsType("aaa", 0);
		(unknownWsCounts() as Map<string, number>).set("hacked", 999);
		expect(unknownWsCounts().has("hacked")).toBe(false);
		expect(unknownWsCounts().get("aaa")).toBe(1);
	});

	it("种类超限后新 type 只进溢出计数，不建 key", () => {
		for (let i = 0; i < MAX_UNKNOWN_WS_TYPES; i++) recordUnknownWsType(`t${i}`, 0);
		expect(unknownWsCounts().size).toBe(MAX_UNKNOWN_WS_TYPES);
		const r = recordUnknownWsType("one-too-many", 0);
		expect(r.warn).toBe(false);
		expect(unknownWsCounts().size).toBe(MAX_UNKNOWN_WS_TYPES);
		expect(unknownWsCounts().has("one-too-many")).toBe(false);
		expect(recordUnknownWsType("t0", 0).count).toBe(2);
	});
});
