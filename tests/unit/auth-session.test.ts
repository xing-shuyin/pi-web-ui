import { describe, expect, it } from "vitest";
import { createAuthSessionStore } from "../../server/auth-session.js";

describe("auth-session（issue #969 第二层）", () => {
	it("签发随机 sid 并支持校验与滑动续期", () => {
		const store = createAuthSessionStore({ ttlMs: 1_000 });
		const { sid, session } = store.create({ ip: "::ffff:127.0.0.1", userAgent: "TestBrowser/1.0" }, 10_000);
		expect(sid.length).toBeGreaterThanOrEqual(32);
		expect(session.id).not.toBe(sid);
		expect(session.ip).toBe("127.0.0.1");
		expect(session.expiresAt).toBe(11_000);

		const verified = store.verify(sid, 10_500);
		expect(verified?.lastSeen).toBe(10_500);
		expect(verified?.expiresAt).toBe(11_500);

		// 滑动续期后，原过期时间 11_000 之后依然有效，直到 11_500 才过期
		expect(store.verify(sid, 11_200)?.expiresAt).toBe(12_200);
		expect(store.verify(sid, 12_200)).toBeUndefined();
		expect(store.size(12_200)).toBe(0);
	});

	it("公开列表不泄露任何 sid 本体，且支持按 id 单设备吊销与全部下线", () => {
		const store = createAuthSessionStore({ ttlMs: 60_000 });
		const a = store.create({ ip: "10.0.0.1" }, 1_000);
		const b = store.create({ ip: "10.0.0.2" }, 2_000);

		const list = store.list(a.sid, 2_500);
		expect(list).toHaveLength(2);
		expect(list.find((item) => item.id === a.session.id)?.current).toBe(true);
		expect(list.find((item) => item.id === b.session.id)?.current).toBe(false);
		for (const item of list) {
			expect(JSON.stringify(item)).not.toContain(a.sid);
			expect(JSON.stringify(item)).not.toContain(b.sid);
		}

		const revokedB = store.revokeById(b.session.id);
		expect(revokedB).toEqual({ revoked: true, sid: b.sid });
		expect(store.verify(b.sid, 3_000)).toBeUndefined();
		expect(store.verify(a.sid, 3_000)).toBeDefined();

		const allRevoked = store.revokeAll();
		expect(allRevoked).toEqual([a.sid]);
		expect(store.verify(a.sid, 3_000)).toBeUndefined();
	});

	it("会话数有上限：满额时淘汰最久未活跃会话", () => {
		const store = createAuthSessionStore({ ttlMs: 60_000, maxSessions: 2 });
		const first = store.create({}, 1_000);
		const second = store.create({}, 2_000);
		store.verify(first.sid, 2_500); // first 变为更近活跃
		const third = store.create({}, 3_000);

		expect(store.size(3_000)).toBe(2);
		expect(store.verify(second.sid, 3_100)).toBeUndefined();
		expect(store.verify(first.sid, 3_100)).toBeDefined();
		expect(store.verify(third.sid, 3_100)).toBeDefined();
	});
});
