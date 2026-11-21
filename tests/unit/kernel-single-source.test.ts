import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 「一份运行时、一个内核」的守卫：这些文件是那套约束的唯一落点，
 * 有人绕开它们另写一份时，应该在这里红，而不是等线上出现双写。
 * 说明见 docs/architecture-kernel.md。
 */
const root = join(import.meta.dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

describe("内核单源", () => {
	it("服务端启动必须抢数据目录锁（不能静默丢锁）", () => {
		const source = read("server/index.ts");
		expect(source).toMatch(/acquireKernelLock\(/);
		expect(source).toMatch(/KERNEL_LOCK\.state === "denied"[\s\S]{0,200}process\.exit\(1\)/);
		expect(source).toMatch(/process\.once\("exit", \(\) => releaseKernelLock/);
	});

	it("/api/health 必须带 kernel 块（客户端靠它判断常驻与否）", () => {
		const source = read("server/index.ts");
		expect(source).toMatch(/app\.get\("\/api\/health"[\s\S]{0,600}kernel: kernelInfo\(\)/);
	});

	it("公开快照不含 pid / 数据目录 / node 路径（免鉴权端点）", () => {
		const source = read("server/kernel-identity.ts");
		const body = source.slice(source.indexOf("export function buildKernelInfo"));
		for (const forbidden of ["pid:", "dataDir:", "nodePath:", "cwd:"]) {
			expect(body).not.toContain(forbidden);
		}
	});

	it("壳的判定只有一处：main.ts 用 decideKernelMode，不许自己拼条件", () => {
		const source = read("desktop/main.ts");
		expect(source).toMatch(/decideKernelMode\(\{ externalUrl/);
		// 唯一的 sidecar 拉起入口是 startKernel /  restart / 安装回滚三处，且都在判定之后
		expect(source).toMatch(/async function startKernel\(/);
	});

	it("面板文案来自 kernel-view，不在渲染层另写一套措辞", () => {
		const panels = read("browser/renderer/panels.ts");
		expect(panels).toMatch(/describeKernelState/);
		expect(panels).toMatch(/kernelPersistenceHint/);
		// 托管形态的措辞只允许出现在 kernel-view.ts
		expect(panels).not.toContain("systemd 托管");
		expect(read("browser/kernel-view.ts")).toContain("systemd 托管");
	});

	it("权威链只有一处：main.ts 用 pickKernelSource，不自己排优先级", () => {
		const main = read("desktop/main.ts");
		expect(main).toMatch(/pickKernelSource\(/);
		expect(main).toMatch(/KERNEL_AUTHORITY/);
		expect(read("desktop/runtime-config.ts")).toMatch(/export const KERNEL_AUTHORITY/);
	});

	it("权威链停用运行时自更新（两条链不能同时活着）", () => {
		const config = read("desktop/runtime-config.ts");
		expect(config).toMatch(/RUNTIME_SELF_UPDATE_ENABLED/);
		expect(read("desktop/main.ts")).toContain("if (!RUNTIME_SELF_UPDATE_ENABLED)");
	});

	it("装服务的子进程不经 shell，参数由 kernel-install 单源拼装", () => {
		const install = read("desktop/kernel-install.ts");
		expect(install).toMatch(/spawnImpl\(/);
		expect(install).not.toMatch(/shell:\s*true/);
		expect(install).toMatch(/buildServiceInstallArgs/);
	});
});
