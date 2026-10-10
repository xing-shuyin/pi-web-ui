/**
 * 会话与消息 URL 深链纯逻辑单测（issue #587）。
 */
import { describe, expect, it } from "vitest";
import {
	buildSessionDeepLink,
	extractSessionIdFromPath,
	formatSessionHash,
	parseSessionHash,
	resolveMessageIdForJump,
} from "../../web/src/session-url.js";

describe("parseSessionHash & formatSessionHash (issue #587)", () => {
	it("解析 #s=<sessionId> 与可选的 &m=<messageId>", () => {
		expect(parseSessionHash("")).toBeNull();
		expect(parseSessionHash("#")).toBeNull();
		expect(parseSessionHash("#foo=bar")).toBeNull();
		expect(parseSessionHash("#s=   ")).toBeNull();
		expect(parseSessionHash("#s=01961f3a-1111-7222-8333-444455556666")).toEqual({
			sessionId: "01961f3a-1111-7222-8333-444455556666",
		});
		expect(parseSessionHash("#s=01961f3a-1111-7222-8333-444455556666&m=a-1712345678901-2")).toEqual({
			sessionId: "01961f3a-1111-7222-8333-444455556666",
			messageId: "a-1712345678901-2",
		});
		expect(parseSessionHash("s=sid-1&m=u-100-1")).toEqual({
			sessionId: "sid-1",
			messageId: "u-100-1",
		});
	});

	it("格式化会话与消息深链 hash", () => {
		expect(formatSessionHash(null)).toBe("");
		expect(formatSessionHash({ sessionId: "" })).toBe("");
		expect(formatSessionHash({ sessionId: "sid-123" })).toBe("#s=sid-123");
		expect(formatSessionHash({ sessionId: "sid-123", messageId: "a-1700000000-1" })).toBe(
			"#s=sid-123&m=a-1700000000-1",
		);
	});

	it("buildSessionDeepLink 生成完整链接并自动剥离 ?token= 防止凭据外泄", () => {
		expect(
			buildSessionDeepLink("https://host:8787/?token=secret123&foo=1#old", {
				sessionId: "sid-abc",
				messageId: "u-42-1",
			}),
		).toBe("https://host:8787/?foo=1#s=sid-abc&m=u-42-1");
	});
});

describe("extractSessionIdFromPath (issue #587)", () => {
	it("从 pi 转录路径（<timestamp>_<sessionId>.jsonl）与 DSH 路径提取 sessionId", () => {
		expect(
			extractSessionIdFromPath(
				"/home/user/.pi/agent/sessions/--proj--/2026-04-10T09-00-00-000Z_01961f3a-aaaa-7bbb-8ccc-ddddeeeeffff.jsonl",
			),
		).toBe("01961f3a-aaaa-7bbb-8ccc-ddddeeeeffff");
		expect(
			extractSessionIdFromPath("C:\\Users\\c\\.pi\\agent\\sessions\\--proj--\\2026-04-10_01961f3a-1234.jsonl"),
		).toBe("01961f3a-1234");
		expect(extractSessionIdFromPath("/data/sessions/dsh-sid-01/session.jsonl")).toBe("dsh-sid-01");
		expect(extractSessionIdFromPath("")).toBeNull();
		expect(extractSessionIdFromPath(null)).toBeNull();
	});
});

describe("resolveMessageIdForJump (issue #587)", () => {
	const messages = [{ id: "u-1700000001000-1" }, { id: "a-1700000002000-1" }, { id: "t-call_123" }];

	it("精确命中消息 id", () => {
		expect(resolveMessageIdForJump(messages, "a-1700000002000-1")).toBe("a-1700000002000-1");
		expect(resolveMessageIdForJump(messages, "t-call_123")).toBe("t-call_123");
	});

	it("会话从磁盘重载后 seq 变化时按 <role>-<timestamp>- 前缀回退匹配", () => {
		expect(resolveMessageIdForJump(messages, "a-1700000002000-9")).toBe("a-1700000002000-1");
	});

	it("消息不存在（如分支后已不在当前链上）时返回 null（保持在会话末尾）", () => {
		expect(resolveMessageIdForJump(messages, "a-9999999999999-1")).toBeNull();
		expect(resolveMessageIdForJump([], "u-1700000001000-1")).toBeNull();
	});
});
