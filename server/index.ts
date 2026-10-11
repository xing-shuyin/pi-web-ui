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
// MUST be imported before the SDK is loaded so on-disk patches apply cleanly.
import "./patch-remote-catalog.js";
import "./patch-turn-end-boundary.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, request as proxyRequest, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import compression from "compression";
import { WebSocket, WebSocketServer } from "ws";
import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { sdkCopies, sdkOriginNote } from "./sdk-origin.js";
import { PROTOCOL_VERSION } from "./protocol-version.js";
import { AgentService, workspacePath, QuiesceRejectedError, ClientSession } from "./agent-service.js";
import { WS_MAX_PAYLOAD_BYTES, isAbsoluteWirePath, wireToAbs } from "./files-service.js";
import { httpHostAllowed } from "./host-guard.js";
import { registerFileTransferRoutes } from "./file-transfer-routes.js";
import { initAttachmentStore, readAttachment } from "./attachment-store.js";
import { isAudioFile, previewKind } from "./text-sniff.js";
import { startControlServer } from "./control-socket.js";
import { scheduleUploadCleanup } from "./uploads.js";
import { ensureWindowsBash, windowsBashDir } from "./ensure-bash.js";
import { listThemes, resolveThemeFile } from "./themes.js";
import { isManaged, managedRefusal } from "./managed.js";
import { launchOrigin, toServiceInfo } from "./launch-origin.js";
import { parseTabs, tabsRefusal } from "./tabs.js";
import { recordUnknownWsType } from "./ws-unknown-types.js";
import { validateClientId } from "./ws-client-id.js";
import { PendingCommandQueue } from "./ws-pending-queue.js";
import {
	installPack,
	isKnownPack,
	listPacks,
	loadServerStrings,
	readPackFile,
	removePack,
	unloadServerStrings,
} from "./locales.js";
import {
	PluginManager,
	resolvePluginClientFile,
	type PluginChatRequest,
	type PluginConversationQuery,
	type PluginConversationSnapshot,
	type PluginRunEvent,
} from "./plugins.js";
import type { ToolPostRequest, ToolPreRequest } from "./plugin-tool-guard.js";
import { buildPluginJobArgs, confirmPluginInstall, inspectInstallSpec, PluginInstaller } from "./plugin-installer.js";
import { syncPluginCatalog } from "./plugin-catalog-sync.js";
import type { ServerLang } from "./i18n.js";
import { McpBridge } from "./mcp-bridge.js";
import { createMcpHotReload } from "./mcp-hot-reload.js";
import { createHostMetricsSampler } from "./host-metrics.js";
import { SchedulerStore, SchedulerValidationError } from "./scheduler-tasks.js";
import { initHttpProxy } from "./http-proxy.js";
import { globalLspPool } from "./lsp-tool.js";
import { buildPiWebTokenCookie, decodeCookieToken, isTlsRequest } from "./auth-cookie.js";
import {
	handleFileMessage,
	handleScmMessage,
	handleBgServerMessage,
	handlePresetAndDshMessage,
	handleModelAndProviderMessage,
	handleTerminalMessage,
	handleSessionLifecycleMessage,
	handlePlanAndGoalMessage,
	handleScheduleMessage,
	handleSettingsMessage,
	handleInteractiveResponseMessage,
	handleRemoteSshMessage,
} from "./dispatch-domain-handlers.js";
import { RemoteSshService, setGlobalRemoteSshService } from "./remote-ssh-service.js";
import { handlePluginMessage } from "./dispatch-plugin-handlers.js";
import type {
	BgServer,
	ClientMessage,
	UiApprovalRule,
	UiLayoutPrefs,
	CommandDef,
	PromptAttachment,
	ServerMessage,
	UiServiceInfo,
	UiSubagentTemplate,
} from "./protocol.js";

/** Strip npm-injected env (`npm start` exports `npm_config_*` / `npm_package_*` /
 *  `npm_lifecycle_*` into every child). Anything this server spawns — shells,
 *  `pi update` — would otherwise inherit `npm_config_allow_scripts`, which npm
 *  maps to its env config layer and rejects in project-scoped installs
 *  (EALLOWSCRIPTS). The unit keeps `npm ci && npm run build && npm start`;
 *  this is the single scrub point so no wrapper is needed. */
for (const k of Object.keys(process.env)) {
	if (
		k === "npm_config_allow_scripts" ||
		k.startsWith("npm_config_") ||
		k.startsWith("npm_package_") ||
		k.startsWith("npm_lifecycle_")
	) {
		delete (process.env as Record<string, string | undefined>)[k];
	}
}

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
// #506：直启路径与 bin 层对齐做端口校验——`--port abc` / `PI_WEB_PORT=abc` 之前会
// listen(NaN) 被 Node 当 0 绑到随机端口，且日志打印 http://localhost:NaN。
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
	console.error(`无效端口: ${cliFlag("--port") ?? process.env.PI_WEB_PORT} (--port / PI_WEB_PORT)`);
	console.error(`Invalid port: ${cliFlag("--port") ?? process.env.PI_WEB_PORT} (--port / PI_WEB_PORT)`);
	process.exit(1);
}
const CWD = resolve(cliFlag("--cwd") ?? process.env.PI_WEB_CWD ?? process.cwd());
const DATA_DIR = resolve(cliFlag("--data-dir") ?? process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
// The data dir is where the control socket, client state, plugins, themes and
// uploads live, but nothing guarantees it exists on a first run (a fresh
// `server install` never creates it). The control socket binds at startup —
// before any store gets a chance to mkdir its own subdirectory — and bind()
// into a missing directory fails with EACCES, silently disabling the whole
// control channel (status/quiesce) for that process. Create it up front.
try {
	mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
	console.warn(`[data] 无法创建数据目录 ${DATA_DIR}: ${(err as Error).message}`);
}
// issue #295：工作区直接就是家目录时，SDK 初始化期的同步目录扫描会落在 $HOME 上
// （iCloud 占位符/外部卷坏挂载 → scandir/open 内核挂起 → 事件循环假死，hello 后无
// ready）。新装服务默认已是 ~/pi-web-ui（见 bin/pi-web-ui.mjs serviceOptions）；
// 老服务若仍指着家目录，在此提示一次，`server install` 重装即迁移。
try {
	if (resolve(CWD) === resolve(homedir())) {
		console.warn(
			`[ws] 工作区为用户主目录 ${CWD}：目录扫描可能因外部卷/同步盘挂载而长时间阻塞，` +
				`建议用 \`pi-web-ui server install --cwd <项目目录>\` 重装迁移。`,
		);
	}
} catch {
	/* 路径比较失败不影响启动 */
}
// Dev-no-cache setting read without a ClientStateStore instance (the index.html
// route runs before any client attaches). Reads the same global settings blob.
function readDevNoCacheSetting(): boolean | undefined {
	try {
		const raw = readFileSync(join(DATA_DIR, "client-state.json"), "utf8");
		const all = JSON.parse(raw) as Record<string, { settings?: { devNoCache?: unknown } }>;
		const v = all["__settings__"]?.settings?.devNoCache;
		return typeof v === "boolean" ? v : undefined;
	} catch {
		return undefined;
	}
}

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
/** 语言包下载根（语言包仓库的 raw 文件地址；版本 tag 优先、main 兜底，见 locales.ts）。 */
const LOCALE_BASE_URL =
	process.env.PI_WEB_LOCALE_BASE_URL?.trim() || "https://raw.githubusercontent.com/xing-shuyin/pi-web-ui";
/**
 * 本包版本 —— 下载语言包时优先取同版本 tag，保证 key 对齐。
 *
 * Read on first use, not here. `resolvePkgRoot()` is hoisted, but it reads
 * `here`, which is a `const` declared further down: calling it at module-init
 * time throws on the temporal dead zone, the catch swallows it, and the
 * version was silently "" — so the language packs never used the version tag
 * and always fell back to `main`. Reading it lazily costs one branch and
 * gives the real number.
 */
let appVersionCache: string | null = null;
function appVersion(): string {
	if (appVersionCache === null) {
		try {
			const pkg = JSON.parse(readFileSync(join(resolvePkgRoot(), "package.json"), "utf8")) as { version?: string };
			appVersionCache = pkg.version ?? "";
		} catch {
			appVersionCache = "";
		}
	}
	return appVersionCache;
}
/** On-disk web-build id: the main JS bundle hash from the built index.html.
 *  Changes on every rebuild — stale pages compare and reload themselves.
 *  Declared near use (below webDist), not here: webDist is a const further
 *  down and calling this at module-init time would hit its dead zone. */
let buildIdCache: string | null = null;
function buildId(): string {
	if (buildIdCache === null) {
		try {
			const html = readFileSync(join(webDistPath(), "index.html"), "utf8");
			buildIdCache = html.match(/\/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ?? "";
		} catch {
			buildIdCache = "";
		}
	}
	return buildIdCache;
}
// Root of the SDK default per-project session dirs — chat transcripts live in
// <SESSION_DIR_ROOT>/--<cwd>--/, shared with the pi CLI/TUI (getAgentDir
// honors PI_CODING_AGENT_DIR).
const SESSION_DIR_ROOT = join(getAgentDir(), "sessions");

// Propagate pi agent's httpProxy setting and environment proxies to undici/fetch
const proxyInfo = initHttpProxy(getAgentDir());
if (proxyInfo.active) {
	console.log(`[proxy] Outbound HTTP proxy enabled: ${proxyInfo.proxyUrl}`);
}

// Windows 轻量 bash 兜底：把 <home>/.pi-web/bin 前置到 PATH（SDK 的 bash 工具经
// findBashOnPath 会找到其中的 bash.exe），并在无 Git Bash 时后台下载 busybox-w32。
// 终端面板的 shell 探测链也已包含该目录（见 terminals.ts resolveShell）。
if (process.platform === "win32") {
	process.env.PATH = `${windowsBashDir()}${delimiter}${process.env.PATH ?? ""}`;
	void ensureWindowsBash();
}

const app = express();
// Host 白名单（防 DNS rebinding，审查 #352）：无 token 部署下 HTTP 路由此前
// 不校验 Host，恶意网页让自己的域名解析到 127.0.0.1 即可打满全部 API。
// 显式白名单走 PI_WEB_ALLOW_HOSTS（与 WS 侧同 env）；设置了 PI_WEB_TOKEN 则
// 由 token 鉴权兜底，不再限制 Host。WS 升级侧同规则见 originAllowed()。
app.use((req, res, next) => {
	const hostHeader = req.headers.host;
	if (
		typeof hostHeader === "string" &&
		!httpHostAllowed(hostHeader, { allowHosts: ALLOW_HOSTS, hasAuthToken: Boolean(AUTH_TOKEN) })
	) {
		res.status(403).end("host not allowed");
		return;
	}
	next();
});
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
			if (k !== "pi_web_token") continue;
			// 我们下发的是 encodeURIComponent 后的值（issue #261），而手写 / 旧客户端的
			// 明文 cookie 也可能出现（`=` 在值里合法，按首个 = 切分）；两种候选都进池子。
			const raw = rest.join("=").trim();
			if (!raw) continue;
			out.push(raw);
			const decoded = decodeCookieToken(raw);
			if (decoded !== raw) out.push(decoded);
		}
	}
	return out.filter(Boolean);
}

/** 口令比较用常时时间：先哈希到定长再 timingSafeEqual（长度差异被摘要抹平），
 *  消除逐字节短路比较的时序侧信道（审查 #352：纵深防御，远程可利用性低）。 */
function sameSecret(candidate: string): boolean {
	const a = createHash("sha256").update(candidate).digest();
	const b = createHash("sha256").update(AUTH_TOKEN).digest();
	return timingSafeEqual(a, b);
}

function tokenOk(req: Parameters<typeof requestTokens>[0]): boolean {
	return requestTokens(req).some(sameSecret);
}

/** 请求携带的 pi_web_token cookie 的**口令值**（未带/损坏时为空串）。
 *  已解码：下发时是 `encodeURIComponent` 过的（issue #261），所以这里拿到的是
 *  可直接与 `AUTH_TOKEN` 比较的原文。 */
function cookieToken(req: { headers: IncomingMessage["headers"] }): string {
	const cookie = req.headers.cookie;
	if (typeof cookie !== "string") return "";
	for (const part of cookie.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === "pi_web_token") return decodeCookieToken(rest.join("=").trim());
	}
	return "";
}

/** Express 5 命名通配 `*splat` 的取值：单段是字符串，多段是字符串数组
 *  （issue #225：直接 String() 会把多段用逗号拼成 "a,b.mjs"，插件 vendor 子
 *  目录、嵌套文件预览、插件子路径 API 全 404）。统一拼回 "/" 即得 Express 4
 *  语义；下游既有的越界/包含校验（workspacePath / resolvePluginClientFile）不变。 */
function splatParam(req: { params: unknown }): string {
	const v = (req.params as unknown as Record<string, string | string[] | undefined>).splat;
	if (Array.isArray(v)) return v.join("/");
	return String(v ?? "");
}

if (AUTH_TOKEN) {
	// /api/health 保持开放：无敏感信息，容器/监控探针需要它。
	// 但绝不能因命中 /api/health 就反射下发真实 token cookie（安全漏洞：issue #45）。
	app.use((req, res, next) => {
		const ok = tokenOk(req);
		const cookie = cookieToken(req);
		// 浏览器经 ?token= 首次进入后下发 HttpOnly cookie，后续导航/资源请求免带参数。
		// 重要：只要请求携带着有效 token（query/header/cookie 任一匹配）就把 cookie 刷新为
		// 当前 AUTH_TOKEN——服务端重启改了 PI_WEB_TOKEN 后，旧 cookie 经一次正确的
		// ?token= 进入即被重新同步，无需用户清缓存（issue #71）。
		// Secure 只在 TLS 连接上加：常加会让明文 HTTP（默认 loopback）收不到 cookie。
		const secure = isTlsRequest(req);
		if (ok) {
			// cookieToken 已解码成原文（issue #261），所以直接和原始口令比 ——
			// 以前拿 `encodeURIComponent(AUTH_TOKEN)` 比，含 `=` / 非 ASCII 的口令
			// 永远不相等（于是每个请求都重发 cookie，且带 cookie 的请求反而 401）。
			if (!sameSecret(cookie)) {
				res.setHeader("Set-Cookie", buildPiWebTokenCookie(encodeURIComponent(AUTH_TOKEN), 31536000, secure));
			}
		} else if (cookie) {
			// 请求带的 cookie 已是失效旧值（服务端口令已更换）——立即让其过期，
			// 避免浏览器被残留 cookie 卡死一年（本来也不该再信任它鉴权）。
			// Secure 与非 Secure 在浏览器里是两个独立 cookie：只清一种会因种植时的
			// 协议不同而残留，所以两种属性组合各发一遍（HTTP 下 Secure 那条被忽略，无害）。
			res.setHeader("Set-Cookie", [buildPiWebTokenCookie("", 0, false), buildPiWebTokenCookie("", 0, true)]);
		}
		if (req.path === "/api/health" || ok) {
			next();
			return;
		}
		res
			.status(401)
			.send(
				cookie
					? "unauthorized: PI_WEB_TOKEN required — 服务端口令已变更？已清除旧 token cookie，请用当前 ?token= 重新进入"
					: "unauthorized: PI_WEB_TOKEN required (?token=…)",
			);
	});
}

/** 引擎选择：--engine pi|dsh > PI_WEB_ENGINE > 默认 pi。重启生效。 */
const ENGINE: "pi" | "dsh" = (cliFlag("--engine") ?? process.env.PI_WEB_ENGINE) === "dsh" ? "dsh" : "pi";

/** PI_WEB_MANAGED=1: this instance is updated by whoever deploys it. */
const MANAGED = isManaged();
/** Who started this process: a platform service manager (launchd / systemd /
 *  Windows watchdog — i.e. `pi-web-ui server start|install`) or nothing
 *  (foreground / dev / Docker). Decides whether the UPDATE panel offers
 *  "restart service" and what quitting means (see scheduleQuit). */
const ORIGIN = launchOrigin();
/** 下发给浏览器的服务信息（null = 没有 supervisor）。 */
const SERVICE_INFO = toServiceInfo(ORIGIN);
/** PI_WEB_TABS: the tabs this instance offers. null = all of them, as before. */
const TABS = parseTabs();

registerFileTransferRoutes(app, (clientId) => service.get(clientId)?.cwd);

app.get("/api/health", (_req, res) => {
	// 审查 #352：该端点对未鉴权开放（监控探针需要），故只保留版本/引擎与 SDK
	// 副本诊断信息，不再暴露 cwd（工作区路径披露）与 pid（指纹/信息收集面）。
	res.json({
		ok: true,
		piVersion: VERSION,
		// issue #260：服务实际加载的是自带副本，不是全局 pi CLI 那份。这里把两份都报出来，
		// 用户就不用猜「为什么升了全局 SDK 不生效」。（纯新增字段，piVersion 语义不变。）
		piSdkCopies: sdkCopies(),
		engine: ENGINE,
	});
});

/**
 * 基于 SHA-256 内容寻址的附件静态服务：
 * 永久强缓存（immutable），支持图片和文件读取。
 */
app.get("/api/attachment/:hash", async (req, res) => {
	try {
		const hash = String(req.params.hash ?? "").trim();
		const hit = await readAttachment(hash);
		if (!hit) {
			res.status(404).end("attachment not found");
			return;
		}
		res.setHeader("Content-Type", hit.mimeType);
		res.setHeader("Content-Length", hit.buffer.length);
		res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
		if (hit.mimeType === "image/svg+xml") {
			// SVG 以文档形态打开（顶层导航/iframe）时内嵌 <script> 会在本应用
			// origin 执行——附件内容可来自剪贴板/工作区文件，等同存储型 XSS
			// （审查 #352 P0-1）。sandbox CSP 让文档形态降级到不透明 origin；
			// <img> 引用不受影响（子资源响应的 CSP 不作用于引用页，且
			// SVG-as-image 本就不执行脚本）。
			res.setHeader("Content-Security-Policy", "sandbox");
			res.setHeader("X-Content-Type-Options", "nosniff");
		}
		res.end(hit.buffer);
	} catch (err) {
		res.status(500).end((err as Error).message);
	}
});

/**
 * Stream a workspace file over HTTP.
 *
 * Media preview (no download param): only image/video kinds are served —
 * text goes over the WebSocket, and exe/jar/etc. are never exposed here.
 * Audio files (isAudioFile: browser-playable containers only) are allowed too
 * so present_files cards and the preview dialog can inline-play them.
 * express's sendFile handles Range requests, so video/audio seeking works.
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
		const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const root = cs?.cwd ?? CWD;
		const absWire = isAbsoluteWirePath(raw);
		let abs: string;
		if (absWire) {
			abs = wireToAbs(raw);
		} else {
			const wp = workspacePath(root, raw);
			if (!wp) {
				res.status(400).end("path outside workspace");
				return;
			}
			abs = wp.abs;
		}
		const name = basename(abs);
		const kind = previewKind(name);
		const isDownload = req.query.download === "1";
		// HTML files preview through a sandboxed <iframe> in the file modal
		// (FilePreview.tsx). They are text as far as previewKind goes, so
		// allowlist them explicitly here.
		const lower = name.toLowerCase();
		const isHtmlPreview = lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml");
		const isAudioPreview = isAudioFile(name);
		if (!isDownload && kind !== "image" && kind !== "video" && !isHtmlPreview && !isAudioPreview) {
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
			// dotfiles: allow — issue #223：Express 5 的 send 默认 dotfiles=ignore，
			// 工作区/数据目录常位于隐藏目录下（如 ~/.pi-web），绝对路径含点号段会被判 404。
			// 路径已由上方的 workspacePath/isAbsoluteWirePath 做工作区 containment 校验，放行安全。
			// 注：绝对 wire 路径分支是机器浏览设计（whole-machine browsing），
			// 不受工作区约束——别被注释误导（审查 #352）。
			res.download(abs, name, { dotfiles: "allow" });
		} else {
			if (isHtmlPreview) {
				// Sandbox even a top-level navigation to this URL: a workspace
				// HTML file must never get our origin (it could otherwise read
				// the token cookie). The modal iframe carries its own sandbox
				// attribute as well (defense in depth).
				//
				// ?allowJs=1 is the explicit per-file opt-in from the preview
				// modal ("启用脚本"): scripts run, but still in an opaque
				// origin — no DOM/cookie/storage access to our app, no forms,
				// no top-navigation. NEVER add allow-same-origin here.
				const allowJs = req.query.allowJs === "1";
				res.setHeader("Content-Security-Policy", allowJs ? "sandbox allow-scripts" : "sandbox");
				res.setHeader("X-Content-Type-Options", "nosniff");
			} else if (lower.endsWith(".svg")) {
				// 与 /api/attachment 同理：SVG 文档形态的 <script> 沙箱化
				// （审查 #352 P0-1），<img> 内嵌用法不受影响。
				res.setHeader("Content-Security-Policy", "sandbox");
				res.setHeader("X-Content-Type-Options", "nosniff");
			}
			res.sendFile(abs, { dotfiles: "allow" });
		}
	} catch {
		res.status(404).end("not found");
	}
});

/**
 * Directory-mapped preview: serves a workspace file at a URL that mirrors its
 * directory location, so an HTML preview's RELATIVE subresources
 * (<link href="../web/src/styles.css">, <img src="./x.png">, <script
 * src="./app.js">, …) resolve and load with normal browser semantics. The
 * iframe document URL itself carries the file's directory — no HTML rewriting.
 *
 *   /api/preview/<workspace-rel-path>?clientId=…[&allowJs=1]
 *   /api/preview/__abs__/<absolute-wire-path>?clientId=…[&allowJs=1]
 *   (each path segment URI-encoded; ".." is normalized by the browser before
 *   the request is sent, workspace containment is still re-checked here)
 *
 * Same footing as /api/file: workspace containment enforced, HTML documents
 * get a sandboxed CSP (?allowJs=1 relaxes scripts only — never same-origin),
 * everything else streams with its real content type.
 */
app.get("/api/preview/*splat", async (req, res) => {
	try {
		// 多段路径的 splat 是数组（见 splatParam），拼回 "/" 后才是线形路径。
		const captured = splatParam(req);
		const ABS_MARKER = "__abs__/";
		const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const root = cs?.cwd ?? CWD;
		// Express decodes %XX in the wildcard, so this is back to the wire
		// form (filenames never contain "/", so per-segment encoding from
		// the client round-trips exactly).
		let abs: string;
		if (captured === "__abs__" || captured.startsWith(ABS_MARKER)) {
			// Machine browsing: absolute wire path ("C:/..." / "/...").
			const wire = captured.slice(ABS_MARKER.length);
			if (!isAbsoluteWirePath(wire)) {
				res.status(400).end("bad absolute preview path");
				return;
			}
			abs = wireToAbs(wire);
		} else {
			const wp = workspacePath(root, captured);
			if (!wp) {
				res.status(400).end("path outside workspace");
				return;
			}
			abs = wp.abs;
		}
		const name = basename(abs);
		const st = await stat(abs);
		if (!st.isFile()) {
			res.status(400).end("not a file");
			return;
		}
		res.setHeader("X-Content-Type-Options", "nosniff");
		const lower = name.toLowerCase();
		if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xhtml")) {
			const allowJs = req.query.allowJs === "1";
			res.setHeader("Content-Security-Policy", allowJs ? "sandbox allow-scripts" : "sandbox");
		} else if (lower.endsWith(".svg")) {
			// 与 /api/attachment 同理：SVG 文档形态的 <script> 沙箱化（审查 #352 P0-1）。
			res.setHeader("Content-Security-Policy", "sandbox");
		}
		res.sendFile(abs, { dotfiles: "allow" });
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
	const candidates = [resolve(here, ".."), resolve(here, "..", ".."), resolve(here, "..", "..", "..")];
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
// 语言包：核心只随包发布中英，其余按需下载到 <dataDir>/locales/<code>.json。
// 手工放进去的同名 JSON 也会被识别（离线安装）。PI_WEB_TOKEN 鉴权自动覆盖。
/**
 * PI_WEB_LOCALE — the language a first visit falls back to.
 *
 * It is a fallback, not an override: an explicit choice, and then the
 * browser's own languages, come first (web/src/pick-locale.ts). It rides on
 * /api/locales because the client already asks for that at boot, so naming a
 * default costs no extra request.
 */
const DEFAULT_LOCALE = (process.env.PI_WEB_LOCALE ?? "").trim().toLowerCase() || null;

app.get("/api/locales", (_req, res) => {
	res.json({ packs: listPacks(DATA_DIR), defaultLocale: DEFAULT_LOCALE });
});
app.get("/api/locales/:code", (req, res) => {
	const code = String(req.params.code ?? "");
	if (!isKnownPack(code)) {
		res.status(404).end("unknown locale");
		return;
	}
	const pack = readPackFile(DATA_DIR, code);
	if (!pack) {
		res.status(404).end("locale not installed");
		return;
	}
	res.setHeader("Cache-Control", "no-cache");
	res.json(pack);
});
app.post("/api/locales/:code/install", async (req, res) => {
	const code = String(req.params.code ?? "");
	if (!isKnownPack(code)) {
		res.status(400).json({ error: `unknown locale: ${code}` });
		return;
	}
	try {
		const meta = await installPack(DATA_DIR, code, { baseUrl: LOCALE_BASE_URL, version: appVersion() });
		// 新包可能自带 serverStrings（issue #91 v2）——重扫注册，无表则跳过。
		loadServerStrings(DATA_DIR);
		res.json({ ok: true, ...meta });
	} catch (e) {
		res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
	}
});
app.delete("/api/locales/:code", (req, res) => {
	const code = String(req.params.code ?? "");
	if (!isKnownPack(code)) {
		res.status(404).end("unknown locale");
		return;
	}
	if (!removePack(DATA_DIR, code)) {
		res.status(404).end("locale not installed");
		return;
	}
	unloadServerStrings(code);
	res.json({ ok: true });
});
// Serve a theme's full CSS file so the frontend can swap the whole stylesheet.
// Registered before the SPA catch-all below (otherwise it'd return index.html).
app.get("/themes/:id.css", (req, res) => {
	const file = resolveThemeFile(BUILTIN_THEMES_DIR, USER_THEMES_DIR, req.params.id);
	if (!file) {
		res.status(404).end("theme not found");
		return;
	}
	res.setHeader("Content-Type", "text/css; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	// dotfiles: allow — issue #223：Express 5 的 send 默认 dotfiles=ignore，主题文件位于
	// 隐藏目录下（如 ~/.pi-web/themes、npm 全局目录 ~/.local/…）时会被判 404。路径已由
	// resolveThemeFile 校验（id 白名单 + 仅已知目录 + isFile），放行安全。
	res.sendFile(file, { dotfiles: "allow" });
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
app.all(["/plugins-api/:id/*splat", "/plugins-api/:id"], (req, res) => {
	// 多段子路径的 splat 是数组（见 splatParam），拼回 "/" 后再交插件路由。
	const rest = splatParam(req);
	pluginMgr.handleHttp(String(req.params.id ?? ""), req.method, rest, req, res);
});
/** 通用插件代理（host.registerProxy 注册的前缀落到这里）：去前缀后原样透传到
 *  127.0.0.1:port——相对路径/Range/SSE 天然可用。PI_WEB_TOKEN 鉴权已在上方覆盖。
 *  必须站在静态资源与 SPA catch-all 之前，否则子路径被 index.html 吞掉。 */
type ProxyHit = { prefix: string; pluginId: string; host: string; port: number };
function proxyForwardPath(hit: ProxyHit, url: string): string {
	let fwd = String(url ?? "/").slice(hit.prefix.length);
	if (!fwd.startsWith("/")) fwd = `/${fwd}`;
	return fwd || "/";
}
function proxyHttp(hit: ProxyHit, req: express.Request, res: express.Response): void {
	const fwdPath = proxyForwardPath(hit, req.url ?? "/");
	const headers: Record<string, string | string[]> = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined) continue;
		if (k.toLowerCase() === "host") continue;
		if (k.toLowerCase() === "content-length" && req.method !== "GET" && req.method !== "HEAD") continue;
		headers[k] = v as string | string[];
	}
	// 内页拼 SSE/资源绝对地址用（子路径反代下 import.meta 推导不到前缀，靠这个头）。
	headers["x-pi-proxy-prefix"] = hit.prefix;
	let body: Buffer | undefined;
	if (req.method !== "GET" && req.method !== "HEAD" && (req as unknown as { body?: unknown }).body !== undefined) {
		const b = (req as unknown as { body?: unknown }).body;
		if (Buffer.isBuffer(b)) body = b;
		else if (typeof b === "string") body = Buffer.from(b);
		else if (b !== undefined) {
			body = Buffer.from(JSON.stringify(b));
			if (!headers["content-type"]) headers["content-type"] = "application/json";
		}
		if (body) headers["content-length"] = String(body.length);
	}
	const up = proxyRequest(
		{ host: hit.host, port: hit.port, method: req.method, path: fwdPath, headers, timeout: 30000 },
		(upRes) => {
			const out: Record<string, string | string[]> = {};
			for (const [k, v] of Object.entries(upRes.headers)) {
				if (v === undefined) continue;
				const lk = k.toLowerCase();
				if (lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding" || lk === "upgrade") continue;
				out[k] = v as string | string[];
			}
			res.writeHead(upRes.statusCode ?? 502, out);
			upRes.pipe(res);
		},
	);
	up.on("timeout", () => up.destroy(new Error("proxy timeout")));
	up.on("error", (err) => {
		console.error(`[proxy:${hit.prefix}] → 127.0.0.1:${hit.port}${fwdPath} failed:`, err);
		if (!res.headersSent) res.status(502).end("proxy target unreachable");
		else res.end();
	});
	if (body) up.end(body);
	else req.pipe(up);
}
app.use((req, res, next) => {
	const hit = pluginMgr.findProxy(req.path);
	if (!hit) {
		next();
		return;
	}
	proxyHttp(hit, req, res);
});
app.get("/plugins/:id/client/*splat", (req, res) => {
	// 多段子路径（插件 vendor/分包）的 splat 是数组（见 splatParam），拼回 "/"。
	const rest = splatParam(req);
	// 特权 DOM 门禁：声明了 dom 能力的插件，其 bundle 需用户逐个授权后才下发
	// （同源 bundle 技术上拦不住 DOM 访问，门只能放在这里；见 server/plugin-dom.ts）。
	if (pluginMgr.isDomBundleBlocked(String(req.params.id ?? ""))) {
		res.status(403).end("dom access not granted (settings > plugins > grant)");
		return;
	}
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
	// dotfiles: allow — issue #223：插件目录默认在 ~/.pi-web/plugins（隐藏目录段），同上需放行。
	res.sendFile(abs, { dotfiles: "allow" }, (err) => {
		if (err && !res.headersSent)
			res
				.status((err as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 404 ? 404 : 500)
				.end("not found");
	});
});
/** Set in the env of the replacement child spawned by a self-update restart. */
const RESTART_CHILD_ENV = "PI_WEB_RESTART_CHILD";
const webDist = join(pkgRoot, "web", "dist");
/** webDist accessor for buildId() (declared above webDist's const). */
function webDistPath(): string {
	return webDist;
}
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
	// 缺失的静态文件必须 404（不能落进下面的 SPA catch-all）：缺少的 hash 产物若
	// 回 index.html（200），浏览器会把 HTML 当 JS/CSS 执行失败黑屏，SW 还会把
	// 它按 200 缓进 STATIC_CACHE，之后即使文件恢复也要清缓存才能好。
	app.use((req, res, next) => {
		const p = req.path;
		if (
			p.startsWith("/assets/") ||
			p.startsWith("/icons/") ||
			p === "/favicon.svg" ||
			p === "/icon.ico" ||
			p === "/manifest.webmanifest"
		) {
			res.status(404).end();
			return;
		}
		next();
	});
	app.get(/^\/(?!api\/|ws).*/, (_req, res) => {
		// Callback form: a failed stat here (npm i -g is mid-replacement of the
		// package dir) responds 503 instead of crashing the request pipeline
		// with an unhandled ENOENT stack trace.
		// Dev caching (settings → message display → devNoCache): index.html pins
		// hashed asset URLs — a cached copy keeps pointing at stale bundles
		// after a rebuild+restart. Default follows the install: ON from source
		// (.git next to the package root), OFF for installs. PI_WEB_DEV_CACHE=0/1
		// overrides either way.
		const devCache = process.env.PI_WEB_DEV_CACHE;
		const fromSource = existsSync(join(pkgRoot, ".git"));
		const envDefault = devCache !== undefined ? devCache !== "0" : fromSource;
		const stored = readDevNoCacheSetting();
		const noStore = stored ?? envDefault;
		res.setHeader("Cache-Control", noStore ? "no-store" : "public, max-age=0");
		// dotfiles: allow — issue #223：nvm 等安装路径本身在隐藏目录下（如 ~/.nvm/…），同上需放行。
		res.sendFile(join(webDist, "index.html"), { dotfiles: "allow" }, (err) => {
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
		"✖ 更新后的安装不完整（缺少 web/dist/index.html）。\n" + "  请手动执行 npm i -g pi-web-ui@latest 修复后重新启动。",
	);
	process.exit(1);
}

const httpServer = createServer(app);
const wss = new WebSocketServer({
	noServer: true,
	// 右键上传走单帧 base64（100MB 文件 → ~133MB 文本）：上限与
	// files-service 的上传 cap 对齐（base64 上限 + 1MB 包络余量），
	// 超限帧由 ws 层直接拒收，不进 handler 再分配 Buffer。
	maxPayload: WS_MAX_PAYLOAD_BYTES,
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
	const hostHeader = req.headers.host ?? "";
	// Host 白名单与 HTTP 侧同规则（审查 #352）：rebinding 下 Origin 会与
	// 攻击者 Host 自比相等，必须先把非本机/私网的 Host 挡掉。
	if (!httpHostAllowed(hostHeader, { allowHosts: ALLOW_HOSTS, hasAuthToken: Boolean(AUTH_TOKEN) })) {
		return false;
	}
	const host = parseAuthority(hostHeader.toLowerCase());
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
	// 通用插件代理的 websocket 透传（live-reload 这类 socket 走这条；与 proxyHttp 同前缀表）。
	const proxyHit = pluginMgr.findProxy(pathname);
	if (proxyHit) {
		if (!originAllowed(req)) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
			return;
		}
		if (AUTH_TOKEN && !tokenOk(req)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
			return;
		}
		const target = createConnection(proxyHit.port, proxyHit.host);
		const tearDown = (): void => {
			try {
				socket.destroy();
			} catch {
				/* already gone */
			}
			try {
				target.destroy();
			} catch {
				/* already gone */
			}
		};
		target.on("error", tearDown);
		socket.on("error", tearDown);
		target.setTimeout(10000, tearDown);
		target.on("connect", () => {
			target.setTimeout(0);
			let fwdPath = String(req.url ?? "/").slice(proxyHit.prefix.length) || "/";
			if (!fwdPath.startsWith("/")) fwdPath = `/${fwdPath}`;
			const lines = [`${req.method} ${fwdPath} HTTP/${req.httpVersion}`];
			for (const [k, v] of Object.entries(req.headers)) {
				if (k.toLowerCase() === "host") {
					lines.push(`host: 127.0.0.1:${proxyHit.port}`);
					continue;
				}
				if (Array.isArray(v)) for (const x of v) lines.push(`${k}: ${x}`);
				else if (v !== undefined) lines.push(`${k}: ${v}`);
			}
			lines.push("", "");
			try {
				target.write(lines.join("\r\n"));
				if (head?.length) target.write(head);
				socket.pipe(target).pipe(socket);
			} catch {
				tearDown();
			}
		});
		return;
	}
	if (pathname !== "/ws") {
		socket.destroy();
		return;
	}
	if (!originAllowed(req)) {
		// Reject cross-origin browser pages outright. The browser sees a failed
		// WS connect; the page's own reconnect loop then backs off and retries.
		socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	if (AUTH_TOKEN && !tokenOk(req)) {
		socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit("connection", ws, req);
	});
});

// Heartbeat: lets clients detect half-open connections (server killed without
// closing sockets, sleep/wake, network partitions). Also broadcasts lightweight
// server host metrics (CPU and memory usage) sampled every ~2s.
const HEARTBEAT_INTERVAL_MS = 2_000;
/** 全局广播与心跳推送背压阈值（256KB）：socket 积压时丢弃广播消息，防用户态无界堆积（issue #460）。 */
const BROADCAST_BACKPRESSURE_MAX_BYTES = 262_144;

interface TrackedWebSocket extends WebSocket {
	isAlive?: boolean;
	missedPings?: number;
}

const sampleHostMetrics = createHostMetricsSampler();

const heartbeatTimer = setInterval(() => {
	let message: ServerMessage = { type: "heartbeat" };
	try {
		message = { type: "heartbeat", hostMetrics: sampleHostMetrics() };
	} catch {
		// 继续发送普通心跳，下一轮重试采样。
	}

	if (wss.clients.size > 0) {
		const payload = JSON.stringify(message);
		for (const ws of wss.clients) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const tracked = ws as TrackedWebSocket;

			// 半开连接死连接回收（issue #460）：连续无活动/无 pong 则 terminate
			if (tracked.isAlive === false) {
				tracked.missedPings = (tracked.missedPings || 0) + 1;
				if (tracked.missedPings >= 3) {
					try {
						ws.terminate?.();
					} catch {}
					continue;
				}
			} else {
				tracked.missedPings = 0;
			}
			tracked.isAlive = false;
			try {
				ws.ping();
			} catch {
				try {
					ws.terminate?.();
				} catch {}
				continue;
			}

			// 广播背压：缓冲积压严重时跳过心跳推送
			if (ws.bufferedAmount <= BROADCAST_BACKPRESSURE_MAX_BYTES) {
				try {
					ws.send(payload);
				} catch {}
			}
		}
	}
}, HEARTBEAT_INTERVAL_MS);
// Unref'd so it never blocks exit: heartbeat alone must not hold the event loop open.
heartbeatTimer.unref?.();

// 引擎分发：PI_WEB_ENGINE=dsh 时使用 DeepSeek Harness 引擎（server/dsh/），
// 默认 pi 引擎。同一 wire 协议，前端无感知（ready/health 携带 engine 字段）。
import { DshAgentService } from "./dsh/dsh-agent-service.js";

/** dispatch 表所需的方法契约（pi 的 ClientSession 与 dsh 的 DshClientSession
 *  都结构兼容；dsh 引擎对不支持的功能做简化实现）。 */

/** TerminalManager 的 dispatch 面（两个引擎共用同一实现类）。 */
export interface TerminalManagerLike {
	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
		title?: string,
		opts?: { forceBash?: boolean; locale?: string },
	): void;
	input(id: string, data: string): void;
	resize(id: string, cols: number, rows: number): void;
	kill(id: string): void;
	rename(id: string, title: string): void;
	runCommand(id: string, command: CommandDef, cols: number, rows: number, fallbackCwd: string): void;
}

export interface DispatchSession {
	cwd: string;
	prompt(text: string, attachments?: PromptAttachment[], queue?: boolean): Promise<void>;
	/** Remove one queued prompt (steer/followUp) — the ✕ on a pending bubble.
	 *  `index` is the bubble position (identity); omitted = text fallback. */
	removeQueued(kind: "steer" | "followUp", text: string, index?: number): void;
	/** Save the unsent composer draft for the given session (pi engine only;
	 *  DSH sessions don't implement it — dispatch uses `?.` so it's skipped there). */
	saveDraft?(sessionId: string, text: string, ts: number): void;
	abort(): Promise<void>;
	abortBash(): Promise<void>;
	/** 手动重试上次失败的模型调用（自动重试次数用完、已停止标红后）。 */
	retryLast(): Promise<void>;
	killBackgroundServer(port?: number, taskId?: string): Promise<boolean>;
	killAllBackgroundServers(): Promise<string[]>;
	listBgServers(): Promise<void>;
	/** 钉住 / 取消钉住一个后台实例（自动清理跳过钉住的）。 */
	setBackgroundKeep(port: number, keep: boolean): boolean;
	/** 手动「立即清理」：按当前策略阈值清一次遗留实例，返回被清的端口。 */
	cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]>;
	/** 返回值语义见 SlashHost.newChat：布尔值 = 是否落在一个可接收首条的空白
	 *  新对话（/new <prompt> 用）。此处只管转发，返回值被丢弃，故允许 void。
	 *  preset = DSH Agent 预设（pi 引擎忽略）。 */
	newChat(preset?: string, ephemeral?: boolean): Promise<boolean | void>;
	editMessage(messageId: string, text: string, attachments?: PromptAttachment[]): Promise<void>;
	forkSession?(messageId: string, position?: "before" | "at", targetConvId?: string): Promise<void>;
	flushSnapshot(forceFull?: boolean): void;
	pushSlashCommands(): Promise<void>;
	/** 取一条工具的**定义说明** → `tool_info`（工具卡右键 → 「显示工具详细信息」）。
	 *  pi 与 dsh 都实现了；缺失时 dispatch 回 `unsupported`（不静默 —— 否则点开弹窗
	 *  会永远停在「读取中」）。 */
	getToolInfo?(name: string): void | Promise<void>;
	/** 取一条工具的「出厂默认 + 当前覆盖」→ `tool_prompt`（设置页逐工具编辑文案）。
	 *  缺失时 dispatch 回 `found: false`（引擎不支持 / 旧服务端）。 */
	getToolPrompt?(name: string): void | Promise<void>;
	/** 查询被某个压缩卡片折叠的历史消息（按需惰性加载，issue #398）。 */
	getCompactedMessages?(compactionMessageId: string, targetConvId?: string): void | Promise<void>;
	refreshSessions(): Promise<void>;
	pushProjects(): Promise<void>;
	removeProject(path: string): Promise<void>;
	deleteSession(path: string): Promise<void>;
	renameSession(path: string, name: string): Promise<void>;
	renameConversation(id: string, name: string): Promise<void>;
	dismissConversation(id: string, withFinishedSubagents?: boolean, force?: boolean): Promise<void>;
	dismissFinishedSubagents(parentId?: string): Promise<void>;
	persistConversation?(id: string): Promise<void>;
	setConversationPinned?(id: string, pinned: boolean): Promise<void>;
	pinSession?(path: string, pinned: boolean): Promise<void>;
	updatePlanStep?(stepId: string, patch: Partial<import("./protocol.js").PlanStep>, conversationId?: string): void;
	deletePlanStep?(stepId: string, conversationId?: string): void;
	addPlanStep?(step: import("./protocol.js").PlanStep, afterStepId?: string, conversationId?: string): void;
	planCleanHandoff?(steps: import("./protocol.js").PlanStep[], promptText: string): Promise<void>;
	switchSession(path: string, sessionId?: string): Promise<void>;
	switchConversation(id: string): Promise<void>;
	listFiles(path?: string): Promise<void>;
	searchFiles(query: string, reqId: number): Promise<void>;
	searchSessions(query: string, reqId: number): Promise<void>;
	scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		opts?: { path?: string; hash?: string },
	): Promise<void>;
	/** SCM「AI 生成提交信息」（scm_commitmsg）：当前模型一次性补全，应答 kind
	 *  "commitmsg" 的 scm_data；pi 引擎之外的会话实现缺失时分发处兜底报错。 */
	scmGenCommitMessage?(reqId: number): Promise<void>;
	readFile(path: string): Promise<void>;
	writeFile(path: string, text: string): Promise<void>;
	uploadFile(dirPath: string, name: string, data: string): Promise<void>;
	/** 文件树右键菜单的文件操作（contextmenu.file：新建/重命名/删除/复制移动）。 */
	createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void>;
	renameEntry(path: string, newName: string): Promise<void>;
	deleteEntry(path: string): Promise<void>;
	copyEntry(src: string, destDir: string, move?: boolean): Promise<void>;
	revealEntry(path: string): Promise<void>;
	openDefaultEntry(path: string): Promise<void>;
	listModels(): Promise<void>;
	setModel(modelId: string): Promise<void>;
	/** 全局默认模型（pi 引擎专有；DSH 无此概念，实现缺失时 dispatch 侧 `?.` 忽略）。 */
	setDefaultModel?(modelId: string): Promise<void>;
	clearDefaultModel?(): void;
	setThinking(level: string): void;
	setCwd(path: string): Promise<void>;
	/** 设置当前项目的额外工作区根（宿主侧多根，见 protocol 的 set_workspace_roots）。 */
	setWorkspaceRoots(roots?: string[]): Promise<void>;
	completePath(path: string): Promise<void>;
	makeDir(path: string, setAsCwd?: boolean): Promise<void>;
	checkUpdate(): Promise<void>;
	checkUpdatesAll(force?: boolean): Promise<void>;
	checkPluginUpdates?(manual?: boolean): Promise<void>;
	resolveDialog(id: number, value: string | boolean | null): void;
	handleTuiOverlayInput?(id: number, data: string): void;
	handleTuiOverlayResize?(id: number, cols: number, rows: number): void;
	handleTuiOverlayCancel?(id: number): void;
	installPiAgent(): Promise<void>;
	setProviderApiKey(provider: string, apiKey: string): Promise<void>;
	clearProviderApiKey(provider: string): Promise<void>;
	startProviderOAuth(provider: string): void;
	replyProviderOAuth(flowId: string, promptId: string, value: string): void;
	cancelProviderOAuth(flowId: string): void;
	listProviderOAuthFlows(): void;
	logoutProviderOAuth(provider: string): Promise<void>;
	listModelsConfig(): Promise<void>;
	reloadModelsConfig(): Promise<void>;
	saveModelConfig(providerId: string, config: unknown): Promise<void>;
	deleteModelConfig(providerId: string): Promise<void>;
	listProviders(): Promise<void>;
	listProviderKeys(): void;
	addProviderKey(provider: string, apiKey: string, name?: string): Promise<void>;
	activateProviderKey(provider: string, keyName: string): Promise<void>;
	removeProviderKey(provider: string, keyName: string): Promise<void>;
	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void>;
	testModelConnection?(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void>;
	refreshProviderModels(providerId: string, reqId: number): Promise<void>;
	refreshBuiltinModels(reqId: number): Promise<void>;
	appendBuiltinModel(providerId: string, model: unknown, reqId: number): Promise<void>;
	cloneProvider(provider: string, reqId: number): Promise<void>;
	enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void>;
	abortEnrichModels(reqId?: number): void;
	getTerminalManager(conversationId?: string): TerminalManagerLike | undefined;
	getTerminalCwd(conversationId?: string): string;
	listCommands(): Promise<void>;
	saveCommands(commands: CommandDef[]): Promise<void>;
	setGoal(
		goal: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
			/** 目标模式 2.0：执行者模型（DSH 引擎不接委托执行，忽略）。 */
			execModel?: string;
		},
	): Promise<void>;
	clearGoal(): Promise<void>;
	startGoalWizard(text: string, opts?: { wizardModel?: string; maxRounds?: number; locked?: boolean }): Promise<void>;
	setGoalPrefs(opts?: {
		reviewModel?: string;
		maxRounds?: number;
		locked?: boolean;
		execModel?: string;
	}): Promise<void>;
	pushSettings(): void;
	setSettings(partial: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		/** 宿主 UI 布局偏好（插件 UI 贡献 + 内置条目的隐藏/排序/分组；纯 UI，per-client）。 */
		uiLayout?: UiLayoutPrefs;
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		terminalBashMaxForegroundMs?: number;
		editSoftEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		scmCommitMsgPromptMode?: "append" | "replace";
		scmCommitMsgPrompt?: string;
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
	}): Promise<void>;
	reloadExtensions(): Promise<void>;
	/** DSH engine only: list/rescan <dataDir>/dsh-patches user patch files. */
	listDshPatches?(): Promise<void>;
	rescanDshPatches?(): Promise<void>;
	/** DSH engine only: Agent 预设名录刷新/空白切换/默认设置。 */
	refreshAgentPresets?(): Promise<void>;
	selectAgentPreset?(preset: string): Promise<void>;
	setDefaultAgentPreset?(preset: string): Promise<void>;
	/** DSH engine only: 权限预设热切换/新会话默认（三档）。 */
	setPermissionPreset?(preset: string): Promise<void>;
	setDefaultPermissionPreset?(preset: string): Promise<void>;
	/** DSH engine only: answer a model ask_user_question dialog. */
	answerQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): Promise<void>;
	/** 浏览器页面调用回包（browser_page 工具，pi 引擎专有；DSH 无页面桥，
	 *  方法缺失时 dispatch 侧的 `?.` 直接忽略这条消息）。 */
	resolvePageCall?(id: string, ok: boolean, result?: unknown, error?: string): void;
	forkSession?(messageId: string, position?: "before" | "at", conversationId?: string): Promise<void>;
	rollbackSession?(messageId: string, conversationId?: string, restoreWorkspace?: boolean): Promise<void>;
	resolveToolApproval?(
		id: string,
		decision: "approve" | "deny" | "edit",
		editedParams?: unknown,
		reason?: string,
		/** "category" = 顺带记住本对话的该同类档位；"all" = 本对话后续全部允许。 */
		scope?: "once" | "category" | "all",
	): boolean;
	/** 设置当前对话的审批放行策略（设置面板撤销区；纯内存态）。 */
	setApprovalPolicy?(partial: { conversationId?: string; allowAll?: boolean; categories?: string[] }): void;
	updatePlan?(steps: import("./protocol.js").PlanStep[], activeStepId?: string | null, conversationId?: string): void;
	/** 切换计划模式（只规划不实施）：会话级，热生效。 */
	setPlanMode?(enabled: boolean, conversationId?: string): Promise<void>;
	/** 切换审查者模式（自动委派）：会话级，默认关。DSH 实现里直接拒（无工具闸门）。 */
	setDelegateMode?(enabled: boolean, conversationId?: string): Promise<void>;
	savePreset(name: string): Promise<void>;
	applyPreset(name: string): Promise<void>;
	deletePreset(name: string): Promise<void>;
	saveMcpServer?(
		server: import("./protocol.js").UiMcpServer,
		prevName?: string,
		prevScope?: import("./protocol.js").McpScope,
	): Promise<void>;
	deleteMcpServer?(name: string, scope: import("./protocol.js").McpScope): Promise<void>;
	toggleMcpServer?(name: string, scope: import("./protocol.js").McpScope, enabled: boolean): Promise<void>;
	reloadMcp?(): Promise<void>;
	installSkill?(name: string, scope: "global" | "project", content: string): Promise<void>;
	uninstallSkill?(name: string, scope: "global" | "project"): Promise<void>;
	fetchMcpMarket?(source?: string, query?: string, page?: number, refresh?: boolean): Promise<void>;
	fetchSkillMarket?(repo?: string, refresh?: boolean): Promise<void>;
	fetchSkillContent?(repo: string, skillId: string): Promise<void>;
	/** 预设分享（server/preset-share.ts）：导出 / 导入 / 网址导入 / 目录 / 一键分享。 */
	exportPreset(msg: Extract<ClientMessage, { type: "preset_export" }>): Promise<void>;
	importPreset(msg: Extract<ClientMessage, { type: "preset_import" }>): Promise<void>;
	importPresetFromUrl(msg: Extract<ClientMessage, { type: "preset_import_url" }>): Promise<void>;
	pushPresetCatalog(msg: Extract<ClientMessage, { type: "preset_catalog" }>): Promise<void>;
	sharePreset(msg: Extract<ClientMessage, { type: "preset_share" }>): Promise<void>;
	/** Upsert 一个子代理模板（全局共享）。 */
	saveSubagentTemplate(template: UiSubagentTemplate): Promise<void>;
	saveApprovalRule?(rule: UiApprovalRule): Promise<void>;
	saveApprovalRules?(rules: UiApprovalRule[]): Promise<void>;
	deleteApprovalRule?(id: string): Promise<void>;
	resetBuiltinApprovalRule?(id: string): Promise<void>;
	/** 当前客户端的服务端语言（issue #91 v2：归一化 UI 代码，zh/EN/ja/…）。 */
	getLang(): string;
	/** Browser UI locale report (hello.locale / set_locale) — persist per
	 *  client and refresh lang-aware prompts (streaming-safe). */
	setLocale(locale: string): Promise<void>;
	/** 删除一个子代理模板。 */
	deleteSubagentTemplate(name: string): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	activeConversations(): number;
	pendingMessages(): number;
}

/** 引擎无关的服务接口（index.ts attach 流程 + 插件扩展点所需）。 */
export interface EngineService {
	attach(clientId: string, send: (msg: ServerMessage) => void): Promise<DispatchSession>;
	detach(clientId: string, send: (msg: ServerMessage) => void): void;
	get(clientId: string): DispatchSession | undefined;
	disposeAll(): Promise<void>;
	/** Snapshot still-streaming conversations for post-restart resume (pi
	 *  engine records them; dsh engine no-ops). Called from graceful
	 *  shutdown and the restart_service handler. */
	recordInterruptedRuns(): void;
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
		service: UiServiceInfo | null;
	};
	activeConversations(): number;
	pendingMessages(): number;
	applyPluginAgentTools(): void;
	applyPluginCommandCatalog(): void;
	refreshBackgroundServers(): void;
	/** Browser UI locale report (hello.locale / set_locale) — persist per
	 *  client and refresh lang-aware prompts (streaming-safe). */
	setLocale(clientId: string, locale: string): Promise<void>;
	/** 手动过户（pi 引擎实现；DSH 未实现 → dispatch 回落提示）。 */
	takeOverConversation?(targetId: string, ownerId: string, convId: string): Promise<void>;
	/** 跨页作答预告 + 答案转交（pi 引擎实现；DSH 未实现 → dispatch 回落提示）。 */
	peekElsewhereQuestion?(targetId: string, ownerId: string, convId: string): Promise<void>;
	answerElsewhereQuestion?(
		targetId: string,
		ownerId: string,
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
	): Promise<void>;
	onQuit?: (() => boolean) | undefined;
	onToolEvent?:
		| ((ev: {
				phase: "start" | "end";
				toolName: string;
				conversationId: string;
				durationMs?: number;
				isError?: boolean;
		  }) => void)
		| undefined;
	/** bash/read 插件拦截（P1-5，pi 引擎；dsh 引擎无 customTool 注册面，不接）。 */
	toolGuard?:
		| {
				pre: (
					req: ToolPreRequest,
					lang: string,
				) => Promise<{
					verdict:
						| { decision: "allow" }
						| { decision: "deny"; reason?: string; reasonEn?: string }
						| { decision: "ask"; reason?: string; reasonEn?: string };
					pluginId?: string;
				}>;
				post: (
					req: ToolPostRequest,
					lang: string,
				) => Promise<{ content?: Array<{ type: string; text?: string }>; pluginIds: string[] } | undefined>;
		  }
		| undefined;
	/** 运行轨迹事件转发（pi 引擎发射；dsh 引擎暂不发射，插件收不到即无轨迹）。 */
	onRunEvent?: ((ev: PluginRunEvent) => void) | undefined;
	/** 对话切换通知（切历史会话/切 running 对话/新对话/切项目，pi 引擎）。 */
	onConversationChanged?: (() => void) | undefined;
	/** 当前打开对话的快照（pi 引擎；dsh 引擎无此方法，插件回退空态）。
	 *  #542：可带 `{clientId}` 取某标签页正在看的对话。 */
	readConversationForPlugins?: ((options?: PluginConversationQuery) => PluginConversationSnapshot | null) | undefined;
	/** 模型切换成功通知（#542；pi 引擎。dsh 引擎暂无——插件订不到事件但快照照旧可读）。 */
	onClientModelChanged?: ((snap: PluginConversationSnapshot) => void) | undefined;
	/** 插件无头调用 agent（pi 引擎；dsh 引擎暂无，host.chat 明确拒绝）。 */
	chatFromPlugin?:
		((pluginId: string, req: PluginChatRequest) => Promise<{ conversationId: string; clientId: string }>) | undefined;
	pluginToolsProvider?: (() => unknown[]) | undefined;
	pluginCommandsProvider?: (() => unknown[]) | undefined;
	pluginBgTasksProvider?: (() => BgServer[]) | undefined;
	pluginStopBgTask?: ((taskId: string) => boolean) | undefined;
	onClientCwdChanged?: ((cwd: string, roots: string[]) => void) | undefined;
}

const service: EngineService =
	ENGINE === "dsh"
		? new DshAgentService(CWD, join(DATA_DIR, "client-state.json"), DATA_DIR, getAgentDir())
		: new AgentService(
				CWD,
				// Per-client persisted UI state: last-used workspace + recent projects.
				join(DATA_DIR, "client-state.json"),
			);

// Server-string tables (issue #91 v2): packs' `serverStrings` sections feed
// pick() lookup for non-zh/en UI languages (missing key → English fallback).
initAttachmentStore(DATA_DIR);
loadServerStrings(DATA_DIR);
// Optional UI plugins (<dataDir>/plugins/<id>/): scanned on every client
// attach so freshly dropped plugins appear without a server restart.
const pluginMgr = new PluginManager(DATA_DIR, CWD, join(pkgRoot, "plugins", "catalog.json"));
// 插件作业（安装/更新/卸载）后台执行：不占用户终端、不打断设置面板（issue #152）。
// 真正干活的是 CLI（<pkgRoot>/bin/pi-web-ui.mjs），这里只做进程编排 + 进度转发。
const pluginInstaller = new PluginInstaller({ dataDir: DATA_DIR, pkgRoot, managed: MANAGED });
/** 插件目录/市场变化后统一收尾：重扫激活 + 重推 plugins 与 plugin_catalog。 */
async function reloadPluginsAndPush(lang?: () => ServerLang): Promise<void> {
	await pluginMgr.reload(lang);
	await pluginMgr.pushToAll();
	await pluginMgr.pushCatalog();
}
// ---------------------------------------------------------------------------
// 插件目录授权（issue #146）：插件要访问**工作区之外**的目录时，向所有在线客户端推一条
// plugin_path_request，等第一个答复；同意则写进全局授权表（设置面板可撤销），超时=拒绝。
// 这条流程只解决「用户知情 + 可撤销」——插件的服务端代码本来就是全权 Node 代码，
// 想真正限制得靠 OS 沙箱（不在本项目范围），所以这里的价值是让受支持路径覆盖更多场景。
// ---------------------------------------------------------------------------
interface PendingPathRequest {
	resolve: (ok: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
	/** 弹窗广播时在线的 clientId 集合：应答必须来自其中之一——广播后才连上的端
	 *  没见过弹窗，不许代答（plugin_path_response 处理处校验）。 */
	recipients: Set<string>;
}
const pendingPathRequests = new Map<string, PendingPathRequest>();
/** 把授权表推给所有在线客户端（设置面板展示 + 撤销后刷新）。 */
function pushPluginGrants(): void {
	const grants = pluginMgr.grants.list();
	const payload = JSON.stringify({ type: "plugin_grants", grants });
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			try {
				client.send(payload);
			} catch {
				/* 死连接：index.ts 自己会清理 */
			}
		}
	}
}
pluginMgr.pathAccessRequester = (pluginId, dir, reason) =>
	new Promise<boolean>((resolve) => {
		const id = randomUUID();
		const timer = setTimeout(() => {
			pendingPathRequests.delete(id);
			resolve(false);
		}, 120_000);
		// 广播前先记下在线端集合：应答来源绑定用（防没见过弹窗的连接代答）。
		const recipients = new Set(pluginMgr.onlineClientIds());
		pendingPathRequests.set(id, { resolve, timer, recipients });
		const payload = JSON.stringify({
			type: "plugin_path_request",
			id,
			pluginId,
			path: dir,
			...(reason ? { reason } : {}),
		});
		for (const client of wss.clients) {
			if (client.readyState === WebSocket.OPEN) {
				try {
					client.send(payload);
				} catch {
					/* 死连接 */
				}
			}
		}
	});

// 用户点了「允许」→ 授权表变了 → 立刻重推给所有在线客户端（设置面板「已授权目录」即时可见）。
pluginMgr.onGrantsChanged = () => pushPluginGrants();
// ---------------------------------------------------------------------------
// 插件能力授权（host.requestPermission）：向所有在线客户端推一条
// plugin_permission_request，等第一个答复；remember=true 落盘，否则只记内存。
// 超时 120s 视为拒绝（与目录授权同窗口）。
// ---------------------------------------------------------------------------
interface PendingPermissionRequest {
	resolve: (ans: { ok: boolean; remember: boolean }) => void;
	timer: ReturnType<typeof setTimeout>;
	/** 弹窗广播时在线的 clientId 集合：应答必须来自其中之一（同目录授权）。 */
	recipients: Set<string>;
}
const pendingPermissionRequests = new Map<string, PendingPermissionRequest>();
/** 把能力授权表推给所有在线客户端（设置面板展示 + 撤销后刷新）。 */
function pushPluginPermissions(): void {
	const payload = JSON.stringify({ type: "plugin_permissions", grants: pluginMgr.permGrants.list() });
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			try {
				client.send(payload);
			} catch {
				/* 死连接 */
			}
		}
	}
}
pluginMgr.permissionRequester = (pluginId, req) =>
	new Promise<{ ok: boolean; remember: boolean }>((resolve) => {
		const id = randomUUID();
		const resolved = JSON.stringify({ type: "plugin_permission_resolved", id });
		const timer = setTimeout(() => {
			pendingPermissionRequests.delete(id);
			for (const client of wss.clients) {
				if (client.readyState === WebSocket.OPEN) {
					try {
						client.send(resolved);
					} catch {
						/* 死连接 */
					}
				}
			}
			resolve({ ok: false, remember: false });
		}, 120_000);
		// 广播前先记下在线端集合：应答来源绑定用（防没见过弹窗的连接代答）。
		const recipients = new Set(pluginMgr.onlineClientIds());
		pendingPermissionRequests.set(id, { resolve, timer, recipients });
		const ask = JSON.stringify({
			type: "plugin_permission_request",
			id,
			pluginId,
			family: req.family,
			...(req.hosts ? { hosts: req.hosts } : {}),
			...(req.models ? { models: req.models } : {}),
			...(req.reason ? { reason: req.reason } : {}),
		});
		for (const client of wss.clients) {
			if (client.readyState === WebSocket.OPEN) {
				try {
					client.send(ask);
				} catch {
					/* 死连接 */
				}
			}
		}
	});
pluginMgr.onPermGrantsChanged = () => pushPluginPermissions();

// ---------------------------------------------------------------------------
// 特权 DOM 授权两步握手：grant 是提权方向，不接受「一帧消息直接落盘」——设置面板
// 点击先发 plugin_dom_consent，服务端给该 pluginId 生成在途 consent 请求并广播
// plugin_dom_consent_request，收到绑定来源的 plugin_dom_consent_response 才调
// setDomConsent 持久写盘。发起端（settings 面板）按 from === 自己的 clientId 自动
// 应答，用户点一下的体验不变；陌生连接既不在 recipients 里，也没有发起记录，
// 只能等 120s 超时拒绝。revoke 是降权方向，保持单步直达（不走本表）。
// ---------------------------------------------------------------------------
interface PendingDomConsent {
	/** 随广播下发的请求 id，应答按它回查（本表按 pluginId 键：同插件同时只允许一个在途）。 */
	id: string;
	pluginId: string;
	/** 广播时在线的 clientId 集合：应答来源绑定（与目录/能力授权同一口径）。 */
	recipients: Set<string>;
	timer: ReturnType<typeof setTimeout>;
}
/** key = pluginId：wantsDom 插件集合有限 + 120s 自动过期，规模天然有界。 */
const pendingDomConsents = new Map<string, PendingDomConsent>();
/** 按 id 反查在途 consent 请求（应答只有 id；表很小，线性扫即可）。 */
function findDomConsentById(id: string): PendingDomConsent | undefined {
	for (const p of pendingDomConsents.values()) if (p.id === id) return p;
	return undefined;
}

// ---------------------------------------------------------------------------
// 插件安装的用户确认门（P0）：plugin_catalog_sync 的 install:true 与 plugin_job
// 的 install/update 在真正动安装器之前必须拿到用户确认。
// ---------------------------------------------------------------------------
async function confirmPluginInstallHelper(items: Array<{ id: string; source: string }>): Promise<boolean> {
	return confirmPluginInstall(items, {
		permGrants: pluginMgr.permGrants,
		permissionRequester: pluginMgr.permissionRequester,
		onGrantsChanged: pushPluginPermissions,
	});
}

// 远程 SSH 连接管理、环境探针与目录浏览服务
const remoteSshService = new RemoteSshService(DATA_DIR);
setGlobalRemoteSshService(remoteSshService);

// 内置定时任务（issue #184）：全局 <dataDir>/scheduler-tasks.json，TTL 与
// client-state 同级；Agent 工具建的任务优先唤醒发起对话（issue #193：
// wakeConversation steer 投递，不切用户当前对话），原对话不在先回落同项目
// 活跃对话（issue #231：视口兜底＋自动重绑定＋明确降级提示），都没有才无头伪
// 客户端（chatFromScheduler）；单次任务触发后自动删除。DSH 引擎无这俩方法时
// executor 回 not-supported（历史里记失败，不炸进程）。
const scheduler = new SchedulerStore(DATA_DIR, {
	executor: async (task) => {
		let result: { ok: boolean; conversationId?: string; error?: string };
		try {
			const svc = service as unknown as {
				chatFromScheduler?: (t: {
					id: string;
					cwd: string;
					prompt: string;
					model?: string;
					thinkingLevel?: string;
				}) => Promise<{ ok: boolean; conversationId?: string; error?: string }>;
				wakeConversation?: (
					id: string,
					text: string,
					opts?: { sessionFile?: string; cwd?: string },
				) => Promise<{
					ok: boolean;
					conversationId?: string;
					sessionFile?: string;
					clientId?: string;
					busy?: boolean;
					error?: string;
				}>;
				wakeViewportInCwd?: (
					cwd: string,
					text: string,
				) => Promise<{
					ok: boolean;
					conversationId?: string;
					sessionFile?: string;
					clientId?: string;
					busy?: boolean;
					error?: string;
				}>;
			};
			if (typeof svc.chatFromScheduler !== "function" && typeof svc.wakeConversation !== "function") {
				result = { ok: false, error: "当前引擎不支持定时任务（仅标准 pi 引擎）" };
			} else {
				const runHeadless = (): Promise<{ ok: boolean; conversationId?: string; error?: string }> =>
					svc.chatFromScheduler!({
						id: task.id,
						cwd: task.cwd,
						prompt: task.prompt,
						model: task.model,
						thinkingLevel: task.thinkingLevel,
					});
				const target = String(task.conversationId ?? "").trim();
				const taskFile = String((task as { sessionFile?: unknown }).sessionFile ?? "").trim();
				const text = `[定时任务 ${task.name}] ${task.prompt}`;
				if (!target && !taskFile) {
					// 面板建的任务：创建时就没绑对话，保持无头语义（不抢占用户视口）。
					result = await runHeadless();
				} else if (typeof svc.wakeConversation === "function") {
					// 原绑定对话还在（含压缩/重启后按会话文件重认）→ steer 唤醒，报告落原对话。
					let w: {
						ok: boolean;
						conversationId?: string;
						sessionFile?: string;
						busy?: boolean;
						error?: string;
					};
					try {
						w = await svc.wakeConversation(target, text, { sessionFile: taskFile, cwd: task.cwd });
					} catch (err) {
						w = { ok: false, error: (err as Error).message };
					}
					if (w.ok) {
						// 会话继承（issue #231）：压缩/重启后同文件对话换了新 id → 任务跟过去，
						// 下次触发直达，不再误判 closed/gone。单次任务随后自删，免一次写盘。
						if (!task.oneShot) {
							try {
								if (w.conversationId && w.conversationId !== target)
									scheduler.rebind(task.id, { conversationId: w.conversationId });
								if (w.sessionFile && w.sessionFile !== taskFile)
									scheduler.rebind(task.id, { sessionFile: w.sessionFile });
							} catch {
								// 重绑失败不影响本次已投递的唤醒
							}
						}
						result = { ok: true, conversationId: w.conversationId };
					} else if (typeof svc.wakeViewportInCwd === "function") {
						// 活跃视口兜底（issue #231）：原句柄断开（切走释放/过户改名/重启），
						// 只要同项目还有用户正看着的对话，报告落那里 —— 不静默吞结果。
						const fallbackText = `[定时任务 ${task.name}｜原对话不在，已转到本窗口继续] ${task.prompt}`;
						let f: {
							ok: boolean;
							conversationId?: string;
							sessionFile?: string;
							busy?: boolean;
							error?: string;
						};
						try {
							f = await svc.wakeViewportInCwd(task.cwd, fallbackText);
						} catch (err) {
							f = { ok: false, error: (err as Error).message };
						}
						if (f.ok) {
							if (!task.oneShot) {
								try {
									scheduler.rebind(task.id, {
										conversationId: f.conversationId ?? "",
										sessionFile: f.sessionFile ?? "",
									});
								} catch {
									// 重绑失败不影响本次已投递的唤醒
								}
							}
							pushNoticeToAll(
								"info",
								`定时任务「${task.name}」原对话不在，已转到同项目的活跃对话继续（原绑定 ${target || "（未知）"}）。报告直接落在当前对话。`,
								`Scheduled task "${task.name}" moved to the project's active conversation (was ${target || "unknown"}). The report lands in the current chat.`,
							);
							result = { ok: true, conversationId: f.conversationId };
						} else {
							// 降级可见性（issue #231）：必须无头时明确广播去向，不静默。
							pushNoticeToAll(
								"warning",
								`定时任务「${task.name}」原对话不在、同项目也无存活对话，已转后台执行（无头）。报告在后台任务面板的调度历史中查看。`,
								`Scheduled task "${task.name}" found no live conversation and runs headless; see its report in the background-tasks panel history.`,
							);
							result = await runHeadless();
						}
					} else {
						result = await runHeadless();
					}
				} else {
					result = await runHeadless();
				}
			}
		} catch (err) {
			result = { ok: false, error: (err as Error).message };
		}
		// 单次任务：触发一次后自动删除（历史随任务一起走，成败已由上面的 notify 播报）。
		if (task.oneShot) {
			try {
				scheduler.remove(task.id);
			} catch {
				// 删除失败不影响已记录的执行结果
			}
		}
		return result;
	},
	onChange: () => pushSchedulerTasks(),
	notify: (level, text, textEn) => pushNoticeToAll(level, text, textEn ?? text),
	// issue #291：任务删除（含单次任务跑完自删）后回收其伪客户端，
	// 否则 scheduler:<taskId> 会话会永久占据其他客户端的 elsewhere 列表。
	onTaskRemoved: (taskId) => {
		const svc = service as unknown as { releaseSchedulerClient?: (id: string) => void };
		try {
			svc.releaseSchedulerClient?.(taskId);
		} catch {
			// 回收失败不影响任务删除
		}
	},
});
scheduler.start();
/** 把调度器任务列表推给所有在线客户端（设置面板展示 + 变更后刷新）。 */
function pushSchedulerTasks(): void {
	try {
		const payload = JSON.stringify({ type: "scheduler_tasks", tasks: scheduler.list() });
		for (const client of wss.clients) {
			if (client.readyState !== WebSocket.OPEN) continue;
			if (client.bufferedAmount > BROADCAST_BACKPRESSURE_MAX_BYTES) continue;
			try {
				client.send(payload);
			} catch {
				/* 死连接：index.ts 自己会清理 */
			}
		}
	} catch {
		/* 序列化失败不影响调度 */
	}
}

/** 广播通知条给全部在线客户端（全局事件，不属于某个 ClientSession —— 如 mcp.json 坏）。 */
function pushNoticeToAll(level: "info" | "warning" | "error", text: string, textEn: string): void {
	const payload = JSON.stringify({ type: "notice", level, text, textEn });
	for (const client of wss.clients) {
		if (client.readyState !== WebSocket.OPEN) continue;
		if (client.bufferedAmount > BROADCAST_BACKPRESSURE_MAX_BYTES) continue;
		try {
			client.send(payload);
		} catch {
			/* 死连接：index.ts 自己会清理 */
		}
	}
}

// MCP 工具桥：读取配置启动外部 MCP 服务器（stdio），把它们的
// 工具并入与插件工具相同的 customTools 管线；单服务器失败不炸进程。
const mcpBridge = new McpBridge(DATA_DIR, (...a) => console.log("[mcp]", ...a), {
	agentDir: getAgentDir(),
	cwd: CWD,
});
ClientSession.mcpBridge = mcpBridge;
// mcp.json 热加载：保存文件即生效，改完不必再重启服务。两半都在这里收口 —— reload 换入
// 新的服务器集合（只重启规格真变了的），applyPluginAgentTools 把新工具推给已有会话。
const mcpHotReload = createMcpHotReload({
	dataDir: DATA_DIR,
	agentDir: getAgentDir(),
	cwd: CWD,
	reload: () => mcpBridge.reload(),
	onToolsChanged: () => service.applyPluginAgentTools(),
	onNotice: (level, text, textEn) => pushNoticeToAll(level, text, textEn),
	log: (...a) => console.log(...a),
});
void mcpBridge.load().then(() => {
	if (mcpBridge.getTools().length) service.applyPluginAgentTools();
	// 播种在 load 之后：否则指纹可能记在 load 读到的版本之前，白重载一次。
	mcpHotReload.start();
});
// 插件扩展点：SDK 工具执行事件（bash/读文件等 start+end）转发给已注册的插件。
service.onToolEvent = (ev) => pluginMgr.emitToolEvent(ev);
// 插件扩展点（P1-5）：bash/read 执行前后的拦截（pre 拒/问即拦、post 脱敏补上下文；
// 只覆盖已接管的这两处，DSH 引擎无 customTool 注册面不接）。
service.toolGuard = {
	pre: (req, lang) => pluginMgr.evaluateToolPre(req, lang),
	post: (req, lang) => pluginMgr.evaluateToolPost(req, lang),
};
service.onRunEvent = (ev) => pluginMgr.emitRunEvent(ev);
// 插件扩展点：对话切换通知（轨迹视图切会话后即重拉；dsh 引擎暂无）。
service.onConversationChanged = () => pluginMgr.emitConversationChanged();
// 插件扩展点：当前打开对话的快照（轨迹视图直接显示打开对话的时间线；
// dsh 引擎无此方法时回退 null，插件显示空态）。#542：透传 {clientId} 选本标签页的对话。
pluginMgr.conversationProvider = (opts) => service.readConversationForPlugins?.(opts) ?? null;
// 插件扩展点：模型切换成功事件（#542；dsh 引擎无此钩子 = 不发事件）。
service.onClientModelChanged = (snap) => pluginMgr.emitClientModelChanged(snap);
// 插件扩展点：无头调用 agent（微信通道等经 host.chat 投递外部消息，无浏览器也能跑）。
pluginMgr.chatProvider = (pluginId, req) =>
	service.chatFromPlugin?.(pluginId, req) ?? Promise.reject(new Error("当前引擎不支持无头调用（仅标准 pi 引擎）"));
// 插件扩展点：插件注册的 AI 工具（registerAgentTool）+ MCP 桥工具 → 会话创建时
// 带上 + 变化时动态注入/移除已有会话。
service.pluginToolsProvider = () => [...pluginMgr.getAgentTools(), ...mcpBridge.getTools()];
pluginMgr.onAgentToolsChanged = () => {
	service.applyPluginAgentTools();
	void pluginMgr.pushToAll().catch(() => {});
};
// 插件扩展点：插件斜杠命令（registerCommand）→ 命令选择器目录 + prompt 拦截执行。
pluginMgr.onCommandsChanged = () => service.applyPluginCommandCatalog();
service.pluginCommandsProvider = () => pluginMgr.listCommands();
// 插件扩展点：插件常驻后台任务（registerBackgroundTask）→ 并入「后台任务」面板。
pluginMgr.onBgTasksChanged = () => service.refreshBackgroundServers();
service.pluginBgTasksProvider = () => pluginMgr.bgTasks();
service.pluginStopBgTask = (taskId) => pluginMgr.stopPluginBgTask(taskId);
// 定时任务 Agent 工具的数据源（schedule 单 action：create/list/cancel）：标准 pi 引擎的
// AgentService 才有 schedulerStore 字段，DSH service 没有 —— 有才设。
if ("schedulerStore" in service) {
	(service as unknown as { schedulerStore: typeof scheduler }).schedulerStore = scheduler;
}
// ---------------------------------------------------------------------------
// 插件扩展点 v2（并行任务在 server/plugins.ts 加 host.conversations/prompt/
// steer/abortRun/chatWait/fs.watch/scm/bash/schedule/models/onStats/onStreaming/
// net.fetch/events + conversationLister/conversationSearcher/conversationWriter/
// runSteerer/runAborter/modelLister + emitStats/emitStreaming 注入点，web/ 侧加
// plugin-host v8 与新 slot/kind/messageWidget）。本文件只做接线，不实现宿主方法
// 本身：下面全是注入函数（读 service 现有逻辑组装数据），PluginManager 那边
// 存在即用、不存在即跳过。约束：全部用 (pm as any).xxx 赋值 + typeof 防御，绝不
// 假设 PluginManager 已有这些字段（并行任务可能还没合入）；每个注入内部再
// try/catch，DSH 引擎（无 pluginClient/各 ForPlugins 方法）回退空列表或
// {ok:false}，绝不抛错炸进程。
// ---------------------------------------------------------------------------
{
	// SAFETY: This compatibility bridge only assigns optional plugin hooks; consumers test their presence.
	const pm = pluginMgr as unknown as Record<string, unknown>;
	/** 注入函数间复用的对话条目形状（与 agent-service 的 *ForPlugins 方法对齐）。 */
	type PluginConvListItem = { id: string; title: string; cwd: string; kind: string; isStreaming: boolean };
	type PluginListerClient = {
		listRunningForPlugins?: () => PluginConvListItem[];
		listHistoryForPlugins?: (limit?: number) => Promise<PluginConvListItem[]>;
	};
	type PluginSearchClient = {
		searchForPlugins?: (q: string, n?: number) => Promise<{ id: string; title: string }[]>;
	};
	type PluginWriteClient = {
		writeForPlugins?: (cid: string, t: string) => Promise<{ ok: boolean; error?: string }>;
	};
	type PluginModelsClient = {
		listModelsForPlugins?: () => Promise<{ id: string; provider: string; vision: boolean }[]>;
	};
	type PluginAbortClient = {
		abortForPlugins?: (cid: string) => Promise<{ ok: boolean; error?: string }>;
	};
	type PluginSteerClient = {
		steerForPlugins?: (cid: string, t: string) => Promise<{ ok: boolean; error?: string }>;
	};
	/** 挑一个客户端会话：标准 pi 引擎走 service.pluginClient()，DSH/未知引擎无此方法即 undefined。 */
	const pickClient = (): ReturnType<AgentService["pluginClient"]> => {
		try {
			return service instanceof AgentService ? service.pluginClient() : undefined;
		} catch {
			return undefined;
		}
	};
	// conversationLister：本客户端运行中对话 + 当前项目历史会话摘要，只读组装
	// {id,title,cwd,kind,isStreaming}。无客户端/方法缺失回空数组（插件显示空态）。
	(pm as any).conversationLister = async () => {
		try {
			const cs = pickClient() as PluginListerClient | undefined;
			if (!cs) return [];
			const running = typeof cs.listRunningForPlugins === "function" ? cs.listRunningForPlugins() : [];
			const history = typeof cs.listHistoryForPlugins === "function" ? await cs.listHistoryForPlugins(50) : [];
			return [...running, ...history];
		} catch {
			return [];
		}
	};
	// conversationSearcher：复用 search_sessions 逻辑，返回前 N 个 {id,title}。
	(pm as any).conversationSearcher = async (query: string, limit?: number) => {
		try {
			const cs = pickClient() as PluginSearchClient | undefined;
			if (!cs || typeof cs.searchForPlugins !== "function") return [];
			return await cs.searchForPlugins(query, limit ?? 20);
		} catch {
			return [];
		}
	};
	// conversationWriter：向指定对话投递 prompt（复用 prompt 路径）；找不到对话回 {ok:false,error}。
	(pm as any).conversationWriter = async (id: string, text: string) => {
		try {
			const cs = pickClient() as PluginWriteClient | undefined;
			if (!cs || typeof cs.writeForPlugins !== "function")
				return { ok: false, error: "当前引擎不支持对话投递（仅标准 pi 引擎）" };
			return await cs.writeForPlugins(id, text);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	};
	// modelLister：复用现有模型列表，映射 {id,provider,vision}。
	(pm as any).modelLister = async () => {
		try {
			const cs = pickClient() as PluginModelsClient | undefined;
			if (!cs || typeof cs.listModelsForPlugins !== "function") return [];
			return await cs.listModelsForPlugins();
		} catch {
			return [];
		}
	};
	// runSteerer：复用 ClientSession.steerForPlugins（sendUserMessage + deliverAs:'steer'，
	// 跨客户端查找由方法内部兜底）；DSH/未知引擎无此方法即 not supported。
	(pm as any).runSteerer = async (id: string, text: string) => {
		try {
			const cs = pickClient() as PluginSteerClient | undefined;
			if (!cs || typeof cs.steerForPlugins !== "function") return { ok: false, error: "not supported" };
			return await cs.steerForPlugins(id, text);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	};
	// runAborter：有现成 abort 路径（interruptRun，卡住/空转强制重置语义继承）。
	(pm as any).runAborter = async (id: string) => {
		try {
			const cs = pickClient() as PluginAbortClient | undefined;
			if (!cs || typeof cs.abortForPlugins !== "function") return { ok: false, error: "not supported" };
			return await cs.abortForPlugins(id);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	};
	// llmProvider：插件直调模型（孤立无工具的一次性补全，不建对话）。
	// 标准 pi 引擎走 service.completeForPlugins；DSH/未知引擎回 {ok:false}，绝不抛错。
	(pm as any).llmProvider = async (pluginId: string, req: unknown) => {
		try {
			// SAFETY: Only invoked after the optional method is checked; request fields are narrowed below.
			const svc = service as unknown as {
				completeForPlugins?: (
					pluginId: string,
					req: { prompt?: string; system?: string; model?: string; maxChars?: number; timeoutMs?: number },
				) => Promise<{ ok: boolean; text?: string; model?: string; error?: string }>;
			};
			if (typeof svc.completeForPlugins !== "function")
				return { ok: false, error: "当前引擎不支持 LLM 直调（仅标准 pi 引擎）" };
			return await svc.completeForPlugins(pluginId, (req ?? {}) as { prompt?: string });
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	};
}
// 插件宿主工作区实时跟随当前项目：任意客户端 set_cwd 成功后同步给
// PluginManager，编辑器等工作区跟随型插件随即切根（详见 plugins.ts notifyCwd）。
service.onClientCwdChanged = (cwd, roots) => {
	pluginMgr.notifyCwd(cwd);
	// 工作区根（宿主侧多根，issue #146）：插件宿主的「工作区内」判定要跟着变。
	pluginMgr.notifyWorkspaceRoots(roots);
};

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
	// Windows `server install` runs the server under the powershell watchdog
	// launcher (`while ($true) { node …; Start-Sleep 10 }`) — exiting brings it
	// back within ~10s, same contract as launchd/systemd (see launch-origin.ts).
	const isWinWatchdog = ORIGIN.supervisor === "windows-watchdog";
	const inDocker = existsSync("/.dockerenv");
	if (isLaunchd || isSystemd || isWinWatchdog || inDocker) {
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
/** issue #295：attach（会话初始化）超过此时长未完成，先给浏览器一句可见提示，
 *  避免界面永久停在「正在连接」而用户不知发生了什么。attach 本体继续等（不取消），
 *  完成后照常走快照流程。 */
const ATTACH_SLOW_NOTICE_MS = 8_000;

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
	const tracked = ws as TrackedWebSocket;
	tracked.isAlive = true;
	tracked.missedPings = 0;
	ws.on("pong", () => {
		tracked.isAlive = true;
		tracked.missedPings = 0;
	});

	// Count attached sockets (the control socket reports REAL sockets, not
	// cached client-session objects).
	service.noteSocketOpen();
	let clientId: string | null = null;
	let closed = false;
	/** 最近一份全量 snapshot 的估算字节数（UTF-16 ×2），供背压相对阈值用（issue #11）。 */
	let lastSnapshotBytes = 0;
	/** Commands received while the session is still being created — replayed after attach.
	 *  带上限（256 条）：attach 挂死/失败保活期间队列不再无界增长，超限丢最旧并告警。 */
	const pending = new PendingCommandQueue();
	/** attach 完成（含插件链 + 首快照）前一律排队（见 hello 分支的 replayQueued）：
	 *  ready 先行后，ready 只代表传输通，插件命令目录/首快照都还没好，直接分发
	 *  会撞「未知命令」/ rev 链断裂。 */
	let attachDone = false;
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
			const wasFull = msg.type === "snapshot";
			// 真正的慢客户端：丢弃是安全的，但不能「丢完就没了」——安排一次延迟
			// 重发，等缓冲排空后快照最终必达（否则若此后再无事件，客户端将永久
			// 停留在旧快照）。重发仍走 flushSnapshot：缓冲未排空则再次顺延；
			// 若被丢弃的是全量快照（snapshot），重发必须强制 forceFull 保证客户端能拿到完整基线。
			if (!snapshotRetryTimer) {
				snapshotRetryTimer = setTimeout(() => {
					snapshotRetryTimer = null;
					service.get(clientId ?? "")?.flushSnapshot(wasFull);
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

	/** DOM 授权落盘 + notice 反馈（两步握手的 grant 与单步 revoke 共用收尾）。
	 *  cs 缺席（未 attach 完成）时只落盘不提示——消息本来就会在 attach 前排队。 */
	const applyDomConsent = (pluginId: string, granted: boolean): void => {
		void pluginMgr
			.setDomConsent(pluginId, granted)
			.then((r) => {
				const cs2 = clientId ? service.get(clientId) : undefined;
				if (r.error) cs2?.emitNotice("warning", `DOM 授权失败：${r.error}`, `DOM consent failed: ${r.error}`);
				else if (r.changed)
					cs2?.emitNotice(
						"info",
						granted ? `已授权插件「${pluginId}」完全 DOM 访问` : `已撤销插件「${pluginId}」完全 DOM 访问`,
						granted
							? `Granted full DOM access to plugin "${pluginId}"`
							: `Revoked full DOM access from plugin "${pluginId}"`,
					);
			})
			.catch(() => {});
	};

	const dispatch = (msg: ClientMessage): void => {
		if (!clientId) {
			pending.push(msg);
			return;
		}
		const cs = service.get(clientId);
		if (!cs || !attachDone) {
			// Session not ready yet (hello processing / plugin chain) — hold the command.
			pending.push(msg);
			return;
		}
		// Managed instances do not install software on themselves, and tabs this
		// instance does not offer stay closed. Both refusals live here, on the
		// server, because hiding them in the client would still leave the message
		// reachable to anything that can open the socket. See managed.ts / tabs.ts.
		const refusal = managedRefusal(msg.type, MANAGED) ?? tabsRefusal(msg.type, TABS);
		if (refusal) {
			send({ type: "notice", level: "error", text: refusal });
			return;
		}
		try {
			if (handleFileMessage(msg, cs)) return;
			if (handleScmMessage(msg, cs, send)) return;
			if (handleBgServerMessage(msg, cs)) return;
			if (handlePresetAndDshMessage(msg, cs)) return;
			if (handleModelAndProviderMessage(msg, cs)) return;
			if (handleTerminalMessage(msg, cs)) return;
			if (handleSessionLifecycleMessage(msg, cs)) return;
			if (handlePlanAndGoalMessage(msg, cs)) return;
			if (handleScheduleMessage(msg, scheduler, send)) return;
			if (handleRemoteSshMessage(msg, remoteSshService, send)) return;
			if (handleSettingsMessage(msg, cs)) return;
			if (handleInteractiveResponseMessage(msg, cs, service, clientId, send)) return;
			if (
				handlePluginMessage(msg, {
					pluginMgr,
					pluginInstaller,
					cs,
					clientId,
					send,
					dataDir: DATA_DIR,
					cwd: CWD,
					clients: wss.clients,
					pendingPathRequests,
					pendingPermissionRequests,
					pendingDomConsents,
					findDomConsentById,
					applyDomConsent,
					pushPluginGrants,
					pushPluginPermissions,
					reloadPluginsAndPush,
					confirmPluginInstallHelper,
				})
			)
				return;

			switch (msg.type) {
				case "prompt": {
					const hasAttach = Boolean(msg.attachments && msg.attachments.length > 0);
					if (!msg.text?.trim() && !hasAttach) {
						send({
							type: "notice",
							level: "warning",
							text: "发送已忽略：提示词为空且未附带文件或上下文引用。",
							textEn: "Prompt ignored: text is empty and no attachments were provided.",
						});
						break;
					}
					void cs.prompt(msg.text, msg.attachments, msg.queue);
					break;
				}
				case "queue_remove":
					// #491：removeQueued 是 async——dispatch 是 fire-and-forget，缺 void 时
					// 内部抛错即 unhandledRejection，而全仓没有兜底 handler，Node ≥15 直接崩进程。
					void cs.removeQueued(msg.kind, msg.text, msg.index);
					break;
				case "draft_update":
					cs.saveDraft?.(msg.sessionId, msg.text, msg.ts);
					break;
				case "abort":
					void cs.abort();
					break;
				case "abort_bash":
					void cs.abortBash();
					break;
				case "retry_last":
					void cs.retryLast();
					break;
				case "get_state":
					// Always a FULL snapshot: the client is (re)connecting or detected
					// a rev/seq gap — it needs an authoritative state to rebuild from.
					cs.flushSnapshot(true);
					break;
				case "get_commands":
					void cs.pushSlashCommands();
					break;
				case "get_tool_info":
					// 工具卡右键菜单的「显示工具详细信息」：按需取一次工具定义（不进快照）。
					// 引擎没实现（或旧版服务端）时回一条 unsupported，前端据此显示「不支持」
					// 而不是永远转圈。
					if (typeof cs.getToolInfo === "function") {
						void cs.getToolInfo(msg.name);
					} else {
						send({ type: "tool_info", name: msg.name, found: false, unsupported: true });
					}
					break;
				case "get_tool_prompt":
					// 设置页逐工具文案编辑器：取「出厂默认 + 当前覆盖」。
					if (typeof cs.getToolPrompt === "function") {
						void cs.getToolPrompt(msg.name);
					} else {
						send({ type: "tool_prompt", name: msg.name, found: false, unsupported: true });
					}
					break;
				case "take_over_conversation":
					if (typeof service.takeOverConversation === "function") {
						void service.takeOverConversation(clientId, msg.owner, msg.id);
					} else {
						send({
							type: "notice",
							level: "error",
							text: "当前引擎不支持过户（take over），请用 pi 引擎",
							textEn: "Takeover is not supported by the current engine; use the pi engine.",
						});
					}
					break;
				case "peek_elsewhere_question":
					if (typeof service.peekElsewhereQuestion === "function") {
						void service.peekElsewhereQuestion(clientId, msg.owner, msg.id);
					} else {
						send({
							type: "notice",
							level: "error",
							text: "当前引擎不支持跨页作答，请用 pi 引擎",
							textEn: "Cross-page answering is not supported by the current engine; use the pi engine.",
						});
					}
					break;
				case "set_locale":
					// UI language report — per-client persist + lang-aware prompt
					// refresh (streaming-safe). Engine-agnostic via DispatchSession.
					void service.setLocale(clientId, msg.locale);
					break;
				case "check_update":
					void cs.checkUpdate();
					break;
				case "check_updates_all":
					void cs.checkUpdatesAll(msg.force === true);
					break;
				case "check_plugin_updates":
					if (typeof cs.checkPluginUpdates === "function") {
						void cs.checkPluginUpdates(true);
					}
					break;
				case "restart_service": {
					// Same effect as `pi-web-ui server restart`: this process exits and its
					// supervisor brings it back (launchd/systemd immediately, the Windows
					// watchdog within ~10s). Refused without a supervisor — exiting there
					// would just stop the server the user is looking at.
					if (!ORIGIN.supervisor) {
						send({
							type: "notice",
							level: "error",
							text: "当前实例不是由 pi-web-ui 服务启动的（前台运行），无法自动重启；请在终端里重启，或先用 pi-web-ui server install 安装服务。",
							textEn:
								"This instance runs in the foreground, not as a pi-web-ui service — nothing would bring it back. Restart it in its terminal, or install the service with `pi-web-ui server install`.",
						});
						break;
					}
					send({
						type: "notice",
						level: "info",
						text: "正在重启服务…页面会在服务恢复后自动重连，进行中的对话会自动恢复并继续。",
						textEn:
							"Restarting the service… this page reconnects once it is back; running conversations resume automatically.",
					});
					// Record streaming runs BEFORE exiting: under systemd this path
					// exits via process.exit without shutdown(), so without this the
					// post-restart resume would find nothing to continue.
					try {
						service.recordInterruptedRuns();
					} catch {
						/* best effort — never block the restart on bookkeeping */
					}
					// Let the notice (and this socket's backlog) flush before we go down.
					setTimeout(() => void scheduleQuit(), 400);
					break;
				}
				default: {
					// 未知 type 只计数 + 节流 warn，不改变已知类型行为。
					// default 分支里 msg 已收窄成 never，type 需从宽化后取。
					const raw = (msg as unknown as { type?: unknown }).type;
					const name = typeof raw === "string" ? raw : String(raw);
					const r = recordUnknownWsType(name);
					if (r.warn) console.warn(`[ws] unknown message type "${name}" (x${r.count})`);
					break;
				}
			}
		} catch (err) {
			console.error(`[dispatch error on "${msg.type}"]:`, err);
			if (!closed) {
				send({
					type: "notice",
					level: "error",
					text: `操作「${msg.type}」执行出错：${err instanceof Error ? err.message : String(err)}`,
					textEn: `Error executing "${msg.type}": ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		}
	};

	/** ready 握手帧：首连与重复 hello 的幂等回包共用同一构造，避免两处漂移。 */
	const readyMsg = (cid: string): ServerMessage => ({
		type: "ready",
		clientId: cid,
		serverVersion: VERSION,
		protocolVersion: PROTOCOL_VERSION,
		engine: ENGINE,
		// This package's own version. `serverVersion` is the pi SDK's,
		// and the client used to learn ours from the update check —
		// which a managed instance never runs.
		appVersion: appVersion(),
		buildId: buildId(),
		managed: MANAGED,
		tabs: TABS ? [...TABS] : undefined,
		service: SERVICE_INFO ?? undefined,
	});

	ws.on("message", (data) => {
		tracked.isAlive = true;
		tracked.missedPings = 0;
		let msg: ClientMessage;
		try {
			msg = JSON.parse(data.toString()) as ClientMessage;
		} catch {
			return;
		}

		if (msg.type === "hello") {
			// 重放守卫：一条连接只允许 attach 一次。clientId 已赋值说明 hello 处理过
			//（或进行中），再来的 hello 幂等回一条 ready 即可——否则重复 hello 会把
			// service.attach 整个再跑一遍：重型 ClientSession 重复创建 + 旧 send sink
			// 永久泄漏（removePluginSender 只在 close 时清一次）。
			if (clientId) {
				if (!closed) send(readyMsg(clientId));
				return;
			}
			// clientId 校验：外部输入，类型/长度/字符集不合格直接换 randomUUID()——
			// 它随后成为 ClientSession key 与上传落盘目录名（uploads/<clientId>/，
			// saveUpload 的两条路径都从这里来，入口统一拦一次即可）。
			const cid = validateClientId(msg.clientId) ?? randomUUID();
			clientId = cid;
			// issue #295：ready 先行 —— 传输握手不等待会话初始化。attach 会进 SDK 的
			// resourceLoader.reload 等同步目录扫描，坏挂载/家目录下可能阻塞数十秒；
			// ready 在握手里先发，前端立刻离开「正在连接」（快照随后到）。
			if (!closed) {
				send(readyMsg(cid));
			}
			// attach 慢提示：本体继续等，不取消；完成后照常走快照流程。
			const slowTimer = setTimeout(() => {
				if (closed) return;
				send({
					type: "notice",
					level: "warning",
					text: "会话初始化耗时较长（可能在扫描工作区目录），请稍候…",
					textEn: "Session init is taking a while (possibly scanning the workspace) — hang on…",
				});
			}, ATTACH_SLOW_NOTICE_MS);
			service
				.attach(cid, send)
				.then((cs) => {
					clearTimeout(slowTimer);
					if (closed) {
						service.detach(cid, send);
						return;
					}
					// Plugin catalog: re-scan + activate new dirs on every attach so
					// freshly dropped plugins show up without a server restart.
					pluginMgr
						.ensureLoaded(() => service.get(cid)?.getLang() ?? "en")
						.then((plugins) => {
							if (closed) return;
							send({ type: "plugins", plugins, epoch: pluginMgr.epoch });
							// 插件市场列表（可一键安装的清单）随附推一次。
							send({
								type: "plugin_catalog",
								entries: pluginMgr.catalog(),
								epoch: pluginMgr.catalogEpochValue,
							});
							// 让各插件向新接入的客户端推送自身初始状态（onAttach 钩子）——
							// 插件不要依赖客户端挂载后自己拉（见 plugins.ts onAttach 注释）。
							pluginMgr.notifyAttach(cid);
							// P3：左栏插件运行条目全量补发（之后的变更经 plugin_panel_items 广播）。
							send({ type: "plugin_panel_items", groups: pluginMgr.panelGroups() });
							// 插件目录授权表（设置面板展示 + 可撤销）
							send({ type: "plugin_grants", grants: pluginMgr.grants.list() });
							// 插件能力授权表（设置面板展示 + 可撤销；session 授权带标记）
							send({ type: "plugin_permissions", grants: pluginMgr.permGrants.list() });
							// 插件命令可能在本客户端 attach 过程中才注册（首载竞态）——
							// 重推一次目录，保证选择器完整。
							service.applyPluginCommandCatalog();
							// 插件清单【先于】快照推送：前端渲染历史消息前就拿到 renderer
							// 注册表（plugin-fence.ts），`` ```lang `` 围栏才能立即命中插件；
							// 否则消息先落成普通代码块，清单后到也不会重渲。
							// 新连接/新客户端 attach 首次快照必须强制全量（forceFull=true），
							// 保证新标签页/刷新页能立刻拿到完整的会话基线，绝不因增量 delta 而卡在加载中。
							cs.flushSnapshot(true);
							// 内置定时任务列表随附推一次（后续变更经 pushSchedulerTasks 广播）。
							try {
								send({ type: "scheduler_tasks", tasks: scheduler.list() });
							} catch {
								/* 推送失败不挡快照 */
							}
							replayQueued();
						})
						.catch(() => {
							if (closed) return;
							// ensureLoaded 失败（如磁盘读错）不能卡死快照——前端 30s 无消息
							// 会重连，重连又失败会陷入循环。至少把状态推下去（同样强制全量）。
							cs.flushSnapshot(true);
							replayQueued();
						});
					// hello may carry the UI locale — persist it before replaying
					// anything queued during startup (issue #91).
					if (msg.locale) void service.setLocale(cid, msg.locale);
					// attach 期间收到的命令先排队（dispatch 里的 pending），必须等插件链
					// 就绪后再重放：prompt 里可能是插件命令（/probe-grant 等），目录由
					// 下面的 applyPluginCommandCatalog 同步；提前重放会撞上「未知命令」。
					// ready 先行（issue #295）之前，客户端收到 ready 时 attach 已完成，
					// 首条命令天然落在插件加载之后；现在 ready 与 attach 脱钩，不等就重放
					// 等于把竞态窗口从一个 RTT 放大到整个插件扫描期（CI 必现 grant 超时）。
					const replayQueued = (): void => {
						attachDone = true;
						for (const m of pending.drain()) dispatch(m);
					};
				})
				.catch((err: unknown) => {
					clearTimeout(slowTimer);
					if (closed) {
						service.detach(cid, send);
					}
					// Admission refused (quiesce): close the socket so the browser
					// reconnect loop keeps retrying until admission reopens. Do NOT
					// leave a half-alive connection that can only show an error.
					clearTimeout(slowTimer);
					if (err instanceof QuiesceRejectedError) {
						closed = true;
						if (ws.readyState === WebSocket.OPEN) {
							// 先发 4403 关闭帧，等它刷出去再真正撕连接：close 后立刻
							// terminate 会把关闭握手一起掐掉，客户端只能看到 1006
							// （quiesce-test 的 brand-new client 断言 4403）。
							try {
								ws.close(4403, "quiesced");
							} catch {
								/* already closing */
							}
							setTimeout(() => {
								try {
									if (ws.readyState !== WebSocket.CLOSED) ws.terminate?.();
								} catch {
									/* ignore */
								}
							}, 500);
						} else {
							try {
								ws.terminate?.();
							} catch {
								/* ignore */
							}
						}
						return;
					}
					// Real init failure (bad agent dir etc.) — keep the connection
					// open so the user can see the error and fix it.
					// 排队的命令此时无会话可服务，直接丢弃（否则 attachDone 永 false，
					// 队列越积越深；用户修好后重连会重发 get_state）。
					pending.clear();
					send({
						type: "notice",
						level: "error",
						text: `会话初始化失败：${(err as Error).message}`,
						textEn: `Failed to initialize session: ${(err as Error).message}`,
					});
				});
			return;
		}

		dispatch(msg);
	});

	ws.on("close", () => {
		service.noteSocketClose();
		closed = true;
		pending.clear();
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
	// issue #260：全局那份 pi SDK 不是服务在用的那份（自带副本赢在 Node 解析顺序上）。
	// #321 起默认已反转（resolve-global-sdk 自动跟随更新的那份），这条提示只在
	// 「进程没跟上」（升级发生在启动后 / 旧构建没注入钩子）或显式 PI_WEB_SDK=bundled
	// 钉死自带副本时出现。
	const sdkNote = sdkOriginNote(sdkCopies(), VERSION);
	if (sdkNote) {
		console.log(`    pi SDK note : ${sdkNote}`);
	}
	console.log(`    bind        : ${HOST}:${PORT}`);
	console.log("");
});

// 上传文件保留期清理：启动扫一次 + 每 6 小时一次（best-effort，见 uploads.ts）
scheduleUploadCleanup();

// 开机目录预同步（issue #165）：拉取一份插件市场目录文档 → 写可安装列表 → 逐条安装/更新。
// 官方社区清单（xing-shuyin/pi-web-ui-plugins，PR 经 CI 自动审核 + 构建发布）作为**默认来源**，
// 开箱即用、无需配置 PI_WEB_PLUGIN_CATALOG_URL；显式设为空串或 off/0/false/no 可关闭。
// 默认**仅同步市场目录列表，绝不自动安装插件**（用户在界面按需点击安装）。
// 仅在显式配置 PI_WEB_PLUGIN_CATALOG_INSTALL=1/true 时才顺手全部安装（headless/容器预置镜像场景）。
const OFFICIAL_PLUGIN_CATALOG_URL = "https://xing-shuyin.github.io/pi-web-ui-plugins/catalog.json";
const BOOT_CATALOG_URL =
	process.env.PI_WEB_PLUGIN_CATALOG_URL === undefined
		? OFFICIAL_PLUGIN_CATALOG_URL
		: process.env.PI_WEB_PLUGIN_CATALOG_URL.trim();
const bootCatalogDisabled = !BOOT_CATALOG_URL || /^(0|off|false|no)$/i.test(BOOT_CATALOG_URL);
const autoInstall = /^(1|true|yes)$/i.test(process.env.PI_WEB_PLUGIN_CATALOG_INSTALL ?? "");

if (!bootCatalogDisabled) {
	void syncPluginCatalog(
		BOOT_CATALOG_URL,
		{ install: autoInstall },
		{
			customCatalogPath: pluginMgr.customCatalogPath,
			pluginsDir: join(DATA_DIR, "plugins"),
			installer: pluginInstaller,
			// 默认仅同步市场列表；重载插件会重复触发其激活广播。
			afterWrite: () => (autoInstall ? reloadPluginsAndPush() : pluginMgr.pushCatalog()),
		},
	).then((r) => {
		if (!r.ok) {
			console.warn(`[catalog] 插件目录预同步失败（不阻断启动）: ${r.error}`);
			return;
		}
		if (autoInstall) {
			const bad = (r.installed ?? []).filter((i) => !i.ok);
			console.log(
				`[catalog] 插件目录预同步完成：安装 ${(r.installed ?? []).length - bad.length} 成功 / ${bad.length} 失败` +
					(bad.length ? `：${bad.map((i) => `${i.id}(${i.error ?? "?"})`).join("；")}` : ""),
			);
		} else {
			console.log(`[catalog] 插件市场列表预同步完成（共 ${(r.entries ?? []).length} 个条目，按需安装）`);
		}
	});
}

// Local control socket (status / quiesce / unquiesce) — same data dir the
// CLI uses, so `pi-web-ui server status|quiesce|unquiesce` just works.
const stopControl = startControlServer({ service, dataDir: DATA_DIR, port: PORT });

/**
 * Graceful shutdown budget (issue #172): disposeAll() can hang forever on a
 * stuck session runtime / PTY / pending handle, and the process would then
 * sit forever with no way out. The watchdog guarantees the process is gone
 * within this long no matter what — unref'd so a clean shutdown never
 * waits on it.
 */
const SHUTDOWN_FORCE_EXIT_MS = 5000;

let shuttingDown = false;
/**
 * SIGINT / SIGTERM handler. A second signal while a shutdown is already
 * running exits immediately (130 = killed by SIGINT, 143 = SIGTERM) instead
 * of being swallowed by the shuttingDown guard — previously a hung first
 * shutdown made Ctrl+C look completely dead (issue #172).
 */
async function shutdown(signal: "SIGINT" | "SIGTERM" = "SIGINT"): Promise<void> {
	if (shuttingDown) {
		console.log("\n再次收到中断信号，强制退出…");
		process.exit(signal === "SIGTERM" ? 143 : 130);
	}
	shuttingDown = true;
	console.log("\nshutting down…");
	// Windows ConPTY 兜底看门狗（issue #215）：主线程若死锁在 native
	// ClosePseudoConsole 里，事件循环冻结，进程内的 forceExitTimer 永远触发不了 ——
	// 只能靠外部进程收尾。超时取 forceExit + 余量（只在进程内兜底失效时才开火）；
	// 正常退出在 finally 里取消，避免误杀 + PID 复用竞态。
	// taskkill 必须带 /T（树杀）：只杀单个 node.exe 会留下 node-pty 派生的
	// conhost --headless / bash，控制台永远不回提示符；/T 连它们一起收走。
	// 不用 detached：Windows 会给 detached 子进程分配可见控制台窗口（黑框一闪），
	// 而看门狗根本不需要脱离——父进程死锁时它照样能跑，父进程正常退出时 finally
	// 里会取消它；父进程崩掉时看门狗也没了，但那时本来就不需要收尾。
	// cmd.exe 是无 GUI 的控制台宿主，windowsHide 藏的是它一闪而过的黑窗口。
	let disarmKiller: (() => void) | null = null;
	if (process.platform === "win32") {
		try {
			const { spawn } = await import("node:child_process");
			const killer = spawn(
				"cmd.exe",
				[
					"/c",
					`timeout /t ${Math.ceil((SHUTDOWN_FORCE_EXIT_MS + 5000) / 1000)} /nobreak >nul && taskkill /F /T /PID ${process.pid}`,
				],
				{ stdio: "ignore", windowsHide: true },
			);
			killer.unref();
			disarmKiller = () => {
				try {
					killer.kill();
				} catch {
					// 已退出/杀不掉：看门狗使命本来就是收尾，无需上报
				}
			};
		} catch {
			// 看门狗起不来：回落进程内 forceExitTimer，不阻断关机
		}
	}
	const forceExitTimer = setTimeout(() => {
		console.error("shutdown 超时仍未完成，强制退出…");
		process.exit(1);
	}, SHUTDOWN_FORCE_EXIT_MS);
	forceExitTimer.unref();
	let code = 0;
	try {
		clearInterval(heartbeatTimer);
		stopControl();
		scheduler.stop();
		pluginMgr.dispose();
		pluginInstaller.dispose();
		mcpHotReload.dispose();
		mcpBridge.dispose();
		await globalLspPool.shutdownAll();
		await service.disposeAll();
		// Don't let dead browsers hold the exit open: half-open WebSocket /
		// keep-alive HTTP connections (e.g. test clients killed without
		// closing) would otherwise keep close() from ever finishing — drop
		// them first so shutdown stays prompt.
		for (const ws of wss.clients) {
			try {
				ws.terminate();
			} catch {
				/* already gone */
			}
		}
		wss.close();
		httpServer.closeAllConnections();
		httpServer.close();
	} catch (err) {
		code = 1;
		console.error("shutdown 释放资源时出错:", err);
	} finally {
		clearTimeout(forceExitTimer);
		disarmKiller?.();
		process.exit(code);
	}
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason: unknown) => {
	console.error("[pi-web-ui] Unhandled Promise Rejection:", reason);
});
process.on("uncaughtException", (err: Error) => {
	console.error("[pi-web-ui] Uncaught Exception:", err);
});
