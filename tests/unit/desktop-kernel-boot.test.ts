import { describe, expect, it } from "vitest";
import { planKernelBoot, resolveKernelServiceFirst, type KernelBootFacts } from "../../desktop/kernel-mode.js";

/**
 * 启动决策：壳到底要不要自己拉进程。
 *
 * 这条不变量是「真解绑」的核心——打包版默认把内核交给系统托管，壳只做客户端；
 * 只有开发/冒烟、Linux（无 TTY）与离线兜底才允许壳自己 spawn 一份临时内核。
 */
function facts(over: Partial<KernelBootFacts> = {}): KernelBootFacts {
	return {
		configuredUrl: null,
		configuredProbe: null,
		adoptedUrl: null,
		defaultPortUrl: null,
		serviceFirst: true,
		platform: "win32",
		serviceInstalled: "absent",
		globalKernelAvailable: true,
		node: { found: true, ok: true },
		ephemeralKernelAvailable: true,
		...over,
	};
}

describe("planKernelBoot：先找活内核，只连不拉", () => {
	it("设置里配的内核可达 → 连它（哪怕本机也能装服务）", () => {
		expect(
			planKernelBoot(
				facts({
					configuredUrl: "http://127.0.0.1:8787",
					configuredProbe: { reachable: true, version: "0.121.3" },
				}),
			),
		).toEqual({ kind: "connect", url: "http://127.0.0.1:8787", reason: "configured" });
	});

	it("数据目录锁里有活内核（系统服务）→ 直接连，不重复装", () => {
		expect(planKernelBoot(facts({ adoptedUrl: "http://127.0.0.1:8790" }))).toEqual({
			kind: "connect",
			url: "http://127.0.0.1:8790",
			reason: "adopted",
		});
	});

	it("配置的内核不可达时不挡路：默认端口上若有内核就连它", () => {
		expect(
			planKernelBoot(
				facts({
					configuredUrl: "http://10.0.0.9:8787",
					configuredProbe: { reachable: false, error: "探测超时" },
					defaultPortUrl: "http://127.0.0.1:8790",
				}),
			),
		).toEqual({ kind: "connect", url: "http://127.0.0.1:8790", reason: "default-port" });
	});
});

describe("planKernelBoot：打包版服务优先（壳不拉 sidecar）", () => {
	it("有全局包内核、没服务 → 装成系统服务", () => {
		expect(planKernelBoot(facts())).toEqual({
			kind: "provision-service",
			action: "install",
			reason: "global-kernel",
		});
	});

	it("服务已装但没跑 → 先 start（尊重用户停过它），失败才由执行方回退重装", () => {
		expect(planKernelBoot(facts({ serviceInstalled: "installed" }))).toEqual({
			kind: "provision-service",
			action: "start",
			reason: "service-installed",
		});
	});

	it("开发/冒烟（策略关闭）→ 保留旧行为：壳自己拉临时内核", () => {
		expect(planKernelBoot(facts({ serviceFirst: false }))).toEqual({
			kind: "ephemeral-kernel",
			reason: "policy-off",
		});
	});

	it("Linux：systemd 要 root，GUI 里拿不到 TTY → 临时内核 + 面板给命令", () => {
		expect(planKernelBoot(facts({ platform: "linux" }))).toEqual({
			kind: "ephemeral-kernel",
			reason: "needs-terminal",
		});
	});
});

describe("planKernelBoot：什么都跑不了时把安装交给界面", () => {
	it("没有全局包内核，但有包内自带那份（离线活路）→ 先跑临时内核", () => {
		expect(planKernelBoot(facts({ globalKernelAvailable: false }))).toEqual({
			kind: "ephemeral-kernel",
			reason: "prerequisite-missing",
		});
	});

	it("纯壳包 + 有 node → 提示安装内核（npm i -g pi-web-ui）", () => {
		expect(planKernelBoot(facts({ globalKernelAvailable: false, ephemeralKernelAvailable: false }))).toEqual({
			kind: "install-kernel",
		});
	});

	it("连 node 都没有 → 先装 node", () => {
		expect(
			planKernelBoot(
				facts({
					globalKernelAvailable: false,
					ephemeralKernelAvailable: false,
					node: { found: false, ok: false },
				}),
			),
		).toEqual({ kind: "install-node", reason: "node-missing" });
	});

	it("node 太老（<22）→ 先升级 node", () => {
		expect(
			planKernelBoot(
				facts({
					globalKernelAvailable: false,
					ephemeralKernelAvailable: false,
					node: { found: true, ok: false },
				}),
			),
		).toEqual({ kind: "install-node", reason: "node-too-old" });
	});

	it("有全局包但 node 不可用 → 临时内核还能跑（全局包可用 Electron 的 node 兜底）", () => {
		expect(planKernelBoot(facts({ node: { found: false, ok: false } }))).toEqual({
			kind: "ephemeral-kernel",
			reason: "prerequisite-missing",
		});
	});
});

describe("resolveKernelServiceFirst", () => {
	it("默认：打包版开、开发态关", () => {
		expect(resolveKernelServiceFirst({ packaged: true, env: {} })).toBe(true);
		expect(resolveKernelServiceFirst({ packaged: false, env: {} })).toBe(false);
	});

	it("环境变量可双向覆盖（实机对比两种形态用）", () => {
		expect(resolveKernelServiceFirst({ packaged: true, env: { PI_DESKTOP_KERNEL_SERVICE_FIRST: "0" } })).toBe(false);
		expect(resolveKernelServiceFirst({ packaged: false, env: { PI_DESKTOP_KERNEL_SERVICE_FIRST: "1" } })).toBe(true);
		expect(resolveKernelServiceFirst({ packaged: true, env: { PI_DESKTOP_KERNEL_SERVICE_FIRST: " FALSE " } })).toBe(
			false,
		);
		// 认不出来的值不改变默认结论
		expect(resolveKernelServiceFirst({ packaged: true, env: { PI_DESKTOP_KERNEL_SERVICE_FIRST: "maybe" } })).toBe(true);
	});
});
