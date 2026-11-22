import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hiddenConsoleArgs } from "../../shared/hide-console-windows.js";
import { launchShell, openArgv, revealArgv } from "../../server/shell-activate.js";

/**
 * 出口三：系统外壳委派。
 *
 * 这一层的红线只有一条 —— **`windowsHide` 必须是 `false`**（#960：显式 `true` 会让 explorer 新建的
 * 文件夹窗口沿用 `SW_HIDE`，Windows 上「在资源管理器中显示 / 用默认应用打开」整个静默失效），
 * 以及它不能复用 `spawnChild` 的监护策略（无 `stop()`、不建进程组、不注入 `NO_COLOR`）。
 */

function fakeChild(): EventEmitter & { unref: () => void } {
	const child = new EventEmitter() as EventEmitter & { unref: () => void };
	child.unref = () => {};
	return child;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("revealArgv / openArgv：平台 argv 单源", () => {
	it("Windows 目录用 /n,（展开），文件用 /select,（选中）", () => {
		expect(revealArgv("C:\\work\\src", true, "win32")).toEqual({
			cmd: "explorer.exe",
			args: ["/n,", "C:\\work\\src"],
			shell: "explorer",
		});
		expect(revealArgv("C:\\work\\src\\a.ts", false, "win32")).toEqual({
			cmd: "explorer.exe",
			args: ["/select,", "C:\\work\\src\\a.ts"],
			shell: "explorer",
		});
	});

	it("macOS 目录用 open，文件用 open -R", () => {
		expect(revealArgv("/w/src", true, "darwin")).toEqual({ cmd: "open", args: ["/w/src"], shell: "finder" });
		expect(revealArgv("/w/src/a.ts", false, "darwin")).toEqual({
			cmd: "open",
			args: ["-R", "/w/src/a.ts"],
			shell: "finder",
		});
	});

	it("其余 POSIX 用 xdg-open；文件没有「选中」语义，退化成打开所在目录", () => {
		expect(revealArgv("/w/src", true, "linux")).toEqual({ cmd: "xdg-open", args: ["/w/src"], shell: "xdg-open" });
		expect(revealArgv("/w/src/a.ts", false, "linux")).toEqual({
			cmd: "xdg-open",
			args: [dirname("/w/src/a.ts")],
			shell: "xdg-open",
		});
	});

	it("「用默认应用打开」三个平台都是「直接给路径」", () => {
		expect(openArgv("C:\\w\\a.pdf", "win32")).toEqual({
			cmd: "explorer.exe",
			args: ["C:\\w\\a.pdf"],
			shell: "explorer",
		});
		expect(openArgv("/w/a.pdf", "darwin")).toEqual({ cmd: "open", args: ["/w/a.pdf"], shell: "finder" });
		expect(openArgv("/w/a.pdf", "linux")).toEqual({ cmd: "xdg-open", args: ["/w/a.pdf"], shell: "xdg-open" });
	});
});

describe("launchShell：火并即忘的外壳委派", () => {
	it("固定 windowsHide: false + detached + stdio ignore，且不被监护策略污染", async () => {
		const calls: Array<{ cmd: string; args: readonly string[]; options: Record<string, unknown> }> = [];
		const spawnImpl = (cmd: string, args: readonly string[], options: Record<string, unknown>) => {
			calls.push({ cmd, args, options });
			const child = fakeChild();
			queueMicrotask(() => child.emit("spawn"));
			return child as never;
		};
		const result = await launchShell("explorer.exe", ["/n,", "C:\\w"], { spawnImpl: spawnImpl as never });

		expect(result).toEqual({ ok: true });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.cmd).toBe("explorer.exe");
		expect(calls[0]!.options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: false });
		// 不复用常驻子进程那套：不建进程组、不注入 NO_COLOR。
		expect(calls[0]!.options).not.toHaveProperty("env");
	});

	it("显式 false 会压过进程级「不弹黑窗」开关（否则 Windows 上照样静默失效）", () => {
		// 装过 hide-console-windows 的进程里，spawn 会被包成 `{ windowsHide: true, ...options }`。
		const patched = hiddenConsoleArgs("spawn", [
			"explorer.exe",
			["/n,", "C:\\w"],
			{ detached: true, stdio: "ignore", windowsHide: false },
		]);
		expect((patched[2] as { windowsHide: boolean }).windowsHide).toBe(false);
	});

	it("起不来（同步抛）返回原因而不是抛错", async () => {
		const spawnImpl = () => {
			throw new Error("ENOENT");
		};
		await expect(launchShell("nope", [], { spawnImpl: spawnImpl as never })).resolves.toEqual({
			ok: false,
			reason: "ENOENT",
		});
	});

	it("异步 error 事件同样转成失败原因", async () => {
		const spawnImpl = () => {
			const child = fakeChild();
			queueMicrotask(() => child.emit("error", new Error("EACCES")));
			return child as never;
		};
		await expect(launchShell("x", [], { spawnImpl: spawnImpl as never })).resolves.toEqual({
			ok: false,
			reason: "EACCES",
		});
	});

	it("既没 spawn 也没 error 时按超时算已交出去（外壳转发没有可观测回执）", async () => {
		vi.useFakeTimers();
		const pending = launchShell("explorer.exe", [], {
			spawnImpl: (() => fakeChild() as never) as never,
			timeoutMs: 50,
		});
		await vi.advanceTimersByTimeAsync(60);
		await expect(pending).resolves.toEqual({ ok: true });
	});
});
