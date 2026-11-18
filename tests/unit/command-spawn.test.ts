import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeCommandLaunchFailure,
	resolveCommandLaunch,
	windowsCmdCommandLine,
} from "../../server/command-spawn.js";

const windows = process.platform === "win32";

/**
 * npm cmd-shim 真实骨架（npm 11 给 npx 生成的 npx.cmd），只有入口分隔符留成 `/`：
 * 解析正则同时接受 `\` 与 `/`，这样 Linux CI 也能对着真实临时文件断言；
 * Windows 上另有用例跑反斜杠形态与真实 cmd.exe。
 */
function npmShim(entry: string): string {
	return [
		"@ECHO off",
		"GOTO start",
		":find_dp0",
		"SET dp0=%~dp0",
		"EXIT /b",
		":start",
		"SETLOCAL",
		"CALL :find_dp0",
		"",
		'IF EXIST "%dp0%\\node.exe" (',
		'  SET "_prog=%dp0%\\node.exe"',
		") ELSE (",
		"  SET _prog=node",
		"  SET PATHEXT=%PATHEXT:;.JS;=;%",
		")",
		"",
		`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*`,
		"",
	].join("\r\n");
}

let root: string;
let nodeBinary: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-command-spawn-"));
	nodeBinary = join(root, "nodejs", "node.exe");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** win32 分支的注入版：假 ComSpec、假 node、把「PATH 里找到的东西」直接钉死。 */
function win32(file: string) {
	return {
		platform: "win32" as const,
		env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
		resolveExecutable: () => file,
		nodeExecutable: nodeBinary,
	};
}

describe("resolveCommandLaunch：非 Windows 不翻译", () => {
	it("命令与参数原样透传（PATH 查找、shebang 交给内核）", () => {
		expect(resolveCommandLaunch("npx", ["-y", "pkg with space"], { platform: "linux", env: {} })).toEqual({
			file: "npx",
			args: ["-y", "pkg with space"],
		});
	});
});

describe("resolveCommandLaunch：Windows 上的命令翻译", () => {
	it("npm .cmd shim → 直启 node + 入口，参数顺序与内容不变（不走 shell）", () => {
		const shim = join(root, "npx.cmd");
		writeFileSync(shim, npmShim("node_modules/npm/bin/npx-cli.js"));
		expect(resolveCommandLaunch("npx", ["-y", "@scope/pkg", "--flag=a b"], win32(shim))).toEqual({
			file: nodeBinary,
			args: [join(root, "node_modules", "npm", "bin", "npx-cli.js"), "-y", "@scope/pkg", "--flag=a b"],
		});
	});

	it(".exe / .com 直接用，不套 shell", () => {
		const exe = join(root, "mcp-server.exe");
		writeFileSync(exe, "");
		expect(resolveCommandLaunch("mcp-server", ["--stdio"], win32(exe))).toEqual({ file: exe, args: ["--stdio"] });
	});

	it("command 直接指向入口 js 时用 node 启动", () => {
		const script = join(root, "server.mjs");
		writeFileSync(script, "// fixture");
		expect(resolveCommandLaunch("server", ["--stdio"], win32(script))).toEqual({
			file: nodeBinary,
			args: [script, "--stdio"],
		});
	});

	it("解析不出来的 .cmd（用户自写批处理）退化成 cmd /d /s /c，不瞎猜入口", () => {
		const directory = join(root, "my tools");
		mkdirSync(directory, { recursive: true });
		const cmd = join(directory, "custom.cmd");
		writeFileSync(cmd, "@echo off\r\nnode server.js %*\r\n");
		const launch = resolveCommandLaunch("custom", ["--a"], win32(cmd));
		expect(launch.file).toBe("C:\\Windows\\system32\\cmd.exe");
		expect(launch.args).toEqual(["/d", "/s", "/c", String.raw`""${cmd}" --a"`]);
		// 命令行已经自己引号化过了，必须串明让 Node 别再逐参数加引号（否则 /s 那一层剥不下来）
		expect(launch.windowsVerbatimArguments).toBe(true);
	});

	it("自写 .bat 走 cmd，带空格 / 引号的参数按 Windows 命令行规则加引号", () => {
		const bat = join(root, "my server.bat");
		writeFileSync(bat, "@echo off\r\n");
		const launch = resolveCommandLaunch("my server", ["--config", "C:\\a b\\c d.json", 'say "hi"'], win32(bat));
		expect(launch.file).toBe("C:\\Windows\\system32\\cmd.exe");
		expect(launch.args).toEqual(["/d", "/s", "/c", String.raw`""${bat}" --config "C:\a b\c d.json" "say ""hi""""`]);
	});

	it("找不到可执行文件 → 明确报错，而不是留给 spawn 的 ENOENT", () => {
		expect(() =>
			resolveCommandLaunch("npx", [], { platform: "win32", env: { PATH: "" }, resolveExecutable: () => undefined }),
		).toThrow(/未找到可执行文件「npx」/);
	});

	it("不支持的后缀（.ps1 之类）直接报错，不赌 CreateProcess", () => {
		const ps1 = join(root, "tool.ps1");
		writeFileSync(ps1, "");
		expect(() => resolveCommandLaunch("tool", [], win32(ps1))).toThrow(/不支持的 Windows 可执行文件/);
	});
});

describe("windowsCmdCommandLine：cmd /s 的引号规则", () => {
	it("空参数、空格、引号、cmd 元字符各自加引号，外层再包一层给 /s 剥掉", () => {
		expect(windowsCmdCommandLine(["C:\\x y\\prog.bat", "--a", "", 'say "hi"', "a&b"])).toBe(
			String.raw`""C:\x y\prog.bat" --a "" "say ""hi""" "a&b""`,
		);
	});

	it("引号写成双引号、结尾前的反斜杠翻倍（都不打破 cmd 的引号奇偶性）", () => {
		expect(windowsCmdCommandLine(["C:\\Program Files\\", 'a\\"b'])).toBe(String.raw`""C:\Program Files\\" "a\\""b""`);
	});
});

describe("describeCommandLaunchFailure：失败要说清怎么处置", () => {
	it("Windows 上点明 .cmd 批处理 shim，并给出 where / node + 入口两条处置", () => {
		const message = describeCommandLaunchFailure("npx", "spawn npx ENOENT", "win32");
		expect(message).toContain("「npx」");
		expect(message).toContain("spawn npx ENOENT");
		expect(message).toContain(".cmd 批处理 shim");
		expect(message).toContain("where npx");
		expect(message).toContain("npx-cli.js");
	});

	it("非 Windows 只提示确认 PATH", () => {
		expect(describeCommandLaunchFailure("uvx", "ENOENT", "linux")).toBe(
			"无法启动命令「uvx」：ENOENT；请确认该命令在 PATH 中（which uvx）",
		);
	});
});

describe.skipIf(!windows)("真实 Windows 解析（findNativeCliExecutable）", () => {
	it("PATH 里的 npx.cmd（反斜杠入口）→ node + 入口 js", () => {
		const directory = join(root, "npm bin");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "npx.cmd"), npmShim("node_modules\\npm\\bin\\npx-cli.js"));
		const launch = resolveCommandLaunch("npx", ["-y", "some-pkg"], {
			platform: "win32",
			env: { Path: directory, ComSpec: "C:\\Windows\\system32\\cmd.exe" },
			cwd: root,
			autoDetect: false,
			nodeExecutable: "C:\\nodejs\\node.exe",
		});
		expect(launch).toEqual({
			file: "C:\\nodejs\\node.exe",
			args: [join(directory, "node_modules", "npm", "bin", "npx-cli.js"), "-y", "some-pkg"],
		});
	});

	it("退化出来的命令行真能被 cmd.exe 执行：空格 / 引号 / 结尾反斜杠 / 空参数 / 元字符都原样到达子进程", () => {
		const printer = join(root, "argv.mjs");
		writeFileSync(printer, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
		const args = ["plain", "with space", 'quo"te', "trail\\", "a&b|c", ""];
		const commandLine = windowsCmdCommandLine([process.execPath, printer, ...args]);
		const result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
			encoding: "utf8",
			windowsVerbatimArguments: true,
		});
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual(args);
	});
});
