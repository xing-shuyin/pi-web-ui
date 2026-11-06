import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { processTreeKillPlan, resolveCwdTarget } from "../../server/agent-service.js";

describe("resolveCwdTarget", () => {
	it("相对路径以当前会话 cwd 为基准（不是 server 进程 cwd）", () => {
		if (process.platform === "win32") {
			expect(resolveCwdTarget("src", "C:\\proj\\app", "win32")).toBe("C:\\proj\\app\\src");
		} else {
			expect(resolveCwdTarget("src", "/proj/app", "linux")).toBe("/proj/app/src");
		}
	});

	it("绝对路径不受基准影响", () => {
		if (process.platform === "win32") {
			expect(resolveCwdTarget("D:\\other", "C:\\proj", "win32")).toBe("D:\\other");
		} else {
			expect(resolveCwdTarget("/other", "/proj", "linux")).toBe("/other");
		}
	});

	it("首尾空白先裁剪再解析", () => {
		if (process.platform === "win32") {
			expect(resolveCwdTarget("  src  ", "C:\\proj", "win32")).toBe(resolve("C:\\proj", "src"));
		} else {
			expect(resolveCwdTarget("  src  ", "/proj", "linux")).toBe("/proj/src");
		}
	});

	it("win32 裸盘符显式指到盘根（大写归一）", () => {
		expect(resolveCwdTarget("c:", "C:\\proj", "win32")).toBe("C:\\");
		expect(resolveCwdTarget("D:", "C:\\proj", "win32")).toBe("D:\\");
	});

	it.skipIf(process.platform === "win32")('posix 下 "C:" 仍是普通相对路径', () => {
		expect(resolveCwdTarget("C:", "/proj", "linux")).toBe("/proj/C:");
	});

	it("空串回落到会话 cwd 本身", () => {
		if (process.platform === "win32") {
			expect(resolveCwdTarget("", "C:\\proj", "win32")).toBe("C:\\proj");
		} else {
			expect(resolveCwdTarget("", "/proj", "linux")).toBe("/proj");
		}
	});
});

describe("processTreeKillPlan", () => {
	it("win32：taskkill /T /F 整树杀（shell:true 下 p.kill 只杀 cmd.exe 壳）", () => {
		expect(processTreeKillPlan("win32", 4321)).toEqual({
			kind: "taskkill",
			cmd: "taskkill",
			args: ["/PID", "4321", "/T", "/F"],
		});
	});

	it("posix：杀负 pid（进程组）SIGTERM，依赖 spawn detached", () => {
		expect(processTreeKillPlan("linux", 4321)).toEqual({ kind: "group-signal", signal: "SIGTERM" });
		expect(processTreeKillPlan("darwin", 4321)).toEqual({ kind: "group-signal", signal: "SIGTERM" });
	});

	it("pid 缺失/非法时不动手（spawn 失败竞态）", () => {
		expect(processTreeKillPlan("win32", undefined)).toEqual({ kind: "none" });
		expect(processTreeKillPlan("linux", 0)).toEqual({ kind: "none" });
		expect(processTreeKillPlan("linux", -5)).toEqual({ kind: "none" });
	});
});
