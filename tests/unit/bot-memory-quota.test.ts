import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMemoryWriteQuota,
	MEMORY_WRITES_PER_SESSION,
	MEMORY_WRITES_PER_TURN,
} from "../../server/device-center/bot-memory-quota.js";
import { makeBotMemoryTool } from "../../server/bot-memory-tool.js";

/**
 * §7.2 的写入配额：每回合 ≤2、每会话 ≤20。
 * 规则必须在服务端执行——Bot 不能靠提示词或参数放宽，否则一个"整理记忆"的回合就能把索引刷满。
 */

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("记忆写入配额", () => {
	it("每回合两条，超了给可操作的拒绝原因；写被拒时不吃配额", () => {
		const quota = createMemoryWriteQuota();
		expect(quota.consume()).toEqual({ ok: true });
		expect(quota.consume()).toEqual({ ok: true });
		const denied = quota.consume();
		expect(denied.ok).toBe(false);
		expect(denied.ok === false && denied.reason).toMatch(/At most 2 memory writes per turn/);
		quota.beginTurn();
		expect(quota.snapshot()).toEqual({ turn: 0, session: 2 });
		expect(quota.consume()).toEqual({ ok: true });
	});

	it("每会话上限独立于回合：换回合也补不回来", () => {
		const quota = createMemoryWriteQuota({ perTurn: 5, perSession: 3 });
		for (let i = 0; i < 3; i++) expect(quota.consume()).toEqual({ ok: true });
		quota.beginTurn();
		const denied = quota.consume();
		expect(denied.ok).toBe(false);
		expect(denied.ok === false && denied.reason).toMatch(/already wrote 3 memories/);
	});

	it("默认上限就是设计值（2 / 20）", () => {
		expect(MEMORY_WRITES_PER_TURN).toBe(2);
		expect(MEMORY_WRITES_PER_SESSION).toBe(20);
	});

	it("release 归还已申请的额度，且不会退成负数", () => {
		const quota = createMemoryWriteQuota();
		expect(quota.consume()).toEqual({ ok: true });
		quota.release();
		expect(quota.snapshot()).toEqual({ turn: 0, session: 0 });
		quota.release();
		expect(quota.snapshot()).toEqual({ turn: 0, session: 0 });
	});
});

describe("memory 工具执行配额", () => {
	type ToolResult = { details: Record<string, unknown> };
	const runTool = (tool: ReturnType<typeof makeBotMemoryTool>, params: unknown) =>
		(tool.execute as unknown as (id: string, params: unknown) => Promise<ToolResult>)("call", params);

	function toolAt() {
		const root = mkdtempSync(join(tmpdir(), "bot-memory-quota-"));
		roots.push(root);
		const quota = createMemoryWriteQuota();
		const tool = makeBotMemoryTool({ root, botId: "bot-quota", quota });
		const write = (text: string) => runTool(tool, { op: "write", scope: "env", text });
		return { tool, quota, write };
	}

	it("第三写入被服务端拒绝，且不会落盘", async () => {
		const { tool, quota, write } = toolAt();
		await write("项目用 pnpm 而不是 npm");
		await write("测试端口从 8900 起");
		await expect(write("第三条应该被配额拦住")).rejects.toThrow(/At most 2 memory writes per turn/);
		quota.beginTurn();
		await expect(write("换一回合之后可以继续写")).resolves.toBeTruthy();
		const read = await runTool(tool, { op: "list" });
		expect(JSON.stringify(read.details)).toContain("env");
	});

	it("校验失败的写入不吃配额：改对参数后同一回合仍能写满两条", async () => {
		const { tool, quota, write } = toolAt();
		// 真实现场：模型先拿非法 scope（user）和非法 confidence（confirmed）各试一次，
		// 两次都被拒却把 2 条的回合额度吃掉了，于是整轮再也写不进任何记忆。
		await expect(runTool(tool, { op: "write", scope: "user", text: "职责定位" })).rejects.toThrow(
			/Unknown scope family/,
		);
		await expect(
			runTool(tool, {
				op: "write",
				scope: "user-pref",
				text: "职责定位",
				confidence: "confirmed",
			}),
		).rejects.toThrow(/Only user-confirmed facts/);
		expect(quota.snapshot()).toEqual({ turn: 0, session: 0 });
		await write("第一条可以落盘");
		await write("第二条也能落盘");
		await expect(write("第三条才应该被配额拦住")).rejects.toThrow(/At most 2 memory writes per turn/);
		expect(quota.snapshot()).toEqual({ turn: 2, session: 2 });
	});

	it("会话上限：换回合也不能绕过", async () => {
		const root = mkdtempSync(join(tmpdir(), "bot-memory-quota-"));
		roots.push(root);
		const quota = createMemoryWriteQuota({ perTurn: 5, perSession: 2 });
		const tool = makeBotMemoryTool({ root, botId: "bot-quota", quota });
		const write = (text: string) => runTool(tool, { op: "write", scope: "env", text });
		await write("第一条");
		await write("第二条");
		quota.beginTurn();
		await expect(write("第三条会撞会话上限")).rejects.toThrow(/already wrote 2 memories/);
	});
});
