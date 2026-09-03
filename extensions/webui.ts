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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// 本文件位于 <pkg>/extensions/webui.ts → 包根在上一级
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(PKG_ROOT, "dist", "server", "index.js");
const NODE = process.execPath;

/** 每个会话的服务器子进程 + 元数据 */
interface RunningServer {
	proc: ReturnType<typeof spawn>;
	port: number;
	cwd: string;
	url: string;
}

// 会话 → 运行实例（模块级 Map；每会话一个会话对象，无需清理全局）
const running = new Map<string, RunningServer>();

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
	spawn(cmd, rest, { stdio: "ignore", detached: true })
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
				if (!inst) {
					ctx.ui.notify("没有正在运行的本机 pi-web-ui 服务器", "info");
					return;
				}
				inst.proc.kill("SIGTERM");
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
				const alive = inst.proc.exitCode === null;
				ctx.ui.notify(
					alive
						? `pi-web-ui 运行中 → ${inst.url}\n端口 ${inst.port} · cwd ${inst.cwd}`
						: `已退出(exit=${inst.proc.exitCode})`,
					alive ? "info" : "warning",
				);
				return;
			}

			// 默认 start
			if (action !== "start" && action !== "run") {
				ctx.ui.notify(`未知动作 ${action}（可用 start|stop|status）`, "warning");
				return;
			}

			// 已运行则提示
			const existing = running.get(sid);
			if (existing && existing.proc.exitCode === null) {
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

			const env = {
				...process.env,
				PORT: String(port),
				PI_WEB_CWD: cwd,
				...(process.env.PI_WEB_DATA_DIR ? {} : { PI_WEB_DATA_DIR: join(cwd, ".pi-web") }),
			};
			const proc = spawn(NODE, [SERVER_ENTRY], { cwd, env, stdio: "ignore", detached: true });
			proc.unref();
			running.set(sid, { proc, port, cwd, url });

			ctx.ui.notify(`pi-web-ui 启动中 → ${url}\n端口 ${port} · cwd ${cwd}\n(几秒后可用，/webui status 查看)`);

			if (!opts.noBrowser) await openBrowser(url);

			// 进程退出时清理
			proc.on("exit", () => {
				if (running.get(sid)?.proc === proc) running.delete(sid);
			});
		},
	});

	// 会话结束清理子进程，避免孤儿
	pi.on("session_shutdown", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const inst = running.get(sid);
		if (inst && inst.proc.exitCode === null) {
			inst.proc.kill("SIGTERM");
			running.delete(sid);
		}
	});
}
