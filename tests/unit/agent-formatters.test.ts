import { describe, expect, it } from "vitest";
import { getMaxOpenConversations, MAX_OPEN_CONVERSATIONS } from "../../server/agent-formatters.js";

describe("getMaxOpenConversations", () => {
	it("默认上限是一个有限的真实值（issue #944：曾为 Infinity，使 LRU 淘汰成为死代码）", () => {
		const prev = process.env.PI_WEB_MAX_OPEN_CONVERSATIONS;
		try {
			delete process.env.PI_WEB_MAX_OPEN_CONVERSATIONS;
			expect(getMaxOpenConversations()).toBe(MAX_OPEN_CONVERSATIONS);
			// issue #944：默认值必须有限，否则 `makeRoomForConversation` 的淘汰分支永远是死代码。
			expect(Number.isFinite(MAX_OPEN_CONVERSATIONS)).toBe(true);
			expect(MAX_OPEN_CONVERSATIONS).toBeGreaterThanOrEqual(4);

			process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = "32";
			expect(getMaxOpenConversations()).toBe(32);

			// 非法 / 非正值回退到默认值（不再回退到「无限」）。
			for (const raw of ["", "0", "-3", "invalid", "Infinity"]) {
				process.env.PI_WEB_MAX_OPEN_CONVERSATIONS = raw;
				expect(getMaxOpenConversations()).toBe(MAX_OPEN_CONVERSATIONS);
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
