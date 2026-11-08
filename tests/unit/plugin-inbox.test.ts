import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginInbox } from "../../server/plugin-inbox.js";

describe("PluginInbox（至少一次 + 幂等键）", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "plugin-inbox-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function makeInbox(over: Partial<ConstructorParameters<typeof PluginInbox>[0]> = {}): PluginInbox {
		return new PluginInbox({ dataDir: dir, pluginId: "qq", flushDelayMs: 0, now: () => 1_000, ...over });
	}

	it("首次 claim 是 new，完成后同一个 key 是 duplicate(done)", () => {
		const inbox = makeInbox();
		expect(inbox.claim("msg:1")).toMatchObject({ status: "new", attempts: 1 });
		inbox.complete("msg:1", { conversationId: "c1", runId: "r1" });
		expect(inbox.claim("msg:1")).toMatchObject({ status: "duplicate", reason: "done" });
		expect(inbox.snapshot()[0]).toMatchObject({ state: "done", conversationId: "c1", runId: "r1" });
	});

	it("处理中再 claim 判重（防并发双投），超过 stallMs 后允许重投并累加 attempts", () => {
		let now = 1_000;
		const inbox = makeInbox({ stallMs: 5_000, now: () => now });
		expect(inbox.claim("m1")).toMatchObject({ status: "new", attempts: 1 });
		expect(inbox.claim("m1")).toMatchObject({ status: "duplicate", reason: "in-flight" });
		now += 6_000;
		expect(inbox.claim("m1")).toMatchObject({ status: "new", attempts: 2 });
		expect(inbox.pending()).toHaveLength(0); // 刚被重新认领，仍在处理窗口内
	});

	it("失败会累加 attempts，到上限后变死信且不再重投", () => {
		let now = 1_000;
		const inbox = makeInbox({ stallMs: 1_000, maxAttempts: 2, now: () => now });
		inbox.claim("m1");
		inbox.fail("m1", new Error("boom"));
		now += 2_000;
		expect(inbox.claim("m1")).toMatchObject({ status: "new", attempts: 2 });
		inbox.fail("m1", "second failure");
		now += 2_000;
		expect(inbox.claim("m1")).toMatchObject({ status: "duplicate", reason: "dead", attempts: 2 });
		expect(inbox.dead()).toEqual([expect.objectContaining({ key: "m1", error: "second failure" })]);
	});

	it("跨重启恢复：新实例读同一文件，已完成的仍判重、卡住的出现在 pending", () => {
		const first = makeInbox({ stallMs: 1_000, now: () => 1_000 });
		first.claim("done-1");
		first.complete("done-1");
		first.claim("stuck-1");
		first.dispose();

		const second = makeInbox({ stallMs: 1_000, now: () => 10_000 });
		expect(second.claim("done-1")).toMatchObject({ status: "duplicate", reason: "done" });
		expect(second.pending().map((r) => r.key)).toEqual(["stuck-1"]);
		expect(second.claim("stuck-1")).toMatchObject({ status: "new", attempts: 2 });
	});

	it("落盘是原子写且有界：done 超过 keepMs 被裁剪，条数超过 maxEntries 丢最旧", () => {
		let now = 1_000_000;
		const inbox = makeInbox({ maxEntries: 16, keepMs: 1_000, now: () => now });
		for (let i = 0; i < 40; i++) {
			inbox.claim(`k${i}`);
			inbox.complete(`k${i}`);
			now += 10;
		}
		inbox.flush();
		expect(inbox.snapshot().length).toBeLessThanOrEqual(16);
		const file = join(dir, "plugin-inbox", "qq.json");
		expect(existsSync(file)).toBe(true);
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { v: number; records: unknown[] };
		expect(parsed.v).toBe(1);
		expect(parsed.records.length).toBeLessThanOrEqual(16);
		// 最新的 key 一定还在
		expect(inbox.snapshot().some((r) => r.key === "k39")).toBe(true);
	});

	it("空 key 永远放行（无法去重的入站事件宁可处理也不要丢）", () => {
		const inbox = makeInbox();
		expect(inbox.claim("")).toMatchObject({ status: "new" });
		expect(inbox.claim("")).toMatchObject({ status: "new" });
	});

	it("key 超长会被截断（避免账本被大 payload 撑爆）", () => {
		const inbox = makeInbox();
		const long = `x${"y".repeat(500)}`;
		inbox.claim(long);
		inbox.complete(long);
		expect(inbox.snapshot()[0]?.key.length).toBeLessThanOrEqual(200);
	});

	it("同一账号不同消息互不影响；不同插件各自一本账", () => {
		const qq = makeInbox();
		const wx = new PluginInbox({ dataDir: dir, pluginId: "wechat", flushDelayMs: 0 });
		qq.claim("m1");
		qq.complete("m1");
		expect(wx.claim("m1")).toMatchObject({ status: "new" });
		wx.dispose();
	});

	it("写盘失败不抛错、不丢内存记录（下次变更再试）", () => {
		const inbox = makeInbox();
		// 用一个必然失败的路径构造不可写账本
		const broken = new PluginInbox({
			dataDir: join(dir, "does-not-matter"),
			pluginId: "x",
			flushDelayMs: 0,
		});
		expect(() => {
			broken.claim("a");
			broken.complete("a");
			broken.dispose();
		}).not.toThrow();
		expect(() => inbox.dispose()).not.toThrow();
	});
});
