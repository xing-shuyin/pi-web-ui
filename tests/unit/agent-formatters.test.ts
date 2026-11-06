import { describe, expect, it } from "vitest";
import { getMaxOpenConversations, MAX_OPEN_CONVERSATIONS } from "../../server/agent-formatters.js";

describe("getMaxOpenConversations", () => {
	it("默认不限驻留对话数量，仅有限正数配置启用上限", () => {
		const prev = process.env.PI_WEB_MAX_OPEN_CONVERSATIONS;
		try {
			delete process.env.PI_WEB_MAX_OPEN_CONVERSATIONS;
			expect(getMaxOpenConversations()).toBe(MAX_OPEN_CONVERSATIONS);
			expect(getMaxOpenConversations()).toBe(Number.POSITIVE_INFINITY);

			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "32";
			expect(getMaxOpenConversations()).toBe(32);

			for (const raw of ["", "0", "-3", "invalid", "Infinity"]) {
				process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = raw;
				expect(getMaxOpenConversations()).toBe(Number.POSITIVE_INFINITY);
			}

			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "2.7";
			expect(getMaxOpenConversations()).toBe(2);

			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "0.5";
			expect(getMaxOpenConversations()).toBe(1);
		} finally {
			if (prev === undefined) delete process.env.PI_WEB_MAX_OPEN_CONVERSATIONS;
			else process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = prev;
		}
	});
});
