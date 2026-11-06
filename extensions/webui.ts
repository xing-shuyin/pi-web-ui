import { spawn, execSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = join(PKG_ROOT, "dist", "server", "index.js");

function resolveNode(): string {
	const base = process.execPath.toLowerCase();
	if (!(process as any).isBun && /(^|[/\\])(node|nodejs)(\.exe)?$/.test(base)) {
		return process.execPath;
	}

	const candidates: string[] = [];
	try {
		const cmd = process.platform === "win32" ? "where node" : "which node";
		const out = execSync(cmd, { windowsHide: true }).toString().trim();
		for (const line of out.split(/\r?\n/)) {
			const p = line.trim();
			if (p && !/pi[/\\]pi(\.exe)?$/i.test(p)) candidates.push(p);
		}
	} catch {}

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

interface RunningServer {
	proc: ReturnType<typeof spawn>;
	port: number;
	cwd: string;
	url: string;
	logFile?: string;
	stop: () => void;
}

const running = new Map<string, RunningServer>();

export function buildNodeArgs(
	entry: string,
	hookPath?: string,
	hookExists = hookPath ? existsSync(hookPath) : false,
): string[] {
	return hookPath && hookExists ? ["--import", pathToFileURL(hookPath).href, entry] : [entry];
}

export { running };

function findFreePort(from = 8787): Promise<number> {
	return new Promise((resolve_, reject) => {
		const srv = net.createServer();
		srv.listen(from, () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve_(port));
		});
		srv.on("error", () => {
			findFreePort(from + 1).then(resolve_, reject);
		});
	});
}

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

async function openBrowser(url: string): Promise<void> {
	const { platform } = process;
	const [cmd, ...rest] =
		platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
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

const READY_HEALTH_PATH = "/api/health";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;

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

			if (action !== "start" && action !== "run") {
				ctx.ui.notify(`未知动作 ${action}（可用 start|stop|status）`, "warning");
				return;
			}

			const existing = running.get(sid);
			if (existing && existing.proc.exitCode === null && existing.proc.signalCode === null) {
				ctx.ui.notify(`pi-web-ui 已在运行 → ${existing.url}`, "info");
				return;
			}

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
				PI_WEB_PORT: String(port),
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
			} catch {}

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

	pi.on("session_shutdown", async (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		const inst = running.get(sid);
		if (inst && inst.proc.exitCode === null && inst.proc.signalCode === null) {
			inst.stop();
		}
		running.delete(sid);
	});
}
