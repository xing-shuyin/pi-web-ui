/**
 * command-spawn.ts — 把「用户写的命令 + 参数」翻译成真正能 spawn 的进程。
 *
 * 为什么需要：`mcp.json` 里的 command 是用户按终端习惯写的（`npx …` / `yarn dlx …` / `uvx …`）。
 * Windows 上这些命令是 `.cmd` 批处理 shim，而 `spawn(file, args)` 走 CreateProcess：既不查 PATHEXT
 * 也无法执行批处理 —— 写 `npx` 直接 ENOENT，改成 `npx.cmd` 又是 EINVAL，MCP 服务器于是「一个工具都不
 * 贡献」，UI 上跟没配的条目一模一样。这里把解析收敛成一处：能还原成 `node <入口 js>` 就绝不开 shell
 * （没有引号二次解析、没有注入面），只有用户自写批处理才退化成 `cmd /d /s /c`。
 *
 * 复用单源：可执行文件定位走 `native-cli-discovery.findNativeCliExecutable`（PATH/PATHEXT + 版本管理器
 * 安装目录），shim 文本解析走 `engine-cli.readNpmShimTargets`（npm cmd-shim 的真实形态）。
 */
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { readNpmShimTargets, type CliLaunch } from "./engine-cli.js";
import { findNativeCliExecutable, type NativeCliDiscoveryOptions } from "./native-cli-discovery.js";

export interface CommandSpawnOptions extends NativeCliDiscoveryOptions {
	/**
	 * 覆盖可执行文件定位。CI 跑 Linux，win32 分支的 PATH/PATHEXT 查找只能在 Windows 上真跑，
	 * 留这个注入点让「shim → node 入口」这段能在任意平台对着真实临时文件守。
	 */
	resolveExecutable?: (command: string, options: NativeCliDiscoveryOptions) => string | undefined;
}

/** 解释器兜底：没有 ComSpec 时 `cmd.exe` 由 CreateProcess 按系统目录解析。 */
function windowsCommandInterpreter(options: CommandSpawnOptions): string {
	const env = options.env ?? process.env;
	const comspec = Object.entries(env).find(([key]) => key.toLowerCase() === "comspec")?.[1];
	return comspec || "cmd.exe";
}

/** shim 还原成 node 入口时，用运行 pi-web-ui 的这套 node（与 `engine-cli` 同策略）。 */
function nodeBinary(options: CommandSpawnOptions): string {
	return options.nodeExecutable ?? process.execPath;
}

/**
 * 真正该 spawn 的东西。`windowsVerbatimArguments` 只在 cmd 退化路径上是 true：
 * 那条命令行已经自己引号化过了，再交给 Node 逐参数加引号就会把整条命令再包一层，
 * cmd 于是不再剥 `/s` 那一层，直接报「不是内部或外部命令」。
 */
export interface CommandLaunch extends CliLaunch {
	windowsVerbatimArguments?: boolean;
}

/**
 * 把 argv 拼成一条 `cmd /d /s /c` 能执行的命令行。
 *
 * `/s` 的语义是「剥掉整条命令行的首尾各一个引号，其余原样交给命令解析」，所以外层必须再包一层引号，
 * 里面每个 token 各自加引号 —— 少了这层外层引号，带空格的路径会被 cmd 拆成两截（同类项目栽在这）。
 * 已知局限：cmd 仍会展开 `%VAR%`，命令行上没有可靠转义，这也正是主路径坚持 shell:false 的原因。
 */
export function windowsCmdCommandLine(argv: readonly string[]): string {
	return `"${argv.map(quoteWindowsArgument).join(" ")}"`;
}

function quoteWindowsArgument(value: string): string {
	if (value === "") return '""';
	// 不含空白、引号与 cmd 元字符的参数原样透传：多一层引号就多一次二次解析的机会
	if (!/[\s"&|<>^()]/.test(value)) return value;
	let out = '"';
	let backslashes = 0;
	for (const char of value) {
		if (char === "\\") {
			backslashes += 1;
			continue;
		}
		if (char === '"') {
			// 引号写成 `""` 而不是反斜杠转义：后者的引号奇偶性会被 cmd 打乱，同一行里后面的 `&`、`|`
			// 就被当成命令分隔符（实测 `quo"te` 后面跟 `a&b` 时会被拆成两条命令）；而 CRT 解析 `""`
			// 正好得到一个引号。引号前那一批反斜杠要翻倍，才不会被这对引号吃掉。
			out += "\\".repeat(backslashes * 2) + '""';
		} else {
			out += "\\".repeat(backslashes) + char;
		}
		backslashes = 0;
	}
	// 结尾的反斜杠会转义收尾引号，同样翻倍
	return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * 纯函数：给定 shim 文件与内容，算出该 spawn 什么（不碰文件系统，所以任意平台都能守 win32 分支）。
 *
 * 优先按 npm cmd-shim 还原成 `node <入口>` 直启；还原不出来（用户自写 .bat / 不是 shim 的 .cmd）
 * 才退化成 `cmd /d /s /c`。入口是否存在交给 spawn 报错 —— 错误里带绝对路径，比这里猜更可信。
 *
 * 路径运算故意用宿主 `path`：生产里这条分支只在 Windows 上跑（host 就是 win32，与显式 win32 等价），
 * 而 CI 跑 Linux —— 只有用宿主 path，注入 `platform: "win32"` 时才能对着真实临时文件断言。
 */
export function planWindowsShimLaunch(
	file: string,
	shimText: string,
	args: readonly string[] = [],
	options: CommandSpawnOptions = {},
): CommandLaunch {
	if (extname(file).toLowerCase() === ".cmd") {
		const { nodeTarget, nativeTarget } = readNpmShimTargets(shimText);
		const target = nodeTarget ?? nativeTarget;
		if (target && !/[%\x00-\x1f"]/.test(target) && (!nodeTarget || /\.(?:[cm]?js)$/i.test(nodeTarget))) {
			const entry = resolve(dirname(file), target);
			if (!nodeTarget) return { file: entry, args: [...args] };
			return { file: nodeBinary(options), args: [entry, ...args] };
		}
	}
	return {
		file: windowsCommandInterpreter(options),
		args: ["/d", "/s", "/c", windowsCmdCommandLine([file, ...args])],
		windowsVerbatimArguments: true,
	};
}

/**
 * 把 mcp.json / 任何用户配置里的命令翻译成可 spawn 的 `{ file, args }`。找不到或无从启动时抛错，
 * 由调用方补上下文（这里只说明「解析失败」，处置建议见 `describeCommandLaunchFailure`）。
 */
export function resolveCommandLaunch(
	command: string,
	args: readonly string[] = [],
	options: CommandSpawnOptions = {},
): CommandLaunch {
	const platform = options.platform ?? process.platform;
	// 非 Windows 不翻译：PATH 查找、可执行位、shebang 都由内核负责，原样交给 spawn 最忠实
	if (platform !== "win32") return { file: command, args: [...args] };
	// PATH 查找与版本管理器目录（fnm/nvm/volta/scoop/pnpm）都要查：桌面壳给的 PATH 常常没有它们
	const discovery: NativeCliDiscoveryOptions = {
		platform,
		env: options.env,
		cwd: options.cwd,
		homeDir: options.homeDir,
		nodeExecutable: options.nodeExecutable,
		autoDetect: options.autoDetect ?? true,
	};
	const executable = (options.resolveExecutable ?? findNativeCliExecutable)(command, discovery);
	if (!executable) throw new Error(`未找到可执行文件「${command}」（已按 PATH/PATHEXT 与常见安装目录查找）`);
	const extension = extname(executable).toLowerCase();
	if (extension === ".exe" || extension === ".com") return { file: executable, args: [...args] };
	if (extension === ".js" || extension === ".mjs" || extension === ".cjs")
		return { file: nodeBinary(options), args: [executable, ...args] };
	if (extension === ".cmd" || extension === ".bat") {
		// 读不出来（权限 / 占用）也继续：planWindowsShimLaunch 会退化成 cmd 执行
		let shimText = "";
		try {
			shimText = readFileSync(executable, "utf8");
		} catch {}
		return planWindowsShimLaunch(executable, shimText, args, options);
	}
	throw new Error(
		`不支持的 Windows 可执行文件「${executable}」：只支持 .exe/.com/.cmd/.bat 与 node 能跑的 .js/.mjs/.cjs`,
	);
}

/**
 * spawn 失败 / 解析失败时说人话。
 *
 * 为什么单独成函数：Windows 上 `npx` 这类命令是 `.cmd` 批处理 shim，只说一句 ENOENT 用户根本不知道
 * 要改什么（issue #934 的表现就是「UI 上跟没配的条目一样」），把常见处置直接写进错误里，
 * 它会原样进 `McpBridge.getServerStatus().error` 显示在界面上。
 */
export function describeCommandLaunchFailure(
	command: string,
	detail: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const head = `无法启动命令「${command}」：${detail}`;
	if (platform !== "win32") return `${head}；请确认该命令在 PATH 中（which ${command}）`;
	return (
		`${head}；Windows 上 npx / yarn / pnpm / uvx 这类命令其实是 .cmd 批处理 shim —— ` +
		`先在 cmd 里确认 where ${command} 有输出，或者把 command 改成 node 的绝对路径、` +
		`args 首项写该包的入口 js 绝对路径（如 command 用 "<node 安装目录>/node.exe"、` +
		`args 首项用 "<node 安装目录>/node_modules/npm/bin/npx-cli.js"）`
	);
}
