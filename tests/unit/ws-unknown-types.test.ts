import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_UNKNOWN_WS_TYPES,
	UNKNOWN_WS_OVERFLOW_WARN_INTERVAL_MS,
	UNKNOWN_WS_WARN_INTERVAL_MS,
	recordUnknownWsType,
	resetUnknownWsTypes,
	unknownWsCounts,
	warnUnknownOverflow,
} from "../../server/ws-unknown-types.js";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	resetUnknownWsTypes();
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warnSpy.mockRestore();
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

	it("种类超限后仍有可观测性：按分钟节流打一条汇总 warn，带最近的未知类型（issue #980）", () => {
		const lines: string[] = [];
		warnSpy.mockImplementation((line: string) => lines.push(String(line)));
		for (let i = 0; i < MAX_UNKNOWN_WS_TYPES; i++) recordUnknownWsType(`t${i}`, 0);

		recordUnknownWsType("overflow-a", 1_000);
		recordUnknownWsType("overflow-b", 2_000);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(String(MAX_UNKNOWN_WS_TYPES));
		expect(lines[0]).toContain("overflow-a");

		// 过了节流窗才有下一条：累计丢弃数也跟着涨。
		recordUnknownWsType("overflow-c", 1_000 + UNKNOWN_WS_OVERFLOW_WARN_INTERVAL_MS);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("overflow-c");
	});

	it("warnUnknownOverflow 自己节流：同窗口内只打第一条", () => {
		const lines: string[] = [];
		const log = (line: string) => lines.push(line);
		warnUnknownOverflow("bogus", 1, 10_000, log);
		warnUnknownOverflow("bogus2", 2, 10_500, log);
		expect(lines).toHaveLength(1);
		warnUnknownOverflow("bogus3", 3, 10_000 + UNKNOWN_WS_OVERFLOW_WARN_INTERVAL_MS, log);
		expect(lines).toHaveLength(2);
	});
});
