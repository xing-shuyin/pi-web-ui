import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KERNEL_LINUX_INSTALL_COMMAND, kernelActions, SHELL_CAPABILITY } from "../../browser/kernel-view.js";
import type { BrowserKernelState } from "../../browser/contracts.js";

const base: BrowserKernelState = {
	mode: "local",
	reason: "no-external-configured",
	url: "http://127.0.0.1:8790",
	reachable: true,
	supervisor: null,
};

const act = (state: BrowserKernelState | null, platform = "win32", shellCapability = SHELL_CAPABILITY) =>
	kernelActions({ state, platform, shellCapability });

describe("kernelActions", () => {
	it("没有内核状态时不显示安装按钮（先连上再谈装）", () => {
		const actions = act(null);
		expect(actions.install.kind).toBe("hidden");
		// 连都没连上时重启也无从下手（没有目标）
		expect(actions.restart.kind).toBe("hidden");
	});

	it("Windows / macOS 裸内核 → 可直接装（Win 免管理员，mac 用 launchd 免 sudo）", () => {
		expect(act(base, "win32").install).toEqual({ kind: "enabled" });
		expect(act(base, "darwin").install).toEqual({ kind: "enabled" });
	});

	it("Linux → 只给命令，不在 GUI 里 sudo（没有 TTY 必然失败）", () => {
		expect(act(base, "linux").install).toEqual({
			kind: "terminal",
			command: KERNEL_LINUX_INSTALL_COMMAND,
		});
	});

	it("已由系统托管 → 隐藏安装（已经满足“关掉也在跑”）", () => {
		const supervised: BrowserKernelState = { ...base, mode: "external", supervisor: "systemd" };
		expect(act(supervised, "win32").install.kind).toBe("hidden");
		expect(act(supervised, "linux").install.kind).toBe("hidden");
	});

	it("外部但没人托管 → 仍可安装（连的是别人的裸进程）", () => {
		const external: BrowserKernelState = { ...base, mode: "external", supervisor: null };
		expect(act(external, "win32").install.kind).toBe("enabled");
	});

	it("未知平台 → 不瞎给按钮", () => {
		expect(act(base, "freebsd").install.kind).toBe("hidden");
	});

	it("内核要求更高的壳能力 → 给警告（先更新桌面应用）", () => {
		expect(act({ ...base, minShell: 2 }).warning).toBe("min-shell-above");
		expect(act({ ...base, minShell: 1 }).warning).toBeUndefined();
		expect(act({ ...base, minShell: 0 }).warning).toBeUndefined();
	});

	it("本地 sidecar / 系统托管 → 可重启（连不上时正是要用它）", () => {
		expect(act({ ...base, reachable: false }).restart.kind).toBe("enabled");
		expect(act({ ...base, mode: "external", supervisor: "systemd" }).restart.kind).toBe("enabled");
	});

	// 别人的裸内核：本壳没有任何手段重启它，点了只会白点
	it("外部且无托管者 → 重启按钮隐藏", () => {
		expect(act({ ...base, mode: "external", supervisor: null }).restart.kind).toBe("hidden");
		expect(act(null).restart.kind).toBe("hidden");
	});
});

describe("SHELL_CAPABILITY 副本守卫", () => {
	it("渲染层副本必须等于 desktop/runtime-config.ts 的 SHELL_CAPABILITY_VERSION", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "..", "desktop", "runtime-config.ts"), "utf8");
		const match = /SHELL_CAPABILITY_VERSION\s*=\s*(\d+)/.exec(source);
		expect(match, "runtime-config.ts 里找不到 SHELL_CAPABILITY_VERSION").toBeTruthy();
		expect(Number(match?.[1])).toBe(SHELL_CAPABILITY);
	});

	it("Linux 命令用 CLI 的原始子命令（改了要一起改）", () => {
		expect(KERNEL_LINUX_INSTALL_COMMAND).toBe("pi-web-ui server install");
	});
});
