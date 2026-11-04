// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { readCachedSessions, sessionsStorageKey, clearCachedSession } from "../../web/src/use-chat.js";

describe("sessionsStorageKey and readCachedSessions (#439)", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("sessionsStorageKey 根据 cwd 区分不同的 localStorage key", () => {
		const keyA = sessionsStorageKey("/proj/a");
		const keyB = sessionsStorageKey("/proj/b");
		expect(keyA).not.toBe(keyB);
		expect(keyA).toContain("/proj/a");
	});

	it("readCachedSessions 根据指定 cwd 返回隔离的会话列表", () => {
		const keyA = sessionsStorageKey("/proj/a");
		const keyB = sessionsStorageKey("/proj/b");

		const sessA = [{ path: "/proj/a/s1.jsonl", name: "sa", firstMessage: "m1", messageCount: 1, modified: 1 }];
		const sessB = [{ path: "/proj/b/s2.jsonl", name: "sb", firstMessage: "m2", messageCount: 1, modified: 2 }];

		localStorage.setItem(keyA, JSON.stringify(sessA));
		localStorage.setItem(keyB, JSON.stringify(sessB));

		expect(readCachedSessions("/proj/a")).toEqual(sessA);
		expect(readCachedSessions("/proj/b")).toEqual(sessB);
		expect(readCachedSessions("/proj/non-existent")).toEqual([]);
	});

	it("clearCachedSession 只清除对应 cwd 下的缓存", () => {
		const keyA = sessionsStorageKey("/proj/a");
		const sessA = [
			{ path: "/proj/a/s1.jsonl", name: "sa1", firstMessage: "m1", messageCount: 1, modified: 1 },
			{ path: "/proj/a/s2.jsonl", name: "sa2", firstMessage: "m2", messageCount: 1, modified: 2 },
		];
		localStorage.setItem(keyA, JSON.stringify(sessA));

		clearCachedSession("/proj/a/s1.jsonl", "/proj/a");
		const updated = readCachedSessions("/proj/a");
		expect(updated).toHaveLength(1);
		expect(updated[0].path).toBe("/proj/a/s2.jsonl");
	});

	it("readCachedSessions 在未指定 engine 或跨 engine 时支持智能降级命中", () => {
		// 模拟某项目在 "pi" 引擎下存入了会话
		const keyPi = sessionsStorageKey("/proj/c", "pi");
		const sessC = [{ path: "/proj/c/s1.jsonl", name: "sc", firstMessage: "hello", messageCount: 1, modified: 1 }];
		localStorage.setItem(keyPi, JSON.stringify(sessC));

		// 调用时不传 engine 或传不同 engine，依然能通过降级命中
		expect(readCachedSessions("/proj/c")).toEqual(sessC);
		expect(readCachedSessions("/proj/c", "default")).toEqual(sessC);
	});
});
