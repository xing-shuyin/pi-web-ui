/**
 * pi-web-ui 的 pi 扩展 —— 提供命令行集成。
 *
 * 能力：
 *   /webui                      启动本机 pi-web-ui 服务器，打开浏览器访问
 *   /webui --port 9000          指定端口启动
 *   /webui --no-browser         启动但不开浏览器
 *   /webui stop                 停止已启动的服务器
 *   /webui status               查看运行状态 / URL
 *
 * 实现说明：
 *   - 不依赖全局 bin（pi install 后 pi-web-ui 命令不一定在 PATH），直接用
 *     node 调包内 dist/server/index.js，通过环境变量 PORT / PI_WEB_CWD /
 *     PI_WEB_DATA_DIR 控制。
 *   - 工作目录默认用当前 pi 会话的 ctx.cwd；可用 --cwd / path 覆盖。
 *   - 服务器作为子进程后台运行，/webui 不阻塞 pi。
 *   - 每个 pi 会话管理一个子进程；session_shutdown 时清理，避免孤儿进程。
 */

import { spawn, execSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// 本文件位于 <pkg>/extensions/webui.ts → 包根在上一级
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(PKG_ROOT, "dist", "server", "index.js");

/**
 * 解析真实的 node 可执行路径。
 *
 * pi 0.87+ 的 TUI 版本是 Bun 打包的二进制（pi.exe），此时 process.execPath 指向
 * pi.exe 而非 node。用 pi.exe 去 spawn(index.js) 会静默失败（pi.exe 不能当
 * node 执行脚本）。此函数在 Bun 环境或 execPath 非 node 时，从 PATH 和常见安装
 * 位置回退查找真实 node。
 */
function resolveNode(): string {
	const base = process.execPath.toLowerCase();
	// 普通 node 直接返回（未被 Bun 接管）
	if (!(process as any).isBun && /(^|[/\\])(node|nodejs)(\.exe)?$/.test(base)) {
		return process.execPath;
	}

	const candidates: string[] = [];
	// 1. 从 PATH 里找（跨平台：Windows 用 where，其余用 which）
	try {
		const cmd = process.platform === "win32" ? "where node" : "which node";
		const out = execSync(cmd, { windowsHide: true }).toString().trim();
		for (const line of out.split(/\r?\n/)) {
			const p = line.trim();
			// 过滤掉 pi 自身
			if (p && !/pi[/\\]pi(\.exe)?$/i.test(p)) candidates.push(p);
		}
	} catch {
		/* node 不在 PATH */
	}

	// 2. 常见安装位置兜底（Windows 为主，也兼顾 Unix）
	const home = homedir();
	const extra: string[] = [];
	if (process.env.PNPM_HOME) extra.push(join(process.env.PNPM_HOME, "node.exe"));
	for (const rel of [
		"scoop/apps/nodejs/current/node.exe",
		"AppData/Roaming/nvm/current/node.exe",
		".nvm/versions/node/current/bin/node",
		".local/share/pnpm/node.exe",
		".local/bin/node",
	]) {
		extra.push(join(home, ...rel.split("/")));
	}
	for (const c of extra) {
		if (existsSync(c) && !/pi[/\\]pi(\.exe)?$/i.test(c)) candidates.push(c);
	}

	if (candidates.length > 0) return candidates[0];

	console.warn(
		"[webui] 未找到真实 node（当前 process.execPath 指向非 node 进程，疑似 Bun 环境）。" +
			"将退回 process.execPath，子进程可能无法启动。请确保 node 在 PATH 中。",
	);
	return process.execPath;
}

const NODE = resolveNode();

/** 每个会话的服务器子进程 + 元数据 */
interface RunningServer {
	proc: ReturnType<typeof spawn>;
	port: number;
	cwd: string;
	url: string;
	logFile?: string;
	stop: () => void;
}

// 会话 → 运行实例（模块级 Map；每会话一个会话对象，无需清理全局）
const running = new Map<string, RunningServer>();

/**
 * 组装子进程参数。
 * hookPath（resolve-global-sdk.js）必须以 file:// URL 形式传给 --import，
 * 否则在 Windows 上传裸盘符路径（如 C:\...）会触发 Node ESM 的 ERR_UNSUPPORTED_ESM_URL_SCHEME 异常（issue #420 / #580）。
 */
export function buildNodeArgs(
	entry: string,
	hookPath?: string,
	hookExists = hookPath ? existsSync(hookPath) : false,
): string[] {
	return hookPath && hookExists ? ["--import", pathToFileURL(hookPath).href, entry] : [entry];
}

export { running };

/** 找一个空闲端口 */
function findFreePort(from = 8787): Promise<number> {
	return new Promise((resolve_, reject) => {
		const srv = net.createServer();
		srv.listen(from, () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve_(port));
		});
		srv.on("error", () => {
			// 端口被占则顺延
			findFreePort(from + 1).then(resolve_, reject);
		});
	});
}

/** 解析 --key value / --flag 参数 */
function parseArgs(args: string): { port?: number; cwd?: string; noBrowser: boolean } {
	const out: { port?: number; cwd?: string; noBrowser: boolean } = { noBrowser: false };
	const toks = args.split(/\s+/).filter(Boolean);
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if ((t === "--port" || t === "-p") && toks[i + 1]) {
			const n = Number(toks[++i]);
			if (Number.isInteger(n) && n > 0 && n < 65536) out.port = n;
		} else if (t === "--cwd" && toks[i + 1]) {
			out.cwd = resolve(toks[++i]);
		} else if (t === "--no-browser") {
			out.noBrowser = true;
		}
	}
	return out;
}

/** 打开浏览器 */
async function openBrowser(url: string): Promise<void> {
	const { platform } = process;
	const [cmd, ...rest] =
		platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
	// 无界面环境缺少 xdg-open 等打开器时，ENOENT 以异步 'error' 事件触发，
	// try/catch 拦不住会崩掉整个进程 —— 必须挂 error 监听。
	// Windows 下 detached 子进程会新建控制台闪窗；改为不 detached 并 windowsHide。
	spawn(cmd, rest, { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true })
		.on("error", (err) => {
			if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
				console.warn(
					`[webui] 未找到浏览器打开器 (${(err as NodeJS.ErrnoException).path || "command not found"})，请用 --no-browser 关闭自动打开`,
				);
			} else {
				console.warn("[webui] 打开浏览器失败:", err.message);
			}
		})
		.unref();
}

/** 就绪探针：/api/health 无需鉴权（server/index.ts），有应答就说明已经 listen。 */
const READY_HEALTH_PATH = "/api/health";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;

/**
 * 等到服务端真的应答再打开浏览器。
 *
 * spawn 之后服务还要激活插件、连 MCP 才 listen；当场 openBrowser 会打开一个所有
 * 请求都 ERR_CONNECTION_REFUSED 的页面（主题样式表、提示模板全拉不到，只能手动刷新
 * 才能恢复，issue #814）。bin/pi-web-ui.mjs 的前台启动一直用同样的轮询
 * （openBrowserWhenUp），扩展路径当初漏了这一步。
 *
 * `isAlive` 为假（子进程已退出/被 /webui stop）时直接放弃：开一个注定打不开的页面
 * 只会误导用户。超时也开（之前的行为），但先告警一次。
 */
export async function openBrowserWhenUp(
	url: string,
	port: number,
	options: { isAlive: () => boolean; open?: (target: string) => Promise<void> },
): Promise<void> {
	const { isAlive, open = openBrowser } = options;
	const deadline = Date.now() + READY_TIMEOUT_MS;
	let ready = false;
	while (Date.now() < deadline) {
		if (!isAlive()) return;
		try {
			// 127.0.0.1 而非 localhost：服务默认只 bind IPv4 回环，localhost 可能先解析到 ::1。
			await fetch(`http://127.0.0.1:${port}${READY_HEALTH_PATH}`, { signal: AbortSignal.timeout(1500) });
			ready = true;
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
		}
	}
	if (!ready) console.warn(`[webui] 等待服务端就绪超时（${READY_TIMEOUT_MS / 1000}s），仍尝试打开 ${url}`);
	await open(url);
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("webui", {
		description: "启动本机 pi-web-ui Web 界面（/webui [--port N] [--cwd PATH] [--no-browser] | stop | status）",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sid = ctx.sessionManager.getSessionId();
			const opts = parseArgs(args);
			const action = (args.split(/\s+/)[0] || "start").toLowerCase();

			// 停止
			if (action === "stop" || action === "kill") {
				const inst = running.get(sid);
				const alive = inst && inst.proc.exitCode === null && inst.proc.signalCode === null;
				if (!inst || !alive) {
					running.delete(sid);
					ctx.ui.notify("没有正在运行的本机 pi-web-ui 服务器", "info");
					return;
				}
				inst.stop();
				running.delete(sid);
				ctx.ui.notify(`已停止 pi-web-ui (${inst.url})`, "info");
				return;
			}

			// 状态
			if (action === "status") {
				const inst = running.get(sid);
				if (!inst) {
					ctx.ui.notify("本机 pi-web-ui 未运行", "info");
					return;
				}
				const alive = inst.proc.exitCode === null && inst.proc.signalCode === null;
				if (alive) {
					ctx.ui.notify(
						`pi-web-ui 运行中 → ${inst.url}\n端口 ${inst.port} · cwd ${inst.cwd}${inst.logFile ? `\n日志: ${inst.logFile}` : ""}`,
						"info",
					);
				} else {
					const exit =
						inst.proc.exitCode !== null
							? `exit=${inst.proc.exitCode}`
							: inst.proc.signalCode
								? `signal=${inst.proc.signalCode}`
								: "unknown";
					ctx.ui.notify(`pi-web-ui 已退出 (${exit})${inst.logFile ? ` · 日志: ${inst.logFile}` : ""}`, "warning");
				}
				return;
			}

			// 默认 start
			if (action !== "start" && action !== "run") {
				ctx.ui.notify(`未知动作 ${action}（可用 start|stop|status）`, "warning");
				return;
			}

			// 已运行则提示
			const existing = running.get(sid);
			if (existing && existing.proc.exitCode === null && existing.proc.signalCode === null) {
				ctx.ui.notify(`pi-web-ui 已在运行 → ${existing.url}`, "info");
				return;
			}

			// 检查是否已构建
			if (!existsSync(SERVER_ENTRY)) {
				ctx.ui.notify(
					"缺少 dist/ 产物（当前安装未包含已构建前端）。请运行 `npm run build` 后重试，或用 pi-web-ui 官方 npm 包。",
					"warning",
				);
				return;
			}

			const port = opts.port ?? (await findFreePort());
			const cwd = opts.cwd ?? ctx.cwd;
			const url = `http://localhost:${port}`;

			// 探测并向子进程显式透传宿主 Pi SDK 路径（issue #482）
			let hostSdkDir: string | undefined;
			try {
				const resolved = import.meta.resolve?.("@earendil-works/pi-coding-agent");
				if (resolved) {
					let p = resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
					if (p.endsWith("index.js") || p.endsWith("index.mjs")) p = dirname(p);
					if (existsSync(join(p, "package.json"))) hostSdkDir = p;
				}
			} catch {}

			const dataDir = process.env.PI_WEB_DATA_DIR ? resolve(process.env.PI_WEB_DATA_DIR) : join(cwd, ".pi-web");
			const env = {
				...process.env,
				PORT: String(port),
				PI_WEB_PORT: String(port), // server/index.js 读取 PI_WEB_PORT
				PI_WEB_CWD: cwd,
				...(hostSdkDir ? { PI_WEB_SDK_DIR: hostSdkDir } : {}),
				PI_WEB_DATA_DIR: dataDir,
			};
			const hookPath = join(PKG_ROOT, "dist", "server", "resolve-global-sdk.js");
			const nodeArgs = buildNodeArgs(SERVER_ENTRY, hookPath);

			let logFile: string | undefined;
			let logFd: number | "ignore" = "ignore";
			try {
				mkdirSync(dataDir, { recursive: true });
				logFile = join(dataDir, "webui.log");
				logFd = openSync(logFile, "a");
			} catch {
				/* 无法创建日志目录或文件时静默回退 ignore */
			}

			const proc = spawn(NODE, nodeArgs, {
				cwd,
				env,
				stdio: ["ignore", logFd, logFd],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
			if (typeof logFd === "number") {
				try {
					closeSync(logFd);
				} catch {}
			}
			proc.unref();

			let stoppedManually = false;
			const startTime = Date.now();
			const inst: RunningServer = {
				proc,
				port,
				cwd,
				url,
				logFile,
				stop: () => {
					stoppedManually = true;
					proc.kill("SIGTERM");
				},
			};
			running.set(sid, inst);

			proc.on("error", (err) => {
				ctx.ui.notify(`pi-web-ui 启动失败: ${err.message}${logFile ? `\n日志: ${logFile}` : ""}`, "error");
			});

			proc.on("exit", (code, signal) => {
				const duration = Date.now() - startTime;
				// 启动后 15 秒内非手动停止的异常退出，向用户告警
				if (!stoppedManually && (code !== 0 || signal !== null) && duration < 15000) {
					const reason = code !== null ? `exit=${code}` : `signal=${signal}`;
					ctx.ui.notify(`pi-web-ui 启动异常退出 (${reason})。\n${logFile ? `查看日志: ${logFile}` : ""}`, "error");
				}
			});

			ctx.ui.notify(`pi-web-ui 启动中 → ${url}\n端口 ${port} · cwd ${cwd}\n(几秒后可用，/webui status 查看)`);

			if (!opts.noBrowser)
				void openBrowserWhenUp(url, port, {
					isAlive: () => !stoppedManually && proc.exitCode === null && proc.signalCode === null,
				});
		},
	});

	// 会话结束清理子进程，避免孤儿
	pi.on("session_shutdown", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const inst = running.get(sid);
		if (inst && inst.proc.exitCode === null && inst.proc.signalCode === null) {
			inst.stop();
		}
		running.delete(sid);
	});
}
