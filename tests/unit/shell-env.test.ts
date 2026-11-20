import { writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureShellPath, mergeShellPath, parseCapturedPath } from "../../server/shell-env.js";
import { augmentNodePathFromShell, resolveCaptureTimeoutMs } from "../../server/node-path.js";
import { captureCommands, isAbsolutePathEntry } from "../../server/shell-env.js";

const windows = process.platform === "win32";
const posixOnly = windows ? it.skip : it;

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-shell-env-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("交互式登录 shell 的 PATH 捕获", () => {
	it("只取 marker 之间的内容，profile 里的 banner 与 ANSI 都不参与解析", () => {
		const out =
			"\u001b[1mWelcome to zsh!\u001b[0m\nsome banner\nm1/\u001b[32m/usr/local/bin\u001b[0m:/opt/node/bin\nm2\ntrailing junk";
		expect(parseCapturedPath(out, "m1", "linux")).toBeNull(); // marker 必须成对出现
		expect(parseCapturedPath("banner\nm1/usr/local/bin:/opt/node/binm1\nbye", "m1", "linux")).toBe(
			"/usr/local/bin:/opt/node/bin",
		);
	});
	it("多段 marker 时取最后一段（前面可能是 profile 自己 echo 的内容）", () => {
		const out = "m1/fake/one m1 noise m1/real:/bin m1";
		expect(parseCapturedPath(out, "m1", "linux")).toBe("/real:/bin");
	});
	it("形状可疑就放弃，绝不把脏串写进 PATH", () => {
		expect(parseCapturedPath("no markers here", "m1", "linux")).toBeNull();
		expect(parseCapturedPath("m1a:b\nc m1", "m1", "linux")).toBeNull(); // 含换行
		expect(parseCapturedPath("m1not-a-path m1", "m1", "linux")).toBeNull(); // 没有分隔符
		expect(parseCapturedPath("m1 m1", "m1", "linux")).toBeNull(); // 空串
	});
	it("合并时 shell 顺序在前、去重、保留当前独有条目", () => {
		const merged = mergeShellPath("/a:/b", "/b:/c", "linux");
		expect(merged.split(":")).toEqual(["/a", "/b", "/c"]);
	});
	it("Windows 合并按大小写不敏感去重", () => {
		const merged = mergeShellPath("C:\\Node;D:\\tools", "c:\\node;C:\\Other", "win32");
		expect(merged.split(";")).toEqual(["C:\\Node", "D:\\tools", "C:\\Other"]);
	});
	posixOnly("真起一次交互式登录 shell 也能干净取到 PATH（stderr 噪声不影响）", async () => {
		const fake = join(root, "fake-login-shell");
		// 假装是用户的 shell：打印 banner、往 stderr 喷噪声，再按 -c 的命令输出 marker 包住的 PATH。
		writeFileSync(
			fake,
			'#!/bin/sh\nprintf "profile banner\\n"\nprintf "noise\\n" >&2\nexport PATH="/fixture/bin:/usr/bin"\neval "$2"\n',
			{ mode: 0o755 },
		);
		chmodSync(fake, 0o755);
		const captured = await captureShellPath({ platform: "linux", env: { SHELL: fake }, timeoutMs: 4000 });
		expect(captured).toBe("/fixture/bin:/usr/bin");
	});
	it("开关关掉 / 已有 node+npm 时不起 shell，直接 skipped", async () => {
		expect(await augmentNodePathFromShell({ env: { PATH: "/usr/bin", PI_WEB_PATH_CAPTURE: "off" } })).toEqual({
			reason: "skipped",
			added: 0,
			ms: 0,
			timeoutMs: 1500,
		});
		const binDir = join(root, "bin");
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, windows ? "node.exe" : "node"), "fixture");
		writeFileSync(join(binDir, windows ? "npm.cmd" : "npm"), "fixture");
		const result = await augmentNodePathFromShell({ env: { PATH: binDir } });
		expect(result.reason).toBe("skipped");
	});
	it("超时可由 PI_WEB_PATH_CAPTURE_TIMEOUT_MS 调，并且夹在 200ms～10s", () => {
		expect(resolveCaptureTimeoutMs({})).toBe(1500);
		expect(resolveCaptureTimeoutMs({ PI_WEB_PATH_CAPTURE_TIMEOUT_MS: "4000" })).toBe(4000);
		expect(resolveCaptureTimeoutMs({ PI_WEB_PATH_CAPTURE_TIMEOUT_MS: "30" })).toBe(200);
		expect(resolveCaptureTimeoutMs({ PI_WEB_PATH_CAPTURE_TIMEOUT_MS: "60000" })).toBe(10_000);
		expect(resolveCaptureTimeoutMs({ PI_WEB_PATH_CAPTURE_TIMEOUT_MS: "abc" })).toBe(1500);
		expect(resolveCaptureTimeoutMs({ PI_WEB_PATH_CAPTURE_TIMEOUT_MS: "-5" })).toBe(1500);
		expect(resolveCaptureTimeoutMs({ PI_WEB_PATH_CAPTURE_TIMEOUT_MS: "4000" }, 800)).toBe(800);
	});
	it("Windows 依次试 pwsh / powershell（两份 $PROFILE 是不同文件），均带 -NonInteractive", () => {
		const specs = captureCommands("mk", { platform: "win32", env: {} });
		expect(specs.map((s) => s.command)).toEqual(["pwsh", "powershell"]);
		for (const spec of specs) {
			expect(spec.args).toContain("-NonInteractive");
			expect(spec.args).not.toContain("-NoProfile"); // 必须加载 profile，否则一无所获
			expect(spec.args.join(" ")).toContain("mk");
		}
	});
	it("配了 PI_WEB_SHELL 时追加 bash -ilc 兜底", () => {
		const specs = captureCommands("mk", {
			platform: "win32",
			env: { PI_WEB_SHELL: "C:/Program Files/Git/bin/bash.exe" },
		});
		expect(specs.at(-1)).toEqual({
			command: "C:/Program Files/Git/bin/bash.exe",
			args: ["-ilc", `printf 'mk%smk' "$PATH"`],
		});
	});
	it("POSIX 用 $SHELL -ilc（-i 不能省：fnm env 写在 .bashrc/.zshrc）", () => {
		expect(captureCommands("mk", { platform: "linux", env: { SHELL: "/bin/zsh" } })[0]).toEqual({
			command: "/bin/zsh",
			args: ["-ilc", `printf 'mk%smk' "$PATH"`],
		});
	});
	it("相对 / cwd 相关条目不会焊进全局 PATH（捕获侧过滤，当前 PATH 不动）", () => {
		const merged = mergeShellPath("relative/bin:.:/abs/one", ".:/abs/two", "linux");
		expect(merged.split(":")).toEqual(["/abs/one", ".", "/abs/two"]);
		expect(isAbsolutePathEntry("node_modules/.bin", "linux")).toBe(false);
		expect(isAbsolutePathEntry("C:\\tools", "win32")).toBe(true);
		expect(isAbsolutePathEntry("tools", "win32")).toBe(false);
		expect(isAbsolutePathEntry("\\\\server\\share", "win32")).toBe(true);
	});
	it("抓不到（shell 不存在）时安静失败，PATH 原样不动", async () => {
		const env = { SHELL: join(root, "missing-shell"), PATH: "/usr/bin" };
		const result = await augmentNodePathFromShell({ platform: "linux", env, timeoutMs: 1200 });
		expect(result.reason).toBe("failed");
		expect(result.timeoutMs).toBe(1200);
		expect(env.PATH).toBe("/usr/bin");
	});
});
