/** C2：异步分时片打开会话与 SDK SessionManager.open 结果一致，且解析期间让出事件循环。 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openSessionManagerAsync, parseJsonlSliced } from "../../server/session-open.js";

function pair(content: string): [string, string] {
	const dir = mkdtempSync(join(tmpdir(), "session-open-"));
	const a = join(dir, "a.jsonl");
	const b = join(dir, "b.jsonl");
	writeFileSync(a, content);
	writeFileSync(b, content);
	return [a, b];
}

function snapshot(m: SessionManager) {
	return {
		id: m.getSessionId(),
		cwd: m.getCwd(),
		leaf: m.getLeafId(),
		header: m.getHeader(),
		entries: m.getEntries(),
		branch: m.getBranch().map((e) => e.id),
	};
}

const header = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		type: "session",
		version: 3,
		id: "0191a07a-32d0-7208-b133-cf7870ab850e",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/proj/x",
		...extra,
	});
const msg = (id: string, parentId: string | null, role: string, text: string) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:01.000Z",
		message: { role, content: [{ type: "text", text }], timestamp: 1 },
	});

const cases: Record<string, string> = {
	normal: [header(), msg("a", null, "user", "hi"), msg("b", "a", "assistant", "yo"), ""].join("\n"),
	"no trailing newline": [header(), msg("a", null, "user", "hi"), msg("b", "a", "assistant", "yo")].join("\n"),
	"blank / malformed / falsy lines": [
		header(),
		"",
		"   ",
		"{bad json",
		"0",
		"false",
		"null",
		msg("a", null, "user", "hi"),
		"",
	].join("\n"),
	crlf: [header(), msg("a", null, "user", "hi"), msg("b", "a", "assistant", "x")].join("\r\n") + "\r\n",
	branches: [
		header(),
		msg("a", null, "user", "q"),
		msg("b", "a", "assistant", "old"),
		msg("c", "a", "assistant", "new"),
		msg("d", "c", "user", "next"),
		"",
	].join("\n"),
	"large lines": [
		header(),
		msg("a", null, "user", "x".repeat(200_000)),
		msg("b", "a", "assistant", "中文😀".repeat(5000)),
		"",
	].join("\n"),
};

describe("openSessionManagerAsync ≡ SessionManager.open", () => {
	for (const [name, content] of Object.entries(cases)) {
		it(name, async () => {
			const [a, b] = pair(content);
			const sync = SessionManager.open(a);
			const asyncM = await openSessionManagerAsync(b);
			expect(snapshot(asyncM)).toEqual(snapshot(sync));
			expect(asyncM.getSessionFile()).toBe(b);
			// 文件副作用一致（缺换行时补 "\n"）
			expect(readFileSync(b, "utf8")).toBe(readFileSync(a, "utf8"));
		});
	}

	it("合法会话走预解析构造路径，不回退 SessionManager.open", async () => {
		const [, b] = pair(cases.branches!);
		const spy = vi.spyOn(SessionManager, "open");
		try {
			await openSessionManagerAsync(b);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("新会话照常可追加（构造出的 manager 是可写的持久化会话）", async () => {
		const [, b] = pair(cases.normal!);
		const m = await openSessionManagerAsync(b);
		expect(m.isPersisted()).toBe(true);
		m.appendMessage({ role: "user", content: [{ type: "text", text: "appended" }], timestamp: 2 } as never);
		const reopened = SessionManager.open(b);
		expect(reopened.getEntries().length).toBe(m.getEntries().length);
	});

	it("非 pi 会话 / 空文件：回退 SDK 原路径（同样的报错或初始化语义）", async () => {
		const [a, b] = pair('{"type":"message","id":"x"}\n');
		expect(() => SessionManager.open(a)).toThrow();
		await expect(openSessionManagerAsync(b)).rejects.toThrow();
		const [c, d] = pair("");
		const sync = SessionManager.open(c);
		const asyncM = await openSessionManagerAsync(d);
		expect(asyncM.getEntries()).toEqual(sync.getEntries());
	});

	it("PI_WEB_ASYNC_SESSION_OPEN=0：直接走 SDK 原路径", async () => {
		const prev = process.env.PI_WEB_ASYNC_SESSION_OPEN;
		process.env.PI_WEB_ASYNC_SESSION_OPEN = "0";
		try {
			const [, b] = pair(cases.normal!);
			expect((await openSessionManagerAsync(b)).getEntries()).toHaveLength(2);
		} finally {
			if (prev === undefined) delete process.env.PI_WEB_ASYNC_SESSION_OPEN;
			else process.env.PI_WEB_ASYNC_SESSION_OPEN = prev;
		}
	});
});

describe("parseJsonlSliced", () => {
	it("解析期间让出事件循环（其它回调能在解析完成前运行）", async () => {
		const raw = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(200) })).join("\n");
		let ranDuringParse = false;
		let done = false;
		const probe = new Promise<void>((r) =>
			setImmediate(() => {
				ranDuringParse = !done;
				r();
			}),
		);
		const res = await parseJsonlSliced(raw, 0);
		done = true;
		await probe;
		expect(ranDuringParse).toBe(true);
		expect(res.entries).toHaveLength(5000);
		expect(res.tail).not.toBe("");
	});
});
