import { describe, expect, it } from "vitest";
import {
	decideKernelMode,
	probeKernel,
	toKernelState,
	type FetchLike,
	type KernelProbeResult,
} from "../../desktop/kernel-mode.js";
import { describeKernelState, formatUptime, kernelPersistenceHint } from "../../browser/kernel-view.js";

function fetchReturning(body: unknown, init: { ok?: boolean; status?: number } = {}): FetchLike {
	return async () => ({
		ok: init.ok ?? true,
		status: init.status ?? 200,
		json: async () => body,
	});
}

describe("decideKernelMode", () => {
	it("没配外部内核 → local", () => {
		expect(decideKernelMode({ externalUrl: "", probe: null })).toEqual({
			mode: "local",
			reason: "no-external-configured",
		});
		expect(decideKernelMode({ externalUrl: "   ", probe: null }).mode).toBe("local");
	});

	it("配了且可达 → external（这条就是“关掉壳内核还在跑”）", () => {
		expect(
			decideKernelMode({ externalUrl: "http://127.0.0.1:8787", probe: { reachable: true, version: "0.1.0" } }),
		).toEqual({ mode: "external", reason: "external-reachable" });
	});

	it("配了但不可达 → 回退 local，并保留原因", () => {
		const decision = decideKernelMode({
			externalUrl: "http://10.0.0.9:8787",
			probe: { reachable: false, error: "探测超时" },
		});
		expect(decision).toEqual({ mode: "local", reason: "external-unreachable" });
	});
});

describe("probeKernel", () => {
	it("ok:true 的 health → 可达，并带出版本/形态/托管者", async () => {
		const result = await probeKernel("http://127.0.0.1:8787/", {
			fetchImpl: fetchReturning({
				ok: true,
				kernel: {
					mode: "service",
					supervisor: "systemd",
					version: "0.121.3",
					installKind: "global-npm",
					uptimeMs: 9000,
				},
			}),
		});
		expect(result).toEqual({
			reachable: true,
			version: "0.121.3",
			installKind: "global-npm",
			supervisor: "systemd",
			uptimeMs: 9000,
		});
	});

	it("老版本内核没有 kernel 块也算可达（向后兼容）", async () => {
		const result = await probeKernel("http://x", { fetchImpl: fetchReturning({ ok: true }) });
		expect(result.reachable).toBe(true);
		expect(result.version).toBeUndefined();
		expect(result.supervisor).toBeNull();
	});

	it("非 2xx → 不可达（带回状态码）", async () => {
		const result = await probeKernel("http://x", {
			fetchImpl: fetchReturning({}, { ok: false, status: 502 }),
		});
		expect(result.reachable).toBe(false);
		expect(result.error).toBe("HTTP 502");
	});

	it("不是 pi-web-ui（ok 不为 true）→ 不可达", async () => {
		const result = await probeKernel("http://x", { fetchImpl: fetchReturning({ ok: "yes" }) });
		expect(result.reachable).toBe(false);
		expect(result.error).toContain("不是 pi-web-ui");
	});

	it("网络错误/超时 → 不可达且带原因，不抛", async () => {
		const boom: FetchLike = async () => {
			throw new Error("ECONNREFUSED");
		};
		expect((await probeKernel("http://x", { fetchImpl: boom })).error).toBe("ECONNREFUSED");
		const abort: FetchLike = async () => {
			const error = new Error("aborted");
			error.name = "AbortError";
			throw error;
		};
		expect((await probeKernel("http://x", { fetchImpl: abort })).error).toBe("探测超时");
	});

	it("空地址直接判不可达，不发请求", async () => {
		let called = false;
		const spy: FetchLike = async () => {
			called = true;
			return { ok: true, json: async () => ({}) };
		};
		const result = await probeKernel("  ", { fetchImpl: spy });
		expect(result.reachable).toBe(false);
		expect(called).toBe(false);
	});
});

describe("toKernelState / 文案", () => {
	const probe: KernelProbeResult = {
		reachable: true,
		version: "0.121.3",
		installKind: "global-npm",
		supervisor: "systemd",
		uptimeMs: 3 * 60 * 60 * 1000,
	};

	it("状态字段来自探测结果，且是纯投影", () => {
		const state = toKernelState({
			decision: { mode: "external", reason: "external-reachable" },
			url: "http://127.0.0.1:8787",
			probe,
		});
		expect(state).toMatchObject({ mode: "external", reachable: true, installKind: "global-npm", version: "0.121.3" });
		expect(describeKernelState(state)).toBe("v0.121.3 · 全局 npm 包 · systemd 托管 · 已运行 3 小时 0 分钟");
	});

	it("不可达时把错误显式说出来（不吞）", () => {
		const state = toKernelState({
			decision: { mode: "local", reason: "external-unreachable" },
			url: "http://127.0.0.1:8787",
			probe: { reachable: false, error: "探测超时" },
		});
		expect(state.reachable).toBe(false);
		expect(kernelPersistenceHint(state)).toContain("探测超时");
	});

	it("核心语义：托管 = 关掉壳还在跑；非托管 = 一起停", () => {
		const service = toKernelState({
			decision: { mode: "external", reason: "external-reachable" },
			url: "http://x",
			probe,
		});
		expect(kernelPersistenceHint(service)).toContain("关掉本窗口与浏览器");
		const local = toKernelState({
			decision: { mode: "local", reason: "no-external-configured" },
			url: "http://x",
			probe: { reachable: true },
		});
		expect(kernelPersistenceHint(local)).toContain("随本窗口退出而停止");
	});

	it("formatUptime 分级", () => {
		expect(formatUptime(30_000)).toBe("不到 1 分钟");
		expect(formatUptime(90_000)).toBe("1 分钟");
		expect(formatUptime(2 * 60 * 60 * 1000)).toBe("2 小时 0 分钟");
		expect(formatUptime(26 * 60 * 60 * 1000)).toBe("1 天 2 小时");
	});
});
