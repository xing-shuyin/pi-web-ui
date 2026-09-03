/**
 * pi-web-ui server entry.
 *
 * - Serves the built frontend (web/dist) in production; in dev, Vite serves it
 *   on :5173 and proxies /ws to this server.
 * - Exposes /api/health and a WebSocket endpoint at /ws carrying the chat
 *   protocol defined in protocol.ts.
 *
 * Env:
 *   PI_WEB_PORT     HTTP port (default 8787)
 *   PI_WEB_CWD      workspace the agent operates in (default: process.cwd())
 *   PI_WEB_DATA_DIR where per-client UI state is stored (client-state.json,
 *   default: <home>/.pi-web). Chat sessions are NOT stored here — they live
 *   in the pi agent's global TUI session dir (~/.pi/agent/sessions/--<cwd>--/)
 *   via the SDK default, so this web UI, the dev instance, and the pi CLI/TUI
 *   all share one conversation list per project.
 *   PI_CODING_AGENT_DIR  pi config dir (auth/models/skills) — passed to the SDK
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import compression from "compression";
import { WebSocket, WebSocketServer } from "ws";
import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "./protocol-version.js";
import {
	AgentService,
	workspacePath,
	QuiesceRejectedError,
} from "./agent-service.js";
import { previewKind } from "./text-sniff.js";
import { startControlServer } from "./control-socket.js";
import { scheduleUploadCleanup } from "./uploads.js";
import { ensureWindowsBash, windowsBashDir } from "./ensure-bash.js";
import { listThemes, resolveThemeFile } from "./themes.js";
import { PluginManager, resolvePluginClientFile } from "./plugins.js";
import { McpBridge } from "./mcp-bridge.js";
import type {
	BgServer,
	ClientMessage,
	CommandDef,
	PromptAttachment,
	ServerMessage,
} from "./protocol.js";

/** 从 CLI 参数中取 flag 值：支持 --flag value 与 --flag=value 两种写法。
 *  让 `node dist/server/index.js --host 0.0.0.0 --port 9000` 这类直接启动也能生效，
 *  而不只是经由 bin/pi-web-ui.mjs 的 env 转发。bin 仍是主入口，此处仅作兜底。 */
function cliFlag(name: string): string | undefined {
	const eq = `${name}=`;
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a === name && i + 1 < process.argv.length) return process.argv[i + 1];
		if (a.startsWith(eq)) return a.slice(eq.length);
	}
	return undefined;
}

const PORT = Number(cliFlag("--port") ?? process.env.PI_WEB_PORT ?? 8787);
const CWD = resolve(cliFlag("--cwd") ?? process.env.PI_WEB_CWD ?? process.cwd());
const DATA_DIR = resolve(cliFlag("--data-dir") ?? process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));

/** Bind address. Default is loopback ONLY — the service is a local personal
 *  tool and should not be reachable from the network unless explicitly asked
 *  (e.g. PI_WEB_HOST=0.0.0.0 for LAN access / Docker port mapping). */
const HOST = cliFlag("--host") ?? process.env.PI_WEB_HOST ?? "127.0.0.1";
/** Optional strict hostname allowlist (comma-separated) — only used when set.
 *  Origin / Host same-authority matching happens regardless. */
const ALLOW_HOSTS = (process.env.PI_WEB_ALLOW_HOSTS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
/** Optional extra Origins allowed through the same-authority check (comma-
 *  separated, e.g. reverse-proxy setups where the browser origin differs
 *  from the Host the backend sees). */
const ALLOW_ORIGINS = (process.env.PI_WEB_ALLOW_ORIGINS ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
/** 可选共享口令（PI_WEB_TOKEN）：设置后所有 HTTP/WS 请求必须携带——
 *  Authorization: Bearer / X-PI-Token 头、?token= 查询参数或 pi_web_token cookie
 *  任一匹配即可；供 0.0.0.0 / 反代等暴露场景兜底，未设置则行为不变。 */
const AUTH_TOKEN = process.env.PI_WEB_TOKEN?.trim() ?? "";
// Root of the SDK default per-project session dirs — chat transcripts live in
// <SESSION_DIR_ROOT>/--<cwd>--/, shared with the pi CLI/TUI (getAgentDir
// honors PI_CODING_AGENT_DIR).
const SESSION_DIR_ROOT = join(getAgentDir(), "sessions");

// Windows 轻量 bash 兜底：把 <home>/.pi-web/bin 前置到 PATH（SDK 的 bash 工具经
// findBashOnPath 会找到其中的 bash.exe），并在无 Git Bash 时后台下载 busybox-w32。
// 终端面板的 shell 探测链也已包含该目录（见 terminals.ts resolveShell）。
if (process.platform === "win32") {
	process.env.PATH = `${windowsBashDir()}${delimiter}${process.env.PATH ?? ""}`;
	void ensureWindowsBash();
}

const app = express();
app.use(express.json({ limit: "10mb" }));

/** 从请求中提取候选 token：头 / 查询参数 / cookie（浏览器导航场景靠 cookie 续命）。 */
function requestTokens(req: { headers: IncomingMessage["headers"]; url?: string }): string[] {
	const out: string[] = [];
	const auth = req.headers.authorization;
	if (typeof auth === "string" && auth.startsWith("Bearer ")) out.push(auth.slice(7).trim());
	const header = req.headers["x-pi-token"];
	if (typeof header === "string") out.push(header.trim());
	try {
		const q = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
		if (q) out.push(q.trim());
	} catch {
		/* ignore malformed url */
	}
	const cookie = req.headers.cookie;
	if (typeof cookie === "string") {
		for (const part of cookie.split(";")) {
			const [k, ...rest] = part.trim().split("=");
			if (k === "pi_web_token") out.push(rest.join("=").trim());
		}
	}
	return out.filter(Boolean);
}

function tokenOk(req: Parameters<typeof requestTokens>[0]): boolean {
	return requestTokens(req).includes(AUTH_TOKEN);
}

if (AUTH_TOKEN) {
	// /api/health 保持开放：无敏感信息，容器/监控探针需要它。
	// 但绝不能因命中 /api/health 就反射下发真实 token cookie（安全漏洞）。
	app.use((req, res, next) => {
		const ok = tokenOk(req);
		// 浏览器经 ?token= 首次进入后下发 HttpOnly cookie，后续导航/资源请求免带参数；
		// 只有请求确实携带着有效 token 时才下发——匿名命中 /api/health 不触发。
		if (ok && !req.headers.cookie?.includes("pi_web_token=")) {
			res.setHeader(
				"Set-Cookie",
				`pi_web_token=${encodeURIComponent(AUTH_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
			);
		}
		if (req.path === "/api/health" || ok) {
			next();
			return;
		}
		res.status(401).send("unauthorized: PI_WEB_TOKEN required (?token=…)");
	});
}

/** 引擎选择：PI_WEB_ENGINE=pi|dsh（默认 pi）。重启生效。 */
const ENGINE: "pi" | "dsh" =
	process.env.PI_WEB_ENGINE === "dsh" ? "dsh" : "pi";

app.get("/api/health", (_req, res) => {
	res.json({ ok: true, piVersion: VERSION, cwd: CWD, pid: process.pid, engine: ENGINE });
});

/**
 * Stream a workspace file over HTTP.
 *
 * Media preview (no download param): only image/video kinds are served —
 * text goes over the WebSocket, and exe/jar/etc. are never exposed here.
 * express's sendFile handles Range requests, so video seeking works.
 *
 * Download (?download=1): any file kind is served with
 * Content-Disposition: attachment so the browser saves it instead of
 * rendering. Path is validated against the workspace root either way.
 */
app.get("/api/file", async (req, res) => {
	try {
		const raw = typeof req.query.path === "string" ? req.query.path : "";
		// Resolve against the requesting client's workspace (the opened
		// project), not the server's startup cwd — they can differ when the
		// client switched projects or restored a previous workspace. Fall
		// back to the server cwd for requests without a known client.
		const cid =
			typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const wp = workspacePath(cs?.cwd ?? CWD, raw);
		if (!wp) {
			res.status(400).end("path outside workspace");
			return;
		}
		const abs = wp.abs;
		const name = basename(abs);
		const kind = previewKind(name);
		const isDownload = req.query.download === "1";
		if (!isDownload && kind !== "image" && kind !== "video") {
			res.status(400).end("not a previewable media file");
			return;
		}
		const st = await stat(abs);
		if (!st.isFile()) {
			res.status(400).end("not a file");
			return;
		}
		if (isDownload) {
			// res.download sets Content-Disposition: attachment and RFC 5987
			// filename* encoding for non-ASCII names.
			res.download(abs, name);
		} else {
			res.sendFile(abs);
		}
	} catch {
		res.status(404).end("not found");
	}
});

// Production: serve the built frontend from web/dist. Resolve relative to this
// module so it works when installed as a package (global/npx/Docker), not just
// from the repo root. In dev, Vite serves the UI on :5173 and proxies /ws.
const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/dist/server or <pkg>/server
// Resolve the package root robustly: dev runs from <repo>/server (tsx), prod
// from <pkg>/dist/server — the ancestor that actually has package.json wins.
function resolvePkgRoot(): string {
	// 可选：显式指定 pkgRoot（如部署在自定义目录时），否则按候选路径探测。
	if (process.env.PI_WEB_PKG_ROOT) return process.env.PI_WEB_PKG_ROOT;
	const candidates = [
		resolve(here, ".."),
		resolve(here, "..", ".."),
		resolve(here, "..", "..", ".."),
	];
	for (const c of candidates) {
		if (existsSync(join(c, "package.json"))) return c;
	}
	return candidates[0];
}
const pkgRoot = resolvePkgRoot();
// Theme CSS files: complete standalone stylesheets. Builtin themes ship in
// <pkg>/themes (npm files whitelist); user themes can be dropped into
// <dataDir>/themes and are served alongside (user wins on id collision).
const BUILTIN_THEMES_DIR = join(pkgRoot, "themes");
const USER_THEMES_DIR = join(DATA_DIR, "themes");

app.get("/api/themes", (_req, res) => {
	res.json({ themes: listThemes(BUILTIN_THEMES_DIR, USER_THEMES_DIR) });
});
// Serve a theme's full CSS file so the frontend can swap the whole stylesheet.
// Registered before the SPA catch-all below (otherwise it'd return index.html).
app.get("/themes/:id.css", (req, res) => {
	const file = resolveThemeFile(
		BUILTIN_THEMES_DIR,
		USER_THEMES_DIR,
		req.params.id,
	);
	if (!file) {
		res.status(404).end("theme not found");
		return;
	}
	res.setHeader("Content-Type", "text/css; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	res.sendFile(file);
});

// Plugin client bundles: <dataDir>/plugins/<id>/client/* served at
// /plugins/<id>/client/* so the frontend can import() plugin views. Only the
// client/ subtree is exposed — manifest.json and the server-side index.mjs
// (which may hold credentials) never leave the machine. Registered BEFORE the
// SPA catch-all below.
const PLUGINS_DIR = join(DATA_DIR, "plugins");
// 插件 HTTP 路由挂载点：host.route("GET", "/inbox") 实际暴露为
// /plugins-api/<id>/inbox。PI_WEB_TOKEN 鉴权（上方 app.use）自动覆盖；
// 响应已在前面过了 express.json。注意不要在此 catch-all 里消费 body。
app.all(["/plugins-api/:id/*", "/plugins-api/:id"], (req, res) => {
	const rest = String((req.params as unknown as Record<string, string | undefined>)[0] ?? "");
	pluginMgr.handleHttp(String(req.params.id ?? ""), req.method, rest, req, res);
});
app.get("/plugins/:id/client/*", (req, res) => {
	// express 4 的通配参数在运行时落在 params[0]，但类型声明里没有 —— 显式取
	const rest = String((req.params as unknown as Record<string, string | undefined>)[0] ?? "");
	const abs = resolvePluginClientFile(PLUGINS_DIR, req.params.id, rest);
	if (!abs) {
		res.status(404).end("plugin not found");
		return;
	}
	// .mjs 常不在老 mime 表里，手动定 Content-Type 保证 import() 可用
	if (/\.(mjs|js)$/.test(abs)) {
		res.setHeader("Content-Type", "text/javascript; charset=utf-8");
	}
	res.setHeader("Cache-Control", "no-cache"); // 开发期改文件即生效
	res.sendFile(abs, (err) => {
		if (err && !res.headersSent)
			res.status((err as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 404 ? 404 : 500).end("not found");
	});
});
/** Set in the env of the replacement child spawned by a self-update restart. */
const RESTART_CHILD_ENV = "PI_WEB_RESTART_CHILD";
const webDist = join(pkgRoot, "web", "dist");
if (existsSync(webDist)) {
	// gzip/deflate 响应压缩：前端 bundle ~1MB，局域网/反代场景传输量降到 ~1/4；
	// 对 API JSON 同样生效，WS 升级不受影响
	app.use(compression());
	app.use(
		express.static(webDist, {
			// Vite 产物文件名带内容 hash，可永久强缓存——业务发版后 hash 变化自然失效，
			// index.html 由下方 catch-all 处理（sendFile 不走这里）
			setHeaders(res, filePath) {
				if (filePath.includes(`${sep}assets${sep}`)) {
					res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
				}
			},
		}),
	);
	app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
		// Callback form: a failed stat here (npm i -g is mid-replacement of the
		// package dir) responds 503 instead of crashing the request pipeline
		// with an unhandled ENOENT stack trace.
		res.sendFile(join(webDist, "index.html"), (err) => {
			if (err && !res.headersSent) {
				res.status(503).send("正在更新 pi-web-ui，请稍后刷新…");
			}
		});
	});
} else if (process.env[RESTART_CHILD_ENV]) {
	// Auto-restart replacement of a self-update whose npm install did not
	// complete (Windows: locked files / rollback can leave the global package
	// without web/dist). Fail loudly with a repair hint instead of serving a
	// UI-less 404 with no explanation.
	console.error(
		"✖ 更新后的安装不完整（缺少 web/dist/index.html）。\n" +
			"  请手动执行 npm i -g pi-web-ui@latest 修复后重新启动。",
	);
	process.exit(1);
}

const httpServer = createServer(app);
const wss = new WebSocketServer({
	noServer: true,
	// 上调入站帧上限：右键上传走单帧 base64（100MB 文件 → ~133MB 帧），
	// ws 默认 maxPayload 只有 100MB，超限会直接断连。
	maxPayload: 256 * 1024 * 1024,
	// Per-message deflate: big-session snapshots serialize to multi-MB JSON
	// strings; wire-level compression cuts that several-fold. threshold keeps
	// tiny messages (notices/heartbeats) uncompressed to save CPU.
	perMessageDeflate: { threshold: 16 * 1024 },
});

// ---------------------------------------------------------------------------
// Origin / Host admission for WebSocket upgrades.
//
// Browsers attach an Origin header; non-browser clients (curl, ws scripts)
// usually don't — they're admitted by the network layer / reverse proxy.
// Rules (checked in order):
//   4. No Origin header → admit (non-browser client).
//   5. Anything else → 403 + close.
//
// Dev-mode note: the Vite dev server (:5173) proxies /ws to the backend on
// :8788, so their authorities differ — the dev:server script sets
// PI_WEB_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 for that.
// LAN / reverse-proxy setups add their own origin the same way.
// ---------------------------------------------------------------------------

/** "host" or "host:port" → { hostname, port }. */
function parseAuthority(a: string): { hostname: string; port: string } {
	try {
		const u = new URL(`http://${a}`);
		return { hostname: u.hostname.toLowerCase(), port: u.port || "80" };
	} catch {
		return { hostname: "", port: "" };
	}
}

function originAllowed(req: IncomingMessage): boolean {
	const hostHeader = (req.headers.host ?? "").toLowerCase();
	const host = parseAuthority(hostHeader);
	if (ALLOW_HOSTS.length > 0 && !ALLOW_HOSTS.includes(host.hostname)) {
		return false;
	}
	const origin = req.headers.origin;
	if (!origin) return true; // non-browser client
	const o = origin.toLowerCase();
	if (ALLOW_ORIGINS.includes(o)) return true;
	if (o === "null") return false; // file:// pages etc. are not trusted
	const ori = parseAuthority(o.replace(/^[a-z]+:\/\//, ""));
	if (ori.hostname === host.hostname && ori.port === host.port) return true;
	// Browsers treat host:port pairs on the SAME host as different origins —
	// do not accept them. (Dev-mode proxying is handled by PI_WEB_ALLOW_ORIGINS
	// set in the dev:server script; LAN/reverse-proxy setups add their origin.)
	return false;
}

httpServer.on("upgrade", (req, socket, head) => {
	let pathname = "/";
	try {
		pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	} catch {
		/* fall through to the path check below */
	}
	if (pathname !== "/ws") {
		socket.destroy();
		return;
	}
	if (!originAllowed(req)) {
		// Reject cross-origin browser pages outright. The browser sees a failed
		// WS connect; the page's own reconnect loop then backs off and retries.
		socket.write(
			"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
		);
		socket.destroy();
		return;
	}
	if (AUTH_TOKEN && !tokenOk(req)) {
		socket.write(
			"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
		);
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
});

// Heartbeat: lets clients detect half-open connections (server killed without
// closing sockets, sleep/wake, network partitions). Idle connections otherwise
// carry no traffic and TCP keepalive defaults are far too slow (~2h).
const heartbeatTimer = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "heartbeat" } satisfies ServerMessage));
		}
	}
}, 10_000);

// 引擎分发：PI_WEB_ENGINE=dsh 时使用 DeepSeek Harness 引擎（server/dsh/），
// 默认 pi 引擎。同一 wire 协议，前端无感知（ready/health 携带 engine 字段）。
import { DshAgentService } from "./dsh/dsh-agent-service.js";

/** dispatch 表所需的方法契约（pi 的 ClientSession 与 dsh 的 DshClientSession
 *  都结构兼容；dsh 引擎对不支持的功能做简化实现）。 */

/** TerminalManager 的 dispatch 面（两个引擎共用同一实现类）。 */
export interface TerminalManagerLike {
	create(id: string, cwd: string, cols: number, rows: number, fallbackCwd: string, title?: string, opts?: { forceBash?: boolean; locale?: string }): unknown;
	input(id: string, data: string): void;
	resize(id: string, cols: number, rows: number): void;
	kill(id: string): void;
	runCommand(id: string, command: CommandDef, cols: number, rows: number, fallbackCwd: string): unknown;
}

export interface DispatchSession {
	cwd: string;
	prompt(text: string, attachments?: PromptAttachment[], queue?: boolean): Promise<void>;
	/** Remove one queued prompt text (steer/followUp) — the ✕ on a pending bubble. */
	removeQueued(kind: "steer" | "followUp", text: string): void;
	abort(): Promise<void>;
	abortBash(): Promise<void>;
	killBackgroundServer(port?: number, taskId?: string): Promise<boolean>;
	killAllBackgroundServers(): Promise<string[]>;
	listBgServers(): Promise<void>;
	newChat(): Promise<void>;
	editMessage(messageId: string, text: string, attachments?: PromptAttachment[]): Promise<void>;
	cycleModel(): Promise<void>;
	cycleThinking(): void;
	flushSnapshot(forceFull?: boolean): void;
	pushSlashCommands(): Promise<void>;
	refreshSessions(): Promise<void>;
	pushProjects(): Promise<void>;
	removeProject(path: string): Promise<void>;
	deleteSession(path: string): Promise<void>;
	switchSession(path: string): Promise<void>;
	switchConversation(id: string): Promise<void>;
	listFiles(path?: string): Promise<void>;
	searchFiles(query: string, reqId: number): Promise<void>;
	searchSessions(query: string, reqId: number): Promise<void>;
	scmQuery(kind: "status" | "history" | "filediff" | "commit", reqId: number, opts?: { path?: string; hash?: string }): Promise<void>;
	readFile(path: string): Promise<void>;
	writeFile(path: string, text: string): Promise<void>;
	uploadFile(dirPath: string, name: string, data: string): Promise<void>;
	listModels(): Promise<void>;
	setModel(modelId: string): Promise<void>;
	setThinking(level: string): void;
	setCwd(path: string): Promise<void>;
	completePath(path: string): Promise<void>;
	checkUpdate(): Promise<void>;
	checkUpdatesAll(force?: boolean): Promise<void>;
	resolveDialog(id: number, value: string | boolean | null): void;
	installPiAgent(): Promise<void>;
	setProviderApiKey(provider: string, apiKey: string): Promise<void>;
	clearProviderApiKey(provider: string): Promise<void>;
	listModelsConfig(): Promise<void>;
	saveModelConfig(providerId: string, config: unknown): Promise<void>;
	deleteModelConfig(providerId: string): Promise<void>;
	listProviders(): Promise<void>;
	listProviderKeys(): void;
	addProviderKey(provider: string, apiKey: string, name?: string): Promise<void>;
	activateProviderKey(provider: string, keyName: string): Promise<void>;
	removeProviderKey(provider: string, keyName: string): Promise<void>;
	fetchModelsList(reqId: number, baseUrl: string, apiKey?: string, authHeader?: boolean, api?: string): Promise<void>;
	refreshProviderModels(providerId: string, reqId: number): Promise<void>;
	cloneProvider(provider: string, reqId: number): Promise<void>;
	getTerminalManager(conversationId?: string): TerminalManagerLike | undefined;
	getTerminalCwd(conversationId?: string): string;
	listCommands(): Promise<void>;
	saveCommands(commands: CommandDef[]): Promise<void>;
	setGoal(goal: string, opts?: { reviewModel?: string; maxRounds?: number; locked?: boolean }): Promise<void>;
	clearGoal(): Promise<void>;
	startGoalWizard(text: string, opts?: { wizardModel?: string; maxRounds?: number; locked?: boolean }): Promise<void>;
	setGoalPrefs(opts?: { reviewModel?: string; maxRounds?: number; locked?: boolean }): Promise<void>;
	pushSettings(): void;
	setSettings(partial: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
	}): Promise<void>;
	reloadExtensions(): Promise<void>;
	/** DSH engine only: list/rescan <dataDir>/dsh-patches user patch files. */
	listDshPatches?(): Promise<void>;
	rescanDshPatches?(): Promise<void>;
	/** DSH engine only: answer a model ask_user_question dialog. */
	answerQuestion?(id: string, answers: { id: string; selected: string[]; custom?: string }[], cancelled?: boolean): Promise<void>;
	savePreset(name: string): Promise<void>;
	applyPreset(name: string): Promise<void>;
	deletePreset(name: string): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", text: string): void;
	activeConversations(): number;
	pendingMessages(): number;
}

/** 引擎无关的服务接口（index.ts attach 流程 + 插件扩展点所需）。 */
export interface EngineService {
	attach(clientId: string, send: (msg: ServerMessage) => void): Promise<DispatchSession>;
	detach(clientId: string, send: (msg: ServerMessage) => void): void;
	get(clientId: string): DispatchSession | undefined;
	disposeAll(): Promise<void>;
	noteSocketOpen(): void;
	noteSocketClose(): void;
	isQuiesced(): boolean;
	quiesce(): void;
	unquiesce(): void;
	quiesceInfo(): { quiesced: boolean; quiescedSince?: number };
	serviceStatus(): {
		pid: number;
		version: string;
		cwd: string;
		quiesced: boolean;
		quiescedSince?: number;
		connectedClients: number;
		activeConversations: number;
		pendingMessages: number;
	};
	activeConversations(): number;
	pendingMessages(): number;
	applyPluginAgentTools(): void;
	applyPluginCommandCatalog(): void;
	refreshBackgroundServers(): void;
	onQuit?: (() => boolean) | undefined;
	onToolEvent?: ((ev: { phase: "start" | "end"; toolName: string; conversationId: string; durationMs?: number; isError?: boolean }) => void) | undefined;
	pluginToolsProvider?: (() => unknown[]) | undefined;
	pluginCommandsProvider?: (() => unknown[]) | undefined;
	pluginBgTasksProvider?: (() => BgServer[]) | undefined;
	pluginStopBgTask?: ((taskId: string) => boolean) | undefined;
	onClientCwdChanged?: ((cwd: string) => void) | undefined;
}

const service: EngineService =
	ENGINE === "dsh"
		? new DshAgentService(CWD, join(DATA_DIR, "client-state.json"), DATA_DIR, getAgentDir())
		: new AgentService(
				CWD,
				// Per-client persisted UI state: last-used workspace + recent projects.
				join(DATA_DIR, "client-state.json"),
			);

// Optional UI plugins (<dataDir>/plugins/<id>/): scanned on every client
// attach so freshly dropped plugins appear without a server restart.
const pluginMgr = new PluginManager(DATA_DIR, CWD);
// MCP 工具桥：读取 <dataDir>/mcp.json 启动外部 MCP 服务器（stdio），把它们的
// 工具并入与插件工具相同的 customTools 管线；单服务器失败不炸进程。
const mcpBridge = new McpBridge(DATA_DIR, (...a) => console.log("[mcp]", ...a));
void mcpBridge.load().then(() => {
	if (mcpBridge.getTools().length) service.applyPluginAgentTools();
});
// 插件扩展点：SDK 工具执行事件（bash/读文件等 start+end）转发给已注册的插件。
service.onToolEvent = (ev) => pluginMgr.emitToolEvent(ev);
// 插件扩展点：插件注册的 AI 工具（registerAgentTool）+ MCP 桥工具 → 会话创建时
// 带上 + 变化时动态注入/移除已有会话。
service.pluginToolsProvider = () => [...pluginMgr.getAgentTools(), ...mcpBridge.getTools()];
pluginMgr.onAgentToolsChanged = () => service.applyPluginAgentTools();
// 插件扩展点：插件斜杠命令（registerCommand）→ 命令选择器目录 + prompt 拦截执行。
pluginMgr.onCommandsChanged = () => service.applyPluginCommandCatalog();
service.pluginCommandsProvider = () => pluginMgr.listCommands();
// 插件扩展点：插件常驻后台任务（registerBackgroundTask）→ 并入「后台任务」面板。
pluginMgr.onBgTasksChanged = () => service.refreshBackgroundServers();
service.pluginBgTasksProvider = () => pluginMgr.bgTasks();
service.pluginStopBgTask = (taskId) => pluginMgr.stopPluginBgTask(taskId);
// 插件宿主工作区实时跟随当前项目：任意客户端 set_cwd 成功后同步给
// PluginManager，编辑器等工作区跟随型插件随即切根（详见 plugins.ts notifyCwd）。
service.onClientCwdChanged = (cwd) => pluginMgr.notifyCwd(cwd);

// ---------------------------------------------------------------------------
// Self-update
// ---------------------------------------------------------------------------
// In-app updates now run `npm i -g pi-web-ui@latest` in a visible terminal
// tab (frontend-initiated); after it finishes the user restarts via
// `pi-web-ui server restart`. The PI_WEB_RESTART_CHILD port-wait handshake
// below stays: an externally orchestrated replacement child still needs it.

function scheduleQuit(): boolean {
	const isLaunchd = process.platform === "darwin" && process.ppid === 1;
	const isSystemd = process.platform === "linux" && !!process.env.INVOCATION_ID;
	const inDocker = existsSync("/.dockerenv");
	if (isLaunchd || isSystemd || inDocker) {
		setTimeout(() => {
			console.log("pi-web-ui:quit — shutting down (supervisor will restart)…");
			if (isSystemd) process.exit(3);
			void shutdown();
		}, 300);
		return true;
	}
	setTimeout(() => {
		console.log("pi-web-ui:quit — shutting down (restart to reload)…");
		void shutdown();
	}, 300);
	return true;
}
service.onQuit = scheduleQuit;

/** 背压相对倍数：socket 未发送积压超过「最近一份 snapshot 大小 × 此倍数」时丢弃
 *  （issue #11 及其评论区的自适应建议）。固定 1MB 阈值在长会话下单份 snapshot 可达
 *  ~10MB——连半份都没发完就丢，前端频繁跳帧；短会话又太迟钝。相对阈值语义稳定在
 *  「缓冲堆了约 N 份快照」，不随会话长短漂移。 */
const SNAPSHOT_BACKPRESSURE_FACTOR = 3;
/** 背压绝对下限：低于此积压永不丢快照（小会话的相对阈值只有几 KB，会被
 *  正常的消息突发误伤，见 send() 内注释）。 */
const SNAPSHOT_BACKPRESSURE_MIN_BYTES = 262_144;
/** 背压丢弃后的延迟重发间隔。 */
const SNAPSHOT_RETRY_MS = 250;

/**
 * Multi-tab serialization sharing: emit() hands the SAME message object to
 * every socket of a client, but each send() used to JSON.stringify it
 * separately — N open tabs serialized the same multi-MB snapshot N times per
 * push. Keyed by object identity (WeakMap): a new snapshot is a new object,
 * so the cache self-invalidates and never grows.
 */
const serializedCache = new WeakMap<ServerMessage, string>();
function serializeShared(msg: ServerMessage): string {
	let s = serializedCache.get(msg);
	if (s === undefined) {
		s = JSON.stringify(msg);
		serializedCache.set(msg, s);
	}
	return s;
}

wss.on("connection", (ws) => {
	// Count attached sockets (the control socket reports REAL sockets, not
	// cached client-session objects).
	service.noteSocketOpen();
	let clientId: string | null = null;
	let closed = false;
	/** 最近一份全量 snapshot 的估算字节数（UTF-16 ×2），供背压相对阈值用（issue #11）。 */
	let lastSnapshotBytes = 0;
	/** Commands received while the session is still being created — replayed after attach. */
	let pending: ClientMessage[] = [];
	/** 背压丢快照后的延迟重发定时器（去重：一次只排一个）。 */
	let snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;

	// 协议层错误（非法帧/未 masked 帧等）：不注册 handler 会作为 uncaught
	// exception 打崩整个进程（issue #11 附带发现）。记日志并按坏连接关闭。
	ws.on("error", (err) => {
		console.error(`[ws] socket error${clientId ? ` (${clientId})` : ""}:`, err.message);
		try {
			ws.close();
		} catch {
			/* already closing */
		}
	});

	const send = (msg: ServerMessage): void => {
		if (closed || ws.readyState !== WebSocket.OPEN) return;
		// 发送背压（issue #11）：socket 消费不过来时（前端慢/网络差），堆里会堆积
		// 每份可达 ~10MB 的全量 snapshot 字符串，低内存主机直接 OOM。snapshot 是全量
		// 幂等的且稍后必有更新的一份，可以安全丢弃——在序列化之前丢，连
		// stringify 的分配都省掉。ready/notice/error/tool_delta 等消息必须送达。
		// 阈值相对化（评论区建议）：用「最近一份 snapshot 的字节数 × 倍数」做基准，
		// 首份无基准不丢（首次必达）。wire.length 是 UTF-16 字符数，×2 估算字节。
		// 下限保护（小会话误伤修复）：小会话一份 snapshot 才 ~1KB，相对阈值只有几
		// KB——前面一批 settings_state/slash_commands 的正常突发就能把 bufferedAmount
		// 抬过阈值，把紧随其后的 snapshot_delta 静默丢掉；而丢弃后若无后续事件就
		// 再也没有快照，客户端永远停在旧状态（前端靠 rev 缺口 get_state 自愈，
		// 协议测试则直接卡死）。绝对下限保证小会话永不触发背压。
		if (
			(msg.type === "snapshot" || msg.type === "snapshot_delta") &&
			lastSnapshotBytes > 0 &&
			ws.bufferedAmount > Math.max(SNAPSHOT_BACKPRESSURE_MIN_BYTES, SNAPSHOT_BACKPRESSURE_FACTOR * lastSnapshotBytes)
		) {
			// 真正的慢客户端：丢弃是安全的，但不能「丢完就没了」——安排一次延迟
			// 重发，等缓冲排空后快照最终必达（否则若此后再无事件，客户端将永久
			// 停留在旧快照）。重发仍走 flushSnapshot：缓冲未排空则再次顺延。
			if (!snapshotRetryTimer) {
				snapshotRetryTimer = setTimeout(() => {
					snapshotRetryTimer = null;
					service.get(clientId ?? "")?.flushSnapshot();
				}, SNAPSHOT_RETRY_MS);
			}
			return;
		}
		const wire = serializeShared(msg);
		if (msg.type === "snapshot") lastSnapshotBytes = wire.length * 2;
		ws.send(wire);
	};

	// Plugins broadcast to every open socket; unregister on close below.
	// Plugins broadcast to every open socket; unregister on close below. The
	// cid getter lets plugins target THIS socket via host.sendTo(clientId).
	const removePluginSender = pluginMgr.addSender(send, () => clientId);

	const dispatch = (msg: ClientMessage): void => {
		if (!clientId) {
			pending.push(msg);
			return;
		}
		const cs = service.get(clientId);
		if (!cs) {
			// Session not ready yet (hello processing) — hold the command.
			pending.push(msg);
			return;
		}
		switch (msg.type) {
			case "prompt":
				void cs.prompt(msg.text, msg.attachments, msg.queue);
				break;
			case "queue_remove":
				cs.removeQueued(msg.kind, msg.text);
				break;
			case "abort":
				void cs.abort();
				break;
			case "abort_bash":
				void cs.abortBash();
				break;
			case "kill_background_server":
				void cs.killBackgroundServer(msg.port, msg.taskId);
				break;
			case "kill_background_servers":
				void cs.killAllBackgroundServers();
				break;
			case "list_bg_servers":
				void cs.listBgServers();
				break;
			case "new_chat":
				void cs.newChat();
				break;
			case "edit_message":
				void cs.editMessage(msg.messageId, msg.text, msg.attachments);
				break;
			case "cycle_model":
				void cs.cycleModel();
				break;
			case "cycle_thinking":
				cs.cycleThinking();
				break;
			case "get_state":
				// Always a FULL snapshot: the client is (re)connecting or detected
				// a rev/seq gap — it needs an authoritative state to rebuild from.
				cs.flushSnapshot(true);
				break;
			case "get_commands":
				void cs.pushSlashCommands();
				break;
			case "list_sessions":
				void cs.refreshSessions();
				break;
			case "list_projects":
				void cs.pushProjects();
				break;
			case "remove_project":
				void cs.removeProject(msg.path);
				break;
			case "delete_session":
				void cs.deleteSession(msg.path);
				break;
			case "switch_session":
				void cs.switchSession(msg.path);
				break;
			case "switch_conversation":
				void cs.switchConversation(msg.id);
				break;
			case "list_files":
				void cs.listFiles(msg.path);
				break;
			case "search_files":
				void cs.searchFiles(msg.query, msg.reqId);
				break;
			case "search_sessions":
				void cs.searchSessions(msg.query, msg.reqId);
				break;
			case "scm_status":
				void cs.scmQuery("status", msg.reqId);
				break;
			case "scm_history":
				void cs.scmQuery("history", msg.reqId);
				break;
			case "scm_filediff":
				void cs.scmQuery("filediff", msg.reqId, { path: msg.path });
				break;
			case "scm_commit":
				void cs.scmQuery("commit", msg.reqId, { hash: msg.hash });
				break;
			case "read_file":
				void cs.readFile(msg.path);
				break;
			case "write_file":
				void cs.writeFile(msg.path, msg.text);
				break;
			case "upload_file":
				void cs.uploadFile(msg.dirPath, msg.name, msg.data);
				break;
			case "list_models":
				void cs.listModels();
				break;
			case "set_model":
				void cs.setModel(msg.modelId);
				break;
			case "set_thinking":
				cs.setThinking(msg.level);
				break;
			case "set_cwd":
				void cs.setCwd(msg.path);
				break;
			case "complete_path":
				void cs.completePath(msg.path);
				break;
			case "check_update":
				void cs.checkUpdate();
				break;
			case "check_updates_all":
				void cs.checkUpdatesAll(msg.force === true);
				break;
			case "dialog_response":
				cs.resolveDialog(msg.id, msg.value);
				break;
			case "install_pi_agent":
				void cs.installPiAgent();
				break;
			case "set_provider_api_key":
				void cs.setProviderApiKey(msg.provider, msg.apiKey);
				break;
			case "clear_provider_api_key":
				void cs.clearProviderApiKey(msg.provider);
				break;
			case "list_models_config":
				void cs.listModelsConfig();
				break;
			case "save_model_config":
				void cs.saveModelConfig(msg.providerId, msg.config);
				break;
			case "delete_model_config":
				void cs.deleteModelConfig(msg.providerId);
				break;
			case "list_providers":
				void cs.listProviders();
				break;
			case "fetch_models":
				void cs.fetchModelsList(
					msg.reqId,
					msg.baseUrl,
					msg.apiKey,
					msg.authHeader,
					msg.api,
				);
				break;
			case "refresh_provider_models":
				void cs.refreshProviderModels(msg.providerId, msg.reqId);
				break;
			case "clone_provider":
				void cs.cloneProvider(msg.provider, msg.reqId);
				break;
			case "list_provider_keys":
				cs.listProviderKeys();
				break;
			case "add_provider_key":
				void cs.addProviderKey(msg.provider, msg.apiKey, msg.name);
				break;
			case "activate_provider_key":
				void cs.activateProviderKey(msg.provider, msg.keyName);
				break;
			case "remove_provider_key":
				void cs.removeProviderKey(msg.provider, msg.keyName);
				break;
			case "terminal_create": {
				const tm = cs.getTerminalManager(msg.conversationId);
				if (tm) tm.create(msg.terminalId, msg.cwd, msg.cols, msg.rows, cs.getTerminalCwd(msg.conversationId), msg.title, msg.locale ? { locale: msg.locale } : undefined);
				break;
			}
			case "terminal_input":
				cs.getTerminalManager(msg.conversationId)?.input(msg.terminalId, msg.data);
				break;
			case "terminal_resize":
				cs.getTerminalManager(msg.conversationId)?.resize(msg.terminalId, msg.cols, msg.rows);
				break;
			case "terminal_kill":
				cs.getTerminalManager(msg.conversationId)?.kill(msg.terminalId);
				break;
			case "run_command":
				cs.getTerminalManager(msg.conversationId)?.runCommand(
					msg.terminalId,
					msg.command,
					msg.cols,
					msg.rows,
					cs.getTerminalCwd(msg.conversationId),
				);
				break;
			case "list_commands":
				void cs.listCommands();
				break;
			case "save_commands":
				void cs.saveCommands(msg.commands);
				break;
			case "set_goal":
				void cs.setGoal(msg.goal, {
					reviewModel: msg.reviewModel,
					maxRounds: msg.maxRounds,
					locked: msg.locked,
				});
				break;
			case "clear_goal":
				void cs.clearGoal();
				break;
			case "start_goal_wizard":
				void cs.startGoalWizard(msg.text, {
					wizardModel: msg.wizardModel,
					maxRounds: msg.maxRounds,
					locked: msg.locked,
				});
				break;
			case "set_goal_prefs":
				void cs.setGoalPrefs({
					reviewModel: msg.reviewModel,
					maxRounds: msg.maxRounds,
					locked: msg.locked,
				});
				break;
			case "get_settings":
				cs.pushSettings();
				break;
			case "set_settings":
				void cs.setSettings({
					promptMode: msg.promptMode,
					customSystemPrompt: msg.customSystemPrompt,
					disabledSkills: msg.disabledSkills,
					disabledExtensions: msg.disabledExtensions,
					disabledPlugins: msg.disabledPlugins,
					terminalToolsEnabled: msg.terminalToolsEnabled,
					terminalBash: msg.terminalBash,
					terminalBashIdleMs: msg.terminalBashIdleMs,
					thinkingWrap: msg.thinkingWrap,
					toolsWrap: msg.toolsWrap,
					visionBridgeEnabled: msg.visionBridgeEnabled,
					visionBridgeModel: msg.visionBridgeModel,
					visionBridgePromptMode: msg.visionBridgePromptMode,
					visionBridgePrompt: msg.visionBridgePrompt,
					reviewPrompt: msg.reviewPrompt,
					reviewDisabledSkills: msg.reviewDisabledSkills,
				});
				break;
			case "extensions_reload":
				void cs.reloadExtensions();
				break;
			case "plugin_message":
				pluginMgr.handleMessage(msg.pluginId, msg.payload, clientId ?? undefined);
				break;
			case "plugin_settings": {
				const r = pluginMgr.savePluginSettings(msg.pluginId, msg.values ?? {});
				if (r.error) {
					cs?.emitNotice("error", `插件设置保存失败：${r.error}`);
				} else {
					cs?.emitNotice("info", "插件设置已保存");
				}
				break;
			}
			case "plugins_reload":
				void pluginMgr.reload().then(() => pluginMgr.pushToAll());
				break;
			case "dsh_patches_list":
				void cs.listDshPatches?.();
				break;
			case "dsh_patches_rescan":
				void cs.rescanDshPatches?.();
				break;
			case "question_answer":
				void cs.answerQuestion?.(msg.id, msg.answers, msg.cancelled);
				break;
			case "save_preset":
				void cs.savePreset(msg.name);
				break;
			case "apply_preset":
				void cs.applyPreset(msg.name);
				break;
			case "delete_preset":
				void cs.deletePreset(msg.name);
				break;
			default:
				break;
		}
	};

	ws.on("message", (data) => {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(data.toString()) as ClientMessage;
		} catch {
			return;
		}

		if (msg.type === "hello") {
			const cid = msg.clientId || randomUUID();
			clientId = cid;
			service
				.attach(cid, send)
				.then((cs) => {
					if (closed) return;
					send({
						type: "ready",
						clientId: cid,
						serverVersion: VERSION,
						protocolVersion: PROTOCOL_VERSION,
						engine: ENGINE,
					});
					cs.flushSnapshot();
					// Plugin catalog: re-scan + activate new dirs on every attach so
					// freshly dropped plugins show up without a server restart.
					pluginMgr
						.ensureLoaded()
						.then((plugins) => {
							send({ type: "plugins", plugins, epoch: pluginMgr.epoch });
							// 让各插件向新接入的客户端推送自身初始状态（onAttach 钩子）——
							// 插件不要依赖客户端挂载后自己拉（见 plugins.ts onAttach 注释）。
							pluginMgr.notifyAttach(cid);
							// 插件命令可能在本客户端 attach 过程中才注册（首载竞态）——
							// 重推一次目录，保证选择器完整。
							service.applyPluginCommandCatalog();
						})
						.catch(() => {});
					// Replay anything that arrived while the session was starting.
					const queued = pending;
					pending = [];
					for (const m of queued) dispatch(m);
				})
				.catch((err: unknown) => {
					// Admission refused (quiesce): close the socket so the browser
					// reconnect loop keeps retrying until admission reopens. Do NOT
					// leave a half-alive connection that can only show an error.
					if (err instanceof QuiesceRejectedError) {
						closed = true;
						if (ws.readyState === WebSocket.OPEN) {
							ws.close(4403, "quiesced");
						}
						ws.terminate?.();
						return;
					}
					// Real init failure (bad agent dir etc.) — keep the connection
					// open so the user can see the error and fix it.
					send({
						type: "notice",
						level: "error",
						text: `会话初始化失败：${(err as Error).message}`,
					});
				});
			return;
		}

		dispatch(msg);
	});

	ws.on("close", () => {
		service.noteSocketClose();
		closed = true;
		pending = [];
		removePluginSender();
		if (snapshotRetryTimer) {
			clearTimeout(snapshotRetryTimer);
			snapshotRetryTimer = null;
		}
		if (clientId) service.detach(clientId, send);
	});
});

// When spawned by the old process as an auto-restart replacement, wait for
// the old instance to release the port before binding (it exits right after
// spawning us). Probe by attempting a connection: refused = free.
if (process.env[RESTART_CHILD_ENV] === "1") {
	const deadline = Date.now() + 20_000;
	const portFree = () =>
		new Promise<boolean>((resolve) => {
			const sock = createConnection({ port: PORT, host: "127.0.0.1" });
			sock.once("connect", () => {
				sock.destroy();
				resolve(false); // busy — old instance still up
			});
			sock.once("error", () => resolve(true)); // refused → free
			sock.setTimeout(500, () => {
				sock.destroy();
				resolve(false);
			});
		});
	while (Date.now() < deadline) {
		if (await portFree()) break;
		await new Promise((r) => setTimeout(r, 300));
	}
}

httpServer.listen(PORT, HOST, () => {
	console.log("");
	console.log("  ⚡ pi-web-ui — web chat for the pi coding agent");
	console.log(`    http://localhost:${PORT}`);
	console.log(`    workspace   : ${CWD}`);
	console.log(`    session dir : ${SESSION_DIR_ROOT}`);
	console.log(`    pi SDK      : v${VERSION}`);
	console.log(`    bind        : ${HOST}:${PORT}`);
	console.log("");
});

// 上传文件保留期清理：启动扫一次 + 每 6 小时一次（best-effort，见 uploads.ts）
scheduleUploadCleanup();

// Local control socket (status / quiesce / unquiesce) — same data dir the
// CLI uses, so `pi-web-ui server status|quiesce|unquiesce` just works.
const stopControl = startControlServer({ service, dataDir: DATA_DIR, port: PORT });

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("\nshutting down…");
	clearInterval(heartbeatTimer);
	stopControl();
	pluginMgr.dispose();
	mcpBridge.dispose();
	await service.disposeAll();
	wss.close();
	httpServer.close();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
