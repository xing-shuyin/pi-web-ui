#!/usr/bin/env node
/**
 * pi-web-ui CLI.
 *
 *   pi-web-ui                              启动生产服务器（前台，Ctrl+C 停止，自动打开浏览器）
 *   pi-web-ui --engine dsh --port 9000 --cwd /path    同上，覆盖引擎/端口/工作目录/数据目录
 *   pi-web-ui --no-browser                 启动但不自动打开浏览器
 *   pi-web-ui --version | --help
 *   pi-web-ui server install [选项]         安装系统服务（开机自启）并启动
 *   pi-web-ui server shortcut [选项]        在桌面创建「一键启动」图标（启动服务并打开浏览器）
 *   pi-web-ui server uninstall [选项]       卸载系统服务（同时移除桌面图标）
 *   pi-web-ui server start|stop|restart|status [选项]
 *   pi-web-ui install <源> [选项]           安装 GitHub 上的界面插件（见下方「界面插件」）
 *   pi-web-ui plugins / uninstall <id>      列出 / 卸载界面插件
 *
 * 系统服务：
 *   - macOS   → launchd 用户代理，label 默认 com.xingshuyin.pi-web-ui
 *              （--name 自定义时 com.<name>.server），无需 sudo
 *   - Linux   → systemd 单元 <name>.service（/etc/systemd/system/，自动 sudo）
 *   - Windows → 登录自启 Run 键（HKCU，无需管理员）+ wscript 隐藏启动（无黑窗）；
 *              PowerShell 启动脚本 / VBS 启动器 / PID 文件生成在
 *              %APPDATA%\pi-web-ui\
 *
 * 环境变量（flag 优先，环境变量后备）：PI_WEB_PORT / PI_WEB_CWD / PI_WEB_DATA_DIR /
 * PI_WEB_ENGINE / PI_WEB_HOST / PI_CODING_AGENT_DIR；token 仅环境变量，不走命令行。
 */
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { get as httpGet } from "node:http";
import { createInterface } from "node:readline/promises";
import {
	ensureBackup as ensurePluginBackup,
	restoreBackup as restorePluginBackup,
	checkPluginUpdates,
	resolveRemoteSha,
} from "../dist/server/plugin-updater.js";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
/** <pkg>/dist/server/index.js — the actual server entry. */
const SERVER_ENTRY = join(BIN_DIR, "..", "dist", "server", "index.js");
/** 「机器上有更新的 pi 副本就跟随它」解析钩子（issue #260；#321 起默认启用）。
 *  必须早于任何 SDK 静态 import 加载 —— 所以每条启动路径都把它当 `--import` 传进去；
 *  PI_WEB_SDK=bundled 显式钉死自带副本（见 server/resolve-global-sdk.ts）。 */
const SDK_HOOK = join(BIN_DIR, "..", "dist", "server", "resolve-global-sdk.js");
/** dist 可能是旧构建（没有这个钩子文件）—— 只有文件在才注入：`--import <missing>` 会让
 *  CLI/服务直接起不来，那比少个开关严重得多。 */
const HAS_SDK_HOOK = existsSync(SDK_HOOK);
const NODE = process.execPath;
let pkg = { version: "0.0.0" };
try {
	pkg = JSON.parse(readFileSync(join(BIN_DIR, "..", "package.json"), "utf8"));
} catch {
	// version is best-effort — the server itself doesn't need it
}

/** Detect if the user prefers Chinese locale: POSIX env vars win, then Intl API fallback. */
function isZhLang() {
	const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
	if (env.startsWith("zh")) return true;
	if (!env) {
		try {
			return Intl.DateTimeFormat().resolvedOptions().locale.startsWith("zh");
		} catch {
			/* ignore */
		}
	}
	return false;
}

/** Resolved once: CLI messages below pick zh/en with `ZH ? zh : en` (only the chosen branch is evaluated). */
const ZH = isZhLang();

const HELP_ZH = `pi-web-ui v${pkg.version} — web chat for the pi coding agent

用法:
  pi-web-ui                               启动服务器（前台，Ctrl+C 停止，自动打开浏览器）
  pi-web-ui --engine dsh --port 9000 --cwd /path      启动并指定引擎 / 端口 / 工作目录 / 数据目录
  pi-web-ui --no-browser                  启动但不自动打开浏览器
  pi-web-ui server install [选项]         安装系统服务（开机自启）并启动
  pi-web-ui server shortcut [选项]        在桌面创建「一键启动」图标（启动服务并打开浏览器）
  pi-web-ui server uninstall [选项]       卸载系统服务（同时移除桌面图标）
  pi-web-ui server start|stop|restart|status [选项]
  pi-web-ui server quiesce [选项]          进入排空模式：拒绝新的对话/消息/编辑，存量运行继续跑完
  pi-web-ui server unquiesce [选项]        解除排空模式，恢复接收新工作
  pi-web-ui --version / --help

server 选项:
  --port <n>        端口（默认 8787，或 $PI_WEB_PORT）
  --cwd <dir>       工作目录（默认 $PI_WEB_CWD 或用户主目录；前台启动默认当前目录）
  --data-dir <dir>  会话数据目录（默认 <cwd>/.pi-web）
  --engine <pi|dsh> 智能体引擎（默认 $PI_WEB_ENGINE 或 pi）
  --host <addr>     监听地址（默认 $PI_WEB_HOST 或 127.0.0.1；0.0.0.0 供局域网/容器）
  --agent-dir <dir> pi 配置目录（默认 $PI_CODING_AGENT_DIR 或 ~/.pi/agent）
  --name <name>     服务名（默认 pi-web-ui；仅限字母/数字/-/_，字母或数字开头，
                    最长 64 字符。macOS 的 launchd label 为 com.xingshuyin.pi-web-ui，
                    自定义名时为 com.<name>.server）
  --print           只打印将生成的配置文件，不实际安装

平台: macOS → launchd 用户代理 · Linux → systemd · Windows → 登录自启 Run 键
      （HKCU 写入无需管理员；wscript 隐藏启动无黑窗；stop 停止，uninstall 移除）
快捷方式: Windows → 桌面 .lnk · macOS → 桌面 .command 启动器 · Linux → 桌面 .desktop 图标

界面插件（安装到 <data-dir>/plugins/，服务运行中刷新浏览器即生效）:
  pi-web-ui plugin create <id>         生成最小可跑的插件骨架
  pi-web-ui install <源>            从 GitHub 安装界面插件
  pi-web-ui uninstall <id>          卸载已安装的界面插件
  pi-web-ui plugins                 列出已安装的界面插件

  源写法: owner/repo · https://github.com/owner/repo · 本地目录路径
          URL 带 /tree/<分支>/<子目录> 可指定分支与仓库内子目录；任意写法
          末尾加 #<分支或tag> 也可指定分支（如 owner/repo#v1.2）
  install 选项: --name <id> 自定义插件目录名（默认取仓库名）
                --data-dir <dir> 数据目录（默认 ~/.pi-web）
                --force 目标已存在时覆盖
                --build 强制源码构建（隔离目录编译，见下；不加 --build 时若插件只有
                        源码，交互终端会询问是否构建并需输入 y 确认，非交互环境跳过）
                --no-build 即使只有源码也不构建（产物缺失的插件装上后不加载）
                --catalog <url> 目录同步模式：读目录文档 → 写可安装列表 → 逐条安装
                --replace 配合 --catalog：整体替换列表（默认按 id 合并）

环境变量（flag 优先，环境变量后备）:
  PI_WEB_PORT / PI_WEB_CWD / PI_WEB_DATA_DIR / PI_WEB_ENGINE / PI_WEB_HOST /
  PI_CODING_AGENT_DIR。
  鉴权口令 PI_WEB_TOKEN：仅环境变量（不走命令行）；Linux install 会写入 unit，--print 会显示口令。
  其他平台需手动加入服务配置。
`;

const HELP_EN = `pi-web-ui v${pkg.version} — web chat for the pi coding agent

Usage:
  pi-web-ui                               Start server (foreground, Ctrl+C to stop, auto-opens browser)
  pi-web-ui --engine dsh --port 9000 --cwd /path      Start with engine/port/cwd/data-dir overrides
  pi-web-ui --no-browser                   Start without auto-opening browser
  pi-web-ui server install [options]       Install system service (autostart on boot) and launch it
  pi-web-ui server shortcut [options]      Create desktop "one-click start" icon
  pi-web-ui server uninstall [options]     Uninstall system service (also removes desktop icon)
  pi-web-ui server start|stop|restart|status [options]
  pi-web-ui server quiesce [options]       Drain mode: reject new chats/messages/edits; let current runs finish
  pi-web-ui server unquiesce [options]     Exit drain mode, resume accepting new work
  pi-web-ui --version / --help

Server options:
  --port <n>        Port (default 8787, or $PI_WEB_PORT)
  --cwd <dir>       Working directory (default $PI_WEB_CWD or home dir; foreground uses current dir)
  --data-dir <dir>  Session data directory (default <cwd>/.pi-web)
  --engine <pi|dsh> Agent engine (default $PI_WEB_ENGINE or pi)
  --host <addr>     Listen address (default $PI_WEB_HOST or 127.0.0.1; 0.0.0.0 for LAN/containers)
  --agent-dir <dir> pi config directory (default $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --name <name>     Service name (default pi-web-ui; alphanumeric, "-" and "_" only,
                    starting with a letter or digit, max 64 chars. macOS launchd label is
                    com.xingshuyin.pi-web-ui, or com.<name>.server for custom names)
  --print           Only print generated config files (no actual install)

Platforms: macOS → launchd user agent · Linux → systemd · Windows → Logon Run key
           (HKCU, no admin needed; wscript hidden launch, no black window)
Shortcuts: Windows → desktop .lnk · macOS → desktop .command · Linux → desktop .desktop

UI plugins (installed into <data-dir>/plugins/; refresh browser to activate while running):
  pi-web-ui plugin create <id>        Scaffold a minimal runnable plugin
  pi-web-ui install <source>          Install a UI plugin from GitHub
  pi-web-ui uninstall <id>            Uninstall a UI plugin
  pi-web-ui plugins                   List installed UI plugins

  Source formats: owner/repo · https://github.com/owner/repo · local directory path
                  URL with /tree/<branch>/<subdir> to specify branch and sub-directory;
                  append #<branch-or-tag> to any source to pin a branch (e.g. owner/repo#v1.2)
  install options: --name <id>   Custom plugin directory name (default: repo name)
                   --data-dir <dir>  Data directory (default: ~/.pi-web)
                   --force       Overwrite if target already exists
                   --build       Force a source build (isolated build, see below). Without it,
                                 a source-only plugin asks for confirmation on a TTY (answer y to
                                 build) and skips the build in non-interactive environments
                   --no-build    Never build, even for source-only plugins
                   --catalog <url> Catalog mode: read a catalog document, write the
                                 installable list, then install every entry
                   --replace     With --catalog: replace the whole list (default merges by id)

Environment variables (flag takes precedence, env var as fallback):
  PI_WEB_PORT / PI_WEB_CWD / PI_WEB_DATA_DIR / PI_WEB_ENGINE / PI_WEB_HOST /
  PI_CODING_AGENT_DIR
  Auth token PI_WEB_TOKEN: env var only (not on command line). Linux install persists it; --print reveals it.
  On other platforms, add it to the service config manually.
`;

const HELP = isZhLang() ? HELP_ZH : HELP_EN;

/** Minimum Node required by the pi SDK (its dist uses `import … with { type: "json" }`). */
const NODE_MIN = [22, 19, 0];
function checkNodeVersion() {
	const v = process.versions.node.split(".").map(Number);
	const tooOld =
		v[0] < NODE_MIN[0] ||
		(v[0] === NODE_MIN[0] && v[1] < NODE_MIN[1]) ||
		(v[0] === NODE_MIN[0] && v[1] === NODE_MIN[1] && v[2] < NODE_MIN[2]);
	if (tooOld) {
		const zh =
			`✖ pi-web-ui 需要 Node.js >= ${NODE_MIN.join(".")}（当前 ${process.versions.node}）。\n` +
			`  pi SDK 的代码使用了 import attributes（with）语法，旧版 Node 无法解析。\n` +
			`  请升级 Node：https://nodejs.org（或 nvm-windows / fnm）后重装：npm i -g pi-web-ui`;
		const en =
			`✖ pi-web-ui requires Node.js >= ${NODE_MIN.join(".")} (current: ${process.versions.node}).\n` +
			`  The pi SDK uses import attributes (\`with\` syntax) which older Node versions can't parse.\n` +
			`  Upgrade Node: https://nodejs.org then reinstall: npm i -g pi-web-ui`;
		console.error(isZhLang() ? zh : en);
		process.exit(1);
	}
}

function fail(msg) {
	console.error(`✖ ${msg}`);
	process.exit(1);
}

/** Run a command, inheriting stdio; exits on failure unless ignoreError. */
function run(cmd, args, { ignoreError = false, silent = false } = {}) {
	const res = spawnSync(cmd, args, {
		stdio: silent ? ["inherit", "ignore", "ignore"] : "inherit",
	});
	if (!ignoreError && res.status !== 0) process.exit(res.status ?? 1);
	return res;
}

/** Parse --flag value / --flag=value options; returns { opts, positionals }. */
function parseFlags(argv) {
	const opts = {
		port: undefined,
		cwd: undefined,
		dataDir: undefined,
		name: undefined,
		engine: undefined,
		host: undefined,
		agentDir: undefined,
		print: false,
		noBrowser: false,
		force: false,
		checkUpdates: false,
		rollback: undefined,
		dir: undefined,
		template: undefined,
		withTest: false,
		help: false,
	};
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const eq = a.indexOf("=");
		const key = eq >= 0 ? a.slice(0, eq) : a;
		const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
		const take = (flag) => {
			if (inline !== undefined) return inline;
			if (i + 1 < argv.length) {
				i++;
				return argv[i];
			}
			fail(ZH ? `缺少选项 ${flag} 的值` : `Option ${flag} is missing a value`);
		};
		switch (key) {
			case "--port":
				opts.port = take("--port");
				break;
			case "--cwd":
				opts.cwd = take("--cwd");
				break;
			case "--data-dir":
				opts.dataDir = take("--data-dir");
				break;
			case "--engine":
				opts.engine = take("--engine");
				break;
			case "--host":
				opts.host = take("--host");
				break;
			case "--agent-dir":
				opts.agentDir = take("--agent-dir");
				break;
			case "--name":
				opts.name = take("--name");
				break;
			case "--print":
				opts.print = true;
				break;
			case "--no-browser":
				opts.noBrowser = true;
				break;
			case "--force":
				opts.force = true;
				break;
			case "--build":
				opts.build = true;
				break;
			case "--no-build":
				opts.noBuild = true;
				break;
			case "--catalog":
				opts.catalog = take("--catalog");
				break;
			case "--replace":
				opts.replace = true;
				break;
			case "--check-updates":
				opts.checkUpdates = true;
				break;
			case "--rollback":
				opts.rollback = take("--rollback");
				break;
			case "--dir":
				opts.dir = take("--dir");
				break;
			case "--template":
				opts.template = take("--template");
				break;
			case "--with-test":
				opts.withTest = true;
				break;
			case "--help":
			case "-h":
				opts.help = true;
				break;
			default:
				if (key.startsWith("-")) fail(ZH ? `未知选项: ${key}` : `Unknown option: ${key}`);
				positionals.push(a);
		}
	}
	return { opts, positionals };
}

// ---------------------------------------------------------------------------
// 前台启动
// ---------------------------------------------------------------------------

/** Open a URL in the OS default browser; failures are ignored (best-effort). */
function openBrowser(url) {
	let res;
	if (isMac) {
		res = spawnSync("open", [url], { stdio: "ignore" });
	} else if (isWin) {
		res = spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
	} else {
		res = spawnSync("xdg-open", [url], { stdio: "ignore" });
	}
	// spawnSync 不抛异常：命令缺失（headless 服务器）时在返回对象里带 error 字段。
	if (res?.error) {
		if (res.error.code === "ENOENT") {
			console.warn(
				ZH
					? `[browser] 未找到打开器 (${res.error.path || "command not found"})，` +
							"headless 服务器可用 --no-browser 关闭自动打开"
					: `[browser] no opener found (${res.error.path || "command not found"}), ` +
							"headless servers can use --no-browser to disable auto-open",
			);
		} else {
			console.warn(ZH ? "[browser] 打开浏览器失败:" : "[browser] failed to open browser:", res.error.message);
		}
	}
}

/**
 * Poll `url` until the server answers (or ~15s pass), then open it in the
 * default browser. The foreground server runs in this process, so the first
 * HTTP response is the "listening" signal; if the server crashes meanwhile
 * (e.g. port already taken), the pending timers die with the process and
 * nothing is opened.
 */
function openBrowserWhenUp(url) {
	const deadline = Date.now() + 15_000;
	const attempt = () => {
		const req = httpGet(url, (res) => {
			res.resume();
			console.log(
				ZH
					? `  🌐 已自动打开浏览器：${url}（--no-browser 可关闭）`
					: `  🌐 Browser opened automatically: ${url} (--no-browser to disable)`,
			);
			openBrowser(url);
		});
		req.setTimeout(1000, () => {
			req.destroy();
			if (Date.now() < deadline) setTimeout(attempt, 150);
		});
		req.on("error", () => {
			if (Date.now() < deadline) setTimeout(attempt, 150);
		});
	};
	attempt();
}

async function startForeground(opts) {
	if (opts.port) process.env.PI_WEB_PORT = opts.port;
	if (opts.cwd) process.env.PI_WEB_CWD = resolve(opts.cwd);
	if (opts.dataDir) process.env.PI_WEB_DATA_DIR = resolve(opts.dataDir);
	if (opts.engine) {
		if (opts.engine !== "pi" && opts.engine !== "dsh")
			fail(ZH ? `无效引擎: ${opts.engine}（仅支持 pi / dsh）` : `Invalid engine: ${opts.engine} (pi and dsh only)`);
		process.env.PI_WEB_ENGINE = opts.engine;
	}
	if (opts.host) process.env.PI_WEB_HOST = opts.host;
	if (opts.agentDir) process.env.PI_CODING_AGENT_DIR = resolve(opts.agentDir);
	const url = `http://localhost:${effectivePort(opts)}`;
	if (HAS_SDK_HOOK) await import(pathToFileURL(SDK_HOOK).href);
	try {
		await import(pathToFileURL(SERVER_ENTRY).href);
	} catch (err) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			err.code === "ERR_MODULE_NOT_FOUND" &&
			String(err.message).includes("@earendil-works/pi-coding-agent")
		) {
			console.error(
				ZH
					? `\n[pi-web-ui] 错误：未找到 @earendil-works/pi-coding-agent 核心依赖。\n` +
							`请先全局安装 pi CLI，然后重试：\n` +
							`  npm i -g @earendil-works/pi-coding-agent@latest\n` +
							`或在 pnpm 环境下：\n` +
							`  pnpm add -g @earendil-works/pi-coding-agent@latest\n`
					: `\n[pi-web-ui] Error: '@earendil-works/pi-coding-agent' core dependency not found.\n` +
							`Please install the pi CLI globally and try again:\n` +
							`  npm i -g @earendil-works/pi-coding-agent@latest\n` +
							`or with pnpm:\n` +
							`  pnpm add -g @earendil-works/pi-coding-agent@latest\n`,
			);
			process.exit(1);
		}
		throw err;
	}
	if (!opts.noBrowser) openBrowserWhenUp(url);
}

// ---------------------------------------------------------------------------
// 系统服务管理
// ---------------------------------------------------------------------------

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";

function uid() {
	try {
		return userInfo().uid;
	} catch {
		return process.getuid?.() ?? 501;
	}
}

/** launchd label / systemd unit name / Windows task name for a service name. */
function serviceLabel(name) {
	if (isMac) {
		return name === "pi-web-ui" ? "com.xingshuyin.pi-web-ui" : `com.${name}.server`;
	}
	return name;
}

function launchAgentPlist(name) {
	return join(homedir(), "Library", "LaunchAgents", `${serviceLabel(name)}.plist`);
}

function systemdUnitPath(name) {
	return `/etc/systemd/system/${name}.service`;
}

/** Windows: per-user config dir (%APPDATA%\pi-web-ui) holding the ps1/vbs launchers + pid file. */
function winServiceDir() {
	return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "pi-web-ui");
}

function winCmdPath(name) {
	return join(winServiceDir(), `${name}.cmd`);
}

function winPs1Path(name) {
	return join(winServiceDir(), `${name}.ps1`);
}

function winVbsPath(name) {
	return join(winServiceDir(), `${name}.vbs`);
}

function winTaskXmlPath(name) {
	return join(winServiceDir(), `${name}.xml`);
}

/** Windows log file (per service name — multiple services must not share one log). */
function winLogPath(name) {
	return join(homedir(), name === "pi-web-ui" ? "pi-web-ui.log" : `pi-web-ui-${name}.log`);
}

/** True when a scheduled task with this name exists (schtasks exits 0). */
function winTaskExists(name) {
	return spawnSync("schtasks", ["/Query", "/TN", name], { stdio: "ignore" }).status === 0;
}

/** Windows: per-user autostart registry key (HKCU — writable without admin). */
function winRunKeyName() {
	return "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
}

/** True when the per-user autostart Run key value exists. */
function winRunKeyInstalled(name) {
	return (
		spawnSync("reg", ["query", `HKCU\\${winRunKeyName()}`, "/v", name], {
			stdio: "ignore",
		}).status === 0
	);
}

/** Set the per-user autostart Run key value (no admin needed for HKCU). */
function winRunKeySet(name, value) {
	run("reg", ["add", `HKCU\\${winRunKeyName()}`, "/v", name, "/t", "REG_SZ", "/d", value, "/f"], { silent: true });
}

/** Remove the per-user autostart Run key value (missing key is a no-op). */
function winRunKeyDelete(name) {
	run("reg", ["delete", `HKCU\\${winRunKeyName()}`, "/v", name, "/f"], { ignoreError: true, silent: true });
}

// ---------------------------------------------------------------------------
// 桌面快捷方式（server shortcut）
// ---------------------------------------------------------------------------

const SHORTCUT_LNK_NAME = "pi-web-ui.lnk"; // Windows 桌面快捷方式
const SHORTCUT_MAC_NAME = "pi-web-ui.command"; // macOS 双击启动器
const SHORTCUT_LINUX_NAME = "pi-web-ui.desktop"; // Linux 桌面图标

/** 快捷方式图标（品牌 .ico，随包发布；.lnk / .desktop 指向它）。 */
const APP_ICO_NAME = "pi-web-ui-logo.ico"; // 复制到用户目录后的稳定文件名（避开 pi-web-ui.ico —— Windows 对该路径有损坏的图标缓存残留，见 issue #xxx）
const APP_ICO_SOURCE = join(BIN_DIR, "..", "web", "public", "icon.ico"); // 包内品牌图标源文件（10 帧多分辨率，DPI 密度帧保证桌面/任务栏各尺寸颜色不失真）
/** Branded SVG logo (source of truth: web/public/favicon.svg) — used on Linux. */
const APP_SVG_PACKAGE = join(BIN_DIR, "..", "web", "public", "favicon.svg");

/** Windows: per-user copy of the branded .ico (stable path for the .lnk icon). */
function winIcoPath() {
	return join(winServiceDir(), APP_ICO_NAME);
}

/** Full path to Windows PowerShell. Prefers pwsh.exe (PowerShell 7) when it is
 * resolvable on PATH: some machines ship Windows PowerShell 5.1 as a broken
 * stub whose launch fails silently, so probe for a working shell first and
 * fall back to the built-in path. */
function winPowershell() {
	const which = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8" });
	if (which.status === 0) {
		const first = (which.stdout ?? "").trim().split(/\r?\n/)[0];
		if (first) return first;
	}
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Full path to wscript.exe — a console-free host (no conhost window, so no black
 * console box ever appears in the taskbar on double-click). Used as the .lnk target;
 * it launches the .ps1 hidden via a thin VBS launcher. */
function winWscript() {
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
}

/**
 * The node binary the launcher scripts must bake in: the executable this
 * process itself runs on. Under Bun this resolves to bun, so a Bun-hosted
 * install never bakes in pi.exe.
 */
function resolveNode() {
	return process.execPath;
}

/**
 * Resolve the real node binary. fnm/volta/nvm shims (e.g. fnm_multishells)
 * point into temp dirs that vanish when the installing shell exits — the
 * baked-in launcher scripts must use the stable real path instead.
 * Also applies resolveNode() so Bun-hosted pi never bakes in pi.exe.
 */
function realNode() {
	try {
		return realpathSync(resolveNode());
	} catch {
		return resolveNode();
	}
}

/** Windows: launcher ps1 the desktop .lnk runs (hidden). */
function winShortcutPs1Path(name) {
	return join(winServiceDir(), `${name}-shortcut.ps1`);
}

/** Windows: launcher vbs the desktop .lnk actually runs (wscript.exe, console-free). */
function winShortcutVbsPath(name) {
	return join(winServiceDir(), `${name}-shortcut.vbs`);
}

/** Windows: PID file of a shortcut-started (no scheduled task) instance. */
function winPidFilePath(name) {
	return join(winServiceDir(), `${name}.pid`);
}

/** Read the recorded PID of a shortcut-started Windows instance. */
function winReadPid(name) {
	try {
		const pid = Number(readFileSync(winPidFilePath(name), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** True when a PID exists (signal 0; EPERM means exists but not ours). */
function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

/** Single-quote a string for embedding in a POSIX shell script. */
function shQuote(s) {
	return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Windows shortcut launcher. Double-click the .lnk → this script runs hidden:
 * server already up → just open the browser; autostart service installed
 * (HKCU Run key + wscript/VBS launcher) → start it (manageable via `server
 * stop`); otherwise run the server in the foreground of this hidden window and
 * record its PID so `server stop` / `server uninstall` can terminate it too.
 */
function buildWinShortcutPs1(env, cwd, taskName, url, logPath, pidPath) {
	const sets = Object.entries(env)
		.map(([k, v]) => `$env:${k} = ${psQuote(v)}`)
		.join("\r\n");
	const node = realNode();
	return [
		"# Generated by: pi-web-ui server shortcut (rerun to change)",
		"# Runs hidden from the desktop shortcut: if the server is already up it",
		"# opens the browser; the autostart service (if installed) is started;",
		"# otherwise the server runs in the foreground of this hidden window and",
		"# its PID is recorded so `server stop` / `server uninstall` can stop it.",
		"$ErrorActionPreference = 'Continue'",
		`$url = ${psQuote(url)}`,
		`$health = ${psQuote(url + "/api/health")}`,
		`$svcName = ${psQuote(taskName)}`,
		`$pidFile = ${psQuote(pidPath)}`,
		`$log = ${psQuote(logPath)}`,
		"",
		"function Test-Up {",
		"  try { return (Invoke-WebRequest -Uri $health -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }",
		"}",
		"function Open-Browser { Start-Process $url | Out-Null }",
		"",
		"# 已在运行 → 直接打开浏览器",
		"if (Test-Up) { Open-Browser; exit 0 }",
		"",
		"# 已安装自启服务（HKCU Run 键 + wscript 隐藏启动）→ 走服务启动（server stop 可管理）",
		"$vbs = Join-Path $env:APPDATA ('pi-web-ui\\' + $svcName + '.vbs')",
		"if (Test-Path $vbs) {",
		"  wscript.exe $vbs",
		"  for ($i = 0; $i -lt 120; $i++) {",
		"    Start-Sleep -Milliseconds 250",
		"    if (Test-Up) { Open-Browser; exit 0 }",
		"  }",
		"  Write-Host ('✖ pi-web-ui 服务未在 30 秒内就绪，请查看日志: ' + $log)",
		"  exit 1",
		"}",
		"",
		"# 未安装服务 → 在本隐藏窗口中前台运行（记录 PID，server stop 可停止）",
		`$PID | Out-File -Encoding ascii $pidFile`,
		sets,
		`Set-Location ${psQuote(cwd)}`,
		"# 后台轮询，就绪后打开浏览器（与前台 node 并行）",
		"$job = Start-Job -ScriptBlock { param($u)",
		"  $h = $u + '/api/health'",
		"  for ($i = 0; $i -lt 120; $i++) {",
		"    Start-Sleep -Milliseconds 250",
		"    try { if ((Invoke-WebRequest -Uri $h -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { Start-Process $u | Out-Null; break } } catch {}",
		"  }",
		"} -ArgumentList $url",
		`& ${psQuote(node)} ${HAS_SDK_HOOK ? `--import ${psQuote(pathToFileURL(SDK_HOOK).href)} ` : ""}${psQuote(SERVER_ENTRY)} *>> $log`,
		"Remove-Item $pidFile -ErrorAction SilentlyContinue",
		"",
	].join("\r\n");
}

/**
 * Build the tiny VBS launcher that starts a .ps1 *without* creating any console
 * host: wscript.exe has no console, and WScript.Shell.Run(…, 0, False) launches
 * the child hidden and returns at once (0 = hidden window, False = don't wait).
 * Used by both the desktop .lnk and the logon autostart service. Note:
 * `powershell -WindowStyle Hidden` alone is unreliable when Windows itself
 * spawns the process (Task Scheduler) — the console window can still show;
 * this launcher never creates one at all.
 */
function buildWinHiddenVbs(ps1Path) {
	// 可执行文件必须带引号：winPowershell() 常返回 `C:\Program Files\PowerShell\7\pwsh.exe`，
	// 含空格且未加引号时 WScript.Shell.Run 找不到文件，直接报 80070002（系统找不到指定的文件）。
	const cmd = `"${winPowershell()}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`;
	// VBScript 字符串没有 \" 转义（也没有 \uXXXX），内嵌引号必须写成 ""；
	// 不能用 JSON.stringify —— 它输出 \" 会在 VBScript 里提前结束字符串（语句未结束 800A0401），
	// 且会把非 ASCII 路径转成 \uXXXX 字面量（wscript 不识别，中文用户名直接变成乱码路径）。
	const vbsCmd = cmd.replace(/"/g, '""');
	return [
		"Option Explicit",
		"Dim sh, cmd",
		'Set sh = CreateObject("WScript.Shell")',
		`cmd = "${vbsCmd}"`,
		"sh.Run cmd, 0, False",
		"Set sh = Nothing",
		"",
	].join("\r\n");
}

/**
 * Create the Windows desktop .lnk via WScript.Shell COM (correct Desktop path
 * even with OneDrive redirection). Target is powershell.exe with
 * -WindowStyle Hidden so nothing flashes on double-click.
 */
function installWinShortcut(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir, engine, host, agentDir);
	// The server binds 127.0.0.1 by default; PowerShell 7's Invoke-WebRequest
	// resolves `localhost` to ::1 first and hangs until TimeoutSec when nothing
	// listens on IPv6, making the health probe misfire ("server not running").
	// Pin the probe (and the opened URL) to the IPv4 loopback the server uses.
	const url = `http://127.0.0.1:${port}`;
	const ps1Path = winShortcutPs1Path(name);
	const ps1 = buildWinShortcutPs1(env, cwd, name, url, winLogPath(name), winPidFilePath(name));
	if (opts.print) {
		console.log(`# ${ps1Path}\n${ps1}`);
		return;
	}
	mkdirSync(dirname(ps1Path), { recursive: true });
	writeFileSync(ps1Path, "\uFEFF" + ps1, "utf8"); // PS 5.1 需要 BOM
	// wscript host + VBS launcher: no console window / taskbar black box on double-click.
	const vbsPath = winShortcutVbsPath(name);
	writeFileSync(vbsPath, "\uFEFF" + buildWinHiddenVbs(ps1Path), "utf16le"); // wscript 只认 UTF-16/ANSI，UTF-8 BOM 会报“无效字符”，中文路径用 utf16le + BOM
	// 把品牌图标准备好：复制到用户目录（.lnk 图标指向稳定路径）
	if (existsSync(APP_ICO_SOURCE)) {
		copyFileSync(APP_ICO_SOURCE, winIcoPath());
	} else {
		console.log(
			ZH
				? `⚠ 未找到品牌图标 ${APP_ICO_SOURCE}，快捷方式将使用默认图标`
				: `⚠ Brand icon not found ${APP_ICO_SOURCE}, shortcut will use the default icon`,
		);
	}
	const powershell = winPowershell();
	const ps = [
		"$ErrorActionPreference = 'Stop'",
		"$ws = New-Object -ComObject WScript.Shell",
		"$desktop = [Environment]::GetFolderPath('Desktop')",
		`$lnk = $ws.CreateShortcut((Join-Path $desktop ${psQuote(SHORTCUT_LNK_NAME)}))`,
		`$lnk.TargetPath = ${psQuote(winWscript())}`,
		`$lnk.Arguments = ${psQuote(vbsPath)}`,
		`$lnk.WorkingDirectory = ${psQuote(cwd)}`,
		"$lnk.Description = 'pi-web-ui — 双击启动服务并打开浏览器'",
		`$lnk.IconLocation = ${psQuote(winIcoPath())} + ',0'`,
		"$lnk.Save()",
		`Write-Output (Join-Path $desktop ${psQuote(SHORTCUT_LNK_NAME)})`,
	].join("\r\n");
	const res = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
		encoding: "utf8",
	});
	if (res.status !== 0) {
		fail(
			ZH
				? `创建桌面快捷方式失败: ${(res.stderr || res.stdout || "").trim()}`
				: `Failed to create desktop shortcut: ${(res.stderr || res.stdout || "").trim()}`,
		);
	}
	const lnk = (res.stdout ?? "").trim();
	console.log(ZH ? `✅ 已创建桌面快捷方式: ${lnk}` : `✅ Desktop shortcut created: ${lnk}`);
	console.log(
		ZH
			? `   双击 : 服务未运行则启动（隐藏窗口，无黑窗），就绪后自动打开浏览器`
			: `   Launch    : double-click starts the service if not running (hidden window, no console), auto-opens browser when ready`,
	);
	console.log(
		ZH
			? `   停止 : pi-web-ui server stop（快捷方式启动的实例也会一并停止）`
			: `   Stop      : pi-web-ui server stop (also stops instances launched by the shortcut)`,
	);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
}

/** macOS: double-clickable .command launcher (the .lnk equivalent). */
function buildMacShortcut(label, plist, url, env) {
	const exports = Object.entries(env)
		.map(([k, v]) => `export ${k}=${shQuote(v)}`)
		.join("\n");
	const node = realNode();
	return `#!/bin/bash
# pi-web-ui 启动器 — generated by: pi-web-ui server shortcut
# 双击运行：确保服务在运行，然后打开浏览器。
#   · 已安装 launchd 服务（登录自启）→ kickstart，图标主要用于「启动 + 打开」
#   · 未安装服务 → 在本终端前台运行（关闭窗口即停止）
LABEL=${shQuote(label)}
PLIST=${shQuote(plist)}
URL=${shQuote(url)}
LOG=/tmp/pi-web-ui-shortcut.log
NODE=${shQuote(node)}
ENTRY=${shQuote(SERVER_ENTRY)}
SDK_HOOK_ARG=${HAS_SDK_HOOK ? `${shQuote("--import")} ${shQuote(SDK_HOOK)} ` : ""}
${exports}

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart "gui/$(id -u)/$LABEL"
elif [ -f "$PLIST" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  # 未安装服务：在本终端前台运行服务器（关闭窗口即停止）
  "$NODE" $SDK_HOOK_ARG"$ENTRY" >>"$LOG" 2>&1 &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
fi

# 等服务就绪后打开浏览器（最多约 30 秒）
for i in $(seq 1 120); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
open "$URL"
if [ -n "\${SERVER_PID:-}" ]; then wait "$SERVER_PID"; fi
`;
}

function installMacShortcut(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const url = `http://localhost:${port}`;
	const script = buildMacShortcut(
		serviceLabel(name),
		launchAgentPlist(name),
		url,
		serviceEnv(port, cwd, dataDir, engine, host, agentDir),
	);
	const path = join(homedir(), "Desktop", SHORTCUT_MAC_NAME);
	if (opts.print) {
		console.log(`# ${path}\n${script}`);
		return;
	}
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	console.log(ZH ? `✅ 已创建桌面启动器: ${path}` : `✅ Desktop launcher created: ${path}`);
	console.log(
		ZH
			? `   双击 : 确保服务运行并打开浏览器；未安装服务时在本终端前台运行`
			: `   Launch    : double-click ensures the service is running and opens browser; runs in foreground in this terminal if service not installed`,
	);
	console.log(
		ZH
			? `   说明 : macOS 没有 Windows 式快捷方式，这是等价的 .command 启动器；`
			: `   Notes     : macOS has no Windows-style shortcuts; this is the equivalent .command launcher;`,
	);
	console.log(
		ZH
			? `          launchd 服务登录自启，图标主要用于快速「启动 + 打开浏览器」`
			: `               launchd service auto-starts at login, icon mainly for quick “start + open browser”`,
	);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
}

/** Linux: launcher script run by the .desktop icon. */
function buildLinuxStartScript(unitName, url) {
	const log = join(homedir(), ".local", "share", "pi-web-ui", "pi-web-ui.log");
	const node = realNode();
	return `#!/bin/bash
# pi-web-ui 启动器 — generated by: pi-web-ui server shortcut
# 双击运行：确保服务在运行，然后打开浏览器。
#   · systemd 单元已安装 → systemctl start（系统单元需要授权，失败则前台运行）
#   · 未安装 → 在本进程前台运行（终端关闭即停止）
LOG=${shQuote(log)}
URL=${shQuote(url)}
NODE=${shQuote(node)}
ENTRY=${shQuote(SERVER_ENTRY)}
SDK_HOOK_ARG=${HAS_SDK_HOOK ? `${shQuote("--import")} ${shQuote(SDK_HOOK)} ` : ""}
UNIT=${shQuote(unitName)}.service

if ! curl -sf "$URL/api/health" >/dev/null 2>&1; then
  systemctl start "$UNIT" 2>/dev/null || true
  if ! curl -sf "$URL/api/health" >/dev/null 2>&1; then
    mkdir -p "$(dirname "$LOG")"
    "$NODE" $SDK_HOOK_ARG"$ENTRY" >>"$LOG" 2>&1 &
    SERVER_PID=$!
    trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
  fi
fi

for i in $(seq 1 120); do
  curl -sf "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
xdg-open "$URL" >/dev/null 2>&1 &
if [ -n "\${SERVER_PID:-}" ]; then wait "$SERVER_PID"; fi
`;
}

function installLinuxShortcut(opts) {
	const { name, port } = serviceOptions(opts);
	const url = `http://localhost:${port}`;
	const scriptDir = join(homedir(), ".local", "share", "pi-web-ui");
	const scriptPath = join(scriptDir, `${name}-start.sh`);
	const desktopPath = join(homedir(), "Desktop", SHORTCUT_LINUX_NAME);
	const icoPath = join(scriptDir, APP_ICO_NAME); // 备用；优先 SVG
	const svgPath = join(scriptDir, "pi-web-ui.svg");
	const script = buildLinuxStartScript(name, url);
	const desktopIcon = existsSync(APP_SVG_PACKAGE) ? svgPath : APP_ICO_NAME;
	const desktop = `[Desktop Entry]
Version=1.0
Type=Application
Name=pi-web-ui
Comment=启动 pi-web-ui 服务并打开浏览器
Exec=${shQuote(scriptPath)}
Icon=${shQuote(desktopIcon)}
Terminal=false
Categories=Network;WebBrowser;
`;
	if (opts.print) {
		console.log(`# ${scriptPath}\n${script}`);
		console.log(`# ${desktopPath}\n${desktop}`);
		return;
	}
	mkdirSync(scriptDir, { recursive: true });
	// 品牌图标（缺失时跳过，桌面自动回退默认图标）
	if (existsSync(APP_SVG_PACKAGE)) copyFileSync(APP_SVG_PACKAGE, svgPath);
	else if (existsSync(APP_ICO_SOURCE)) copyFileSync(APP_ICO_SOURCE, icoPath);
	writeFileSync(scriptPath, script);
	chmodSync(scriptPath, 0o755);
	writeFileSync(desktopPath, desktop);
	chmodSync(desktopPath, 0o755);
	// GNOME 需要标记可信才能双击运行
	run("gio", ["set", desktopPath, "metadata::trusted", "true"], {
		ignoreError: true,
		silent: true,
	});
	console.log(ZH ? `✅ 已创建桌面图标: ${desktopPath}` : `✅ Desktop icon created: ${desktopPath}`);
	console.log(
		ZH
			? `   GNOME 若提示「不受信任的应用程序」，右键选择 Allow Launching`
			: `   If GNOME prompts “untrusted application”, right-click and choose Allow Launching`,
	);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
}

/** Remove desktop shortcut artifacts created by `server shortcut`. */
function removeShortcut(name) {
	if (isWin) {
		for (const f of [winShortcutPs1Path(name), winShortcutVbsPath(name), winPidFilePath(name), winIcoPath()]) {
			if (existsSync(f)) rmSync(f);
		}
		spawnSync(
			winPowershell(),
			[
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`$d=[Environment]::GetFolderPath('Desktop');$p=Join-Path $d ${psQuote(SHORTCUT_LNK_NAME)};if(Test-Path $p){Remove-Item $p -Force}`,
			],
			{ stdio: "ignore" },
		);
	} else if (isMac) {
		const p = join(homedir(), "Desktop", SHORTCUT_MAC_NAME);
		if (existsSync(p)) rmSync(p);
	} else if (isLinux) {
		const p = join(homedir(), "Desktop", SHORTCUT_LINUX_NAME);
		if (existsSync(p)) rmSync(p);
		rmSync(join(homedir(), ".local", "share", "pi-web-ui"), {
			recursive: true,
			force: true,
		});
	}
}

/** Single-quote a string for embedding in a generated PowerShell script. */
function psQuote(s) {
	return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Build the PowerShell launcher the autostart service runs. Windows never sees
 * a console from it: the HKCU Run key launches wscript.exe → VBS → powershell
 * (hidden), so no black box can appear. The script sets the env, cd's to the
 * workspace, records its PID to <name>.pid (for `server stop`), then runs node
 * inside a watchdog loop — if node exits, it restarts after 10s (same
 * philosophy as launchd KeepAlive / systemd Restart=always). `server stop`
 * force-kills the recorded PID tree, which takes the loop down with it.
 */
function buildWinStartPs1(env, cwd, logPath, pidPath) {
	const sets = Object.entries(env)
		.map(([k, v]) => `$env:${k} = ${psQuote(v)}`)
		.join("\r\n");
	return [
		"# Generated by: pi-web-ui server install (rerun to change)",
		"# Runs the server with no console window (wscript+VBS launcher) and",
		"# restarts it if it crashes (watchdog, like launchd/systemd).",
		sets,
		`Set-Location ${psQuote(cwd)}`,
		`$PID | Out-File -Encoding ascii ${psQuote(pidPath)}`,
		"try {",
		"  while ($true) {",
		`    & ${psQuote(realNode())} ${HAS_SDK_HOOK ? `--import ${psQuote(pathToFileURL(SDK_HOOK).href)} ` : ""}${psQuote(SERVER_ENTRY)} *>> ${psQuote(logPath)}`,
		"    Start-Sleep 10",
		"  }",
		"} finally {",
		`  Remove-Item ${psQuote(pidPath)} -ErrorAction SilentlyContinue`,
		"}",
		"",
	].join("\r\n");
}

function esc(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Start the autostart service now: wscript runs the VBS hidden and exits at once. */
function launchWinService(vbsPath) {
	const child = spawn(winWscript(), [vbsPath], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
}

/**
 * PID 文件记录的是看门狗 PowerShell 的 $PID（winPowershell() 可能选 pwsh.exe），
 * node 是它的子进程 —— 这三者是本服务实例的合理映像名。taskkill /T /F 是树级强杀，
 * PID 若已退出被系统复用就会误杀无辜进程，所以杀前必须核对映像名。
 */
const WIN_SERVICE_IMAGE_RE = /^(powershell|pwsh|node)\.exe$/i;

/** tasklist 查询 PID 对应的进程映像名；查询失败/无此进程返回 null（无法核实）。 */
function winPidImageName(pid) {
	const res = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
	if (res.status !== 0) return null;
	const line = (res.stdout ?? "").split(/\r?\n/).find((l) => l.trim());
	if (!line) return null; // tasklist 的 "INFO: 无任务" 输出没有 CSV 行
	return (line.match(/^"([^"]+)"/) ?? [])[1] ?? null;
}

/** Kill a running Windows instance via its PID file (whole tree). */
function stopWinInstance(name) {
	const pid = winReadPid(name);
	if (pid) {
		if (pidAlive(pid)) {
			// PID 可能已退出并被系统复用给别的进程：杀前核对映像名，不符则警告并跳过，
			// 绝不 taskkill /T /F 盲杀。macOS/Linux 无按 PID 杀的路径（launchctl/systemctl
			// 按服务单元管理），只有 Windows 需要这道核对。
			const image = winPidImageName(pid);
			if (image === null) {
				console.warn(
					ZH
						? `⚠ 无法核实 PID ${pid} 的进程映像名（tasklist 不可用或进程已消失），跳过强制结束以防误杀`
						: `⚠ Cannot verify the image name of PID ${pid} (tasklist unavailable or process gone), skipping force-kill to avoid killing an unrelated process`,
				);
			} else if (!WIN_SERVICE_IMAGE_RE.test(image)) {
				console.warn(
					ZH
						? `⚠ PID ${pid} 现在是 ${image}，不是本服务的进程（PID 可能已被复用），跳过强制结束`
						: `⚠ PID ${pid} is now ${image}, not a pi-web-ui process (PID may have been reused), skipping force-kill`,
				);
			} else {
				run("taskkill", ["/PID", String(pid), "/T", "/F"], {
					ignoreError: true,
					silent: true,
				});
				// taskkill /F 异步生效：等到进程树真正退出（restart 需要避免端口竞争）
				const deadline = Date.now() + 5000;
				while (Date.now() < deadline && pidAlive(pid)) {
					spawnSync("ping", ["-n", "2", "127.0.0.1"], { stdio: "ignore" });
				}
			}
		}
		rmSync(winPidFilePath(name), { force: true });
	}
}

/** Build the launchd plist XML. */
function buildPlist(label, cwd, env) {
	const entries = Object.entries(env)
		.map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by: pi-web-ui server install (do not edit by hand — rerun to change) -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
${
	HAS_SDK_HOOK ? `    <string>--import</string>\n    <string>${esc(SDK_HOOK)}</string>\n` : ""
}    <string>${esc(SERVER_ENTRY)}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it crashes -->
  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${esc(cwd)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>

  <key>StandardOutPath</key>
  <string>/tmp/pi-web-ui.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/pi-web-ui.err</string>
</dict>
</plist>
`;
}

/** systemd quoted strings use C-style escapes; %% prevents specifier expansion. */
function systemdQuote(value) {
	return JSON.stringify(String(value)).replace(/%/g, "%%");
}

/**
 * systemd paths (WorkingDirectory=) must NOT be quoted: unlike Environment= and
 * ExecStart=, the path directives do not strip surrounding double quotes, so
 * WorkingDirectory="/home/me/work" makes systemd fail with "path is not absolute".
 * The whole (trimmed) value is the path, so inner spaces need no escaping —
 * only % has to be doubled to survive specifier expansion.
 */
function systemdPath(value) {
	return String(value).replace(/%/g, "%%");
}

/** Build the systemd unit file. */
function buildUnit(cwd, env) {
	const envLines = Object.entries(env)
		.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
		.join("\n");
	const lowPort = Number(env.PI_WEB_PORT) > 0 && Number(env.PI_WEB_PORT) < 1024;
	const capabilities = lowPort
		? "CapabilityBoundingSet=CAP_NET_BIND_SERVICE\nAmbientCapabilities=CAP_NET_BIND_SERVICE\n"
		: "";
	return `# Generated by: pi-web-ui server install (do not edit by hand — rerun to change)
[Unit]
Description=pi-web-ui — web chat for the pi coding agent
After=network.target

[Service]
Type=simple
User=${process.env.SUDO_USER ?? userInfo().username}
WorkingDirectory=${systemdPath(cwd)}
${envLines}
${capabilities}ExecStart=${JSON.stringify(NODE)}${HAS_SDK_HOOK ? ` --import ${JSON.stringify(SDK_HOOK)}` : ""} ${JSON.stringify(SERVER_ENTRY)}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

/** If not root on Linux, re-exec the same server command through sudo. */
function ensureRootForSystemctl() {
	if (typeof process.getuid === "function" && process.getuid() === 0) return;
	// process.argv = [node, <bin>, "server", <action>, ...rest] — forward
	// everything after "server" so flags like --port/--cwd survive.
	const res = spawnSync("sudo", [NODE, fileURLToPath(import.meta.url), "server", ...process.argv.slice(3)], {
		stdio: "inherit",
	});
	process.exit(res.status ?? 1);
}

/** Resolve the effective HTTP port: --port > $PI_WEB_PORT > 8787. */
function effectivePort(opts) {
	return String(opts.port ?? process.env.PI_WEB_PORT ?? "8787");
}

/**
 * 服务名（--name）统一校验。name 会被原样拼进 systemd unit 文件名
 * (/etc/systemd/system/<name>.service)、Windows 启动脚本/PID 文件路径
 * (%APPDATA%\pi-web-ui\<name>.ps1) 与 HKCU Run 键值名 —— 不限字符集时，
 * 路径分隔符/引号/空格都能进这些拼接点（路径穿越或 unit 内容注入）。
 * 收紧为：字母或数字开头，仅字母/数字/-/_，最长 64 字符。
 */
function serviceName(opts) {
	const name = opts.name ?? "pi-web-ui";
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
		fail(
			ZH
				? `无效服务名 "${name}"（仅限字母/数字/-/_，字母或数字开头，最长 64 字符）`
				: `Invalid service name "${name}" (alphanumeric, "-" and "_" only; must start with a letter or digit; max 64 chars)`,
		);
	return name;
}

/** Shared option normalization for install. */
function serviceOptions(opts) {
	const name = serviceName(opts);
	const port = effectivePort(opts);
	if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		fail(ZH ? `无效端口: ${port}` : `Invalid port: ${port}`);
	}
	// 服务默认工作区（issue #295）：安装命令的当前目录不可靠（例如 Windows 提权提示符
	// 默认在 C:\WINDOWS\system32），且直接拿用户主目录当 agent cwd 会让 SDK 的
	// resourceLoader.reload 等同步目录扫描落在 $HOME 上 —— 家目录下的 iCloud 占位符、
	// 外部/网络卷坏挂载会让 scandir/open 在内核里挂起，整个事件循环假死（hello 后永远
	// 收不到 ready）。默认落到干净的 ~/pi-web-ui 子目录（不存在即建）；显式 --cwd /
	// PI_WEB_CWD 保持原语义（不存在则报错）。前台启动仍默认当前目录。
	const explicitCwd = opts.cwd ?? process.env.PI_WEB_CWD;
	const cwd = resolve(explicitCwd ?? join(homedir(), "pi-web-ui"));
	if (explicitCwd) {
		if (!existsSync(cwd)) fail(ZH ? `工作目录不存在: ${cwd}` : `Working directory does not exist: ${cwd}`);
	} else if (!existsSync(cwd)) {
		mkdirSync(cwd, { recursive: true });
	}
	let dataDir;
	if (opts.dataDir) {
		dataDir = resolve(opts.dataDir);
	} else if (process.env.PI_WEB_DATA_DIR) {
		dataDir = resolve(process.env.PI_WEB_DATA_DIR);
	}
	// 引擎/监听地址/agent 配置目录：flag 优先，环境变量后备（token 不走命令行，仅环境变量）。
	const engine = opts.engine ?? process.env.PI_WEB_ENGINE ?? "pi";
	if (engine !== "pi" && engine !== "dsh")
		fail(ZH ? `无效引擎: ${engine}（仅支持 pi / dsh）` : `Invalid engine: ${engine} (pi and dsh only)`);
	const host = opts.host ?? process.env.PI_WEB_HOST;
	const agentDir = opts.agentDir ? resolve(opts.agentDir) : process.env.PI_CODING_AGENT_DIR;
	return { name, port, cwd, dataDir, engine, host, agentDir };
}

function serviceEnv(port, cwd, dataDir, engine, host, agentDir, service = {}) {
	const env = {
		PI_WEB_PORT: port,
		PI_WEB_CWD: cwd,
	};
	// 启动来源标记（见 server/launch-origin.ts）：只有真正被平台服务管理器托管的
	// 启动器才写。桌面快捷方式 / .command 在「未安装服务」时是前台跑（退出不回来），
	// 不能带这个标记，所以它们不传 service。已装好的老服务没有这两个变量，服务端
	// 仍能靠运行时判据（XPC_SERVICE_NAME / INVOCATION_ID / PID 文件）认出来。
	if (service.name) {
		env.PI_WEB_LAUNCHED_BY = "service";
		env.PI_WEB_SERVICE_NAME = service.name;
	}
	// Interactive Windows tasks inherit the user's PATH; only systemd/launchd
	// run with a minimal environment that needs an explicit PATH.
	if (!isWin) env.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	// Same for the locale: launchd/systemd drop LANG/LC_ALL, and a C-locale
	// shell garbles multibyte input in the terminal (UTF-8 continuation
	// bytes 0x80–0x9F rendered as C1 control chars). Bake the installing
	// shell's locale into the service env so spawned terminals are UTF-8.
	if (!isWin && process.env.LANG) env.LANG = process.env.LANG;
	if (!isWin && process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
	if (dataDir) env.PI_WEB_DATA_DIR = dataDir;
	if (engine === "dsh") env.PI_WEB_ENGINE = "dsh"; // 仅非默认引擎才烘焙，保持服务单元简洁
	if (host) env.PI_WEB_HOST = host;
	if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
	return env;
}

function installLaunchd(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	const content = buildPlist(label, cwd, serviceEnv(port, cwd, dataDir, engine, host, agentDir, { name }));
	if (opts.print) {
		console.log(`# ${plist}\n${content}`);
		return;
	}
	// Unload any existing instance (ignore "not loaded"), then (re)install.
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(plist, content);
	run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
	console.log(ZH ? `✅ 已安装并启动 launchd 服务 ${label}` : `✅ launchd service installed and started ${label}`);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
	console.log(ZH ? `   访问 : http://localhost:${port}` : `   URL       : http://localhost:${port}`);
	console.log(
		ZH ? `   日志 : /tmp/pi-web-ui.log  /tmp/pi-web-ui.err` : `   Log       : /tmp/pi-web-ui.log  /tmp/pi-web-ui.err`,
	);
	console.log(
		ZH
			? `   管理 : pi-web-ui server status|restart|stop|uninstall`
			: `   Manage    : pi-web-ui server status|restart|stop|uninstall`,
	);
	console.log(
		ZH
			? `   提示 : pi-web-ui server shortcut 可在桌面创建「一键启动」图标`
			: `   Tip       : pi-web-ui server shortcut creates a “one-click launch” icon on the desktop`,
	);
}

/** Elevate only the privileged operation, not the CLI that captures the user's environment.
 * Unit contents travel through stdin, never argv (which may expose the token via ps). */
function runSystemdRoot(command, args, input) {
	const root = typeof process.getuid === "function" && process.getuid() === 0;
	const result = spawnSync(root ? command : "sudo", root ? args : ["--", command, ...args], {
		input,
		stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
	});
	if (result.error)
		fail(ZH ? `无法执行 ${command}: ${result.error.message}` : `Cannot run ${command}: ${result.error.message}`);
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function installSystemd(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir, engine, host, agentDir, { name });
	if (process.env.PI_WEB_TOKEN !== undefined) env.PI_WEB_TOKEN = process.env.PI_WEB_TOKEN;
	const content = buildUnit(cwd, env);
	const unitPath = systemdUnitPath(name);
	if (opts.print) {
		console.log(`# ${unitPath}\n${content}`);
		return;
	}
	// Generated units can contain credentials. install also corrects an existing unit's mode.
	// Stage through a temp file: `install /dev/stdin` fails on some hosts (WSL) with
	// ENXIO when stdin is a pipe rather than a tty.
	const staged = join(tmpdir(), `pi-web-ui-${name}-${process.pid}.service`);
	writeFileSync(staged, content, { mode: 0o600 });
	try {
		runSystemdRoot("install", ["-m", "600", staged, unitPath]);
	} finally {
		rmSync(staged, { force: true });
	}
	runSystemdRoot("systemctl", ["daemon-reload"]);
	runSystemdRoot("systemctl", ["enable", `${name}.service`]);
	// enable --now does not restart an already-active unit after configuration changes.
	runSystemdRoot("systemctl", ["restart", `${name}.service`]);
	console.log(
		ZH ? `✅ 已安装并启动 systemd 服务 ${name}.service` : `✅ systemd service installed and started ${name}.service`,
	);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
	console.log(ZH ? `   访问 : http://localhost:${port}` : `   URL       : http://localhost:${port}`);
	console.log(ZH ? `   日志 : journalctl -u ${name}.service -f` : `   Log       : journalctl -u ${name}.service -f`);
	console.log(
		ZH
			? `   管理 : pi-web-ui server status|restart|stop|uninstall`
			: `   Manage    : pi-web-ui server status|restart|stop|uninstall`,
	);
	console.log(
		ZH
			? `   提示 : pi-web-ui server shortcut 可在桌面创建「一键启动」图标`
			: `   Tip       : pi-web-ui server shortcut creates a “one-click launch” icon on the desktop`,
	);
}

function uninstallLaunchd(opts) {
	const name = serviceName(opts);
	const label = serviceLabel(name);
	const plist = launchAgentPlist(name);
	run("launchctl", ["bootout", `gui/${uid()}/${label}`], {
		ignoreError: true,
		silent: true,
	});
	if (existsSync(plist)) rmSync(plist);
	removeShortcut(name);
	console.log(
		ZH
			? `🗑  已卸载 ${label}（plist 已删除，不再开机自启）`
			: `🗑  Uninstalled ${label} (plist deleted, no longer auto-starts at login)`,
	);
	console.log(ZH ? `🗑  已移除桌面快捷方式` : `🗑  Desktop shortcut removed`);
}

function uninstallSystemd(opts) {
	const name = serviceName(opts);
	ensureRootForSystemctl();
	run("systemctl", ["disable", "--now", `${name}.service`], {
		ignoreError: true,
	});
	const unitPath = systemdUnitPath(name);
	if (existsSync(unitPath)) rmSync(unitPath);
	run("systemctl", ["daemon-reload"]);
	removeShortcut(name);
	console.log(
		ZH
			? `🗑  已卸载 ${name}.service（不再开机自启）`
			: `🗑  Uninstalled ${name}.service (no longer auto-starts at login)`,
	);
	console.log(ZH ? `🗑  已移除桌面快捷方式` : `🗑  Desktop shortcut removed`);
}

function installWindows(opts) {
	const { name, port, cwd, dataDir, engine, host, agentDir } = serviceOptions(opts);
	const env = serviceEnv(port, cwd, dataDir, engine, host, agentDir, { name });
	const ps1Path = winPs1Path(name);
	const vbsPath = winVbsPath(name);
	const pidPath = winPidFilePath(name);
	const ps1 = buildWinStartPs1(env, cwd, winLogPath(name), pidPath);
	const vbs = buildWinHiddenVbs(ps1Path);
	// HKCU Run 键值：wscript.exe 以隐藏方式启动 VBS（无控制台，登录后自启）
	const runValue = `"${winWscript()}" "${vbsPath}"`;
	if (opts.print) {
		console.log(`# ${ps1Path}\n${ps1}`);
		console.log(`# ${vbsPath}\n${vbs}`);
		console.log(ZH ? `# 登录自启（HKCU Run 键，无需管理员）` : `# Login auto-start (HKCU Run key, no admin required)`);
		console.log(`  reg add "HKCU\\${winRunKeyName()}" /v ${name} /t REG_SZ /d "${runValue}" /f`);
		return;
	}
	mkdirSync(dirname(ps1Path), { recursive: true });
	// UTF-8 with BOM: Windows PowerShell 5.1 misreads BOM-less UTF-8 as ANSI.
	writeFileSync(ps1Path, "\uFEFF" + ps1, "utf8");
	// wscript host + VBS launcher: no console window / taskbar black box ever.
	writeFileSync(vbsPath, "\uFEFF" + vbs, "utf16le"); // wscript 只认 UTF-16/ANSI，UTF-8 BOM 会报“无效字符”
	// 迁移：移除旧版 .cmd 包装与历史计划任务（普通用户下 schtasks 无法创建，改为 Run 键）。
	if (existsSync(winCmdPath(name))) rmSync(winCmdPath(name));
	if (winTaskExists(name)) {
		run("schtasks", ["/End", "/TN", name], {
			ignoreError: true,
			silent: true,
		});
		// /End 异步生效：稍候再删任务，避免新实例与旧实例端口竞争
		spawnSync("ping", ["-n", "2", "127.0.0.1"], { stdio: "ignore" });
		run("schtasks", ["/Delete", "/TN", name, "/F"], {
			ignoreError: true,
			silent: true,
		});
	}
	winRunKeySet(name, runValue);
	launchWinService(vbsPath);
	console.log(
		ZH
			? `✅ 已安装并启动 ${name}（登录自启 · HKCU Run 键 · 无需管理员）`
			: `✅ Installed and started ${name} (login auto-start · HKCU Run key · no admin required)`,
	);
	console.log(ZH ? `   窗口 : wscript 隐藏启动，无黑窗` : `   Window    : wscript hidden launch, no console`);
	console.log(ZH ? `   端口 : ${port}` : `   Port      : ${port}`);
	console.log(ZH ? `   目录 : ${cwd}` : `   Directory : ${cwd}`);
	console.log(ZH ? `   访问 : http://localhost:${port}` : `   URL       : http://localhost:${port}`);
	console.log(ZH ? `   日志 : ${winLogPath(name)}` : `   Log       : ${winLogPath(name)}`);
	console.log(
		ZH
			? `   说明 : 崩溃后 10 秒自动重启（看门狗）；stop 停止，uninstall 移除`
			: `   Notes     : auto-restarts 10 s after crash (watchdog); stop to stop, uninstall to remove`,
	);
	console.log(
		ZH
			? `   管理 : pi-web-ui server status|restart|stop|uninstall`
			: `   Manage    : pi-web-ui server status|restart|stop|uninstall`,
	);
	console.log(
		ZH
			? `   提示 : pi-web-ui server shortcut 可在桌面创建「一键启动」图标`
			: `   Tip       : pi-web-ui server shortcut creates a “one-click launch” icon on the desktop`,
	);
}

function uninstallWindows(opts) {
	const name = serviceName(opts);
	winRunKeyDelete(name);
	// 历史计划任务（旧版本 install 可能注册过）
	if (winTaskExists(name)) {
		run("schtasks", ["/Delete", "/TN", name, "/F"], { ignoreError: true });
	}
	// 运行中的实例（服务或快捷方式启动，均记录 PID 文件）
	stopWinInstance(name);
	for (const f of [winCmdPath(name), winPs1Path(name), winVbsPath(name), winTaskXmlPath(name)]) {
		if (existsSync(f)) rmSync(f);
	}
	removeShortcut(name);
	console.log(
		ZH
			? `🗑  已卸载 ${name}（登录自启已移除，不再开机自启）`
			: `🗑  Uninstalled ${name} (login auto-start removed, no longer auto-starts at login)`,
	);
	console.log(ZH ? `🗑  已移除桌面快捷方式` : `🗑  Desktop shortcut removed`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Local control socket (status / quiesce / unquiesce). The server listens on
// a mode-0600 Unix socket (POSIX) or a named pipe (Windows) under its data
// dir; same path rules as server/control-socket.ts so the CLI and server
// always agree without sharing code.
// ---------------------------------------------------------------------------

/** Resolve the control socket path for the given options. */
function controlPath(opts) {
	const dir = opts.dataDir
		? resolve(opts.dataDir)
		: process.env.PI_WEB_DATA_DIR
			? resolve(process.env.PI_WEB_DATA_DIR)
			: join(homedir(), ".pi-web");
	return isWin ? `\\\\.\\pipe\\pi-web-ui-${effectivePort(opts)}` : join(dir, "pi-web-ui.sock");
}

/** Send one control command to a RUNNING server; resolves null if unreachable. */
function controlCommand(opts, cmd) {
	const path = controlPath(opts);
	return new Promise((resolvePromise) => {
		const sock = createConnection(path);
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolvePromise(v);
		};
		const timer = setTimeout(() => finish(null), 3000);
		let buf = "";
		sock.on("connect", () => sock.write(JSON.stringify({ cmd }) + "\n"));
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, nl)));
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
	});
}

/** Append the live server status (via the control socket) to `server status`. */
async function printLiveStatus(opts) {
	const st = await controlCommand(opts, "status");
	if (!st || !st.ok) {
		console.log(
			ZH
				? "   (服务器未运行或控制通道不可达 — 启动后可查 server status 实时信息)"
				: "   (server not running or control channel unreachable — start it, then check server status for live info)",
		);
		return;
	}
	console.log(ZH ? "   --- 实时状态 (control socket) ---" : "   --- live status (control socket) ---");
	console.log(ZH ? `   版本 : ${st.version} · PID ${st.pid}` : `   Version   : ${st.version} · PID ${st.pid}`);
	console.log(ZH ? `   目录 : ${st.cwd}` : `   Directory : ${st.cwd}`);
	// 启动来源（server/launch-origin.ts）：有 supervisor = 这个进程退出后会被自动
	// 拉起（server restart / 更新面板的「重启服务」才有意义）。
	console.log(
		ZH
			? `   启动 : ${
					st.service
						? `pi-web-ui 服务（${st.service.supervisor} · ${st.service.name}）`
						: "前台 / 开发模式（无 supervisor，退出不自动重启）"
				}`
			: `   Started   : ${
					st.service
						? `pi-web-ui service (${st.service.supervisor} · ${st.service.name})`
						: "foreground / dev mode (no supervisor, exit does not auto-restart)"
				}`,
	);
	console.log(
		ZH
			? `   排空 : ${st.quiesced ? `是（自 ${new Date(st.quiescedSince).toLocaleString()}）` : "否"}`
			: `   Drain     : ${st.quiesced ? `yes (since ${new Date(st.quiescedSince).toLocaleString()})` : "no"}`,
	);
	console.log(
		ZH
			? `   连接 : ${st.connectedClients} 个浏览器 · ${st.activeConversations} 个运行中对话 · ${st.pendingMessages} 条排队消息`
			: `   Conns     : ${st.connectedClients} browser · ${st.activeConversations} active session · ${st.pendingMessages} queued messages`,
	);
}

/** `server quiesce|unquiesce` — toggle the admission gate on a RUNNING server. */
async function setQuiesce(opts, on) {
	const st = await controlCommand(opts, on ? "quiesce" : "unquiesce");
	if (!st || !st.ok) {
		fail(
			ZH
				? `服务器未运行或控制通道不可达（${controlPath(opts)}）`
				: `Server not running or control channel unreachable (${controlPath(opts)})`,
		);
	}
	console.log(
		on
			? ZH
				? "⏸  已进入排空模式（quiesce）：拒绝新的对话/消息/编辑，存量运行继续跑完。\n" +
					"    跑完后用 pi-web-ui server unquiesce 恢复。"
				: "⏸  Quiesce mode active: new conversations/messages/edits rejected; existing runs continue to completion.\n" +
					"    Use pi-web-ui server unquiesce to resume when done."
			: ZH
				? "▶  已解除排空模式（unquiesce）：恢复接收新的对话/消息/编辑。"
				: "▶  Unquiesced: now accepting new conversations/messages/edits.",
	);
}

function controlService(action, opts) {
	const name = serviceName(opts);

	if (isMac) {
		const label = serviceLabel(name);
		const target = `gui/${uid()}/${label}`;
		const loaded = () => spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status === 0;

		if (action === "status") {
			if (loaded()) {
				const res = spawnSync("launchctl", ["print", target], {
					encoding: "utf8",
				});
				const state = (res.stdout.match(/state = (\w+)/) ?? [])[1] ?? "loaded";
				console.log(
					ZH ? `${label}: ${state}（已加载，开机自启中）` : `${label}: ${state} (loaded, auto-start enabled)`,
				);
			} else {
				console.log(
					ZH
						? `${label}: 未安装（运行 pi-web-ui server install 安装）`
						: `${label}: not installed (run pi-web-ui server install)`,
				);
			}
			return;
		}

		if (action === "start") {
			if (loaded()) {
				run("launchctl", ["kickstart", target]);
			} else {
				const plist = launchAgentPlist(name);
				if (!existsSync(plist)) {
					fail(
						ZH
							? `找不到 ${plist}，请先运行 pi-web-ui server install`
							: `Cannot find ${plist}, please run pi-web-ui server install first`,
					);
				}
				run("launchctl", ["bootstrap", `gui/${uid()}`, plist]);
			}
			console.log(ZH ? `✅ 已启动 ${label}` : `✅ Started ${label}`);
			return;
		}

		if (action === "restart") {
			if (!loaded())
				fail(
					ZH ? `${label} 未加载，请先 pi-web-ui server start` : `${label} not loaded, run pi-web-ui server start first`,
				);
			run("launchctl", ["kickstart", "-k", target]);
			console.log(ZH ? `✅ 已重启 ${label}` : `✅ Restarted ${label}`);
			return;
		}

		if (action === "stop") {
			run("launchctl", ["bootout", target], {
				ignoreError: true,
				silent: true,
			});
			console.log(
				ZH
					? `⏹  已停止 ${label}（已卸载，不再开机自启；start 恢复）`
					: `⏹  Stopped ${label} (uninstalled, auto-start removed; start to resume)`,
			);
			return;
		}

		fail(ZH ? `未知操作: ${action}` : `Unknown operation: ${action}`);
	}

	if (isLinux) {
		ensureRootForSystemctl();
		if (action === "status") {
			run("systemctl", ["status", `${name}.service`, "--no-pager"]);
			return;
		}
		run("systemctl", [action, `${name}.service`]);
		console.log(`✅ ${action} ${name}.service`);
		return;
	}

	if (isWin) {
		const installed = winRunKeyInstalled(name);
		const legacy = !installed && winTaskExists(name); // 旧版计划任务安装（未迁移）

		if (action === "status") {
			const pid = winReadPid(name);
			const instAlive = pid && pidAlive(pid);
			if (legacy) {
				console.log(
					ZH ? `${name}: 旧版计划任务安装（未迁移）` : `${name}: legacy scheduled task install (not migrated)`,
				);
				console.log(
					ZH
						? `   提示 : 重新执行 server install 可迁移到登录自启模式（删除任务，无需管理员）`
						: `   Hint      : re-run server install to migrate to login auto-start mode (removes task, no admin required)`,
				);
				if (instAlive) console.log(ZH ? `   实例 : 运行中 (PID ${pid})` : `   Instance  : running (PID ${pid})`);
				return;
			}
			if (!installed) {
				console.log(
					ZH
						? `${name}: 未安装（运行 pi-web-ui server install 安装）`
						: `${name}: not installed (run pi-web-ui server install)`,
				);
				if (instAlive)
					console.log(ZH ? `   快捷方式实例 : 运行中 (PID ${pid})` : `   Shortcut  : running (PID ${pid})`);
				return;
			}
			console.log(
				ZH
					? `${name}: 已安装（登录自启 · HKCU Run 键 · wscript 隐藏启动，无黑窗）`
					: `${name}: installed (login auto-start · HKCU Run key · wscript silent launch, no console window)`,
			);
			if (instAlive) {
				console.log(ZH ? `   运行状态 : 运行中 (PID ${pid})` : `   Status    : running (PID ${pid})`);
				console.log(ZH ? `   日志 : ${winLogPath(name)}` : `   Log       : ${winLogPath(name)}`);
			} else {
				console.log(
					ZH
						? `   运行状态 : 未运行（pi-web-ui server start 启动）`
						: `   Status    : not running (pi-web-ui server start to launch)`,
				);
			}
			return;
		}

		if (action === "start") {
			if (legacy) {
				run("schtasks", ["/Run", "/TN", name]);
				console.log(
					ZH
						? `✅ 已启动 ${name}（旧版计划任务，建议重新 server install 迁移）`
						: `✅ Started ${name} (legacy scheduled task, recommend re-running server install to migrate)`,
				);
				return;
			}
			if (!installed)
				fail(
					ZH
						? `${name} 不存在，请先运行 pi-web-ui server install`
						: `${name} does not exist, run pi-web-ui server install first`,
				);
			const pid = winReadPid(name);
			if (pid && pidAlive(pid)) {
				console.log(ZH ? `✅ ${name} 已在运行 (PID ${pid})` : `✅ ${name} already running (PID ${pid})`);
				return;
			}
			launchWinService(winVbsPath(name));
			console.log(ZH ? `✅ 已启动 ${name}` : `✅ Started ${name}`);
			return;
		}

		if (action === "restart") {
			if (legacy) {
				run("schtasks", ["/End", "/TN", name], {
					ignoreError: true,
					silent: true,
				});
				run("schtasks", ["/Run", "/TN", name]);
				console.log(
					ZH
						? `✅ 已重启 ${name}（旧版计划任务，建议重新 server install 迁移）`
						: `✅ Restarted ${name} (legacy scheduled task, recommend re-running server install to migrate)`,
				);
				return;
			}
			if (!installed)
				fail(
					ZH
						? `${name} 不存在，请先运行 pi-web-ui server install`
						: `${name} does not exist, run pi-web-ui server install first`,
				);
			stopWinInstance(name);
			launchWinService(winVbsPath(name));
			console.log(ZH ? `✅ 已重启 ${name}` : `✅ Restarted ${name}`);
			return;
		}

		if (action === "stop") {
			if (legacy) {
				run("schtasks", ["/End", "/TN", name], {
					ignoreError: true,
					silent: true,
				});
				stopWinInstance(name);
				console.log(
					ZH
						? `⏹  已停止 ${name}（旧版计划任务；重新 server install 可迁移到登录自启）`
						: `⏹  Stopped ${name} (legacy scheduled task; re-run server install to migrate to login auto-start)`,
				);
				return;
			}
			stopWinInstance(name);
			console.log(
				ZH
					? `⏹  已停止 ${name}（自启保留；uninstall 移除）`
					: `⏹  Stopped ${name} (auto-start preserved; uninstall to remove)`,
			);
			return;
		}

		fail(ZH ? `未知操作: ${action}` : `Unknown operation: ${action}`);
	}

	fail(
		ZH
			? `不支持的系统服务平台: ${process.platform}（仅 macOS / Linux / Windows）`
			: `Unsupported system service platform: ${process.platform} (macOS / Linux / Windows only)`,
	);
}

// ---------------------------------------------------------------------------
// 界面插件管理（<dataDir>/plugins/，从 GitHub 安装）
// ---------------------------------------------------------------------------

/** 合法插件 id（同 server/plugins.ts 的 ID_RE）。 */
const PLUGIN_ID_RE = /^[A-Za-z0-9_-]+$/;

const PLUGIN_HELP = ZH
	? `用法:
  pi-web-ui plugin create <id> [选项]  生成最小可跑的插件骨架
  pi-web-ui install <源> [选项]     安装 GitHub 上的界面插件
  pi-web-ui install --catalog <目录> [选项]  同步插件市场目录并逐条安装
  pi-web-ui plugin create <id> [选项]    生成插件骨架（minimal|ui-slot|agent-tool|renderer）
  pi-web-ui plugin upgrade-sdk [id] [选项]  刷新已装插件的 SDK 拷贝（sdk/ + client/sdk/；版本或文件对不上才拷）
  pi-web-ui uninstall <id> [选项]   卸载已安装的界面插件
  pi-web-ui plugins [选项]          列出已安装的界面插件

源写法（任选其一）:
  owner/repo                                        简写
  https://github.com/owner/repo                     完整 URL（.git 可省）
  https://github.com/o/r/tree/dev/sub/dir           指定分支 + 仓库内子目录
  以上任意写法末尾加 #分支或tag                      指定分支/tag（如 owner/repo#v1.2）
  /path/to/plugin-dir                 本地目录（离线开发调试）
  目录写法（--catalog 用）：
  https://example.com/catalog.json                  远端目录文档（数组或 {entries:[...]}）
  /path/to/catalog.json               本地目录文档（绝对路径）
  install 选项:
  --name <id>       插件目录名/id（默认取仓库名或 manifest.id，仅限字母数字-_）
  --data-dir <dir>  数据目录（默认 ~/.pi-web 或 $PI_WEB_DATA_DIR）
  --force           目标目录已存在时覆盖（覆盖前自动备份旧版本）
  --build           强制源码构建：在隔离临时目录里按插件声明安装构建依赖并编译
                    （manifest.build 或 package.json 的 scripts.build），
                    成功且产物齐全后才替换目标目录，失败不留半装状态
  --no-build        即使插件只有源码也不构建（与 --build 互斥；装出来的插件因缺产物不会被加载）
  --catalog <目录>  目录同步模式：读目录文档 → 原子写入可安装列表 → 逐条安装/更新
                    （已安装的条目默认跳过，加 --force 则更新；单条失败不中断整批）
  --replace         配合 --catalog：整体替换可安装列表（默认按 id 合并，保留旧条目）

create 选项:
  --template <t>  minimal（默认，零权限）| ui-slot | agent-tool | renderer
  --dir <dir>     插件父目录（默认 <data-dir>/plugins；也可用 --data-dir 指定数据目录）
  --force         目标目录已存在时覆盖
  --with-test     顺带生成 index.test.mjs（node --test + createMockHost 最小单测，需包内 SDK）

upgrade-sdk 选项:
  [id]            只刷新这一个插件（缺省刷新全部有 sdk 拷贝的插件）
  --dir <dir>     插件父目录（默认 <data-dir>/plugins；也可用 --data-dir 指定数据目录）

plugins 选项:
  --check-updates   逐个对比最近安装版本与远端 HEAD，列出可更新插件
  --rollback <id>   回滚到最近一份更新前备份（<dataDir>/plugin-backups/）
`
	: `Usage:
  pi-web-ui plugin create <id> [options]  generate a minimal runnable plugin skeleton
  pi-web-ui install <source> [options]     install a UI plugin from GitHub
  pi-web-ui install --catalog <catalog> [options]  sync plugin catalog and install each entry
  pi-web-ui plugin create <id> [options]    generate plugin skeleton (minimal|ui-slot|agent-tool|renderer)
  pi-web-ui plugin upgrade-sdk [id] [options]  refresh SDK copy in installed plugins (sdk/ + client/sdk/; only when version or files mismatch)
  pi-web-ui uninstall <id> [options]   uninstall an installed UI plugin
  pi-web-ui plugins [options]          list installed UI plugins

Source formats (choose one):
  owner/repo                                        shorthand
  https://github.com/owner/repo                     full URL (.git optional)
  https://github.com/o/r/tree/dev/sub/dir           specify branch + subdirectory in repo
  append #branch-or-tag to any of the above         specify branch/tag (e.g. owner/repo#v1.2)
  /path/to/plugin-dir                 local directory (offline dev/debug)
  Catalog format (for --catalog):
  https://example.com/catalog.json                  remote catalog document (array or {entries:[...]})
  /path/to/catalog.json               local catalog document (absolute path)
  install options:
  --name <id>       plugin directory name/id (default: repo name or manifest.id; alphanumeric -_ only)
  --data-dir <dir>  data directory (default ~/.pi-web or $PI_WEB_DATA_DIR)
  --force           overwrite if target directory exists (auto-backup before overwrite)
  --build           force source build: install build deps and compile in an isolated temp directory
                    (manifest.build or package.json scripts.build),
                    replaces target only on success with complete artifacts; no partial state on failure
  --no-build        skip build even if plugin is source-only (mutually exclusive with --build; plugin will not load without artifacts)
  --catalog <catalog>  catalog sync mode: read catalog → atomically write installable list → install/update each entry
                    (installed entries skipped by default; add --force to update; single failure does not abort batch)
  --replace         used with --catalog: replace installable list entirely (default merges by id, preserving old entries)

create options:
  --template <t>  minimal (default, no permissions) | ui-slot | agent-tool | renderer
  --dir <dir>     plugin parent directory (default <data-dir>/plugins; or use --data-dir to set data directory)
  --force         overwrite if target directory exists
  --with-test     also generate index.test.mjs (node --test + createMockHost minimal unit test; requires in-package SDK)

upgrade-sdk options:
  [id]            refresh only this plugin (default: refresh all plugins with an sdk copy)
  --dir <dir>     plugin parent directory (default <data-dir>/plugins; or use --data-dir to set data directory)

plugins options:
  --check-updates   compare each installed version against remote HEAD, list updatable plugins
  --rollback <id>   roll back to the most recent pre-update backup (<dataDir>/plugin-backups/)
`;

function pluginDataDir(opts) {
	return resolve(opts.dataDir ?? process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
}

/** 解析安装源为 { owner, repo, ref, subpath, cloneUrl } 或本地路径；非法输入直接退出。 */
function parsePluginSource(rawSpec) {
	let spec = rawSpec.trim();
	let ref;
	const hash = spec.indexOf("#");
	if (hash >= 0) {
		ref = spec.slice(hash + 1).trim();
		if (!ref)
			fail(
				ZH
					? `无效的源 "${rawSpec}"：# 后缺少分支/tag 名`
					: `Invalid source "${rawSpec}": branch/tag name missing after #`,
			);
		spec = spec.slice(0, hash).replace(/\/+$/, "");
	}
	// ssh 形式转 https 拉取（不要求本机配 ssh key）；URL 去掉协议前缀统一按路径段解析
	const ssh = spec.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
	if (ssh) [, , spec] = ssh;
	else {
		const url = spec.match(/^https?:\/\/(?:www\.)?github\.com\/(.+?)(?:\.git)?\/?$/i);
		if (url) [, spec] = url;
	}
	const segs = spec.split("/").filter(Boolean);
	if (segs.length < 2)
		fail(
			ZH ? `无法识别的插件源 "${rawSpec}"\n${PLUGIN_HELP}` : `Unrecognized plugin source "${rawSpec}"\n${PLUGIN_HELP}`,
		);
	for (const s of segs) {
		if (s === "." || s === "..")
			fail(
				ZH
					? `无效的源 "${rawSpec}"：路径段不能是 . 或 ..`
					: `Invalid source "${rawSpec}": path segments cannot be . or ..`,
			);
	}
	const [owner, repo] = segs;
	let subpath;
	if (segs[2] === "tree" || segs[2] === "blob") {
		if (!ref && segs.length > 3) ref = segs[3];
		subpath = segs.slice(4).join("/") || undefined;
	} else if (segs.length > 2) {
		subpath = segs.slice(2).join("/"); // owner/repo/sub/dir —— 子目录写法
	}
	return { owner, repo, ref, subpath, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

/** 清理临时目录下残留超过 1 小时的 pi-web-ui-plugin-* 安装目录。 */
function cleanStalePluginTmpDirs() {
	try {
		const base = tmpdir();
		const entries = readdirSync(base);
		const now = Date.now();
		for (const name of entries) {
			if (name.startsWith("pi-web-ui-plugin-")) {
				try {
					const p = join(base, name);
					const st = statSync(p);
					if (now - st.mtimeMs > 3600_000) {
						rmSync(p, { recursive: true, force: true });
					}
				} catch {}
			}
		}
	} catch {}
}

/** 把仓库拉到 tmpDir 并返回检出根目录。优先 git clone --depth 1，失败回退 codeload tarball + 系统 tar。 */
async function acquireRepo(src, tmpDir) {
	const dst = join(tmpDir, "src");
	const hasGit = spawnSync("git", ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0;
	if (hasGit) {
		const gitTimeout = Number(process.env.PI_WEB_GIT_TIMEOUT_MS) || 45_000;
		const args = ["-c", "connect.timeout=15", "clone", "--depth", "1", "--single-branch"];
		if (src.ref) args.push("--branch", src.ref);
		args.push(src.cloneUrl, dst);
		console.log(`· git clone --depth 1 ${src.cloneUrl}${src.ref ? ` (${src.ref})` : ""}`);
		const res = spawnSync("git", args, {
			stdio: "inherit",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
			timeout: gitTimeout,
		});
		if (res.status === 0 && existsSync(dst)) return dst;
		console.log(
			ZH
				? "· git clone 失败，回退到 tarball 直连下载…"
				: "· git clone failed, falling back to direct tarball download…",
		);
	}
	const url = `https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${src.ref || "HEAD"}`;
	console.log(ZH ? `· 下载 ${url}` : `· Downloading ${url}`);
	// 注意：这里不用 fail()/process.exit —— async 上下文里还有未关闭的 socket 时
	// 直接退出会触发 Windows libuv "UV_HANDLE_CLOSING" 断言崩溃；改为 throw，
	// 由 pluginInstallCmd 捕获后设 exitCode 让事件循环自然排空。
	let buf;
	try {
		const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
		if (!res.ok) {
			throw new Error(
				(ZH ? `HTTP 状态码 ${res.status}` : `HTTP status ${res.status}`) +
					(res.status === 404
						? ZH
							? "\n  仓库/分支不存在，或为私有仓库（私有仓库请先在本机配置好 git 凭据再重试，会优先走 git clone）。"
							: "\n  Repository/branch does not exist, or is private (for private repos, configure git credentials locally first and retry; git clone will be tried first)."
						: ""),
			);
		}
		buf = Buffer.from(await res.arrayBuffer());
	} catch (err) {
		throw new Error(
			ZH
				? `下载失败 (${url})：${err?.message ?? err}\n  请检查网络/代理后重试（可配置 HTTP_PROXY / HTTPS_PROXY 环境变量，或为 git/npm 配置代理）。`
				: `Download failed (${url}): ${err?.message ?? err}\n  Check your network/proxy and retry (consider configuring HTTP_PROXY/HTTPS_PROXY or git/npm proxy).`,
		);
	}
	writeFileSync(join(tmpDir, "src.tar.gz"), buf);
	const extractTo = join(tmpDir, "tar");
	mkdirSync(extractTo, { recursive: true });
	// 相对路径解压：win32 的 GNU tar 会把 "C:\..." 里的 C: 当远程主机（Cannot connect to C:）
	const tarRes = spawnSync("tar", ["-xzf", "src.tar.gz", "-C", "tar"], {
		cwd: tmpDir,
		stdio: "inherit",
	});
	if (tarRes.status !== 0)
		fail(
			ZH
				? "tar 解压失败（可重试，或手动下载 release 包解压）"
				: "tar extraction failed (retry, or manually download and extract the release archive)",
		);
	const entries = readdirSync(extractTo);
	if (entries.length !== 1)
		fail(
			ZH
				? "tarball 解压结果异常（顶层应只有一个目录）"
				: "tarball extraction result unexpected (top level should contain exactly one directory)",
		);
	return join(extractTo, entries[0]);
}

/** 在检出树里找包含 manifest.json 的目录（深度 ≤3，跳过 .git/node_modules）。 */
function findManifestDirs(root) {
	const hits = [];
	const walk = (dir, depth) => {
		if (existsSync(join(dir, "manifest.json"))) {
			hits.push(dir);
			return; // 目录本身是插件就不再往下搜嵌套插件
		}
		if (depth >= 3) return;
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (!ent.isDirectory() || ent.name === ".git" || ent.name === "node_modules") continue;
			walk(join(dir, ent.name), depth + 1);
		}
	};
	walk(root, 0);
	return hits;
}

/** 定位插件根目录：显式子路径 > 根目录 manifest > 全树搜索（唯一命中才继续）。 */
function locatePluginRoot(checkout, subpath, repoLabel) {
	if (subpath) {
		const dir = join(checkout, ...subpath.split("/"));
		if (!existsSync(join(dir, "manifest.json")))
			fail(ZH ? `子目录 "${subpath}" 里没有 manifest.json` : `Subdirectory "${subpath}" has no manifest.json`);
		return dir;
	}
	if (existsSync(join(checkout, "manifest.json"))) return checkout;
	const hits = findManifestDirs(checkout);
	if (hits.length === 0)
		fail(
			ZH
				? `"${repoLabel}" 里没找到 manifest.json —— 不是 pi-web-ui 界面插件`
				: `"${repoLabel}" does not contain manifest.json — not a pi-web-ui UI plugin`,
		);
	if (hits.length > 1)
		fail(
			(ZH
				? `${repoLabel} 里有多个插件（多个 manifest.json），请用子目录写法指定其中一个:\n  `
				: `${repoLabel} contains multiple plugins (multiple manifest.json files), use a subdirectory path to specify one:\n  `) +
				hits.map((h) => `${repoLabel}/${relative(checkout, h).split(/[\\/]/).join("/")}`).join("\n  "),
		);
	console.log(
		ZH
			? `· 插件位于子目录: ${relative(checkout, hits[0]).split(/[\\/]/).join("/")}`
			: `· Plugin found in subdirectory: ${relative(checkout, hits[0]).split(/[\\/]/).join("/")}`,
	);
	return hits[0];
}

/**
 * 插件的源码构建声明（--build，issue #150）：
 *   manifest.json: { "build": { "install"?: "npm install --ignore-scripts",
 *                               "command": "npm run build",
 *                               "outputs"?: ["index.mjs", "client/entry.mjs"] } }
 * 缺 command 时回落到 package.json 的 scripts.build；两者都没有 = 没声明构建方式。
 * 返回 null 表示该插件没声明构建（--build 会明确报错，而不是猜一个命令出来）。
 */
function resolveBuildPlan(pluginRoot, manifest) {
	const declared = manifest && typeof manifest.build === "object" && manifest.build ? manifest.build : null;
	let command = declared && typeof declared.command === "string" ? declared.command.trim() : "";
	if (!command) {
		try {
			const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
			if (pkg?.scripts && typeof pkg.scripts.build === "string" && pkg.scripts.build.trim()) command = "npm run build";
		} catch {
			/* 没有 package.json */
		}
	}
	if (!command) return null;
	const install =
		declared && typeof declared.install === "string" && declared.install.trim()
			? declared.install.trim()
			: "npm install --ignore-scripts --no-audit --no-fund";
	const outputs =
		declared && Array.isArray(declared.outputs)
			? declared.outputs.filter((s) => typeof s === "string" && s.trim()).map((s) => (s ?? "").trim())
			: ["index.mjs", "client/entry.mjs"];
	return { install, command, outputs };
}

/** 拷贝插件树时的过滤：不带 .git / node_modules（与安装同一套）。 */
const PLUGIN_COPY_FILTER = (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(s);

/** 在给定目录跑一条外部命令（shell 执行，继承 stdio 让用户看到进度）。失败抛错。 */
function runBuildCommand(cmd, cwd, label) {
	console.log(`· ${label}: ${cmd}`);
	const res = spawnSync(cmd, {
		cwd,
		stdio: "inherit",
		shell: true,
		timeout: 600_000,
		env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", NO_COLOR: "1" },
	});
	if (res.status !== 0)
		throw new Error(
			ZH
				? `${label} 失败（退出码 ${res.status ?? "?"}）：${cmd}`
				: `${label} failed (exit code ${res.status ?? "?"}): ${cmd}`,
		);
}

/**
 * 隔离构建：把插件源码拷进临时目录 → 只在那里安装声明的构建依赖（默认
 * npm install --ignore-scripts：不执行任意生命周期脚本）→ 执行声明的构建命令 →
 * 校验产物齐全 → 返回可安装的目录。
 *
 * 全程不碰目标目录：构建失败时上一版插件原样还在（替换只在构建成功后才发生）。
 */
function buildPluginSource(pluginRoot, tmpDir, manifest) {
	const plan = resolveBuildPlan(pluginRoot, manifest);
	if (!plan)
		throw new Error(
			ZH
				? "插件没有声明构建方式：请在 manifest.json 里加 build.command（或 package.json 的 scripts.build），或去掉 --build"
				: "Plugin has no build declaration: add build.command to manifest.json (or scripts.build in package.json), or remove --build",
		);
	const buildDir = join(tmpDir, "build");
	mkdirSync(buildDir, { recursive: true });
	cpSync(pluginRoot, buildDir, { recursive: true, filter: PLUGIN_COPY_FILTER });
	runBuildCommand(plan.install, buildDir, ZH ? "安装构建依赖" : "installing build dependencies");
	runBuildCommand(plan.command, buildDir, ZH ? "构建" : "building");
	const missing = plan.outputs.filter((o) => !existsSync(join(buildDir, o)));
	if (missing.length)
		throw new Error(
			ZH
				? `构建产物缺失：${missing.join(", ")}（manifest.build.outputs 声明）`
				: `Build artifacts missing: ${missing.join(", ")} (declared in manifest.build.outputs)`,
		);
	console.log(
		ZH
			? `· 构建完成，产物齐全：${plan.outputs.join(", ")}`
			: `· Build complete, all artifacts present: ${plan.outputs.join(", ")}`,
	);
	return buildDir;
}

/**
 * 构建决策（issue #165：--build 自动推断）。
 *
 * 只有源码、没有产物（index.mjs 与 client/entry.mjs 都缺）且存在可解析的构建声明 =
 * “不构建这次安装必死”，此前会直接自动构建；但构建命令来自远端 manifest/package.json，
 * 经 shell:true 执行属于任意命令执行面，非交互环境下静默跑等于替用户放行。
 * 收紧后（审计修复）：mode=auto 只表示“有构建声明且必要”，是否真正执行由
 * installOnePlugin 二次把关 —— 交互 TTY 且用户输入 y 才跑，否则跳过并警告。
 * --no-build 保留旧的“装个空目录”行为（脚本化镜像/检查用），并明确打印跳过原因。
 */
function decideBuildAction({ pluginRoot, manifest, build, noBuild, isCatalog = false }) {
	if (build && noBuild)
		throw new Error(
			ZH ? "--build 与 --no-build 不能同时用（二选一）" : "--build and --no-build cannot be used together (pick one)",
		);
	const plan = resolveBuildPlan(pluginRoot, manifest);
	const artifactsMissing =
		!existsSync(join(pluginRoot, "index.mjs")) && !existsSync(join(pluginRoot, "client", "entry.mjs"));
	if (build) {
		if (!plan) {
			if (isCatalog) return { mode: "none", plan };
			throw new Error(
				ZH
					? "插件没有声明构建方式：请在 manifest.json 里加 build.command（或 package.json 的 scripts.build），或去掉 --build"
					: "Plugin has no build declaration: add build.command to manifest.json (or scripts.build in package.json), or remove --build",
			);
		}
		return { mode: "explicit", plan };
	}
	if (plan && artifactsMissing) {
		if (noBuild) return { mode: "skipped", plan };
		return { mode: "auto", plan };
	}
	return { mode: "none", plan };
}

/**
 * 交互确认：插件声明的构建命令将经 shell 在本机执行（install + command 都来自
 * 远端 manifest/package.json），必须用户显式输入 y 才跑。仅 TTY 下会被调用。
 */
async function confirmSourceBuild(plan) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(
			ZH
				? `⚠ 插件声明了以下构建命令，将在本机以 shell 执行：\n    1) ${plan.install}\n    2) ${plan.command}\n  确认执行？输入 y 继续，其他任意键跳过构建: `
				: `⚠ The plugin declares the following build commands, which will run through a shell on this machine:\n    1) ${plan.install}\n    2) ${plan.command}\n  Proceed? Enter y to run, anything else to skip the build: `,
		);
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}

/**
 * 装一个插件（单源模式与目录模式共用）：拉取/定位 → 读 manifest → 构建决策 →
 * 覆盖（备份+保留 config.json）→ 落盘 → 记录来源/sha。
 * 失败抛 Error（目录模式逐条 try/catch 继续下一条，单源模式由调用方转 fail）。
 */
async function installOnePlugin({ rawSpec, name, force, build, noBuild, dataDir, isCatalog = false }) {
	cleanStalePluginTmpDirs();
	const pluginsDir = join(dataDir, "plugins");
	const localCandidate = resolve(rawSpec.replace(/^file:\/\//, ""));
	const isLocal = existsSync(localCandidate);
	const src = isLocal ? null : parsePluginSource(rawSpec);
	const tmp = mkdtempSync(join(tmpdir(), "pi-web-ui-plugin-"));
	try {
		let checkout;
		try {
			checkout = isLocal ? localCandidate : await acquireRepo(src, tmp);
		} catch (err) {
			throw new Error(`${err?.message ?? err}`);
		}
		const repoLabel = isLocal ? localCandidate : `${src.owner}/${src.repo}`;
		const pluginRoot = locatePluginRoot(checkout, src?.subpath, repoLabel);
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
		} catch (err) {
			throw new Error(
				ZH
					? `manifest.json 不是合法 JSON：${err?.message ?? err}`
					: `manifest.json is not valid JSON: ${err?.message ?? err}`,
			);
		}
		// 构建决策（issue #150 的 --build + issue #165 的自动推断）：构建在临时目录里完成，
		// 成功后才进入覆盖流程——构建失败 = 目标目录完全没被动过（上一版插件照常可用）。
		const decision = decideBuildAction({
			pluginRoot,
			manifest,
			build: build === true,
			noBuild: noBuild === true,
			isCatalog,
		});
		// 授权把关（审计修复）：--build 显式传参行为不变；mode=auto 的构建命令来自
		// 远端 manifest/package.json 且经 shell:true 执行 —— 非交互环境绝不自动跑
		// （跳过并警告），交互 TTY 也要用户显式输入 y 才执行。
		let authorized = decision.mode === "explicit";
		if (decision.mode === "auto") {
			if (!process.stdin.isTTY) {
				console.warn(
					ZH
						? "⚠ 插件声明了构建命令但未授权执行，已跳过构建 —— 传 --build 或手动构建后再安装"
						: "⚠ Plugin declares build commands but they were not authorized; skipping the build — pass --build or build manually before installing",
				);
			} else {
				authorized = await confirmSourceBuild(decision.plan);
				if (!authorized)
					console.warn(
						ZH
							? "⚠ 未确认执行构建命令，已跳过构建 —— 需要时传 --build 或手动构建后再安装"
							: "⚠ Build commands not confirmed; skipping the build — pass --build or build manually if needed",
					);
			}
		}
		let installRoot = pluginRoot;
		if (authorized) {
			console.log(
				ZH
					? `· 源码构建（${decision.mode === "auto" ? "自动推断：有构建声明但无产物" : "--build"}）：先 ${decision.plan.install}，再 ${decision.plan.command}`
					: `· Source build (${decision.mode === "auto" ? "auto-detected: build declaration present but no artifacts" : "--build"}): first ${decision.plan.install}, then ${decision.plan.command}`,
			);
			try {
				installRoot = buildPluginSource(pluginRoot, tmp, manifest);
			} catch (err) {
				throw new Error(`${err?.message ?? err}`);
			}
		} else if (decision.mode === "skipped") {
			console.log(
				ZH
					? "· 跳过构建（--no-build）：目录里没有产物，装上后该插件不会被加载"
					: "· Skipping build (--no-build): no artifacts in directory, plugin will not load after install",
			);
		} else if (decision.mode === "auto") {
			console.log(
				ZH
					? "· 已跳过构建：目录里没有产物，装上后该插件不会被加载（授权后重装可补产物）"
					: "· Build skipped: no artifacts in directory, plugin will not load after install (re-install with authorization to build)",
			);
		}
		// 默认 id：子目录名 > 仓库名 > 本地目录名
		const sourceName = src?.subpath ? src.subpath.split("/").pop() : (src?.repo ?? localCandidate.split(/[\\/]/).pop());
		const fallbackId =
			String(manifest.id ?? sourceName)
				.replace(/[^A-Za-z0-9_-]/g, "-")
				.replace(/^-+|-+$/g, "") || "plugin";
		const id = name ?? fallbackId;
		if (!PLUGIN_ID_RE.test(id))
			throw new Error(
				ZH
					? `非法插件 id "${id}"（仅限字母数字-_，可用 --name <id> 自定义）`
					: `Invalid plugin id "${id}" (alphanumeric and -_ only; use --name <id> to set a custom name)`,
			);
		const target = join(pluginsDir, id);
		let backupTs = null;
		const PRESERVED_FILES = ["config.json", "secrets.bin", "storage.json"];
		const preservedData = new Map();
		if (existsSync(target)) {
			if (!force)
				throw new Error(
					ZH
						? `插件目录已存在：${target}\n  加 --force 覆盖，或用 --name <id> 换个名字。`
						: `Plugin directory already exists: ${target}\n  Add --force to overwrite, or use --name <id> to choose a different name.`,
				);
			// 更新前备份旧版本（<dataDir>/plugin-backups/<id>-<ts>/，保留最近 3 份），
			// 失败时自动回滚。备份与安装同 filter：不带 .git/node_modules。
			backupTs = ensurePluginBackup(dataDir, id, { source: rawSpec });
			// 插件凭据/加密机密/私有存储不因升级丢失：先取出旧 config.json / secrets.bin / storage.json，拷完新文件后原样放回
			for (const fname of PRESERVED_FILES) {
				try {
					preservedData.set(fname, readFileSync(join(target, fname)));
				} catch {
					/* 无该文件 */
				}
			}
			rmSync(target, { recursive: true, force: true });
		}
		mkdirSync(target, { recursive: true });
		try {
			cpSync(installRoot, target, { recursive: true, filter: PLUGIN_COPY_FILTER });
		} catch (err) {
			// 拷贝失败 → 有备份则自动回滚，保持旧版本可用
			if (backupTs && restorePluginBackup(dataDir, id)) {
				throw new Error(
					ZH
						? `插件更新失败：${err?.message ?? err}\n  已自动回滚到更新前版本。`
						: `Plugin update failed: ${err?.message ?? err}\n  Automatically rolled back to the previous version.`,
				);
			}
			throw new Error(
				ZH
					? `插件更新失败：${err?.message ?? err}\n  （无可用备份，请重新 install --force）`
					: `Plugin update failed: ${err?.message ?? err}\n  (no backup available, re-run install --force)`,
			);
		}
		for (const [fname, buf] of preservedData) {
			if (!existsSync(join(target, fname))) {
				writeFileSync(join(target, fname), buf);
			}
		}
		// 记录安装来源：设置面板「更新」按钮据此重跑同一条安装命令（--force 覆盖）。
		try {
			writeFileSync(join(target, ".pi-source.json"), JSON.stringify({ source: rawSpec }, null, 2) + "\n");
		} catch {
			/* 尽力而为：没有来源信息只是不显示更新按钮 */
		}
		// 记录本次安装的远端 sha（git ls-remote HEAD，离线也支持本地 git 源）：
		// 供 `pi-web-ui plugins --check-updates` 对比更新。失败静默（无 sha = 保守可更新）。
		try {
			const sha = await resolveRemoteSha(rawSpec);
			if (sha) writeFileSync(join(target, ".pi-git-sha"), sha + "\n");
		} catch {
			/* 尽力而为 */
		}
		return { id, target, manifest, buildMode: decision.mode };
	} finally {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			/* Windows 等平台杀毒/进程占用可能抛 EBUSY，不应翻转已成功的安装 */
		}
	}
}

/**
 * 目录文档校验（issue #165 的 CLI --catalog）。
 *
 * 规则与 server/plugin-catalog.ts 的 toEntry 对齐（id 字符集、source 形状、字段裁剪），
 * 仅放宽一条：CLI 跑在使用者的本机信任上下文里，允许已存在的本地目录源（离线开发、
 * 本地目录同步）；服务端 toEntry（网络/插件触发）仍只收远端源。两边规则若漂移，
 * tests/plugin-catalog-cli-test.mjs 的行为断言会先响（离线全链路）。
 */
function isCatalogEntrySource(s) {
	if (!s || s.length > 300) return false;
	// 本地目录：CLI 才放行（存在性检查，file:// 前缀兼容 install 单源写法）
	try {
		if (existsSync(resolve(s.replace(/^file:\/\//, "")))) return true;
	} catch {
		/* 非法路径字符：走下面的远端规则 */
	}
	if (/^https?:\/\//.test(s)) return true;
	const spec = s.split("#")[0].replace(/\/+$/, "");
	const segs = spec.split("/").filter(Boolean);
	if (segs.length < 2) return false;
	for (const seg of segs) if (seg === "." || seg === "..") return false;
	return true;
}

function deriveCatalogEntryId(rawId, source) {
	if (rawId && PLUGIN_ID_RE.test(rawId)) return rawId;
	try {
		const local = resolve(source.replace(/^file:\/\//, ""));
		if (existsSync(local)) {
			const base = local.split(/[\\/]/).pop() || "plugin";
			const cleaned = base.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
			return cleaned || "plugin";
		}
	} catch {
		/* 走远端规则 */
	}
	const spec = source.split("#")[0].replace(/\/+$/, "");
	const segs = spec.split("/").filter(Boolean);
	const last = segs.length >= 2 ? segs[segs.length - 1] : (segs[0] ?? "plugin");
	const cleaned = last.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "plugin";
}

function catalogEntryFromRaw(raw) {
	if (!raw || typeof raw !== "object") return null;
	const source = typeof raw.source === "string" ? raw.source.trim() : "";
	if (!isCatalogEntrySource(source)) return null;
	const id = deriveCatalogEntryId(typeof raw.id === "string" ? raw.id.trim() : undefined, source);
	if (!PLUGIN_ID_RE.test(id)) return null;
	const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	const name = str(raw.name) ?? id;
	const description = str(raw.description);
	const descriptionEn = str(raw.descriptionEn);
	const icon = str(raw.icon);
	const homepage = str(raw.homepage);
	return {
		id,
		name,
		source,
		...(description ? { description } : {}),
		...(descriptionEn ? { descriptionEn } : {}),
		...(icon ? { icon } : {}),
		...(homepage ? { homepage } : {}),
	};
}

/** 目录文档形状：JSON 数组或 {entries:[...]}；非法条目丢弃并计数（与服务端同语义）。 */
function normalizeCatalogEntries(raw) {
	const list = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object" && Array.isArray(raw.entries)
			? raw.entries
			: null;
	if (!list)
		throw new Error(
			ZH
				? '目录 JSON 需为数组，或 {"entries": [...]} 形状'
				: 'Catalog JSON must be an array or {"entries": [...]} shape',
		);
	const entries = [];
	let skipped = 0;
	for (const it of list) {
		const e = catalogEntryFromRaw(it);
		if (e) entries.push(e);
		else skipped++;
	}
	return { entries, skipped };
}

/** 读目录文档：http(s) 拉取（30s 超时），其余当本地绝对路径（与服务端同口径）。 */
async function readCatalogDocumentText(source) {
	const src = String(source ?? "").trim();
	if (!src)
		throw new Error(
			ZH
				? "缺少目录来源（--catalog <url 或本地绝对路径>）"
				: "Missing catalog source (--catalog <url or local absolute path>)",
		);
	if (/^https?:\/\//i.test(src)) {
		let res;
		try {
			res = await fetch(src, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
		} catch (err) {
			throw new Error(ZH ? `拉取目录失败：${err?.message ?? err}` : `Failed to fetch catalog: ${err?.message ?? err}`);
		}
		if (!res.ok)
			throw new Error(ZH ? `拉取目录失败：HTTP ${res.status}` : `Failed to fetch catalog: HTTP ${res.status}`);
		const text = await res.text();
		if (text.length > 1024 * 1024)
			throw new Error(ZH ? "目录文档过大（> 1024 KB）" : "Directory document too large (> 1024 KB)");
		return text;
	}
	if (!isAbsolute(src))
		throw new Error(
			ZH
				? "本地目录文档需为绝对路径（远端用 http(s) URL）"
				: "Local directory document must be an absolute path (remote: use http(s) URL)",
		);
	try {
		return readFileSync(src, "utf8");
	} catch (err) {
		throw new Error(
			ZH ? `读取目录文件失败：${err?.message ?? err}` : `Failed to read directory file: ${err?.message ?? err}`,
		);
	}
}

function readCatalogFileEntries(customPath) {
	try {
		const raw = JSON.parse(readFileSync(customPath, "utf8"));
		if (raw && typeof raw === "object" && Array.isArray(raw.entries)) return raw.entries;
	} catch {
		/* 无文件/坏文件 = 空列表 */
	}
	return [];
}

function writeCatalogFileEntries(customPath, entries) {
	mkdirSync(dirname(customPath), { recursive: true });
	const tmp = `${customPath}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify({ entries }, null, 2) + "\n");
	renameSync(tmp, customPath);
}

/** install --catalog <url>：同步可安装列表 + 逐条安装/更新（单条失败不中断整批）。 */
async function installCatalogCmd(opts) {
	const dataDir = pluginDataDir(opts);
	const customPath = join(dataDir, "plugin-catalog.json");
	const pluginsDir = join(dataDir, "plugins");
	const text = await readCatalogDocumentText(opts.catalog).catch((err) => fail(`${err?.message ?? err}`));
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		fail(ZH ? `目录 JSON 解析失败：${err?.message ?? err}` : `Directory JSON parse failed: ${err?.message ?? err}`);
	}
	let entries;
	let skipped = 0;
	try {
		({ entries, skipped } = normalizeCatalogEntries(raw));
	} catch (err) {
		fail(`${err?.message ?? err}`);
	}
	// 到这里才动磁盘：形状不对的文档绝不覆盖有效列表（与服务端同纪律）。
	if (opts.replace) {
		writeCatalogFileEntries(customPath, entries);
	} else {
		const prev = readCatalogFileEntries(customPath).filter((x) => x && typeof x === "object");
		const next = [...prev];
		for (const e of entries) {
			const idx = next.findIndex((x) => x.id === e.id);
			if (idx >= 0) next[idx] = e;
			else next.push(e);
		}
		writeCatalogFileEntries(customPath, next);
	}
	console.log(
		ZH
			? `· 目录同步：${entries.length} 条合法${skipped ? `（丢弃 ${skipped} 条非法）` : ""}${opts.replace ? "（整体替换）" : "（按 id 合并）"} → ${customPath}`
			: `· Directory sync: ${entries.length} valid${skipped ? `(discarded ${skipped} invalid)` : ""}${opts.replace ? "(full replace)" : "(merge by id)"} → ${customPath}`,
	);
	let okCount = 0;
	let failCount = 0;
	let skipCount = 0;
	for (const e of entries) {
		if (existsSync(join(pluginsDir, e.id)) && !opts.force) {
			console.log(
				ZH
					? `· 跳过 ${e.id}（已安装，加 --force 更新）`
					: `· Skipping ${e.id} (already installed, use --force to update)`,
			);
			skipCount++;
			continue;
		}
		try {
			await installOnePlugin({
				rawSpec: e.source,
				name: e.id,
				force: true,
				build: opts.build === true,
				noBuild: opts.noBuild === true,
				dataDir,
				isCatalog: true,
			});
			console.log(ZH ? `✔ ${e.id} 安装成功` : `✔ ${e.id} installed`);
			okCount++;
		} catch (err) {
			console.error(
				ZH ? `✖ ${e.id} 安装失败：${err?.message ?? err}` : `✖ ${e.id} failed to install: ${err?.message ?? err}`,
			);
			failCount++;
		}
	}
	console.log(
		ZH
			? `✔ 目录安装完成：${okCount} 成功 / ${failCount} 失败 / ${skipCount} 跳过（已安装）`
			: `✔ Directory install complete: ${okCount} succeeded / ${failCount} failed / ${skipCount} skipped (already installed)`,
	);
	if (failCount) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 插件脚手架（plugin create）：生成最小可跑骨架
// 形态 = <dataDir>/plugins/<id>/（manifest.json + index.mjs + client/entry.mjs），
// 与 server/plugins.ts 的加载约定对齐；官方插件（plugins/demo-mailbox 等）可作参考。
// ---------------------------------------------------------------------------

/** 脚手架模板：minimal（零权限）| ui-slot | agent-tool | renderer（view:false）。 */
const PLUGIN_TEMPLATES = ["minimal", "ui-slot", "agent-tool", "renderer"];

/** 随包发布的 plugin-sdk 文件：`index.mjs`（入口）+ `client-utils.mjs`（`index.mjs` 末尾
 *  `export * from "./client-utils.mjs"`；**少一份连服务端 import 都会 ERR_MODULE_NOT_FOUND**）。*/
const PLUGIN_SDK_FILES = ["index.mjs", "client-utils.mjs"];

/** 包内 plugin-sdk 文件清单（随包发布，见 package.json files）；缺任一 = 包不完整，按「无 SDK」处理。 */
function pluginSdkSources() {
	const dir = join(BIN_DIR, "..", "plugin-sdk");
	const files = [];
	for (const name of PLUGIN_SDK_FILES) {
		const src = join(dir, name);
		if (!existsSync(src)) return undefined;
		files.push({ name, src });
	}
	return files;
}

function copySdkInto(dir, sources) {
	mkdirSync(dir, { recursive: true });
	for (const { name, src } of sources) copyFileSync(src, join(dir, name));
}

/** 各模板的 manifest.description（一句话说明骨架来源）。 */
function scaffoldDescription(template) {
	switch (template) {
		case "ui-slot":
			return "输入框动作按钮示例（pi-web-ui plugin create --template ui-slot 生成的骨架）";
		case "agent-tool":
			return "AI 工具扩展示例（pi-web-ui plugin create --template agent-tool 生成的骨架）";
		case "renderer":
			return "围栏代码渲染器示例（pi-web-ui plugin create --template renderer 生成的骨架）";
		default:
			return "最小可跑插件骨架（pi-web-ui plugin create 生成）";
	}
}

/** 模板的客户端是否 import SDK：**除 renderer 外都 import `./sdk/index.mjs`**（renderer 渲染器走裸 ESM）。
 *  决定 `client/sdk/` 要不要拷、README 怎么写；拷完还用 import-check 复验（模板以后改了也不漏）。 */
function templateClientUsesSdk(template) {
	return template !== "renderer";
}

/** 拼骨架文件：{ 相对路径: 内容 }。useSdk=false 时走无 SDK 导入的等价写法。
 *  withTest=true（且 useSdk）时多带 index.test.mjs（node --test + createMockHost 最小单测）。 */
function buildPluginScaffold(id, template, useSdk, withTest = false) {
	const sdkServer = useSdk ? `import { definePlugin } from "./sdk/index.mjs";\n\n` : "";
	// 客户端 import 必须落在 client/ 内：宿主只暴露 /plugins/<id>/client/*（见 import-check）。
	const sdkClient = useSdk ? `import { defineView, onUiAction } from "./sdk/index.mjs";\n\n` : "";
	const wrapServer = (body) =>
		useSdk ? `${sdkServer}export default definePlugin({\n${body}\n});\n` : `export default {\n${body}\n};\n`;
	const wrapClient = (body) =>
		useSdk ? `${sdkClient}export default defineView({\n${body}\n});\n` : `export default {\n${body}\n};\n`;
	const toolName = `${id.replace(/[^A-Za-z0-9_]/g, "_")}_hello`;
	const action = `${id}:hello`;
	const lang = id.toLowerCase().replace(/[^a-z0-9]/g, "") || "hello";

	const manifest = {
		id,
		name: id,
		version: "0.1.0",
		description: scaffoldDescription(template),
		apiVersion: 2,
		// apiVersion 2 **必须**声明 permissions（缺字段 = 宿主直接拒激活，issue #546 现场顺带发现）：
		// 模板按需覆写（ui-slot → ["ui"]、agent-tool → ["tools"]），零能力的就是空数组。
		permissions: [],
	};

	const minimalServer = wrapServer(
		`\tactivate(host) {\n` +
			`\t\thost.log("activated");\n` +
			`\t\tconst off = host.onMessage((payload) => {\n` +
			`\t\t\thost.log("message:", JSON.stringify(payload ?? {}));\n` +
			`\t\t});\n` +
			`\t\treturn () => {\n` +
			`\t\t\toff();\n` +
			`\t\t\thost.log("deactivated");\n` +
			`\t\t};\n` +
			`\t},`,
	);
	const minimalClient = wrapClient(
		`\tmount(container) {\n` +
			`\t\tconst el = document.createElement("div");\n` +
			`\t\tel.style.padding = "16px";\n` +
			`\t\tel.textContent = "Hello from ${id} —— 改 client/entry.mjs 后刷新浏览器即生效。";\n` +
			`\t\tcontainer.appendChild(el);\n` +
			`\t\treturn () => {\n` +
			`\t\t\tel.remove();\n` +
			`\t\t};\n` +
			`\t},`,
	);

	let indexJs = minimalServer;
	let clientJs = minimalClient;

	if (template === "ui-slot") {
		manifest.permissions = ["ui"];
		manifest.ui = {
			"composer.actions": [{ id: "hello", label: "打招呼", kind: "action", action }],
		};
		indexJs = wrapServer(
			`\tactivate(host) {\n` +
				`\t\thost.log("activated");\n` +
				`\t\t// manifest.ui["composer.actions"] 里声明的按钮点下后，客户端经 ctx.send 发到这里。\n` +
				`\t\tconst off = host.onMessage((payload) => {\n` +
				`\t\t\tif (payload?.action === "${action}") {\n` +
				`\t\t\t\thost.notify("info", "你好，来自插件 ${id} 👋");\n` +
				`\t\t\t}\n` +
				`\t\t});\n` +
				`\t\treturn () => {\n` +
				`\t\t\toff();\n` +
				`\t\t\thost.log("deactivated");\n` +
				`\t\t};\n` +
				`\t},`,
		);
		clientJs = useSdk
			? `${sdkClient}export default defineView({\n` +
				`\tmount(container, ctx) {\n` +
				`\t\tconst el = document.createElement("div");\n` +
				`\t\tel.style.padding = "16px";\n` +
				`\t\tel.textContent = "点输入框旁的「打招呼」按钮试试 👆";\n` +
				`\t\tcontainer.appendChild(el);\n` +
				`\t\t// manifest.ui 里 action 为 "${action}" 的条目点下走这里，再经 ctx.send 落到服务端。\n` +
				`\t\tconst off = onUiAction("${action}", () => {\n` +
				`\t\t\tel.textContent = "已点击，服务端收到啦 ✅";\n` +
				`\t\t\tctx.send({ action: "${action}" });\n` +
				`\t\t});\n` +
				`\t\treturn () => {\n` +
				`\t\t\toff();\n` +
				`\t\t\tel.remove();\n` +
				`\t\t};\n` +
				`\t},\n});\n`
			: `export default {\n` +
				`\tmount(container, ctx) {\n` +
				`\t\tconst el = document.createElement("div");\n` +
				`\t\tel.style.padding = "16px";\n` +
				`\t\tel.textContent = "点输入框旁的「打招呼」按钮试试 👆";\n` +
				`\t\tcontainer.appendChild(el);\n` +
				`\t\tconst bridge = globalThis.window?.__piWebUiHost;\n` +
				`\t\tconst off = bridge?.onUiAction?.("${action}", () => {\n` +
				`\t\t\tel.textContent = "已点击，服务端收到啦 ✅";\n` +
				`\t\t\tctx.send({ action: "${action}" });\n` +
				`\t\t}) ?? (() => {});\n` +
				`\t\treturn () => {\n` +
				`\t\t\toff();\n` +
				`\t\t\tel.remove();\n` +
				`\t\t};\n` +
				`\t},\n};\n`;
	}

	if (template === "agent-tool") {
		manifest.permissions = ["tools"];
		indexJs = wrapServer(
			`\tactivate(host) {\n` +
				`\t\thost.log("activated");\n` +
				`\t\t// 注册给 AI 用的工具（manifest.permissions 须含 "tools"；name 全局唯一）。\n` +
				`\t\tconst offTool = host.registerAgentTool({\n` +
				`\t\t\tname: "${toolName}",\n` +
				`\t\t\tdescription: "打招呼示例工具：返回一句问候（plugin create 生成的骨架）。",\n` +
				`\t\t\tparameters: {\n` +
				`\t\t\t\ttype: "object",\n` +
				`\t\t\t\tproperties: { name: { type: "string", description: "要问候的名字" } },\n` +
				`\t\t\t},\n` +
				`\t\t\texecute: async (_toolCallId, params) => {\n` +
				`\t\t\t\tconst raw = params?.name;\n` +
				`\t\t\t\tconst who = typeof raw === "string" && raw.trim() ? raw.trim() : "world";\n` +
				`\t\t\t\treturn "Hello, " + who + "! 👋（来自插件 ${id}）";\n` +
				`\t\t\t},\n` +
				`\t\t});\n` +
				`\t\treturn () => {\n` +
				`\t\t\toffTool();\n` +
				`\t\t\thost.log("deactivated");\n` +
				`\t\t};\n` +
				`\t},`,
		);
	}

	if (template === "renderer") {
		manifest.view = false;
		manifest.renderers = [lang];
		indexJs = wrapServer(
			`\tactivate(host) {\n` +
				`\t\thost.log("activated");\n` +
				`\t\treturn () => {\n` +
				`\t\t\thost.log("deactivated");\n` +
				`\t\t};\n` +
				`\t},`,
		);
		// 渲染器走裸 ESM（命中围栏才懒加载）：默认导出 { renderers }，不用 defineView。
		clientJs =
			`/**\n` +
			` * ${id} —— fenced-code 渲染器（pi-web-ui plugin create 生成）。\n` +
			` * manifest 须写 "view": false + "renderers": ["${lang}"]；命中 ${lang} 围栏才懒加载。\n` +
			` */\n` +
			`export default {\n` +
			`\trenderers: {\n` +
			`\t\t"${lang}": (code) => {\n` +
			`\t\t\tconst pre = document.createElement("pre");\n` +
			`\t\t\tpre.style.padding = "12px 16px";\n` +
			`\t\t\tpre.textContent = String(code ?? "");\n` +
			`\t\t\treturn pre;\n` +
			`\t\t},\n` +
			`\t},\n` +
			`};\n`;
	}

	const header = (file) =>
		`/**\n` +
		` * ${id} —— ${file}（pi-web-ui plugin create --template ${template} 生成）。\n` +
		` * 约定：服务端 ESM 默认导出 { activate(host) → cleanup? }；\n` +
		` * 客户端 ESM 默认导出 { mount(container, ctx) → cleanup? }。\n` +
		` */\n`;
	const nextStep =
		template === "ui-slot"
			? "在 manifest.ui 里加更多 composer.actions 条目，client 里用 onUiAction 接住 action。"
			: template === "agent-tool"
				? `在 index.mjs 里追加 host.registerAgentTool（name 全局唯一，建议 ${id.replace(/[^A-Za-z0-9_]/g, "_")}_<动作> 前缀）。`
				: template === "renderer"
					? "把 renderers 回调换成真正的渲染（如 mermaid 插件那样懒加载引擎），manifest.renderers 追加语言。"
					: "在 index.mjs 里接 host API（log/onMessage/broadcast/notify），视图改 client/entry.mjs。";
	const readme =
		`# ${id}\n` +
		`\n` +
		`${scaffoldDescription(template)}。\n` +
		`\n` +
		`## 目录\n` +
		`\n` +
		`- \`manifest.json\` —— 插件声明（id/name/version/description/apiVersion/permissions…；apiVersion 2 必须写 permissions，零能力写 \`[]\`）\n` +
		`- \`index.mjs\` —— 服务端入口（\`export default { activate(host) }\`）\n` +
		`- \`client/entry.mjs\` —— 客户端视图${template === "renderer" ? "（渲染器：`{ renderers }`）" : "（`{ mount }`）"}\n` +
		(useSdk
			? `- \`sdk/index.mjs\` + \`sdk/client-utils.mjs\` —— plugin-sdk 拷贝（服务端用：definePlugin/defineView/onUiAction）\n`
			: "") +
		(useSdk && templateClientUsesSdk(template)
			? `- \`client/sdk/\` —— 同一份 SDK 的**客户端**拷贝：宿主只暴露 \`/plugins/<id>/client/*\`，客户端依赖必须落在 \`client/\` 内（\`client/entry.mjs\` 只能 \`import "./sdk/index.mjs"\`）\n`
			: "") +
		(withTest && useSdk
			? "- `index.test.mjs` —— 最小单测（`node --test index.test.mjs`，createMockHost harness）\n"
			: "") +
		`\n` +
		`## 下一步\n` +
		`\n` +
		`1. 改名改描述：编辑 manifest.json 的 name/description。\n` +
		`2. 写逻辑：${nextStep}\n` +
		`3. 生效：服务运行中刷新浏览器即可加载（或发 \`plugins_reload\`）；未运行则下次启动生效。\n` +
		`4. 参考：官方插件 \`plugins/demo-mailbox\`（最小）、\`plugin-sdk/README.md\`（完整契约）。\n` +
		(withTest && useSdk
			? `\n## 单测\n\n\`node --test index.test.mjs\`（createMockHost harness：activate 记录断言 + reset；改逻辑前保持它绿）。\n`
			: "");

	const out = {
		"manifest.json": JSON.stringify(manifest, null, "\t") + "\n",
		"index.mjs": header("服务端入口") + (useSdk ? sdkServer : "") + indexJs.slice(indexJs.indexOf("export")),
		"client/entry.mjs":
			template === "renderer"
				? `/**\n * ${id} —— 客户端渲染器（pi-web-ui plugin create --template renderer 生成）。\n */\n` +
					clientJs.slice(clientJs.indexOf("export"))
				: header("客户端视图") + (useSdk ? sdkClient : "") + clientJs.slice(clientJs.indexOf("export")),
		"README.md": readme,
	};
	if (withTest && useSdk) {
		// 最小单测：四个模板的 activate 都会 host.log("activated")，断言与模板无关。
		out["index.test.mjs"] =
			`/**\n` +
			` * ${id} —— 最小单测（pi-web-ui plugin create --with-test 生成）。\n` +
			` * 跑法（插件目录下）：node --test index.test.mjs（零依赖，node 内置 runner + assert）。\n` +
			` */\n` +
			`import { describe, it } from "node:test";\n` +
			`import assert from "node:assert/strict";\n` +
			`import plugin from "./index.mjs";\n` +
			`import { createMockHost } from "./sdk/index.mjs";\n` +
			`\n` +
			`describe("${id} activate", () => {\n` +
			`\tit("激活不抛错，且调了 host 方法", async () => {\n` +
			`\t\tconst host = createMockHost({ settings: {} });\n` +
			`\t\tconst cleanup = await plugin.activate(host);\n` +
			`\t\tassert.ok(host.calls.length > 0, "activate 应该至少调一次 host 方法（log 也算）");\n` +
			`\t\tassert.ok(\n` +
			`\t\t\thost.logs.some((l) => l.text.includes("activated")),\n` +
			`\t\t\t"骨架 activate 会 host.log('activated')",\n` +
			`\t\t);\n` +
			`\t\tif (typeof cleanup === "function") cleanup();\n` +
			`\t});\n` +
			`\n` +
			`\tit("reset() 清空调用记录与日志", async () => {\n` +
			`\t\tconst host = createMockHost();\n` +
			`\t\tawait plugin.activate(host);\n` +
			`\t\tassert.ok(host.calls.length > 0);\n` +
			`\t\thost.reset();\n` +
			`\t\tassert.equal(host.calls.length, 0);\n` +
			`\t\tassert.equal(host.logs.length, 0);\n` +
			`\t});\n` +
			`});\n`;
	}
	return out;
}

/** 生成后的 manifest 基础校验（必填/口径）；返回 warnings（无则空数组）。 */
function validateScaffoldManifest(manifest, dirName) {
	const warnings = [];
	for (const k of ["id", "name", "version", "description"]) {
		if (typeof manifest[k] !== "string" || !manifest[k].trim())
			warnings.push(ZH ? `manifest 缺少必填字段 "${k}"` : `manifest missing required field "${k}"`);
	}
	if (manifest.id && manifest.id !== dirName)
		warnings.push(
			ZH
				? `manifest.id "${manifest.id}" 与目录名 "${dirName}" 不一致（以目录名为准）`
				: `manifest.id "${manifest.id}" and directory name "${dirName}" is inconsistent (directory name takes precedence)`,
		);
	if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
		warnings.push(
			ZH
				? `manifest.version "${manifest.version}" 不是 x.y.z 格式`
				: `manifest.version "${manifest.version}" is not in x.y.z format`,
		);
	}
	const api = manifest.apiVersion ?? 1;
	if (typeof api !== "number" || api > 2) {
		warnings.push(
			ZH
				? `manifest.apiVersion=${JSON.stringify(api)} 高于宿主 v2，插件会被拒绝激活`
				: `manifest.apiVersion=${JSON.stringify(api)} exceeds host v2, plugin will be rejected on activation`,
		);
	}
	if (manifest.permissions !== undefined) {
		const ok = Array.isArray(manifest.permissions) && manifest.permissions.every((p) => typeof p === "string" && p);
		if (!ok)
			warnings.push(
				ZH
					? `manifest.permissions 须是字符串数组（如 ["ui"]）`
					: `manifest.permissions must be a string array (e.g. ["ui"])`,
			);
	}
	// 与宿主同口径（server/plugin-manifest-validate.ts）：apiVersion 2 必须有 permissions 字段，
	// 缺失 = 扫到就报错误、插件被拒（零能力也写 []）—— 骨架曾经漏写，装上去才发现。
	if (manifest.apiVersion === 2 && manifest.permissions === undefined)
		warnings.push(
			ZH
				? `apiVersion 2 必须声明 permissions（零能力写 []），否则宿主会直接拒激活`
				: `apiVersion 2 must declare "permissions" (use [] for none), otherwise the host rejects activation`,
		);
	if (manifest.view === false && !(Array.isArray(manifest.renderers) && manifest.renderers.length > 0)) {
		warnings.push(
			ZH
				? `view:false 但未声明 renderers —— 插件将没有任何界面`
				: `view:false but no renderers declared — plugin will have no UI`,
		);
	}
	return warnings;
}

/** 已装插件的 sdk/index.mjs 里解析 SDK_VERSION（老拷贝无此常量 → null，即未知旧版）。 */
function installedSdkVersion(sdkFile) {
	try {
		const src = readFileSync(sdkFile, "utf8");
		const m = src.match(/SDK_VERSION\s*=\s*["']([^"']+)["']/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

/** 包内 SDK 版本（单源：plugin-sdk/index.mjs 的 `export const SDK_VERSION`）。 */
function packageSdkVersion() {
	const sources = pluginSdkSources();
	const sdkSrc = sources?.find((f) => f.name === "index.mjs")?.src;
	if (!sdkSrc)
		fail(
			ZH
				? `包内无 plugin-sdk（找不到 plugin-sdk/index.mjs），无法刷新`
				: `No plugin-sdk in package (plugin-sdk/index.mjs not found), cannot refresh`,
		);
	let src;
	try {
		src = readFileSync(sdkSrc, "utf8");
	} catch {
		fail(
			ZH
				? `包内 plugin-sdk/index.mjs 不可读，无法刷新`
				: `plugin-sdk/index.mjs in package is unreadable, cannot refresh`,
		);
	}
	const m = src.match(/export const SDK_VERSION\s*=\s*["']([^"']+)["']/);
	if (!m)
		fail(
			ZH
				? `包内 plugin-sdk/index.mjs 无 SDK_VERSION 导出，无法刷新（请升级 pi-web-ui）`
				: `plugin-sdk/index.mjs in package has no SDK_VERSION export, cannot refresh (please upgrade pi-web-ui)`,
		);
	return { version: m[1], file: sdkSrc, sources };
}

/** 插件目录里现存的 SDK 拷贝目录：服务端用 `sdk/`，客户端用 `client/sdk/`（两份都要刷）。 */
function pluginSdkDirs(pluginDir) {
	return [join(pluginDir, "sdk"), join(pluginDir, "client", "sdk")].filter((d) => existsSync(d));
}

/** 静态 import 自检问题的双语文案（create / upgrade-sdk 共用）。 */
function importProblemText(p) {
	if (p.kind === "escapes-client")
		return ZH
			? `${p.file}: import "${p.spec}" 解析到 client/ 之外（${p.target}）—— 宿主只暴露 /plugins/<id>/client/*，浏览器会整包加载失败（插件页空白）；把依赖拷进 client/ 内并改成相对 import`
			: `${p.file}: import "${p.spec}" resolves outside client/ (${p.target}) — the host only serves /plugins/<id>/client/*, so the browser fails to load the whole bundle (blank plugin page); copy it inside client/ and use a relative import`;
	return ZH
		? `${p.file}: import "${p.spec}" 的目标不存在（${p.target}）—— 拼错了，还是忘了拷依赖？`
		: `${p.file}: import "${p.spec}" target does not exist (${p.target}) — typo, or a missing vendored dependency?`;
}

/** 懒加载 import-check（随包发布，但裁剪包可能没有 → 跳自检而不是崩）。 */
let importCheckModule;
async function loadImportCheck() {
	if (importCheckModule === undefined) {
		importCheckModule = await import("../plugin-sdk/import-check.mjs").catch(() => null);
	}
	return importCheckModule;
}

/** 刷新已装插件的 SDK 拷贝（服务端 `sdk/` + 客户端 `client/sdk/`，版本/文件对不上才拷）。 */
async function pluginUpgradeSdkCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help || positionals.length > 1) {
		console.log(PLUGIN_HELP);
		if (!opts.help) process.exit(1);
		return;
	}
	const { version: latest, sources } = packageSdkVersion();
	const parentDir = opts.dir ? resolve(opts.dir) : join(pluginDataDir(opts), "plugins");
	const only = positionals.length === 1 ? positionals[0] : null;
	if (only && !PLUGIN_ID_RE.test(only))
		fail(ZH ? `非法插件 id "${only}"（仅限字母数字-_）` : `Invalid plugin id "${only}" (alphanumeric and -_ only)`);
	if (only && !existsSync(join(parentDir, only)))
		fail(
			ZH
				? `未安装插件 "${only}"（pi-web-ui plugins 查看已装列表）`
				: `Plugin not installed: "${only}" (pi-web-ui plugins to see installed list)`,
		);
	let entries;
	try {
		entries = readdirSync(parentDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && PLUGIN_ID_RE.test(e.name))
			.map((e) => e.name);
	} catch {
		fail(ZH ? `读插件目录失败: ${parentDir}` : `Failed to read plugin directory: ${parentDir}`);
	}
	const targets = only ? [only] : entries;
	const importCheck = await loadImportCheck();
	let upgraded = 0;
	let fresh = 0;
	let skipped = 0;
	const healed = [];
	const broken = [];
	for (const id of targets) {
		const pluginDir = join(parentDir, id);
		let dirs = pluginSdkDirs(pluginDir);
		if (dirs.length === 0) {
			skipped++;
			console.log(ZH ? `- ${id}：无 sdk/ 拷贝，跳过` : `- ${id}: no sdk/ copy, skipping`);
			continue;
		}
		// 客户端侧缺失但代码确实 import ./sdk/ → 补建（修好 issue #546 之前生成的插件）。
		if (!existsSync(join(pluginDir, "client", "sdk"))) {
			const wantsClientSdk =
				importCheck?.scanPluginImports(pluginDir).some((r) => r.client && r.target.startsWith("client/sdk/")) ?? false;
			if (wantsClientSdk) {
				dirs = [...dirs, join(pluginDir, "client", "sdk")];
				healed.push(id);
			}
		}
		const stale =
			dirs.some((d) => PLUGIN_SDK_FILES.some((name) => !existsSync(join(d, name)))) ||
			installedSdkVersion(join(dirs[0], "index.mjs")) !== latest;
		if (!stale) {
			fresh++;
			console.log(ZH ? `✔ ${id}：已是最新（SDK ${latest}）` : `✔ ${id}: already up to date (SDK ${latest})`);
			continue;
		}
		const cur = installedSdkVersion(join(dirs[0], "index.mjs"));
		for (const d of dirs) copySdkInto(d, sources);
		const bad = dirs.filter(
			(d) => spawnSync(NODE, ["--check", join(d, "index.mjs")], { stdio: "ignore" }).status !== 0,
		);
		if (bad.length > 0)
			broken.push(
				ZH
					? `${bad.join("、")} 未通过 node --check（磁盘/权限异常？请手动检查）`
					: `${bad.join(", ")} failed node --check (disk/permission issue? please check manually)`,
			);
		else {
			upgraded++;
			const where = dirs.map((d) => (d === join(pluginDir, "sdk") ? "sdk/" : "client/sdk/")).join(" + ");
			console.log(
				ZH
					? `✔ ${id}：SDK ${cur ?? "未知旧版"} → ${latest}（${where}）`
					: `✔ ${id}: SDK ${cur ?? "unknown old version"} → ${latest} (${where})`,
			);
		}
	}
	for (const id of healed)
		console.log(
			ZH
				? `  ↳ ${id}：补上了缺失的 client/sdk/（客户端 import ./sdk/ 需要它）`
				: `  ↳ ${id}: created the missing client/sdk/ (needed by the client-side ./sdk/ import)`,
		);
	for (const w of broken) console.log(`⚠ ${w}`);
	// 顺带自检 import 越界/缺失（issue #546：客户端越界会让插件页整页空白，而服务端看不出来）。
	if (importCheck) {
		for (const id of targets) {
			for (const p of importCheck.checkPluginImports(join(parentDir, id)).problems)
				console.log(`⚠ ${id} ${importProblemText(p)}`);
		}
	}
	console.log(
		ZH
			? `共 ${targets.length} 个插件：刷新 ${upgraded} 个，已最新 ${fresh} 个，跳过 ${skipped} 个。`
			: `Total ${targets.length} plugin(s): refreshed ${upgraded}, up to date ${fresh}, skipped ${skipped}.`,
	);
	console.log(
		ZH
			? `  生效: 服务运行中插件重载（或刷新浏览器）后新 SDK 生效；未运行则下次启动生效。`
			: `  Effect: new SDK takes effect after plugin reload (or browser refresh) while the service is running; if not running, takes effect on next start.`,
	);
}

async function pluginCreateCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help || positionals.length !== 1) {
		console.log(PLUGIN_HELP);
		if (!opts.help) process.exit(1);
		return;
	}
	const id = positionals[0];
	if (!PLUGIN_ID_RE.test(id))
		fail(ZH ? `非法插件 id "${id}"（仅限字母数字-_）` : `Invalid plugin id "${id}" (alphanumeric and -_ only)`);
	const template = opts.template ?? "minimal";
	if (!PLUGIN_TEMPLATES.includes(template))
		fail(
			ZH
				? `未知模板 "${template}"（可选 ${PLUGIN_TEMPLATES.join("|")}）`
				: `Unknown template "${template}" (options: ${PLUGIN_TEMPLATES.join("|")})`,
		);
	const parentDir = opts.dir ? resolve(opts.dir) : join(pluginDataDir(opts), "plugins");
	const target = join(parentDir, id);
	if (existsSync(target) && opts.force !== true)
		fail(
			ZH ? `目标已存在: ${target}（加 --force 覆盖）` : `Target already exists: ${target} (add --force to overwrite)`,
		);
	if (existsSync(target)) rmSync(target, { recursive: true, force: true });
	mkdirSync(join(target, "client"), { recursive: true });
	const sdkSources = pluginSdkSources();
	const useSdk = Boolean(sdkSources);
	const wantTest = opts.withTest === true;
	const files = buildPluginScaffold(id, template, useSdk, wantTest && useSdk);
	if (useSdk) copySdkInto(join(target, "sdk"), sdkSources);
	for (const [rel, content] of Object.entries(files)) writeFileSync(join(target, rel), content);
	// 客户端侧的相对依赖必须落在 client/ 内（宿主只暴露 /plugins/<id>/client/*）：生成文件里
	// 引到 client/ 内的 SDK 就把 SDK 也拷进 client/sdk/（renderer 模板客户端不用 SDK，不白拷）。
	const importCheck = await loadImportCheck();
	if (useSdk && importCheck) {
		// 模板按约定先拷（renderer 除外），再用扫描复验一遍 —— 模板以后加了客户端 SDK 引用也不会漏。
		const scanned = importCheck.scanPluginImports(target).some((r) => r.client && r.target.startsWith("client/sdk/"));
		if (templateClientUsesSdk(template) || scanned) copySdkInto(join(target, "client", "sdk"), sdkSources);
	}
	// 生成后校验：manifest 基础必填 + 生成文件的 node 语法检查 + 静态 import 自检。
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
	} catch {
		fail(
			ZH
				? `生成的 manifest.json 解析失败（请检查磁盘/权限）`
				: `Generated manifest.json failed to parse (please check disk/permissions)`,
		);
	}
	const warnings = validateScaffoldManifest(manifest, id);
	if (wantTest && !useSdk)
		warnings.push(
			ZH
				? `已加 --with-test 但包内无 plugin-sdk，跳过 index.test.mjs（无 SDK 版没有 createMockHost 可用）`
				: `--with-test specified but no plugin-sdk in package, skipping index.test.mjs (no createMockHost available without SDK)`,
		);
	const checkFiles = ["index.mjs", "client/entry.mjs"];
	if (wantTest && useSdk) checkFiles.push("index.test.mjs");
	for (const rel of checkFiles) {
		const r = spawnSync(NODE, ["--check", join(target, rel)], { stdio: "ignore" });
		if (r.status !== 0)
			warnings.push(
				ZH
					? `${rel} 未通过 node --check（请检查生成文件）`
					: `${rel} failed node --check (please check generated files)`,
			);
	}
	// 静态 import 自检（issue #546）：客户端越界 / 目标缺失都会让插件在浏览器里整页空白，
	// 而服务端看不出来 —— 在脚手架阶段就报出来。
	if (importCheck) {
		const { problems } = importCheck.checkPluginImports(target);
		for (const p of problems) warnings.push(importProblemText(p));
	}
	console.log(
		ZH ? `✔ 已生成插件骨架 ${id}（模板 ${template}）` : `✔ Plugin scaffold generated: ${id} (template: ${template})`,
	);
	console.log(ZH ? `  位置: ${target}` : `  Location: ${target}`);
	if (wantTest && useSdk)
		console.log(
			ZH
				? `  单测: node --test ${join(target, "index.test.mjs")}（createMockHost harness）`
				: `  Unit test: node --test ${join(target, "index.test.mjs")} (createMockHost harness)`,
		);
	if (!useSdk)
		console.log(
			ZH
				? `⚠ 未找到包内 plugin-sdk，已生成无 SDK 依赖版本（逻辑等价，详见 plugin-sdk/README.md）`
				: `⚠ No plugin-sdk found in package, generated SDK-free version (logically equivalent, see plugin-sdk/README.md)`,
		);
	for (const w of warnings) console.log(`⚠ ${w}`);
	console.log(
		ZH
			? `  生效: 服务运行中刷新浏览器即可加载（或发 plugins_reload）；未运行则下次启动生效。`
			: `  Effect: reload the browser to load while the service is running (or send plugins_reload); if not running, takes effect on next start.`,
	);
	console.log(
		ZH
			? `  下一步: 打开 ${join(target, "README.md")}（改名 → 写逻辑 → 刷新验证）`
			: `  Next: open ${join(target, "README.md")} (rename → write logic → refresh to verify)`,
	);
}

async function pluginInstallCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(PLUGIN_HELP);
		return;
	}
	// 目录同步模式（issue #165）：install --catalog <url> —— 读目录文档 → 校验 →
	// 原子写盘 → 逐条安装/更新（与服务端 plugin-catalog-sync 同语义）。
	if (opts.catalog !== undefined) {
		if (positionals.length !== 0)
			fail(
				ZH
					? `用法: pi-web-ui install --catalog <目录> [--data-dir <dir>] [--force] [--build|--no-build] [--replace]\n${PLUGIN_HELP}`
					: `Usage: pi-web-ui install --catalog <dir> [--data-dir <dir>] [--force] [--build|--no-build] [--replace]\n${PLUGIN_HELP}`,
			);
		if (opts.name)
			fail(
				ZH
					? "--catalog 模式下 --name 无意义（目录名/id 来自目录条目）"
					: "--name has no effect in --catalog mode (directory name/id comes from directory entries)",
			);
		await installCatalogCmd(opts);
		return;
	}
	if (positionals.length !== 1)
		fail(
			ZH
				? `用法: pi-web-ui install <源> [--name <id>] [--data-dir <dir>] [--force] [--build|--no-build]\n${PLUGIN_HELP}`
				: `Usage: pi-web-ui install <source> [--name <id>] [--data-dir <dir>] [--force] [--build|--no-build]\n${PLUGIN_HELP}`,
		);
	try {
		const { id, target, manifest } = await installOnePlugin({
			rawSpec: positionals[0],
			name: opts.name,
			force: opts.force === true,
			build: opts.build === true,
			noBuild: opts.noBuild === true,
			dataDir: pluginDataDir(opts),
		});
		console.log(
			ZH
				? `✔ 已安装插件 ${id}${manifest.name && manifest.name !== id ? `（${manifest.name}）` : ""}${manifest.version ? ` v${manifest.version}` : ""}`
				: `✔ Plugin installed: ${id}${manifest.name && manifest.name !== id ? `(${manifest.name})` : ""}${manifest.version ? ` v${manifest.version}` : ""}`,
		);
		if (manifest.description) console.log(`  ${manifest.description}`);
		console.log(ZH ? `  位置: ${target}` : `  Location: ${target}`);
		console.log(
			ZH
				? `  生效: 服务运行中刷新浏览器即可加载；未运行则下次启动生效。卸载: pi-web-ui uninstall ${id}`
				: `  Effect: reload the browser to load while the service is running; if not running, takes effect on next start. Uninstall: pi-web-ui uninstall ${id}`,
		);
	} catch (err) {
		fail(`${err?.message ?? err}`);
	}
}

function pluginUninstallCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help || positionals.length !== 1) {
		console.log(PLUGIN_HELP);
		if (!opts.help) process.exit(1);
		return;
	}
	const id = positionals[0];
	if (!PLUGIN_ID_RE.test(id)) fail(ZH ? `非法插件 id: ${id}` : `Invalid plugin id: ${id}`);
	const target = join(pluginDataDir(opts), "plugins", id);
	if (!existsSync(target))
		fail(
			ZH
				? `未安装插件 "${id}"（pi-web-ui plugins 查看已装列表）`
				: `Plugin not installed: "${id}" (pi-web-ui plugins to see installed list)`,
		);
	rmSync(target, { recursive: true, force: true });
	console.log(
		ZH
			? `✔ 已卸载插件 ${id} —— 运行中的服务刷新浏览器后消失。`
			: `✔ Plugin uninstalled: ${id} — disappears after a browser refresh while the service is running.`,
	);
}

function pluginListCmd(argv) {
	const { opts } = parseFlags(argv);
	if (opts.help) {
		console.log(PLUGIN_HELP);
		return;
	}
	const dataDir = pluginDataDir(opts);
	// --rollback <id>：回滚到最近一份更新前备份
	if (opts.rollback) {
		const id = String(opts.rollback);
		if (!PLUGIN_ID_RE.test(id)) fail(ZH ? `非法插件 id: ${id}` : `Invalid plugin id: ${id}`);
		const target = join(dataDir, "plugins", id);
		if (!existsSync(target))
			fail(
				ZH
					? `未安装插件 "${id}"（pi-web-ui plugins 查看已装列表）`
					: `Plugin not installed: "${id}" (pi-web-ui plugins to see installed list)`,
			);
		const ts = restorePluginBackup(dataDir, id);
		if (!ts)
			fail(
				ZH
					? `插件 "${id}" 没有更新备份（从未覆盖安装 / 备份已用完）`
					: `Plugin "${id}" has no update backup (never overwrite-installed / backup exhausted)`,
			);
		console.log(
			ZH
				? `✔ 已回滚插件 ${id} 到 ${ts} 的快照 —— 运行中的服务刷新浏览器后生效。`
				: `✔ Plugin rolled back: ${id} to ${ts} snapshot — takes effect after a browser refresh while the service is running.`,
		);
		return;
	}
	// --check-updates：对比各插件记录的最后安装 sha 与远端 HEAD（git ls-remote）
	if (opts.checkUpdates) {
		return checkUpdatesCmd(dataDir).then(() => {});
	}
	const pluginsDir = join(dataDir, "plugins");
	const rows = [];
	let names = [];
	try {
		names = readdirSync(pluginsDir).sort();
	} catch {
		/* 目录不存在 = 未安装任何插件 */
	}
	for (const n of names) {
		if (!PLUGIN_ID_RE.test(n)) continue;
		try {
			const m = JSON.parse(readFileSync(join(pluginsDir, n, "manifest.json"), "utf8"));
			rows.push(
				`  ${n.padEnd(24)} ${[m.name, m.version ? `v${m.version}` : "", m.description].filter(Boolean).join("  ")}`,
			);
		} catch {
			continue; // 坏目录跳过
		}
	}
	if (rows.length === 0) {
		console.log(
			ZH
				? `尚未安装任何界面插件（目录: ${pluginsDir}）\n安装示例: pi-web-ui install owner/repo`
				: `No UI plugins installed yet (directory: ${pluginsDir})\nInstall example: pi-web-ui install owner/repo`,
		);
		return;
	}
	console.log(
		ZH
			? `已安装的界面插件（${pluginsDir}）:\n${rows.join("\n")}`
			: `Installed UI plugins (${pluginsDir}):\n${rows.join("\n")}`,
	);
}

async function checkUpdatesCmd(dataDir) {
	console.log(
		ZH
			? "检查界面插件更新（git ls-remote 对比最近安装版本）…\n"
			: "Checking UI plugin updates (git ls-remote vs. last installed version)…\n",
	);
	let rows;
	try {
		rows = await checkPluginUpdates(dataDir);
	} catch (err) {
		fail(ZH ? `更新检查失败：${err?.message ?? err}` : `Update check failed: ${err?.message ?? err}`);
	}
	if (rows.length === 0) {
		console.log(
			ZH
				? `尚未安装任何带来源记录的界面插件（目录: ${join(dataDir, "plugins")}）`
				: `No UI plugins with origin records installed yet (directory: ${join(dataDir, "plugins")})`,
		);
		return;
	}
	let any = false;
	for (const r of rows) {
		const label = r.name && r.name !== r.id ? `${r.id}（${r.name}）` : r.id;
		if (r.updatable) {
			const cur = r.version ? (r.version.startsWith("v") ? r.version : `v${r.version}`) : (r.localSha ?? "未知");
			const lat = r.latestVersion
				? r.latestVersion.startsWith("v")
					? r.latestVersion
					: `v${r.latestVersion}`
				: (r.remoteSha ?? "");
			console.log(
				ZH
					? `  🔄 ${label}${r.version ? ` v${r.version}` : ""}  可更新（已装 ${cur} → 远端 ${lat}）`
					: `  🔄 ${label}${r.version ? ` v${r.version}` : ""}  Updatable (installed ${cur} → remote ${lat})`,
			);
			console.log(
				ZH
					? `     更新: pi-web-ui install ${r.source} --name ${r.id} --force`
					: `     Update: pi-web-ui install ${r.source} --name ${r.id} --force`,
			);
			any = true;
		} else if (r.latestVersion || r.remoteSha) {
			const detail = r.latestVersion
				? r.latestVersion.startsWith("v")
					? r.latestVersion
					: `v${r.latestVersion}`
				: (r.remoteSha ?? "");
			console.log(
				ZH
					? `  ✓ ${label}${r.version ? ` v${r.version}` : ""}  已是最新（${detail}）`
					: `  ✓ ${label}${r.version ? ` v${r.version}` : ""}  Up to date (${detail})`,
			);
		} else {
			console.log(
				ZH
					? `  ? ${label}  ${r.error ?? "无法检查"}（来源: ${r.source}）`
					: `  ? ${label}  ${r.error ?? "cannot check"} (source: ${r.source})`,
			);
		}
	}
	if (!any) console.log(ZH ? "\n全部插件均为最新版本。" : "\nAll plugins are up to date.");
}

async function serverCmd(argv) {
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length === 0) {
		console.log(HELP);
		console.log(ZH ? "--- 当前服务状态 ---" : "--- Current service status ---");
		controlService("status", opts);
		return;
	}
	const action = positionals[0];
	if (positionals.length > 1)
		fail(
			ZH ? `多余的参数: ${positionals.slice(1).join(" ")}` : `Unexpected argument: ${positionals.slice(1).join(" ")}`,
		);
	switch (action) {
		case "shortcut": {
			if (isWin) {
				installWinShortcut(opts);
			} else if (isMac) {
				installMacShortcut(opts);
			} else if (isLinux) {
				installLinuxShortcut(opts);
			} else {
				fail(
					ZH ? `不支持的系统服务平台: ${process.platform}` : `Unsupported system service platform: ${process.platform}`,
				);
			}
			break;
		}
		case "install": {
			if (isMac) {
				installLaunchd(opts);
			} else if (isLinux) {
				installSystemd(opts);
			} else if (isWin) {
				installWindows(opts);
			} else {
				fail(
					ZH ? `不支持的系统服务平台: ${process.platform}` : `Unsupported system service platform: ${process.platform}`,
				);
			}
			break;
		}
		case "uninstall": {
			if (isMac) {
				uninstallLaunchd(opts);
			} else if (isLinux) {
				uninstallSystemd(opts);
			} else if (isWin) {
				uninstallWindows(opts);
			} else {
				fail(
					ZH ? `不支持的系统服务平台: ${process.platform}` : `Unsupported system service platform: ${process.platform}`,
				);
			}
			break;
		}
		case "start":
		case "stop":
		case "restart":
			controlService(action, opts);
			break;
		case "status":
			controlService("status", opts);
			await printLiveStatus(opts);
			break;
		case "quiesce":
			await setQuiesce(opts, true);
			break;
		case "unquiesce":
			await setQuiesce(opts, false);
			break;
		default:
			fail(
				ZH
					? `未知操作: ${action}（install / shortcut / uninstall / start / stop / restart / status / quiesce / unquiesce）`
					: `Unknown operation: ${action} (install / shortcut / uninstall / start / stop / restart / status / quiesce / unquiesce)`,
			);
	}
}

async function main() {
	checkNodeVersion();
	const argv = process.argv.slice(2);
	if (argv.length === 0) {
		await startForeground({});
		return;
	}
	const first = argv[0];
	if (first === "--version" || first === "-v") {
		console.log(pkg.version);
		return;
	}
	if (first === "--help" || first === "-h") {
		console.log(HELP);
		return;
	}
	if (first === "server") {
		await serverCmd(argv.slice(1));
		return;
	}
	if (first === "install") {
		await pluginInstallCmd(argv.slice(1));
		return;
	}
	if (first === "uninstall") {
		pluginUninstallCmd(argv.slice(1));
		return;
	}
	if (first === "plugins" || first === "plugin") {
		if (argv[1] === "upgrade-sdk") {
			await pluginUpgradeSdkCmd(argv.slice(2));
			return;
		}
		if (argv[1] === "create") {
			await pluginCreateCmd(argv.slice(2));
			return;
		}
		pluginListCmd(argv.slice(1));
		return;
	}
	// One-shot server with optional --port/--cwd/--data-dir overrides.
	const { opts, positionals } = parseFlags(argv);
	if (opts.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length > 0)
		fail(
			ZH ? `未知命令: ${positionals[0]}（--help 查看用法）` : `Unknown command: ${positionals[0]} (--help for usage)`,
		);
	await startForeground(opts);
}

main().catch((err) => {
	console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
