// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_HOST_API_VERSION, createPluginHostApi } from "../../web/src/plugin-host";

function api(overrides: { bridgeWaitMs?: number } = {}) {
	return createPluginHostApi({
		send: () => true,
		isReady: () => true,
		setView: () => {},
		getCwd: () => "",
		getWorkspaceRoots: () => [],
		listSessions: () => [],
		getConversationId: () => null,
		isConversationBlank: () => true,
		bridgeWaitMs: overrides.bridgeWaitMs ?? 5,
	});
}

function installBridge(impl?: (req: unknown) => Promise<unknown>): unknown[] {
	const calls: unknown[] = [];
	(globalThis as unknown as Record<string, unknown>).__piBridge = {
		call: vi.fn(async (req: unknown) => {
			calls.push(req);
			if (impl) return await impl(req);
			return { title: "页面标题" };
		}),
	};
	return calls;
}

afterEach(() => {
	delete (globalThis as unknown as Record<string, unknown>).__piBridge;
	delete (globalThis as unknown as Record<string, unknown>).__piBrowser;
	delete (window as unknown as Record<string, unknown>).piDesktop;
});

describe("pageCall（模型 → 浏览器扩展）", () => {
	it("宿主 API 版本号跟着能力走（插件靠它判断有没有这个能力）", () => {
		expect(api().version).toBe(PLUGIN_HOST_API_VERSION);
		expect(PLUGIN_HOST_API_VERSION).toBeGreaterThanOrEqual(3);
	});

	it("没有桥 → 立刻给一句能照做的错（不等到天荒地老）", async () => {
		const res = await api({ bridgeWaitMs: 5 }).pageCall({ op: "read" });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toContain("page-picker");
			expect(res.error).toContain("刷新");
		}
	});

	it("桥在 → op / args / 目标 / 超时原样交过去，结果回传", async () => {
		const calls = installBridge();
		const res = await api().pageCall({
			op: "read",
			args: { what: "title" },
			target: "http://localhost:5173",
			timeoutMs: 8000,
		});
		expect(res).toEqual({ ok: true, result: { title: "页面标题" } });
		expect(calls[0]).toEqual({ op: "read", args: { what: "title" }, to: "http://localhost:5173", timeoutMs: 8000 });
	});

	it("省略可选参数时不带空字段（桥那边按 undefined 判断「用哪个页面」）", async () => {
		const calls = installBridge();
		await api().pageCall({ op: "pages" });
		expect(calls[0]).toEqual({ op: "pages" });
	});

	it("动作没返回值 → {ok:true}（不是 {ok:true, result:undefined} 让上层自己想）", async () => {
		installBridge(async () => undefined);
		expect(await api().pageCall({ op: "click", args: { selector: "#a" } })).toEqual({ ok: true });
	});

	it("桥抛错（页面没授权 / 动作失败）→ 原因原样回传，不抛给调用方", async () => {
		installBridge(async () => {
			throw new Error("页面（http://localhost:5173）没打开 —— 先把它开在一个标签页里");
		});
		const res = await api().pageCall({ op: "read" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("没打开");
	});

	it("原生桥在桌面壳优先路由并原样返回，不覆盖应用宿主对象", async () => {
		(window as unknown as Record<string, unknown>).piDesktop = { isDesktop: true };
		const calls = installBridge();
		const pageCall = vi.fn(async () => ({ ok: true, result: { title: "Native" } }));
		(globalThis as unknown as Record<string, unknown>).__piBrowser = { version: 1, pageCall };
		const req = { op: "read", args: { what: "title" }, target: "native-tab", timeoutMs: 8000 };
		expect(await api().pageCall(req)).toEqual({ ok: true, result: { title: "Native" } });
		expect(pageCall).toHaveBeenCalledWith(req);
		expect(calls).toEqual([]);
	});

	it("原生失败和异常不重试扩展，保留真实原因", async () => {
		const calls = installBridge();
		const pageCall = vi.fn(async () => ({ ok: false, error: "Native target closed" }));
		(globalThis as unknown as Record<string, unknown>).__piBrowser = { version: 1, pageCall };
		expect(await api().pageCall({ op: "read", target: "stale-tab" })).toEqual({
			ok: false,
			error: "Native target closed",
		});
		pageCall.mockRejectedValueOnce(new Error("Native disconnected"));
		expect(await api().pageCall({ op: "read" })).toEqual({ ok: false, error: "Native disconnected" });
		expect(calls).toEqual([]);
	});

	it("旧桌面壳无原生能力快速提示，不等待扩展桥", async () => {
		(window as unknown as Record<string, unknown>).piDesktop = { isDesktop: true };
		const calls = installBridge();
		expect(await api().pageCall({ op: "pages" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("Native browser bridge unavailable"),
		});
		expect(calls).toEqual([]);
	});

	it("不支持的原生桥版本在网页版保留扩展路径", async () => {
		const calls = installBridge();
		(globalThis as unknown as Record<string, unknown>).__piBrowser = { version: 2, pageCall: vi.fn() };
		expect(await api().pageCall({ op: "pages" })).toEqual({ ok: true, result: { title: "页面标题" } });
		expect(calls).toEqual([{ op: "pages" }]);
	});

	it("空 op → 直接拒（连桥都不去找）", async () => {
		const calls = installBridge();
		const res = await api().pageCall({ op: "   " });
		expect(res.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});
});
