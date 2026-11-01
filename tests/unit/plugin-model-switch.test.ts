/**
 * 无头路径的模型切换必须「失败即拒绝」（issue #226 的承诺）。
 *
 * 背景：ClientSession.setModel 为兼容 UI（面板要看到原因、调用方是
 * fire-and-forget，见 index.js 的 `void cs.setModel(...)`）把异常吞成 notice，
 * 永不 reject。于是 host.chat / 定时任务里 `try { await cs.setModel(m) } catch`
 * 的 catch 永不触发 —— 模型 ID 打错或没配密钥时，会静默按旧模型跑完整轮次。
 * switchModelOrThrow 用「复核当前模型」把这条路径变成响亮失败。
 */
import { describe, expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";

/** 伪造 this：只用到 setModel 与 session.model 两处。 */
function fakeCtx(setModel: (m: string) => Promise<void>, model: () => { provider: string; id: string } | null) {
	const ctx = {
		setModel,
		get session() {
			const m = model();
			if (!m) throw new Error("no active conversation");
			return { model: m };
		},
	};
	return ctx as unknown as ClientSession;
}

const call = (ctx: ClientSession, m: string) => ClientSession.prototype.switchModelOrThrow.call(ctx, m);

describe("switchModelOrThrow", () => {
	it("切换成功（当前模型已是目标）→ 正常返回", async () => {
		const ctx = fakeCtx(
			async () => {},
			() => ({ provider: "workbuddy-ai", id: "deepseek-v4.1-flash" }),
		);
		await expect(call(ctx, "workbuddy-ai/deepseek-v4.1-flash")).resolves.toBeUndefined();
	});

	it("setModel 静默失败（吞异常，模型没变）→ 抛错，不静默按旧模型跑", async () => {
		// 旧模型仍在：setModel 内部 catch 掉了错误，只有复核能发现。
		const ctx = fakeCtx(
			async () => {},
			() => ({ provider: "my-relay", id: "deepseek-v4-flash" }),
		);
		await expect(call(ctx, "workbuddy-ai/deepseek-v4.1-flash")).rejects.toThrow(/切换模型失败/);
		await expect(call(ctx, "workbuddy-ai/deepseek-v4.1-flash")).rejects.toThrow(/deepseek-v4-flash/);
	});

	it("setModel 显式抛错 → 原样冒出", async () => {
		const ctx = fakeCtx(
			async () => {
				throw new Error("模型不存在：nope/nope");
			},
			() => ({ provider: "a", id: "b" }),
		);
		await expect(call(ctx, "nope/nope")).rejects.toThrow(/模型不存在/);
	});

	it("读不到当前模型（无活跃对话）→ 不阻断投递", async () => {
		const ctx = fakeCtx(
			async () => {},
			() => null, // getter 抛 "no active conversation"
		);
		await expect(call(ctx, "a/b")).resolves.toBeUndefined();
	});

	it("setModel 被调过一次且顺序正确（先切后复核）", async () => {
		const order: string[] = [];
		const ctx = fakeCtx(
			async (m: string) => {
				order.push(`set:${m}`);
			},
			() => {
				order.push("read");
				return { provider: "x", id: "y" };
			},
		);
		await call(ctx, "x/y");
		expect(order).toEqual(["set:x/y", "read"]);
	});

	it("UI 路径的 setModel 仍然只发 notice、不抛（行为不变）", async () => {
		const emitted: unknown[] = [];
		const ctx = {
			runtime: {
				services: {
					modelRuntime: {
						getModel: () => {
							throw new Error("boom");
						},
					},
				},
			},
			emit: (m: unknown) => emitted.push(m),
			flushSnapshot: () => {},
			cwd: "/tmp",
		} as unknown as ClientSession;
		await expect(ClientSession.prototype.setModel.call(ctx, "a/b")).resolves.toBeUndefined();
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({ type: "notice", level: "error" });
	});
});
