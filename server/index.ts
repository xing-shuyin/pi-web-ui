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
import { botExecutionMessageAllowed } from "./device-center/bot-execution.js";
import { ALL_AGENT_TOOL_ENTRIES, effectiveDisabledAgentTools, isToolSupportedOnPlatform } from "./tool-manager.js";
import "./patch-remote-catalog.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { registerPromptTemplateRoutes } from "./prompt-templates.js";
import { createQuickAskRuntime, registerQuickAskRoutes } from "./quick-ask.js";
import { QuickAskError, readQuickAskHistoryConversation } from "./quick-ask-context.js";
import { SandboxManager } from "./sandbox-service.js";
import { registerSystemScreenshotRoutes } from "./system-screenshot.js";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { proxyHttp, type ProxyHit } from "./http-proxy.js";
import { saveSetupConfig } from "./setup-config.js";
import { createConnection } from "node:net";
import { basename, delimiter, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { registerTtsRoutes } from "./tts-routes.js";
import express from "express";
import { mobileCors, mobileOriginAuthorized } from "./mobile-origin.js";
import { createMobilePushService } from "./mobile-push.js";
import type { MobileNotificationEvent } from "./mobile-notification-events.js";
import compression from "compression";
import { WebSocket, WebSocketServer } from "ws";
import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { sdkCopies, sdkOriginNote } from "./sdk-origin.js";
import { PROTOCOL_VERSION } from "./protocol-version.js";
import { AgentService, workspacePath, QuiesceRejectedError, ClientSession } from "./agent-service.js";
import { ClientStateStore } from "./client-state.js";
import { isAbsoluteWirePath, wireToAbs } from "./files-service.js";
import { WS_MAX_PAYLOAD_BYTES } from "./payload-limits.js";
import { httpHostAllowed, isLoopbackHost, hostWithoutPort } from "./host-guard.js";
import { registerFileTransferRoutes } from "./file-transfer-routes.js";
import { initAttachmentStore, findAttachment } from "./attachment-store.js";
import { isOfficeFile, OFFICE_MAX_FILE_BYTES, unzipFiles } from "./office-parse.js";
import { startControlServer } from "./control-socket.js";
import { scheduleUploadCleanup } from "./uploads.js";
import { ensureWindowsBash, windowsBashDir } from "./ensure-bash.js";
import { listThemes, readThemeCss, resolveThemeFile } from "./themes.js";
import { isManaged, managedRefusal } from "./managed.js";
import { launchOrigin, toServiceInfo } from "./launch-origin.js";
import { isTabAllowed, parseTabs, tabsRefusal } from "./tabs.js";
import { nativeCliDiscoveryHandler } from "./native-cli-routes.js";
import { recordUnknownWsType } from "./ws-unknown-types.js";
import { MessageWindowTap, readMessageWindowConfig } from "./message-window.js";
import { validateClientId } from "./ws-client-id.js";
import {
	PendingCommandQueue,
	MAX_PRE_HELLO_WS_BYTES,
	isClientMessageEnvelope,
	isClientMessageWithinByteLimit,
} from "./ws-pending-queue.js";
import {
	installPack,
	isKnownPack,
	listPacks,
	loadServerStrings,
	readPackFile,
	removePack,
	resolveSystemDefaultLocale,
	unloadServerStrings,
} from "./locales.js";
import {
	PluginManager,
	resolvePluginClientFile,
	resolvePluginSharedFile,
	type PluginChatRequest,
	type PluginConversationQuery,
	type PluginConversationSnapshot,
	type PluginRunEvent,
} from "./plugins.js";
import type { ToolPostRequest, ToolPreRequest } from "./plugin-tool-guard.js";
import { confirmPluginInstall, PluginInstaller } from "./plugin-installer.js";
import { syncPluginCatalog } from "./plugin-catalog-sync.js";
import type { ServerLang } from "./i18n.js";
import { McpProjectRuntimeRegistry } from "./mcp-project-runtime.js";
import { installLocalDeviceCenter, requestDeviceHub } from "./device-center/local.js";
import { createGroupRouterRuntime } from "./device-center/group-router-runtime.js";
import { createGroupRouterWorker } from "./device-center/group-router-worker.js";
import { createDeviceConnector } from "./device-center/connector.js";
import { createDeviceRuntime } from "./device-center/runtime.js";
import { createLocalBotRegistry } from "./device-center/bots.js";
import { setDeviceCollabService } from "./device-center/collab-tool.js";
import { createDeviceDesktop } from "./device-center/desktop.js";
import { createDeviceLanAccess } from "./device-center/device-lan-access.js";

import { createHostMetricsSampler } from "./host-metrics.js";
import { SchedulerStore } from "./scheduler-tasks.js";
import { initHttpProxy } from "./http-proxy.js";
import { globalLspPool } from "./lsp-tool.js";
import { buildPiWebTokenCookie, decodeCookieToken, isTlsRequest } from "./auth-cookie.js";
import { isLoopbackAddress, loadServerFileConfig, saveServerFileConfig, tokenWarning } from "./server-config.js";
import { renderSetupHtml } from "./setup-page.js";
import { renderUnauthorizedHtml } from "./unauthorized-page.js";
import { formatStartupBannerLines } from "./startup-banner.js";
import { getAppVersion, getPkgRoot } from "./pkg-info.js";
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
import {
	RemoteSshService,
	isRemoteWorkspaceUri,
	serveRemoteWorkspaceFile,
	setGlobalRemoteSshService,
} from "./remote-ssh-service.js";
import { handlePluginMessage } from "./dispatch-plugin-handlers.js";
import { materializeNativeCliReferences } from "./native-cli-references.js";
import { CanvasOrchestrator } from "./canvas/canvas-orchestrator.js";
import { executeScheduledCanvas, validateScheduledCanvas } from "./canvas/canvas-scheduled-task.js";
import { setCanvasBroadcaster, setCanvasRuntime } from "./canvas/canvas-agent-tool.js";
import { handleCanvasMessage } from "./canvas/canvas-dispatch.js";
import type {
	BgServer,
	ThinkingLevel,
	ClientMessage,
	UiApprovalRule,
	UiLayoutPrefs,
	CommandDef,
	PromptAttachment,
	ServerMessage,
	UiServiceInfo,
	UiSubagentTemplate,
	AgentEngineCapabilities,
	NativeCliConfig,
	TerminalInfo,
} from "./protocol.js";

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

function cliFlag(name: string): string | undefined {
	const eq = `${name}=`;
	for (let i = 2; i < process.argv.length; i++) {
		const a = process.argv[i];
		if (a === name && i + 1 < process.argv.length) return process.argv[i + 1];
		if (a.startsWith(eq)) return a.slice(eq.length);
	}
	return undefined;
}

const CWD = resolve(cliFlag("--cwd") ?? process.env.PI_WEB_CWD ?? process.cwd());
const DATA_DIR = resolve(cliFlag("--data-dir") ?? process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
try {
	mkdirSync(DATA_DIR, { recursive: true });
} catch (err) {
	console.warn(`[data] 无法创建数据目录 ${DATA_DIR}: ${(err as Error).message}`);
}
try {
	mkdirSync(CWD, { recursive: true });
} catch (err) {
	console.warn(`[cwd] 无法创建工作区目录 ${CWD}: ${(err as Error).message}`);
}
const FILE_CFG = loadServerFileConfig(DATA_DIR);
const PORT = Number(cliFlag("--port") ?? process.env.PI_WEB_PORT ?? FILE_CFG.port ?? 8787);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
	console.error(`无效端口: ${cliFlag("--port") ?? process.env.PI_WEB_PORT} (--port / PI_WEB_PORT)`);
	console.error(`Invalid port: ${cliFlag("--port") ?? process.env.PI_WEB_PORT} (--port / PI_WEB_PORT)`);
	process.exit(1);
}
try {
	if (resolve(CWD) === resolve(homedir())) {
		console.warn(
			`[ws] 工作区为用户主目录 ${CWD}：目录扫描可能因外部卷/同步盘挂载而长时间阻塞，` +
				`建议用 \`pi-web-ui server install --cwd <项目目录>\` 重装迁移。`,
		);
	}
} catch {}
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

const HOST = cliFlag("--host") ?? process.env.PI_WEB_HOST ?? FILE_CFG.host ?? "127.0.0.1";
const ALLOW_HOSTS = (process.env.PI_WEB_ALLOW_HOSTS ?? FILE_CFG.allowHosts ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
const ALLOW_ORIGINS = (process.env.PI_WEB_ALLOW_ORIGINS ?? FILE_CFG.allowOrigins ?? "")
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);
let AUTH_TOKEN = (process.env.PI_WEB_TOKEN ?? FILE_CFG.token ?? "").trim();

const ALLOW_INSECURE_NO_AUTH = /^(1|true|yes)$/i.test(
	process.env.PI_WEB_INSECURE_NO_AUTH ?? process.env.PI_WEB_ALLOW_INSECURE_NO_AUTH ?? "",
);

let autoGeneratedToken = "";
if (!isLoopbackHost(HOST) && !AUTH_TOKEN && !ALLOW_INSECURE_NO_AUTH) {
	autoGeneratedToken = randomBytes(24).toString("hex");
	AUTH_TOKEN = autoGeneratedToken;
}
const LOCALE_BASE_URL =
	process.env.PI_WEB_LOCALE_BASE_URL?.trim() || "https://raw.githubusercontent.com/xing-shuyin/pi-web-ui";
function appVersion(): string {
	return getAppVersion();
}
const SERVER_RUN_ID = randomUUID();
let buildIdCache: string | null = null;
function buildId(): string {
	if (buildIdCache === null) {
		try {
			const html = readFileSync(join(webDistPath(), "index.html"), "utf8");
			buildIdCache =
				html.match(/<meta\s+name="pi-web-build-id"\s+content="([^"]+)"/)?.[1] ??
				html.match(/(?:\/|\.\/)assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1] ??
				"";
		} catch {
			buildIdCache = "";
		}
	}
	return buildIdCache;
}
const SESSION_DIR_ROOT = join(getAgentDir(), "sessions");

const proxyInfo = initHttpProxy(getAgentDir());
if (proxyInfo.active) {
	console.log(`[proxy] Outbound HTTP proxy enabled: ${proxyInfo.proxyUrl}`);
}

if (process.platform === "win32") {
	process.env.PATH = `${windowsBashDir()}${delimiter}${process.env.PATH ?? ""}`;
	void ensureWindowsBash();
} else if (process.platform === "darwin") {
	const macPaths = [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(homedir(), ".local", "bin"),
		join(homedir(), "Library", "pnpm"),
		join(homedir(), ".bun", "bin"),
		join(homedir(), ".local", "share", "fnm", "current", "bin"),
	];
	const fnmVersions = join(homedir(), ".local", "share", "fnm", "node-versions");
	if (existsSync(fnmVersions)) {
		try {
			for (const v of readdirSync(fnmVersions)) {
				macPaths.push(join(fnmVersions, v, "installation", "bin"));
			}
		} catch {}
	}
	const nvmVersions = join(homedir(), ".nvm", "versions", "node");
	if (existsSync(nvmVersions)) {
		try {
			for (const v of readdirSync(nvmVersions)) {
				macPaths.push(join(nvmVersions, v, "bin"));
			}
		} catch {}
	}
	const curParts = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	const curSet = new Set(curParts);
	const toAdd = macPaths.filter((p) => existsSync(p) && !curSet.has(p));
	if (toAdd.length > 0) {
		process.env.PATH = `${toAdd.join(delimiter)}${delimiter}${process.env.PATH ?? ""}`;
	}
}

const app = express();
const deviceLanAccess = createDeviceLanAccess();
const mobilePush = createMobilePushService({ dataDir: DATA_DIR });
const mobileOriginOptions = { tokenConfigured: () => Boolean(AUTH_TOKEN), authorize: tokenOk };
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
app.use((req, res, next) => {
	if (!deviceLanAccess.handleRequest(req, res)) next();
});
app.use(mobileCors(mobileOriginOptions));
const superagentWebhookPaths = new Set(["/api/superagent/webhooks/github", "/api/superagent/webhooks/feishu"]);
const isSuperagentWebhook = (req: { method?: string; url?: string }) =>
	req.method === "POST" && superagentWebhookPaths.has((req.url ?? "").split("?")[0]);
const webhookJson = express.json({
	limit: "1mb",
	type: () => true,
	verify: (req, _res, buffer) => {
		if (isSuperagentWebhook(req)) (req as IncomingMessage & { rawBody: Buffer }).rawBody = Buffer.from(buffer);
	},
});
const defaultJson = express.json({ limit: "10mb" });
app.use((req, res, next) => (isSuperagentWebhook(req) ? webhookJson : defaultJson)(req, res, next));

export function setupGate(
	req: { socket?: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> },
	res: { status: (c: number) => { end: (m: string) => void } },
	next: () => void,
): void {
	if (!isLoopbackAddress(req.socket?.remoteAddress)) {
		res.status(403).end("setup page is only available from localhost");
		return;
	}
	if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) {
		res.status(403).end("setup page cannot be accessed through a reverse proxy");
		return;
	}
	const hostHeader = typeof req.headers.host === "string" ? req.headers.host : "";
	const host = hostWithoutPort(hostHeader);
	if (!host || !isLoopbackHost(host)) {
		res.status(403).end("setup page Host header must be localhost");
		return;
	}
	const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
	if (origin) {
		try {
			const u = new URL(origin);
			if (!isLoopbackHost(u.hostname)) {
				res.status(403).end("cross-origin setup request rejected");
				return;
			}
		} catch {
			res.status(403).end("invalid origin");
			return;
		}
	}
	const secFetchSite =
		typeof req.headers["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"].toLowerCase() : "";
	const secFetchMode =
		typeof req.headers["sec-fetch-mode"] === "string" ? req.headers["sec-fetch-mode"].toLowerCase() : "";
	if (secFetchSite === "cross-site" && secFetchMode !== "navigate") {
		res.status(403).end("cross-site request to setup rejected");
		return;
	}
	next();
}

app.get("/setup", setupGate, (_req, res) => {
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
	res.end(renderSetupHtml());
});

app.get("/api/setup/status", setupGate, (_req, res) => {
	res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
	res.json({
		ok: true,
		token: AUTH_TOKEN,
		tokenSet: AUTH_TOKEN.length > 0,
		tokenWarning: AUTH_TOKEN ? tokenWarning(AUTH_TOKEN) : "",
		host: HOST,
		port: PORT,
		allowHosts: ALLOW_HOSTS.join(","),
		allowOrigins: ALLOW_ORIGINS.join(","),
		configFile: `${DATA_DIR}/server-config.json`,
	});
});

app.post("/api/setup/save", setupGate, (req, res) => {
	const result = saveSetupConfig(
		req.body,
		loadServerFileConfig(DATA_DIR),
		{ token: AUTH_TOKEN, host: HOST, port: PORT, allowHosts: ALLOW_HOSTS, allowOrigins: ALLOW_ORIGINS },
		(next) => saveServerFileConfig(DATA_DIR, next),
	);
	if (!result.ok) {
		res.status(result.status).json({ ok: false, error: result.error });
		return;
	}
	AUTH_TOKEN = result.nextToken;
	if (AUTH_TOKEN) {
		res.setHeader("Set-Cookie", buildPiWebTokenCookie(encodeURIComponent(AUTH_TOKEN), 31536000, isTlsRequest(req)));
	} else if (result.tokenApplied) {
		res.setHeader("Set-Cookie", [buildPiWebTokenCookie("", 0, false), buildPiWebTokenCookie("", 0, true)]);
	}
	res.json({
		ok: true,
		tokenApplied: result.tokenApplied,
		restartRequired: result.restartRequired,
		saved: result.saved,
	});
});

function requestTokens(req: { headers: IncomingMessage["headers"]; url?: string }): string[] {
	const out: string[] = [];
	const auth = req.headers.authorization;
	if (typeof auth === "string" && auth.startsWith("Bearer ")) out.push(auth.slice(7).trim());
	const header = req.headers["x-pi-token"];
	if (typeof header === "string") out.push(header.trim());
	try {
		const q = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
		if (q) out.push(q.trim());
	} catch {}
	const cookie = req.headers.cookie;
	if (typeof cookie === "string") {
		for (const part of cookie.split(";")) {
			const [k, ...rest] = part.trim().split("=");
			if (k !== "pi_web_token") continue;
			const raw = rest.join("=").trim();
			if (!raw) continue;
			out.push(raw);
			const decoded = decodeCookieToken(raw);
			if (decoded !== raw) out.push(decoded);
		}
	}
	return out.filter(Boolean);
}

function sameSecret(candidate: string): boolean {
	const a = createHash("sha256").update(candidate).digest();
	const b = createHash("sha256").update(AUTH_TOKEN).digest();
	return timingSafeEqual(a, b);
}

function tokenOk(req: Parameters<typeof requestTokens>[0]): boolean {
	return requestTokens(req).some(sameSecret);
}

function cookieToken(req: { headers: IncomingMessage["headers"] }): string {
	const cookie = req.headers.cookie;
	if (typeof cookie !== "string") return "";
	for (const part of cookie.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === "pi_web_token") return decodeCookieToken(rest.join("=").trim());
	}
	return "";
}

function splatParam(req: { params: unknown }): string {
	const v = (req.params as unknown as Record<string, string | string[] | undefined>).splat;
	if (Array.isArray(v)) return v.join("/");
	return String(v ?? "");
}

function livePreviewCapability(req: { method: string; path: string }): ProxyHit | undefined {
	if (req.method !== "GET" && req.method !== "HEAD") return undefined;
	const candidate = /^\/__live-preview\/[a-f0-9]{64}(?=\/|$)/.exec(req.path)?.[0];
	if (!candidate) return undefined;
	const hit = pluginMgr.findProxy(req.path);
	if (!hit || hit.pluginId !== "live-preview" || !/^\/__live-preview\/[a-f0-9]{64}$/.test(hit.prefix)) return undefined;
	if (
		!timingSafeEqual(createHash("sha256").update(candidate).digest(), createHash("sha256").update(hit.prefix).digest())
	)
		return undefined;
	return hit;
}

app.use((req, res, next) => {
	if (!isSuperagentWebhook(req)) return next();
	const provider = req.path.slice(req.path.lastIndexOf("/") + 1);
	pluginMgr.handleHttp("superagent", "POST", `/webhooks/${provider}`, req, res);
});

app.use((req, res, next) => {
	const preview = livePreviewCapability(req);
	if (preview) {
		proxyHttp(preview, req, res);
		return;
	}
	if (!AUTH_TOKEN) {
		next();
		return;
	}
	const ok = tokenOk(req);
	const cookie = cookieToken(req);
	const secure = isTlsRequest(req);
	if (ok) {
		if (!sameSecret(cookie)) {
			res.setHeader("Set-Cookie", buildPiWebTokenCookie(encodeURIComponent(AUTH_TOKEN), 31536000, secure));
		}
	} else if (cookie) {
		res.setHeader("Set-Cookie", [buildPiWebTokenCookie("", 0, false), buildPiWebTokenCookie("", 0, true)]);
	}
	if (req.path === "/api/health" || ok) {
		next();
		return;
	}
	const isHtml = Boolean(req.headers.accept?.includes("text/html"));
	if (isHtml) {
		const isLoopback = isLoopbackAddress(req.socket?.remoteAddress);
		res.status(401);
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
		res.send(renderUnauthorizedHtml({ isLoopback, isStaleCookie: Boolean(cookie), port: PORT }));
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

mobilePush.registerRoutes(app);
registerTtsRoutes(app);

const sharedStateStore = new ClientStateStore(join(DATA_DIR, "client-state.json"));
registerPromptTemplateRoutes(app, DATA_DIR);
registerSystemScreenshotRoutes(app);
const quickAskSandboxes = new SandboxManager(DATA_DIR);
registerQuickAskRoutes(app, {
	getSettings: () => sharedStateStore.getSettingsSnapshot(""),
	getRuntime: (signal) => createQuickAskRuntime(getAgentDir(), signal),
	context: {
		getWorkspace: (clientId) => {
			const session = clientId ? service.get(clientId) : undefined;
			if (clientId && !session) throw new QuickAskError(404, "Reference client was not found");
			const cwd = session?.cwd ?? CWD;
			const sandbox = quickAskSandboxes.getByCwd(cwd);
			return { cwd, ...(sandbox ? { sandboxRoot: sandbox.path } : {}) };
		},
		readConversation: async (source, clientId, signal) => {
			const owner = source.owner ?? clientId;
			if (!owner) return readQuickAskHistoryConversation(source, signal);
			const session = service.get(owner);
			if (!session?.readQuickAskConversation) throw new QuickAskError(404, "Reference owner was not found");
			return session.readQuickAskConversation(source, signal);
		},
	},
});

const EXPLICIT_ENGINE_ARG = cliFlag("--engine") ?? process.env.PI_WEB_ENGINE;
let currentDefaultEngine: EngineId =
	EXPLICIT_ENGINE_ARG === "codex"
		? "codex"
		: EXPLICIT_ENGINE_ARG === "durable"
			? "durable"
			: EXPLICIT_ENGINE_ARG === "claude"
				? "claude"
				: EXPLICIT_ENGINE_ARG === "dsh"
					? "dsh"
					: EXPLICIT_ENGINE_ARG === "pi"
						? "pi"
						: (sharedStateStore.getDefaultEngine() ?? "pi");
const clientEngines = new Map<string, EngineId>();

function resolveClientEngine(clientId: string): EngineId {
	const mem = clientEngines.get(clientId);
	if (mem) return mem;
	if (!EXPLICIT_ENGINE_ARG) {
		const saved = sharedStateStore.getClientEngine(clientId);
		if (saved) {
			clientEngines.set(clientId, saved);
			return saved;
		}
	}
	clientEngines.set(clientId, currentDefaultEngine);
	return currentDefaultEngine;
}

function setClientEngine(clientId: string, engine: EngineId): void {
	clientEngines.set(clientId, engine);
	currentDefaultEngine = engine;
	sharedStateStore.saveClientEngine(clientId, engine);
	sharedStateStore.saveDefaultEngine(engine);
}

const MANAGED = isManaged();
const ORIGIN = launchOrigin();
const SERVICE_INFO = toServiceInfo(ORIGIN);
const TABS = parseTabs();

app.get(
	"/api/native-cli/discovery",
	nativeCliDiscoveryHandler(() => isTabAllowed("terminal", TABS)),
);

registerFileTransferRoutes(
	app,
	(clientId) => service.get(clientId)?.cwd,
	undefined,
	(clientId) => (sharedStateStore.getSettingsSnapshot(clientId).folderUploadMaxMb ?? 32) * 1024 * 1024,
);

app.get("/api/health", (_req, res) => {
	res.json({
		ok: true,
		piVersion: VERSION,
		piSdkCopies: sdkCopies(),
		engine: currentDefaultEngine,
		instanceName: process.env.PI_WEB_INSTANCE_NAME?.trim() || undefined,
		faviconColor: process.env.PI_WEB_FAVICON_COLOR?.trim() || undefined,
	});
});

app.use(["/api/file", "/api/attachment/:hash", "/api/preview"], (req, res, next) => {
	res.setHeader("Content-Security-Policy", req.query.allowJs === "1" ? "sandbox allow-scripts" : "sandbox");
	res.setHeader("X-Content-Type-Options", "nosniff");
	next();
});

app.get("/api/attachment/:hash", async (req, res) => {
	try {
		const hash = String(req.params.hash ?? "").trim();
		const hit = await findAttachment(hash);
		if (!hit) {
			res.status(404).end("attachment not found");
			return;
		}
		res.setHeader("Content-Type", hit.mimeType);
		res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
		res.sendFile(hit.filePath, { dotfiles: "allow" }, (err) => {
			if (!err) return;
			if (!res.headersSent) res.status((err as { statusCode?: number }).statusCode ?? 500).end();
			else res.destroy(err);
		});
	} catch (err) {
		res.status(500).end((err as Error).message);
	}
});

app.get("/api/file", async (req, res) => {
	try {
		const raw = typeof req.query.path === "string" ? req.query.path : "";
		const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const root = cs?.cwd ?? CWD;
		if (isRemoteWorkspaceUri(root)) {
			await serveRemoteWorkspaceFile(
				req,
				res,
				root,
				raw,
				{ isDownload: req.query.download === "1", allowAllTypes: true },
				remoteSshService,
			);
			return;
		}
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
		const isDownload = req.query.download === "1";
		const st = await stat(abs);
		if (!st.isFile()) {
			res.status(400).end("not a file");
			return;
		}
		if (isDownload) {
			res.download(abs, name, { dotfiles: "allow" });
		} else {
			res.sendFile(abs, { dotfiles: "allow" });
		}
	} catch {
		res.status(404).end("not found");
	}
});

app.get("/api/office-media", async (req, res) => {
	try {
		const rawPath = typeof req.query.path === "string" ? req.query.path : "";
		const media = typeof req.query.media === "string" ? req.query.media : "";
		if (!rawPath || !media) {
			res.status(400).end("missing path or media");
			return;
		}
		if (!/^image\d+\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(media)) {
			res.status(400).end("invalid media name");
			return;
		}
		const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const root = cs?.cwd ?? CWD;
		const absWire = isAbsoluteWirePath(rawPath);
		let abs: string;
		if (absWire) {
			abs = wireToAbs(rawPath);
		} else {
			const wp = workspacePath(root, rawPath);
			if (!wp) {
				res.status(400).end("path outside workspace");
				return;
			}
			abs = wp.abs;
		}
		if (!isOfficeFile(abs)) {
			res.status(400).end("not an office file");
			return;
		}
		const st = await stat(abs);
		if (!st.isFile() || st.size > OFFICE_MAX_FILE_BYTES) {
			res.status(400).end("file not found or too large");
			return;
		}
		const data = await readFile(abs);
		const zipFiles = unzipFiles(data, [`ppt/media/${media}`]);
		const imgBuf = zipFiles.get(`ppt/media/${media}`);
		if (!imgBuf) {
			res.status(404).end("media not found");
			return;
		}
		const ext = media.split(".").pop()?.toLowerCase() ?? "";
		const mimeMap: Record<string, string> = {
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			webp: "image/webp",
			gif: "image/gif",
			svg: "image/svg+xml",
			bmp: "image/bmp",
		};
		res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
		res.setHeader("Cache-Control", "public, max-age=86400, immutable");
		if (ext === "svg") {
			res.setHeader("Content-Security-Policy", "sandbox");
			res.setHeader("X-Content-Type-Options", "nosniff");
		}
		res.send(imgBuf);
	} catch {
		res.status(404).end("not found");
	}
});

app.get("/api/preview/*splat", async (req, res) => {
	try {
		const captured = splatParam(req);
		const ABS_MARKER = "__abs__/";
		const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
		const cs = cid ? service.get(cid) : undefined;
		const root = cs?.cwd ?? CWD;
		if (isRemoteWorkspaceUri(root)) {
			if (captured === "__abs__") {
				res.status(400).end("bad absolute preview path");
				return;
			}
			const remoteTarget = captured.startsWith(ABS_MARKER) ? captured.slice(ABS_MARKER.length) : captured;
			if (captured.startsWith(ABS_MARKER) && !remoteTarget.startsWith("/")) {
				res.status(400).end("bad absolute preview path");
				return;
			}
			await serveRemoteWorkspaceFile(
				req,
				res,
				root,
				remoteTarget,
				{ isDownload: false, allowAllTypes: true },
				remoteSshService,
			);
			return;
		}
		let abs: string;
		if (captured === "__abs__" || captured.startsWith(ABS_MARKER)) {
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
		const st = await stat(abs);
		if (!st.isFile()) {
			res.status(400).end("not a file");
			return;
		}
		res.sendFile(abs, { dotfiles: "allow" });
	} catch {
		res.status(404).end("not found");
	}
});

function resolvePkgRoot(): string {
	return getPkgRoot();
}
const pkgRoot = resolvePkgRoot();
const BUILTIN_THEMES_DIR = join(pkgRoot, "themes");
const USER_THEMES_DIR = join(DATA_DIR, "themes");

app.get("/api/themes", (_req, res) => {
	res.json({ themes: listThemes(BUILTIN_THEMES_DIR, USER_THEMES_DIR) });
});
const DEFAULT_LOCALE = resolveSystemDefaultLocale();

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
app.get("/themes/bases/:name.css", (req, res) => {
	if (!/^[A-Za-z0-9_-]+$/.test(req.params.name)) {
		res.status(404).end("base not found");
		return;
	}
	const baseFile = join(BUILTIN_THEMES_DIR, "bases", `${req.params.name}.css`);
	if (!existsSync(baseFile) || !statSync(baseFile).isFile()) {
		res.status(404).end("base not found");
		return;
	}
	res.setHeader("Content-Type", "text/css; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	res.sendFile(baseFile);
});

app.get("/themes/:id.css", (req, res) => {
	const file = resolveThemeFile(BUILTIN_THEMES_DIR, USER_THEMES_DIR, req.params.id);
	if (!file) {
		res.status(404).end("theme not found");
		return;
	}
	res.setHeader("Content-Type", "text/css; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	const css = readThemeCss(file);
	res.send(css);
});

const PLUGINS_DIR = join(DATA_DIR, "plugins");
app.all(["/plugins-api/:id/*splat", "/plugins-api/:id"], (req, res) => {
	const rest = splatParam(req);
	const cid = typeof req.query.clientId === "string" ? req.query.clientId : "";
	const cs = cid ? service.get(cid) : undefined;
	if (cid && !cs) {
		res.status(400).json({ error: "Unknown client workspace" });
		return;
	}
	pluginMgr.handleHttp(
		String(req.params.id ?? ""),
		req.method,
		rest,
		req,
		res,
		cs ? { cwd: cs.cwd, roots: cs.workspaceRoots } : undefined,
	);
});

app.use((req, res, next) => {
	const hit = pluginMgr.findProxy(req.path);
	if (!hit) {
		next();
		return;
	}
	proxyHttp(hit, req, res);
});
app.get("/plugins/:id/client/*splat", (req, res) => {
	const rest = splatParam(req);
	if (pluginMgr.isDomBundleBlocked(String(req.params.id ?? ""))) {
		res.status(403).end("dom access not granted (settings > plugins > grant)");
		return;
	}
	const abs = resolvePluginClientFile(PLUGINS_DIR, req.params.id, rest);
	if (!abs) {
		res.status(404).end("plugin not found");
		return;
	}
	if (/\.(mjs|js)$/.test(abs)) {
		res.setHeader("Content-Type", "text/javascript; charset=utf-8");
	}
	res.setHeader("Cache-Control", "no-cache");
	res.sendFile(abs, { dotfiles: "allow" }, (err) => {
		if (err && !res.headersSent)
			res
				.status((err as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 404 ? 404 : 500)
				.end("not found");
	});
});
const PLUGIN_SHARED_DIR = join(pkgRoot, "plugin-sdk");
app.get("/plugins-shared/*splat", (req, res) => {
	const rest = splatParam(req);
	const abs = resolvePluginSharedFile(PLUGIN_SHARED_DIR, rest);
	if (!abs || !existsSync(abs)) {
		res.status(404).end("shared module not found");
		return;
	}
	if (/\.(mjs|js)$/.test(abs)) {
		res.setHeader("Content-Type", "text/javascript; charset=utf-8");
	}
	res.setHeader("Cache-Control", "no-cache");
	res.sendFile(abs, { dotfiles: "allow" }, (err) => {
		if (err && !res.headersSent)
			res
				.status((err as NodeJS.ErrnoException & { statusCode?: number }).statusCode === 404 ? 404 : 500)
				.end("not found");
	});
});
const RESTART_CHILD_ENV = "PI_WEB_RESTART_CHILD";
const deviceDesktop = createDeviceDesktop({ app, dataDir: DATA_DIR, authorize: (req) => !AUTH_TOKEN || tokenOk(req) });
const deviceBots = await createLocalBotRegistry(DATA_DIR);
const deviceCenter = await installLocalDeviceCenter({
	app,
	dataDir: DATA_DIR,
	bots: deviceBots,
	allowHosts: ALLOW_HOSTS,
	lanAccess: deviceLanAccess,
	botCatalog: {
		defaultCwd: CWD,
		dataDir: DATA_DIR,
		models: async (signal) => {
			signal.throwIfAborted();
			const models = await (ensureEngine("pi") as AgentService).listGroupRouterModels(signal);
			signal.throwIfAborted();
			return models;
		},
		projects: () => sharedStateStore.getRecentProjects(""),
		defaultModel: () => sharedStateStore.getDefaultModel("pi"),
		defaultTools: () => {
			const disabled = new Set(effectiveDisabledAgentTools(sharedStateStore.getSettingsSnapshot("")));
			return ALL_AGENT_TOOL_ENTRIES.filter(
				(tool) => !disabled.has(tool.name) && isToolSupportedOnPlatform(tool.name),
			).map((tool) => tool.name);
		},
		peekMcpBridge: (cwd) => mcpProjects.peekBridge(cwd),
	},
	async connect(config, syncBots) {
		const localOrigin = `http://127.0.0.1:${PORT}`;
		const runtime = createDeviceRuntime({
			config,
			localOrigin,
			localAuthToken: AUTH_TOKEN,
			dataDir: DATA_DIR,
			bots: deviceBots,
		});
		setDeviceCollabService(runtime.collabService);
		const connector = createDeviceConnector({
			hubUrl: config.hubUrl,
			deviceId: config.deviceId,
			credential: config.credential,
			localOrigin,
			localAuthToken: AUTH_TOKEN,
			recovery: runtime.recovery,
			reportOutbox: runtime.reportOutbox,
			onTask: runtime.onTask,
			onSteer: (taskId, text) => runtime.steerTask(taskId, text),
			onInteractionAnswer: (answer) => runtime.answerTaskInteraction(answer.taskId, answer.attemptId, answer),
			onConnect: syncBots,
			onCommand: async (action, payload, signal) => {
				if (action === "group_router_models") {
					const models = await (ensureEngine("pi") as AgentService).listGroupRouterModels(signal);
					return {
						models: models.map((model) => ({
							...model,
							id: model.id.startsWith(`${model.provider}/`) ? model.id.slice(model.provider.length + 1) : model.id,
						})),
					};
				}
				return runtime.onCommand(action, payload, signal);
			},
			onDisconnect: () => {
				void runtime
					.onDisconnect()
					.catch(() => console.warn("[device-center] Task stop was not confirmed; project remains locked"));
			},
		});
		const routerAbort = new AbortController();
		const routerConfig = { ...config };
		const routerRuntime = createGroupRouterRuntime({
			getModelRuntime: (signal) => (ensureEngine("pi") as AgentService).getGroupRouterModelRuntime(signal),
		});
		const routerWorker = createGroupRouterWorker({
			request: (path, method, body) =>
				requestDeviceHub(routerConfig, path, method, body, { signal: routerAbort.signal }),
			run: (job, context, signal) => routerRuntime.runGroupRouter({ job, context, signal }),
		});
		routerWorker.start();
		return {
			isConnected: connector.isOnline,
			runtime,
			async close() {
				routerWorker.close();
				routerAbort.abort();
				setDeviceCollabService(undefined);
				connector.close();
				await runtime.close();
			},
		};
	},
});
const webDist = join(pkgRoot, "web", "dist");
function webDistPath(): string {
	return webDist;
}
if (existsSync(webDist)) {
	app.use(compression());
	app.use(
		express.static(webDist, {
			setHeaders(res, filePath) {
				if (filePath.includes(`${sep}assets${sep}`)) {
					res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
				}
			},
		}),
	);
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
		const devCache = process.env.PI_WEB_DEV_CACHE;
		const fromSource = existsSync(join(pkgRoot, ".git"));
		const envDefault = devCache !== undefined ? devCache !== "0" : fromSource;
		const stored = readDevNoCacheSetting();
		const noStore = stored ?? envDefault;
		res.setHeader("Cache-Control", noStore ? "no-store" : "public, max-age=0");
		res.sendFile(join(webDist, "index.html"), { dotfiles: "allow" }, (err) => {
			if (err && !res.headersSent) {
				res.status(503).send("正在更新 pi-web-ui，请稍后刷新…");
			}
		});
	});
} else if (process.env[RESTART_CHILD_ENV]) {
	// complete (Windows: locked files / rollback can leave the global package
	console.error(
		"✖ 更新后的安装不完整（缺少 web/dist/index.html）。\n" + "  请手动执行 npm i -g pi-web-ui@latest 修复后重新启动。",
	);
	process.exit(1);
}

const httpServer = createServer(app);
const wss = new WebSocketServer({
	noServer: true,
	maxPayload: WS_MAX_PAYLOAD_BYTES,
	perMessageDeflate: { threshold: 16 * 1024 },
});

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
	if (!httpHostAllowed(hostHeader, { allowHosts: ALLOW_HOSTS, hasAuthToken: Boolean(AUTH_TOKEN) })) {
		return false;
	}
	const host = parseAuthority(hostHeader.toLowerCase());
	if (ALLOW_HOSTS.length > 0 && !ALLOW_HOSTS.includes(host.hostname)) {
		return false;
	}
	const origin = req.headers.origin;
	if (!origin) return true;
	const o = origin.toLowerCase();
	if (ALLOW_ORIGINS.includes(o)) return true;
	if (mobileOriginAuthorized(req, mobileOriginOptions)) return true;
	if (o === "null") return false;
	const ori = parseAuthority(o.replace(/^[a-z]+:\/\//, ""));
	if (ori.hostname === host.hostname && ori.port === host.port) return true;
	return false;
}

httpServer.on("upgrade", (req, socket, head) => {
	if (deviceLanAccess.handleUpgrade(req, socket, head)) return;
	if (deviceDesktop.handleUpgrade(req, socket, head)) return;
	let pathname = "/";
	try {
		pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	} catch {}
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
			} catch {}
			try {
				target.destroy();
			} catch {}
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

const HEARTBEAT_INTERVAL_MS = 2_000;
const BROADCAST_BACKPRESSURE_MAX_BYTES = 262_144;

interface TrackedWebSocket extends WebSocket {
	isAlive?: boolean;
	missedPings?: number;
	pingSentAt?: number;
	latencyMs?: number;
}

const sampleHostMetrics = createHostMetricsSampler();

const heartbeatTimer = setInterval(() => {
	let message: ServerMessage = { type: "heartbeat" };
	try {
		message = { type: "heartbeat", hostMetrics: sampleHostMetrics() };
	} catch {}

	if (wss.clients.size > 0) {
		const payload = JSON.stringify(message);
		for (const ws of wss.clients) {
			if (ws.readyState !== WebSocket.OPEN) continue;
			const tracked = ws as TrackedWebSocket;

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
			const prevLatencyMs = tracked.latencyMs;
			tracked.isAlive = false;
			tracked.pingSentAt = performance.now();
			try {
				ws.ping();
			} catch {
				try {
					ws.terminate?.();
				} catch {}
				continue;
			}

			if (ws.bufferedAmount <= BROADCAST_BACKPRESSURE_MAX_BYTES) {
				try {
					if (typeof prevLatencyMs === "number" && Number.isFinite(prevLatencyMs)) {
						ws.send(JSON.stringify({ ...message, latencyMs: prevLatencyMs }));
					} else {
						ws.send(payload);
					}
				} catch {}
			}
		}
	}
}, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref?.();

import { DshAgentService } from "./dsh/dsh-agent-service.js";
import { UniversalAgentService, ClaudeCodeDriver, probeClaudeCode, CodexDriver } from "./universal/index.js";
import { DurableAgentService } from "./durable/index.js";
import {
	probeAllEngines,
	probeEngine,
	getCachedEngineStatuses,
	updateEngineBackground,
	isEngineUpdating,
	uninstallEngineBackground,
	isEngineUninstalling,
	ENGINE_PACKAGES,
} from "./engine-probe.js";
import type { EngineId, EngineStatus } from "./protocol.js";

export interface TerminalManagerLike {
	attach?(id: string, cols: number, rows: number): boolean;
	create(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
		title?: string,
		opts?: { forceBash?: boolean; locale?: string; agentBash?: boolean; nativeCli?: NativeCliConfig },
	): void;
	createNativeCli?(...args: Parameters<TerminalManagerLike["create"]>): Promise<TerminalInfo | null>;
	getNativeCliTerminal?(id: string): TerminalInfo | undefined;
	captureNativeCliPasteTarget?(id: string):
		| {
				cwd: string;
				signal?: AbortSignal;
				paste: (data: string) => boolean;
				retainCleanup?: (cleanup: () => Promise<void>, paths?: readonly string[]) => boolean;
		  }
		| undefined;
	pasteNativeCli?(id: string, data: string): boolean;
	input(id: string, data: string): void;
	resize(id: string, cols: number, rows: number): void;
	kill(id: string): void;
	rename(id: string, title: string): void;
	runCommand(id: string, command: CommandDef, cols: number, rows: number, fallbackCwd: string): void;
}

export interface DispatchSession {
	cwd: string;
	readonly workspaceRoots?: readonly string[];
	prompt(text: string, attachments?: PromptAttachment[], queue?: boolean): Promise<void>;
	removeQueued(kind: "steer" | "followUp", text: string, index?: number, id?: string): void;
	saveDraft?(sessionId: string, text: string, ts: number): void;
	abort(): Promise<void>;
	abortBash(conversationId?: string): Promise<void>;
	retryLast(): Promise<void>;
	killBackgroundServer(port?: number, taskId?: string): Promise<boolean>;
	killAllBackgroundServers(): Promise<string[]>;
	listBgServers(): Promise<void>;
	setBackgroundKeep(port: number, keep: boolean): boolean;
	cleanBackgroundLeftovers(minutesOverride?: number): Promise<number[]>;
	newChat(
		preset?: string,
		ephemeral?: boolean,
		onReady?: (id: string) => void,
		independent?: boolean,
	): Promise<boolean | void>;
	newCliChat?(config: NativeCliConfig, cwd?: string, onReady?: (id: string) => void): Promise<boolean>;
	controlNativeCli?(conversationId: string, terminalId: string, action: "detach" | "reconnect" | "stop"): Promise<void>;
	getNativeCliConversation?(conversationId?: string): import("./protocol.js").NativeCliConversation | undefined;
	deleteMessage?(messageId: string, conversationId?: string): Promise<void>;
	editMessage(messageId: string, text: string, attachments?: PromptAttachment[]): Promise<void>;
	forkSession?(messageId: string, position?: "before" | "at", targetConvId?: string): Promise<void>;
	flushSnapshot(forceFull?: boolean): void;
	activeConversationId?(): string;
	getMessagesOfConversation?(convId: string): import("./protocol.js").UiMessage[] | undefined;
	pushSlashCommands(): Promise<void>;
	getToolInfo?(name: string): void | Promise<void>;
	getToolPrompt?(name: string): void | Promise<void>;
	getCompactedMessages?(compactionMessageId: string, targetConvId?: string): void | Promise<void>;
	refreshSessions(): Promise<void>;
	pushSessionsForCwd?(targetCwd: string): Promise<void>;
	setSessionListLimit?(cwd: string, limit?: number): number;
	pushProjects(): Promise<void>;
	removeProject(path: string): Promise<void>;
	createSandbox?(opts: { name?: string; sourcePath?: string; ephemeral?: boolean }): Promise<void>;
	resetSandbox?(path?: string): Promise<void>;
	persistSandbox?(path?: string): Promise<void>;
	promoteSandbox?(targetPath: string, path?: string, switchToTarget?: boolean): Promise<void>;
	diffSandbox?(path?: string, requestId?: string): Promise<void>;
	applySandboxToSource?(path: string | undefined, expectedRevision: string): Promise<void>;
	destroySandbox?(path: string): Promise<void>;
	refreshWorktreeInfo?(): Promise<void>;
	switchWorktree?(path: string): Promise<void>;
	removeWorktree?(path: string, force?: boolean): Promise<void>;
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
	switchSession(path: string, sessionId?: string, independent?: boolean): Promise<void>;
	switchConversation(id: string): Promise<void>;
	listFiles(path?: string): Promise<void>;
	searchFiles(query: string, reqId: number): Promise<void>;
	searchSessions(query: string, reqId: number): Promise<void>;
	scmQuery(
		kind: "status" | "history" | "filediff" | "commit",
		reqId: number,
		opts?: { path?: string; hash?: string },
	): Promise<void>;
	scmGenCommitMessage?(reqId: number): Promise<void>;
	readFile(path: string): Promise<void>;
	writeFile(path: string, text: string): Promise<void>;
	uploadFile(dirPath: string, name: string, data: string, uploadId?: string): Promise<void>;
	createEntry(dir: string, name: string, kind: "file" | "dir"): Promise<void>;
	renameEntry(path: string, newName: string): Promise<void>;
	deleteEntry(path: string): Promise<void>;
	copyEntry(src: string, destDir: string, move?: boolean): Promise<void>;
	revealEntry(path: string): Promise<void>;
	openDefaultEntry(path: string): Promise<void>;
	listModels(): Promise<void>;
	setModel(modelId: string): Promise<void>;
	setDefaultModel?(modelId: string): Promise<void>;
	clearDefaultModel?(): void;
	setThinking(level: string): void;
	setCwd(path: string): Promise<void>;
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
	getUserTerminalManager?(): TerminalManagerLike | undefined;
	findTerminalManager?(
		terminalId: string,
		conversationId?: string,
		ownerKind?: "client" | "conversation",
	): TerminalManagerLike | undefined;
	getTerminalCwd(conversationId?: string): string;
	listCommands(): Promise<void>;
	saveCommands(commands: CommandDef[]): Promise<void>;
	setGoal(
		goal: string,
		opts?: {
			reviewModel?: string;
			maxRounds?: number;
			locked?: boolean;
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
	pageCall?(
		req: import("./browser-page-tool.js").PageCallRequest,
		signal: { aborted?: boolean },
		conversationId?: string,
	): Promise<import("./browser-page-tool.js").PageCallResult>;
	readQuickAskConversation?(
		source: import("./quick-ask-context.js").QuickAskConversationSource,
		signal: AbortSignal,
	): Promise<import("./quick-ask-context.js").QuickAskConversationSnapshot | undefined>;
	pushSettings(): void;
	refreshSettings(): void;
	setSettings(partial: {
		promptMode?: "append" | "replace";
		customSystemPrompt?: string;
		promptTemplate?: string;
		promptOverrides?: Record<string, string>;
		disabledSkills?: string[];
		disabledExtensions?: string[];
		disabledPlugins?: string[];
		uiLayout?: UiLayoutPrefs;
		terminalToolsEnabled?: boolean;
		terminalBash?: boolean;
		terminalBashIdleMs?: number;
		terminalBashMaxForegroundMs?: number;
		editSoftEnabled?: boolean;
		thinkingWrap?: boolean;
		toolsWrap?: boolean;
		toolImagesEnabled?: boolean;
		keepRecentMessages?: number;
		showForkedParentSessions?: boolean;
		visionBridgeEnabled?: boolean;
		visionBridgeModel?: string | null;
		visionBridgePromptMode?: "append" | "replace";
		visionBridgePrompt?: string;
		scmCommitMsgPromptMode?: "append" | "replace";
		scmCommitMsgPrompt?: string;
		quickAskEnabled?: boolean;
		quickAskModel?: string | null;
		quickAskThinking?: ThinkingLevel;
		quickAskSystemPrompt?: string;
		quickAskExplainPrompt?: string;
		quickAskTranslateEnabled?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateEnabled"];
		quickAskTranslateTarget?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateTarget"];
		quickAskTranslateStyle?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslateStyle"];
		quickAskTranslatePrompt?: import("./quick-ask-settings.js").QuickAskSettings["quickAskTranslatePrompt"];
		quickAskShowOriginal?: import("./quick-ask-settings.js").QuickAskSettings["quickAskShowOriginal"];
		quickAskReferenceMenus?: import("./quick-ask-settings.js").QuickAskSettings["quickAskReferenceMenus"];
		quickAskConversationScope?: import("./quick-ask-settings.js").QuickAskSettings["quickAskConversationScope"];
		quickAskFolderScope?: import("./quick-ask-settings.js").QuickAskSettings["quickAskFolderScope"];
		reviewPrompt?: string;
		reviewDisabledSkills?: string[];
	}): Promise<void>;
	reloadExtensions(): Promise<void>;
	listDshPatches?(): Promise<void>;
	rescanDshPatches?(): Promise<void>;
	installDshPatch?(spec: string, id?: string): Promise<void>;
	toggleDshPatch?(name: string, enabled: boolean): Promise<void>;
	deleteDshPatch?(name: string): Promise<void>;
	fetchDshMarket?(force?: boolean): Promise<void>;
	refreshAgentPresets?(): Promise<void>;
	selectAgentPreset?(preset: string): Promise<void>;
	setDefaultAgentPreset?(preset: string): Promise<void>;
	setPermissionPreset?(preset: string): Promise<void>;
	setDefaultPermissionPreset?(preset: string): Promise<void>;
	answerQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): Promise<void>;
	resolveQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): boolean;
	resolvePageCall?(id: string, ok: boolean, result?: unknown, error?: string): void;
	forkSession?(messageId: string, position?: "before" | "at", conversationId?: string): Promise<void>;
	rollbackSession?(messageId: string, conversationId?: string, restoreWorkspace?: boolean): Promise<void>;
	resolveToolApproval?(
		id: string,
		decision: "approve" | "deny" | "edit",
		editedParams?: unknown,
		reason?: string,
		scope?: "once" | "category" | "all",
	): boolean;
	setApprovalPolicy?(partial: { conversationId?: string; allowAll?: boolean; categories?: string[] }): void;
	updatePlan?(steps: import("./protocol.js").PlanStep[], activeStepId?: string | null, conversationId?: string): void;
	setPlanMode?(enabled: boolean, conversationId?: string): Promise<void>;
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
	handleMcpOAuth?(
		msg: Extract<
			ClientMessage,
			{ type: "mcp_oauth_start" | "mcp_oauth_finish" | "mcp_oauth_status" | "mcp_oauth_cancel" }
		>,
	): Promise<void>;
	installSkill?(name: string, scope: "global" | "project", content: string): Promise<void>;
	uninstallSkill?(name: string, scope: "global" | "project"): Promise<void>;
	fetchMcpMarket?(source?: string, query?: string, page?: number, refresh?: boolean): Promise<void>;
	fetchSkillMarket?(repo?: string, refresh?: boolean): Promise<void>;
	fetchSkillContent?(repo: string, skillId: string): Promise<void>;
	exportPreset(msg: Extract<ClientMessage, { type: "preset_export" }>): Promise<void>;
	importPreset(msg: Extract<ClientMessage, { type: "preset_import" }>): Promise<void>;
	importPresetFromUrl(msg: Extract<ClientMessage, { type: "preset_import_url" }>): Promise<void>;
	pushPresetCatalog(msg: Extract<ClientMessage, { type: "preset_catalog" }>): Promise<void>;
	sharePreset(msg: Extract<ClientMessage, { type: "preset_share" }>): Promise<void>;
	saveSubagentTemplate(template: UiSubagentTemplate): Promise<void>;
	saveApprovalRule?(rule: UiApprovalRule): Promise<void>;
	saveApprovalRules?(rules: UiApprovalRule[]): Promise<void>;
	deleteApprovalRule?(id: string): Promise<void>;
	resetBuiltinApprovalRule?(id: string): Promise<void>;
	getLang(): string;
	setLocale(locale: string): Promise<void>;
	deleteSubagentTemplate(name: string): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	activeConversations(): number;
	pendingMessages(): number;
}

export interface EngineService {
	attach(
		clientId: string,
		send: (msg: ServerMessage) => void,
		sendShared?: (msg: ServerMessage) => void,
	): Promise<DispatchSession>;
	detach(clientId: string, send: (msg: ServerMessage) => void): void;
	get(clientId: string): DispatchSession | undefined;
	disposeAll(): Promise<void>;
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
	onNotificationEvent?: (event: MobileNotificationEvent) => void | Promise<void>;
	refreshMcpProject?(cwd: string): void;
	mcpProjectCwds?(): string[];
	applyPluginCommandCatalog(): void;
	applyPluginMarkers?(): void;
	refreshBackgroundServers(): void;
	getCapabilities?(): AgentEngineCapabilities;
	setLocale(clientId: string, locale: string): Promise<void>;
	openSharedConversation?(
		viewerId: string,
		ownerId: string,
		convId: string,
		send: (msg: ServerMessage) => void,
		options?: { readOnly?: boolean },
	): boolean;
	closeSharedConversation?(viewerId: string): void;
	sharedConversationTarget?(
		viewerId: string,
	): { conversationId: string; owner: DispatchSession; ownerClientId: string } | undefined;
	dispatchSharedConversationMessage?(viewerId: string, msg: ClientMessage): boolean;
	dismissConversation?(
		clientId: string,
		msg: { id: string; withFinishedSubagents?: boolean; force?: boolean; owner?: string },
	): Promise<boolean>;
	resolveSharedQuestion?(
		viewerId: string,
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): boolean;
	resolveGlobalQuestion?(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
	): boolean;
	resolveSharedToolApproval?(
		viewerId: string,
		...args: Parameters<NonNullable<DispatchSession["resolveToolApproval"]>>
	): boolean;
	takeOverConversation?(targetId: string, ownerId: string, convId: string): Promise<void>;
	peekElsewhereQuestion?(targetId: string, ownerId: string, convId: string): Promise<void>;
	navigateQuestion?(targetId: string, id: string): Promise<void>;
	answerElsewhereQuestion?(
		targetId: string,
		ownerId: string,
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
		cancelReason?: string,
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
	onRunEvent?: ((ev: PluginRunEvent) => void) | undefined;
	onConversationChanged?: (() => void) | undefined;
	readConversationForPlugins?: ((options?: PluginConversationQuery) => PluginConversationSnapshot | null) | undefined;
	onClientModelChanged?: ((snap: PluginConversationSnapshot) => void) | undefined;
	chatFromPlugin?:
		((pluginId: string, req: PluginChatRequest) => Promise<{ conversationId: string; clientId: string }>) | undefined;
	pluginToolsProvider?: ((cwd?: string) => unknown[]) | undefined;
	pluginCommandsProvider?: (() => unknown[]) | undefined;
	pluginBgTasksProvider?: (() => BgServer[]) | undefined;
	pluginStopBgTask?: ((taskId: string) => boolean) | undefined;
	onClientCwdChanged?: ((cwd: string, roots: string[]) => void) | undefined;
}

let piServiceInstance: AgentService | null = null;
let dshServiceInstance: DshAgentService | null = null;
let claudeServiceInstance: UniversalAgentService | null = null;
let codexServiceInstance: UniversalAgentService | null = null;
let durableServiceInstance: DurableAgentService | null = null;
let wireEngineHooks: ((svc: EngineService) => void) | null = null;
let sharedSocketCount = 0;
let sharedQuiesced = false;

function activeEngines(): EngineService[] {
	const list: EngineService[] = [];
	if (piServiceInstance) list.push(piServiceInstance);
	if (dshServiceInstance) list.push(dshServiceInstance);
	if (claudeServiceInstance) list.push(claudeServiceInstance);
	if (codexServiceInstance) list.push(codexServiceInstance);
	if (durableServiceInstance) list.push(durableServiceInstance);
	return list;
}

function ensureEngine(engine: EngineId): EngineService {
	if (engine === "codex") {
		if (!codexServiceInstance) {
			codexServiceInstance = new UniversalAgentService({
				cwd: CWD,
				dataDir: DATA_DIR,
				agentDir: getAgentDir(),
				stateStore: sharedStateStore,
				engine: "codex",
				driverFactory: (cwd) => new CodexDriver(cwd),
			});
			for (let i = 0; i < sharedSocketCount; i++) codexServiceInstance.noteSocketOpen();
			if (sharedQuiesced) codexServiceInstance.quiesce();
			wireEngineHooks?.(codexServiceInstance);
		}
		return codexServiceInstance;
	}
	if (engine === "durable") {
		if (!durableServiceInstance) {
			durableServiceInstance = new DurableAgentService({
				cwd: CWD,
				dataDir: DATA_DIR,
				agentDir: getAgentDir(),
				stateStore: sharedStateStore,
			});
			for (let i = 0; i < sharedSocketCount; i++) durableServiceInstance.noteSocketOpen();
			if (sharedQuiesced) durableServiceInstance.quiesce();
			wireEngineHooks?.(durableServiceInstance);
		}
		return durableServiceInstance;
	}
	if (engine === "claude") {
		if (!claudeServiceInstance) {
			claudeServiceInstance = new UniversalAgentService({
				cwd: CWD,
				dataDir: DATA_DIR,
				agentDir: getAgentDir(),
				stateStore: sharedStateStore,
				driverFactory: (cwd) => new ClaudeCodeDriver(cwd, { agentDir: getAgentDir() }),
			});
			for (let i = 0; i < sharedSocketCount; i++) claudeServiceInstance.noteSocketOpen();
			if (sharedQuiesced) claudeServiceInstance.quiesce();
			wireEngineHooks?.(claudeServiceInstance);
		}
		return claudeServiceInstance;
	}
	if (engine === "dsh") {
		if (!dshServiceInstance) {
			dshServiceInstance = new DshAgentService(CWD, sharedStateStore, DATA_DIR, getAgentDir());
			for (let i = 0; i < sharedSocketCount; i++) dshServiceInstance.noteSocketOpen();
			if (sharedQuiesced) dshServiceInstance.quiesce();
			wireEngineHooks?.(dshServiceInstance);
		}
		return dshServiceInstance;
	}
	if (!piServiceInstance) {
		piServiceInstance = new AgentService(CWD, sharedStateStore);
		for (let i = 0; i < sharedSocketCount; i++) piServiceInstance.noteSocketOpen();
		if (sharedQuiesced) piServiceInstance.quiesce();
		wireEngineHooks?.(piServiceInstance);
	}
	return piServiceInstance;
}

ensureEngine(currentDefaultEngine);

const service: EngineService = {
	attach(clientId, send, sendShared) {
		return ensureEngine(resolveClientEngine(clientId)).attach(clientId, send, sendShared);
	},
	detach(clientId, send) {
		const eng = clientEngines.get(clientId);
		if (eng) {
			ensureEngine(eng).detach(clientId, send);
		} else {
			for (const s of activeEngines()) s.detach(clientId, send);
		}
	},
	get(clientId) {
		if (!clientId) return undefined;
		const eng = clientEngines.get(clientId);
		if (eng) return ensureEngine(eng).get(clientId);
		for (const s of activeEngines()) {
			const cs = s.get(clientId);
			if (cs) return cs;
		}
		return undefined;
	},
	async disposeAll() {
		await Promise.all(activeEngines().map((s) => s.disposeAll()));
	},
	recordInterruptedRuns() {
		for (const s of activeEngines()) s.recordInterruptedRuns();
	},
	noteSocketOpen() {
		sharedSocketCount++;
		for (const s of activeEngines()) s.noteSocketOpen();
	},
	noteSocketClose() {
		sharedSocketCount = Math.max(0, sharedSocketCount - 1);
		for (const s of activeEngines()) s.noteSocketClose();
	},
	isQuiesced() {
		return sharedQuiesced || activeEngines().some((s) => s.isQuiesced());
	},
	quiesce() {
		sharedQuiesced = true;
		for (const s of activeEngines()) s.quiesce();
	},
	unquiesce() {
		sharedQuiesced = false;
		for (const s of activeEngines()) s.unquiesce();
	},
	quiesceInfo() {
		for (const s of activeEngines()) {
			const info = s.quiesceInfo();
			if (info.quiesced) return info;
		}
		return { quiesced: false };
	},
	serviceStatus() {
		const primary = ensureEngine(currentDefaultEngine);
		const base = primary.serviceStatus();
		let active = 0;
		let pending = 0;
		for (const s of activeEngines()) {
			active += s.activeConversations();
			pending += s.pendingMessages();
		}
		return {
			...base,
			activeConversations: active,
			pendingMessages: pending,
		};
	},
	activeConversations() {
		let n = 0;
		for (const s of activeEngines()) n += s.activeConversations();
		return n;
	},
	pendingMessages() {
		let n = 0;
		for (const s of activeEngines()) n += s.pendingMessages();
		return n;
	},
	applyPluginAgentTools() {
		for (const s of activeEngines()) s.applyPluginAgentTools();
	},
	applyPluginCommandCatalog() {
		for (const s of activeEngines()) s.applyPluginCommandCatalog();
	},
	applyPluginMarkers() {
		for (const s of activeEngines()) s.applyPluginMarkers?.();
	},
	refreshBackgroundServers() {
		for (const s of activeEngines()) s.refreshBackgroundServers();
	},
	setLocale(clientId, locale) {
		return ensureEngine(resolveClientEngine(clientId)).setLocale(clientId, locale);
	},
	openSharedConversation(viewerId, ownerId, convId, send, options) {
		return (
			ensureEngine(resolveClientEngine(viewerId)).openSharedConversation?.(viewerId, ownerId, convId, send, options) ??
			false
		);
	},
	closeSharedConversation(viewerId) {
		ensureEngine(resolveClientEngine(viewerId)).closeSharedConversation?.(viewerId);
	},
	sharedConversationTarget(viewerId) {
		return ensureEngine(resolveClientEngine(viewerId)).sharedConversationTarget?.(viewerId);
	},
	dispatchSharedConversationMessage(viewerId, msg) {
		return ensureEngine(resolveClientEngine(viewerId)).dispatchSharedConversationMessage?.(viewerId, msg) ?? false;
	},
	resolveSharedQuestion(viewerId, id, answers, cancelled, cancelReason) {
		return (
			ensureEngine(resolveClientEngine(viewerId)).resolveSharedQuestion?.(
				viewerId,
				id,
				answers,
				cancelled,
				cancelReason,
			) ?? false
		);
	},
	resolveGlobalQuestion(id, answers, cancelled, cancelReason) {
		for (const s of activeEngines()) {
			if (s.resolveGlobalQuestion?.(id, answers, cancelled, cancelReason)) return true;
		}
		return false;
	},
	resolveSharedToolApproval(viewerId, ...args) {
		return ensureEngine(resolveClientEngine(viewerId)).resolveSharedToolApproval?.(viewerId, ...args) ?? false;
	},
	takeOverConversation(targetId, ownerId, convId) {
		const targetSvc = ensureEngine(resolveClientEngine(targetId));
		if (typeof targetSvc.takeOverConversation === "function") {
			return targetSvc.takeOverConversation(targetId, ownerId, convId);
		}
		return Promise.resolve();
	},
	peekElsewhereQuestion(targetId, ownerId, convId) {
		const targetSvc = ensureEngine(resolveClientEngine(targetId));
		if (typeof targetSvc.peekElsewhereQuestion === "function") {
			return targetSvc.peekElsewhereQuestion(targetId, ownerId, convId);
		}
		return Promise.resolve();
	},
	navigateQuestion(targetId, id) {
		const targetSvc = ensureEngine(resolveClientEngine(targetId));
		return targetSvc.navigateQuestion?.(targetId, id) ?? Promise.resolve();
	},
	answerElsewhereQuestion(targetId, ownerId, id, answers, cancelled, cancelReason) {
		const targetSvc = ensureEngine(resolveClientEngine(targetId));
		if (typeof targetSvc.answerElsewhereQuestion === "function") {
			return targetSvc.answerElsewhereQuestion(targetId, ownerId, id, answers, cancelled, cancelReason);
		}
		return Promise.resolve();
	},
	readConversationForPlugins(options) {
		if (options?.clientId) {
			const eng = resolveClientEngine(options.clientId);
			return ensureEngine(eng).readConversationForPlugins?.(options) ?? null;
		}
		return piServiceInstance?.readConversationForPlugins?.(options) ?? null;
	},
	chatFromPlugin(pluginId, req) {
		const piSvc = ensureEngine("pi") as AgentService;
		return piSvc.chatFromPlugin(pluginId, req);
	},
};

initAttachmentStore(DATA_DIR);
loadServerStrings(DATA_DIR);
const pluginMgr = new PluginManager(DATA_DIR, CWD, join(pkgRoot, "plugins", "catalog.json"));
const pluginInstaller = new PluginInstaller({ dataDir: DATA_DIR, pkgRoot, managed: MANAGED });
async function reloadPluginsAndPush(lang?: () => ServerLang): Promise<void> {
	await pluginMgr.reload(lang);
	await pluginMgr.pushToAll();
	await pluginMgr.pushCatalog();
}
interface PendingPathRequest {
	resolve: (ok: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
	recipients: Set<string>;
}
const pendingPathRequests = new Map<string, PendingPathRequest>();
function pushPluginGrants(): void {
	const grants = pluginMgr.grants.list();
	const payload = JSON.stringify({ type: "plugin_grants", grants });
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			try {
				client.send(payload);
			} catch {}
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
				} catch {}
			}
		}
	});

pluginMgr.onGrantsChanged = () => pushPluginGrants();
interface PendingPermissionRequest {
	resolve: (ans: { ok: boolean; remember: boolean }) => void;
	timer: ReturnType<typeof setTimeout>;
	recipients: Set<string>;
}
const pendingPermissionRequests = new Map<string, PendingPermissionRequest>();
function pushPluginPermissions(): void {
	const payload = JSON.stringify({ type: "plugin_permissions", grants: pluginMgr.permGrants.list() });
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			try {
				client.send(payload);
			} catch {}
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
					} catch {}
				}
			}
			resolve({ ok: false, remember: false });
		}, 120_000);
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
				} catch {}
			}
		}
	});
pluginMgr.onPermGrantsChanged = () => pushPluginPermissions();

interface PendingDomConsent {
	id: string;
	pluginId: string;
	recipients: Set<string>;
	timer: ReturnType<typeof setTimeout>;
}
const pendingDomConsents = new Map<string, PendingDomConsent>();
function findDomConsentById(id: string): PendingDomConsent | undefined {
	for (const p of pendingDomConsents.values()) if (p.id === id) return p;
	return undefined;
}

async function confirmPluginInstallHelper(items: Array<{ id: string; source: string }>): Promise<boolean> {
	return confirmPluginInstall(items, {
		permGrants: pluginMgr.permGrants,
		permissionRequester: pluginMgr.permissionRequester,
		onGrantsChanged: pushPluginPermissions,
	});
}

const remoteSshService = new RemoteSshService(DATA_DIR);
setGlobalRemoteSshService(remoteSshService);
pluginMgr.provideService("host", "remoteSsh", remoteSshService);

const canvasOrchestrator = new CanvasOrchestrator(CWD, DATA_DIR, (eng) => ensureEngine(eng));
setCanvasRuntime(canvasOrchestrator);
const broadcastCanvas: Parameters<CanvasOrchestrator["setBroadcaster"]>[0] = (msg) => {
	const payload = JSON.stringify(msg);
	for (const client of wss.clients) {
		if (client.readyState !== WebSocket.OPEN) continue;
		if (client.bufferedAmount > BROADCAST_BACKPRESSURE_MAX_BYTES) continue;
		try {
			client.send(payload);
		} catch {}
	}
};
setCanvasBroadcaster((msg) => broadcastCanvas(msg as never));
canvasOrchestrator.setBroadcaster((msg) => {
	const payload = JSON.stringify(msg);
	for (const client of wss.clients) {
		if (client.readyState !== WebSocket.OPEN) continue;
		if (client.bufferedAmount > BROADCAST_BACKPRESSURE_MAX_BYTES) continue;
		try {
			client.send(payload);
		} catch {}
	}
});

const scheduler = new SchedulerStore(DATA_DIR, {
	validateTask: (task) => validateScheduledCanvas(DATA_DIR, task),
	executor: async (task) => {
		if (task.target === "canvas") {
			return executeScheduledCanvas(DATA_DIR, canvasOrchestrator, task);
		}
		let result: { ok: boolean; conversationId?: string; error?: string };
		try {
			const svc = ensureEngine("pi") as unknown as {
				chatFromScheduler?: (t: {
					id: string;
					name?: string;
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
						name: task.name,
						cwd: task.cwd,
						prompt: task.prompt,
						model: task.model,
						thinkingLevel: task.thinkingLevel,
					});
				const target = String(task.conversationId ?? "").trim();
				const taskFile = String((task as { sessionFile?: unknown }).sessionFile ?? "").trim();
				const text = `[定时任务 ${task.name}] ${task.prompt}`;
				if (!target && !taskFile) {
					result = await runHeadless();
				} else if (typeof svc.wakeConversation === "function") {
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
						if (!task.oneShot) {
							try {
								if (w.conversationId && w.conversationId !== target)
									scheduler.rebind(task.id, { conversationId: w.conversationId });
								if (w.sessionFile && w.sessionFile !== taskFile)
									scheduler.rebind(task.id, { sessionFile: w.sessionFile });
							} catch {}
						}
						result = { ok: true, conversationId: w.conversationId };
					} else if (typeof svc.wakeViewportInCwd === "function") {
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
								} catch {}
							}
							pushNoticeToAll(
								"info",
								`定时任务「${task.name}」原对话不在，已转到同项目的活跃对话继续（原绑定 ${target || "（未知）"}）。报告直接落在当前对话。`,
								`Scheduled task "${task.name}" moved to the project's active conversation (was ${target || "unknown"}). The report lands in the current chat.`,
							);
							result = { ok: true, conversationId: f.conversationId };
						} else {
							pushNoticeToAll(
								"warning",
								`定时任务「${task.name}」原对话不在、同项目也无存活对话，已转后台执行（无头）。报告在后台任务面板的调度历史中查看。`,
								`Scheduled task "${task.name}" found no live conversation and runs headless; see its report in the background-tasks panel history.`,
							);
							if (!task.oneShot) {
								try {
									scheduler.rebind(task.id, { conversationId: "", sessionFile: "" });
								} catch {}
							}
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
		return result;
	},
	onChange: () => pushSchedulerTasks(),
	notify: (level, text, textEn) => pushNoticeToAll(level, text, textEn ?? text),
	onTaskRemoved: (taskId) => {
		const svc = piServiceInstance as unknown as { releaseSchedulerClient?: (id: string) => void } | null;
		try {
			svc?.releaseSchedulerClient?.(taskId);
		} catch {}
	},
});
scheduler.start();
function pushSchedulerTasks(): void {
	try {
		const payload = JSON.stringify({ type: "scheduler_tasks", tasks: scheduler.list() });
		for (const client of wss.clients) {
			if (client.readyState !== WebSocket.OPEN) continue;
			if (client.bufferedAmount > BROADCAST_BACKPRESSURE_MAX_BYTES) continue;
			try {
				client.send(payload);
			} catch {}
		}
	} catch {}
}

function pushNoticeToAll(level: "info" | "warning" | "error", text: string, textEn: string): void {
	const payload = JSON.stringify({ type: "notice", level, text, textEn });
	for (const client of wss.clients) {
		if (client.readyState !== WebSocket.OPEN) continue;
		if (client.bufferedAmount > BROADCAST_BACKPRESSURE_MAX_BYTES) continue;
		try {
			client.send(payload);
		} catch {}
	}
}

const mcpProjects = new McpProjectRuntimeRegistry({
	dataDir: DATA_DIR,
	isProjectInUse: (cwd) => {
		const key = (value: string) => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value));
		return activeEngines().some((svc) => svc.mcpProjectCwds?.().some((project) => key(project) === key(cwd)));
	},
	agentDir: getAgentDir(),
	onToolsChanged: (cwd) => {
		service.applyPluginAgentTools();
		for (const svc of activeEngines()) svc.refreshMcpProject?.(cwd);
	},
	onNotice: (_cwd, level, text, textEn) => pushNoticeToAll(level, text, textEn),
	log: (...a) => console.log("[mcp]", ...a),
});
ClientSession.mcpProjects = mcpProjects;
pluginMgr.mcpProjects = mcpProjects;
wireEngineHooks = (svc: EngineService) => {
	svc.onNotificationEvent = async (event) => {
		const results = await Promise.allSettled([
			mobilePush.handleEvent(event),
			deviceCenter.publishMobileNotification(event),
		]);
		for (const result of results) {
			if (result.status === "rejected")
				console.warn(
					"[mobile-push] notification queue failed",
					result.reason instanceof Error ? result.reason.message : "unknown error",
				);
		}
	};
	svc.onToolEvent = (ev) => pluginMgr.emitToolEvent(ev);
	svc.toolGuard = {
		pre: (req, lang) => pluginMgr.evaluateToolPre(req, lang),
		post: (req, lang) => pluginMgr.evaluateToolPost(req, lang),
	};
	svc.onRunEvent = (ev) => pluginMgr.emitRunEvent(ev);
	svc.onConversationChanged = () => pluginMgr.emitConversationChanged();
	svc.onClientModelChanged = (snap) => pluginMgr.emitClientModelChanged(snap);
	svc.pluginToolsProvider = (cwd) => [...pluginMgr.getAgentTools(), ...(cwd ? mcpProjects.getTools(cwd) : [])];
	svc.pluginCommandsProvider = () => pluginMgr.listCommands();
	svc.pluginBgTasksProvider = () => pluginMgr.bgTasks();
	svc.pluginStopBgTask = (taskId) => pluginMgr.stopPluginBgTask(taskId);
	svc.onClientCwdChanged = (cwd, roots) => {
		pluginMgr.notifyCwd(cwd);
		pluginMgr.notifyWorkspaceRoots(roots);
	};
	svc.onQuit = scheduleQuit;
	if ("schedulerStore" in svc) {
		(svc as unknown as { schedulerStore: typeof scheduler }).schedulerStore = scheduler;
	}
};
for (const s of activeEngines()) wireEngineHooks(s);

pluginMgr.conversationProvider = (opts) => service.readConversationForPlugins?.(opts) ?? null;
pluginMgr.workItemsProvider = (pluginId, method, args) =>
	deviceCenter.workItems(method, { ...args, connectorId: pluginId });
pluginMgr.chatProvider = (pluginId, req) =>
	service.chatFromPlugin?.(pluginId, req) ?? Promise.reject(new Error("当前引擎不支持无头调用（仅标准 pi 引擎）"));
pluginMgr.onAgentToolsChanged = () => {
	service.applyPluginAgentTools();
	void pluginMgr.pushToAll().catch(() => {});
};
pluginMgr.onCommandsChanged = () => service.applyPluginCommandCatalog();
pluginMgr.onMarkersChanged = () => service.applyPluginMarkers?.();
pluginMgr.onBgTasksChanged = () => service.refreshBackgroundServers();
{
	const pm = pluginMgr as unknown as Record<string, unknown>;
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
	const pickClient = (): ReturnType<AgentService["pluginClient"]> => {
		try {
			return piServiceInstance ? piServiceInstance.pluginClient() : undefined;
		} catch {
			return undefined;
		}
	};
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
	(pm as any).conversationSearcher = async (query: string, limit?: number) => {
		try {
			const cs = pickClient() as PluginSearchClient | undefined;
			if (!cs || typeof cs.searchForPlugins !== "function") return [];
			return await cs.searchForPlugins(query, limit ?? 20);
		} catch {
			return [];
		}
	};
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
	(pm as any).modelLister = async () => {
		try {
			const cs = pickClient() as PluginModelsClient | undefined;
			if (!cs || typeof cs.listModelsForPlugins !== "function") return [];
			return await cs.listModelsForPlugins();
		} catch {
			return [];
		}
	};
	(pm as any).runSteerer = async (id: string, text: string) => {
		try {
			const cs = pickClient() as PluginSteerClient | undefined;
			if (!cs || typeof cs.steerForPlugins !== "function") return { ok: false, error: "not supported" };
			return await cs.steerForPlugins(id, text);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	};
	(pm as any).runAborter = async (id: string) => {
		try {
			if (id.startsWith("pr-")) {
				if (!piServiceInstance) return { ok: false, error: "not supported" };
				return await piServiceInstance.abortPluginRun(id);
			}
			const cs = pickClient() as PluginAbortClient | undefined;
			if (!cs || typeof cs.abortForPlugins !== "function") return { ok: false, error: "not supported" };
			return await cs.abortForPlugins(id);
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	};
	(pm as any).llmProvider = async (pluginId: string, req: unknown) => {
		try {
			for (const s of activeEngines()) {
				if (s && typeof (s as any).completeForPlugins === "function") {
					return await (s as any).completeForPlugins(pluginId, (req ?? {}) as { prompt?: string });
				}
			}
			const svc = ensureEngine("pi") as unknown as {
				completeForPlugins?: (
					pluginId: string,
					req: { prompt?: string; system?: string; model?: string; maxChars?: number; timeoutMs?: number },
				) => Promise<{ ok: boolean; text?: string; model?: string; error?: string }>;
			};
			if (typeof svc.completeForPlugins !== "function") return { ok: false, error: "当前引擎不支持 LLM 直调" };
			return await svc.completeForPlugins(pluginId, (req ?? {}) as { prompt?: string });
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	};
}

function scheduleQuit(): boolean {
	const isLaunchd = process.platform === "darwin" && process.ppid === 1;
	const isSystemd = process.platform === "linux" && !!process.env.INVOCATION_ID;
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

const SNAPSHOT_BACKPRESSURE_FACTOR = 3;
const SNAPSHOT_BACKPRESSURE_MIN_BYTES = 262_144;
const SNAPSHOT_RETRY_MS = 250;
const ATTACH_SLOW_NOTICE_MS = 8_000;

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
		if (typeof tracked.pingSentAt === "number") {
			tracked.latencyMs = Math.max(0, Math.round(performance.now() - tracked.pingSentAt));
		}
	});
	tracked.pingSentAt = performance.now();
	try {
		ws.ping();
	} catch {}

	service.noteSocketOpen();
	let clientId: string | null = null;
	let closed = false;
	const helloTimer = setTimeout(() => {
		if (!clientId) ws.close(1008, "Handshake timed out");
	}, 15_000);
	helloTimer.unref?.();
	let lastSnapshotBytes = 0;
	const pending = new PendingCommandQueue();
	let attachDone = false;
	let attachGen = 0;
	let snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;

	ws.on("error", (err) => {
		console.error(`[ws] socket error${clientId ? ` (${clientId})` : ""}:`, err.message);
		try {
			ws.close();
		} catch {}
	});

	const sendRaw = (msg: ServerMessage): void => {
		if (closed || ws.readyState !== WebSocket.OPEN) return;
		if (
			(msg.type === "snapshot" || msg.type === "snapshot_delta") &&
			lastSnapshotBytes > 0 &&
			ws.bufferedAmount > Math.max(SNAPSHOT_BACKPRESSURE_MIN_BYTES, SNAPSHOT_BACKPRESSURE_FACTOR * lastSnapshotBytes)
		) {
			const wasFull = msg.type === "snapshot";
			if (!snapshotRetryTimer) {
				snapshotRetryTimer = setTimeout(() => {
					snapshotRetryTimer = null;
					if (!service.dispatchSharedConversationMessage?.(clientId ?? "", { type: "get_state" })) {
						service.get(clientId ?? "")?.flushSnapshot(wasFull);
					}
				}, SNAPSHOT_RETRY_MS);
			}
			return;
		}
		const wire = serializeShared(msg);
		if (msg.type === "snapshot") lastSnapshotBytes = wire.length * 2;
		ws.send(wire);
	};

	const windowTap = new MessageWindowTap(sendRaw, readMessageWindowConfig(process.env));
	const sendShared = (msg: ServerMessage): void => {
		const shared = clientId ? service.sharedConversationTarget?.(clientId) : undefined;
		windowTap.setScope(
			shared ? `shared:${JSON.stringify([shared.ownerClientId, shared.conversationId])}` : `local:${clientId}`,
		);
		windowTap.accept(msg);
	};
	const send = (msg: ServerMessage): void => {
		if (
			clientId &&
			service.sharedConversationTarget?.(clientId) &&
			(msg.type === "snapshot" ||
				msg.type === "snapshot_delta" ||
				msg.type === "tool_delta" ||
				msg.type === "message_delta" ||
				msg.type === "terminal_output" ||
				msg.type === "terminal_list" ||
				msg.type === "terminal_exit")
		)
			return;
		if (msg.type === "snapshot" || msg.type === "snapshot_delta") windowTap.setScope(`local:${clientId}`);
		windowTap.accept(msg);
	};

	const removePluginSender = pluginMgr.addSender(
		(msg) => {
			// Task sockets receive only their executor/session events. Global plugin
			if (!clientId || clientId.startsWith("device-task-")) return;
			send(msg);
		},
		() => clientId,
	);

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

	const handleSwitchEngine = async (msg: Extract<ClientMessage, { type: "switch_engine" }>): Promise<void> => {
		const targetEngine: EngineId | null =
			msg.engine === "codex"
				? "codex"
				: msg.engine === "durable"
					? "durable"
					: msg.engine === "claude"
						? "claude"
						: msg.engine === "dsh"
							? "dsh"
							: msg.engine === "pi"
								? "pi"
								: null;
		if (!targetEngine) {
			send({
				type: "notice",
				level: "error",
				text: `无效的引擎类型：${String(msg.engine)}（仅支持 pi / dsh / codex / claude / durable）`,
				textEn: `Invalid engine "${String(msg.engine)}" (supported: pi, dsh, codex, claude, durable)`,
			});
			return;
		}
		if (!clientId) return;

		if (targetEngine !== "pi") {
			const probe = await probeEngine(targetEngine);
			if (!probe.installed) {
				send({
					type: "notice",
					level: "warning",
					text: `引擎 ${targetEngine.toUpperCase()} 尚未安装全局包（${probe.packageName ?? targetEngine}），请先安装后再切换`,
					textEn: `Engine ${targetEngine.toUpperCase()} global package (${probe.packageName ?? targetEngine}) is not installed; please install it before switching`,
				});
				return;
			}
		}

		const prevEngine = resolveClientEngine(clientId);
		if (prevEngine === targetEngine) {
			setClientEngine(clientId, targetEngine);
			return;
		}

		try {
			ensureEngine(prevEngine).detach(clientId, send);
		} catch {}
		setClientEngine(clientId, targetEngine);
		attachDone = false;
		if (!closed) {
			send(readyMsg(clientId));
		}
		const cid = clientId;
		const nextSvc = ensureEngine(targetEngine);
		const switchGen = ++attachGen;
		nextSvc
			.attach(cid, send, sendShared)
			.then((newCs) => {
				if (closed) {
					nextSvc.detach(cid, send);
					return;
				}
				if (switchGen !== attachGen) {
					nextSvc.detach(cid, send);
					return;
				}
				nextSvc.applyPluginCommandCatalog();
				newCs.flushSnapshot(true);
				newCs.pushSettings();
				void newCs.refreshSessions();
				void newCs.pushProjects();
				void newCs.listModels();
				pluginMgr
					.ensureLoaded(() => newCs.getLang())
					.then((plugins) => {
						if (closed) return;
						send({ type: "plugins", plugins, epoch: pluginMgr.epoch });
						send({ type: "plugin_panel_items", groups: pluginMgr.panelGroups() });
					})
					.catch(() => {});
				attachDone = true;
				for (const m of pending.drain()) dispatch(m);
				if (targetEngine === "claude") {
					void probeClaudeCode().then((probe) => {
						if (!probe.installed) {
							newCs.emitNotice(
								"warning",
								"已热切换至 Claude Code 引擎。检测到未安装 Claude Code CLI，请在终端执行 npm i -g @anthropic-ai/claude-code 安装并运行 claude 完成登录。",
								"Switched to Claude Code engine. Claude Code CLI not found; run: npm i -g @anthropic-ai/claude-code and log in with claude.",
							);
						} else {
							newCs.emitNotice(
								"info",
								"已热切换至 Claude Code 引擎（已连接本地 CLI 登录态，无需在页面配置 API Key）",
								"Switched to Claude Code engine (connected to local CLI login session, no API Key needed)",
							);
						}
					});
				} else if (targetEngine === "dsh") {
					newCs.emitNotice(
						"info",
						"已热切换至 DSH 引擎（其他引擎后台会话保持运行，可随时切回）",
						"Switched to DSH engine in-place (other background conversations keep running)",
					);
				} else {
					newCs.emitNotice(
						"info",
						"已热切换至 pi 引擎（其他引擎后台会话保持运行，可随时切回）",
						"Switched to pi engine in-place (other background conversations keep running)",
					);
				}
			})
			.catch((err: unknown) => {
				setClientEngine(cid, prevEngine);
				const rollbackGen = ++attachGen;
				ensureEngine(prevEngine)
					.attach(cid, send, sendShared)
					.then((rollbackCs) => {
						if (closed || rollbackGen !== attachGen) {
							ensureEngine(prevEngine).detach(cid, send);
							return;
						}
						rollbackCs.flushSnapshot(true);
						attachDone = true;
						for (const m of pending.drain()) dispatch(m);
					})
					.catch(() => {
						attachDone = true;
					});
				send({
					type: "notice",
					level: "error",
					text: `切换引擎失败，已恢复至 ${prevEngine} 引擎：${(err as Error).message}`,
					textEn: `Failed to switch engine, rolled back to ${prevEngine}: ${(err as Error).message}`,
				});
			});
	};

	const handleUpdateEngine = async (msg: Extract<ClientMessage, { type: "update_engine" }>): Promise<void> => {
		const targetEngine = String(msg.engineId || "").trim();
		const meta = ENGINE_PACKAGES[targetEngine];
		if (!meta || !meta.packageName) {
			send({
				type: "notice",
				level: "error",
				text: `不支持或未知的引擎「${targetEngine}」`,
				textEn: `Unsupported or unknown engine "${targetEngine}"`,
			});
			return;
		}

		const refusal = managedRefusal("update_engine", MANAGED);
		if (refusal) {
			send({ type: "notice", level: "error", text: refusal });
			return;
		}

		if (isEngineUpdating(targetEngine)) {
			send({
				type: "notice",
				level: "warning",
				text: `引擎「${targetEngine.toUpperCase()}」正在后台更新中，请稍候…`,
				textEn: `Engine "${targetEngine.toUpperCase()}" is already updating, please wait…`,
			});
			return;
		}

		const engineDisplayNames: Record<string, { zh: string; en: string }> = {
			pi: { zh: "Pi", en: "Pi" },
			dsh: { zh: "DSH", en: "DSH" },
			claude: { zh: "Claude Code", en: "Claude Code" },
			codex: { zh: "Codex", en: "Codex" },
			durable: { zh: "Pi Durable", en: "Pi Durable" },
		};
		const displayName = engineDisplayNames[targetEngine] ?? {
			zh: targetEngine.toUpperCase(),
			en: targetEngine.toUpperCase(),
		};

		const broadcastStatuses = (list: EngineStatus[]) => {
			const payload = JSON.stringify({ type: "engines_status", engines: list });
			for (const c of wss.clients) {
				if (c.readyState === WebSocket.OPEN) {
					try {
						c.send(payload);
					} catch {}
				}
			}
		};

		send({
			type: "notice",
			level: "info",
			text: `正在后台更新 ${displayName.zh} 引擎（npm i -g ${meta.packageName}@latest）…`,
			textEn: `Updating ${displayName.en} engine in background (npm i -g ${meta.packageName}@latest)…`,
		});

		const updatePromise = updateEngineBackground(targetEngine);
		broadcastStatuses(getCachedEngineStatuses());

		const res = await updatePromise;
		const freshEngines = await probeAllEngines(true);
		broadcastStatuses(freshEngines);

		if (res.ok) {
			send({
				type: "notice",
				level: "info",
				text: `✅ ${displayName.zh} 引擎更新完成`,
				textEn: `✅ ${displayName.en} engine updated successfully`,
			});
		} else {
			const detail = res.error || (res.output ? res.output.slice(-200) : "");
			send({
				type: "notice",
				level: "error",
				text: `❌ ${displayName.zh} 引擎更新失败${detail ? `：${detail}` : ""}`,
				textEn: `❌ Failed to update ${displayName.en} engine${detail ? `: ${detail}` : ""}`,
			});
		}
	};

	const handleUninstallEngine = async (msg: Extract<ClientMessage, { type: "uninstall_engine" }>): Promise<void> => {
		const targetEngine = String(msg.engineId || "").trim();
		if (targetEngine === "pi") {
			send({
				type: "notice",
				level: "error",
				text: "Pi 为内置核心引擎，不支持卸载",
				textEn: "Pi is the built-in core engine and cannot be uninstalled",
			});
			return;
		}

		const meta = ENGINE_PACKAGES[targetEngine];
		if (!meta || !meta.packageName) {
			send({
				type: "notice",
				level: "error",
				text: `不支持或未知的引擎「${targetEngine}」`,
				textEn: `Unsupported or unknown engine "${targetEngine}"`,
			});
			return;
		}

		const refusal = managedRefusal("uninstall_engine", MANAGED);
		if (refusal) {
			send({ type: "notice", level: "error", text: refusal });
			return;
		}

		if (isEngineUpdating(targetEngine)) {
			send({
				type: "notice",
				level: "warning",
				text: `引擎「${targetEngine.toUpperCase()}」正在后台更新中，请稍候再试`,
				textEn: `Engine "${targetEngine.toUpperCase()}" is currently updating, please wait…`,
			});
			return;
		}

		if (isEngineUninstalling(targetEngine)) {
			send({
				type: "notice",
				level: "warning",
				text: `引擎「${targetEngine.toUpperCase()}」正在后台卸载中，请稍候…`,
				textEn: `Engine "${targetEngine.toUpperCase()}" is already uninstalling, please wait…`,
			});
			return;
		}

		const engineDisplayNames: Record<string, { zh: string; en: string }> = {
			pi: { zh: "Pi", en: "Pi" },
			dsh: { zh: "DSH", en: "DSH" },
			claude: { zh: "Claude Code", en: "Claude Code" },
			codex: { zh: "Codex", en: "Codex" },
			durable: { zh: "Pi Durable", en: "Pi Durable" },
		};
		const displayName = engineDisplayNames[targetEngine] ?? {
			zh: targetEngine.toUpperCase(),
			en: targetEngine.toUpperCase(),
		};

		const broadcastStatuses = (list: EngineStatus[]) => {
			const payload = JSON.stringify({ type: "engines_status", engines: list });
			for (const c of wss.clients) {
				if (c.readyState === WebSocket.OPEN) {
					try {
						c.send(payload);
					} catch {}
				}
			}
		};

		send({
			type: "notice",
			level: "info",
			text: `正在后台卸载 ${displayName.zh} 引擎（npm uninstall -g ${meta.packageName}）…`,
			textEn: `Uninstalling ${displayName.en} engine in background (npm uninstall -g ${meta.packageName})…`,
		});

		const uninstallPromise = uninstallEngineBackground(targetEngine);
		broadcastStatuses(getCachedEngineStatuses());

		const res = await uninstallPromise;
		const freshEngines = await probeAllEngines(true);
		broadcastStatuses(freshEngines);

		if (res.ok) {
			send({
				type: "notice",
				level: "info",
				text: `✅ ${displayName.zh} 引擎卸载完成`,
				textEn: `✅ ${displayName.en} engine uninstalled successfully`,
			});
		} else {
			const detail = res.error || (res.output ? res.output.slice(-200) : "");
			send({
				type: "notice",
				level: "error",
				text: `❌ ${displayName.zh} 引擎卸载失败${detail ? `：${detail}` : ""}`,
				textEn: `❌ Failed to uninstall ${displayName.en} engine${detail ? `: ${detail}` : ""}`,
			});
		}
	};

	const dispatch = (msg: ClientMessage, wireBytes?: number): void => {
		if (!clientId) {
			if (!pending.push(msg, wireBytes)) ws.close(1009, "Pending command budget exceeded");
			return;
		}

		if (msg.type === "switch_engine") {
			void handleSwitchEngine(msg);
			return;
		}

		if (msg.type === "update_engine") {
			void handleUpdateEngine(msg);
			return;
		}

		if (msg.type === "uninstall_engine") {
			void handleUninstallEngine(msg);
			return;
		}

		if (msg.type === "check_engines") {
			void probeAllEngines(msg.force).then((engines) => {
				if (!closed) send({ type: "engines_status", engines });
			});
			return;
		}

		const cs = service.get(clientId);
		if (!cs || !attachDone) {
			if (!pending.push(msg, wireBytes)) ws.close(1009, "Pending command budget exceeded");
			return;
		}
		if (msg.type === "load_earlier_messages") {
			const sharedTarget = service.sharedConversationTarget?.(clientId);
			if (sharedTarget && msg.conversationId && msg.conversationId !== sharedTarget.conversationId) return;
			windowTap.setScope(
				sharedTarget
					? `shared:${JSON.stringify([sharedTarget.ownerClientId, sharedTarget.conversationId])}`
					: `local:${clientId}`,
			);
			let handled = windowTap.loadEarlier({
				count: msg.count,
				all: msg.all,
				conversationId: msg.conversationId,
				beforeId: msg.beforeId,
				before: msg.before,
				historyGeneration: msg.historyGeneration,
			});
			if (!handled && cs) {
				const shared = service.sharedConversationTarget?.(clientId);
				const historyOwner = shared?.owner ?? cs;
				const activeId =
					shared?.conversationId ??
					(typeof cs.activeConversationId === "function" ? cs.activeConversationId() : undefined);
				const convId = msg.conversationId || activeId;
				if (shared && convId !== shared.conversationId) return;
				const full = convId ? historyOwner.getMessagesOfConversation?.(convId) : undefined;
				if (convId && full && full.length > 0) {
					windowTap.rehydrate(convId, full, msg.before);
					handled = windowTap.loadEarlier({
						count: msg.count,
						all: msg.all,
						conversationId: convId,
						beforeId: msg.beforeId,
						before: msg.before,
						historyGeneration: msg.historyGeneration,
					});
				}
				if (!handled && (!msg.conversationId || msg.conversationId === activeId)) {
					if (!service.dispatchSharedConversationMessage?.(clientId, { type: "get_state" })) cs.flushSnapshot(true);
				}
			}
			return;
		}
		const refusal = managedRefusal(msg.type, MANAGED) ?? tabsRefusal(msg.type, TABS);
		if (refusal) {
			send({ type: "notice", level: "error", text: refusal });
			if (msg.type === "new_cli_chat" && msg.requestId)
				send({ type: "new_chat_result", requestId: msg.requestId, ok: false });
			return;
		}
		try {
			if (service.dispatchSharedConversationMessage?.(clientId, msg)) return;
			if (handleInteractiveResponseMessage(msg, cs, service, clientId, send)) return;
			if (handleFileMessage(msg, cs)) return;
			if (handleScmMessage(msg, cs, send)) return;
			if (handleBgServerMessage(msg, cs)) return;
			if (handlePresetAndDshMessage(msg, cs)) return;
			if (handleModelAndProviderMessage(msg, cs)) return;
			const cliPasteClientId = clientId;
			const cliPasteSettings = sharedStateStore.getSettingsSnapshot(cliPasteClientId);
			if (
				handleTerminalMessage(msg, cs, {
					clientId: cliPasteClientId,
					dataDir: DATA_DIR,
					settings: cliPasteSettings,
					send,
					materializeAttachments: (attachments, conversationId, pasteText) =>
						materializeNativeCliReferences(attachments, {
							clientId: cliPasteClientId,
							settings: cliPasteSettings,
							dataDir: DATA_DIR,
							pasteText,
							readPage: async (req, signal) => {
								if (!cs.pageCall) throw new Error("This engine cannot read browser references");
								return cs.pageCall(req, signal, conversationId);
							},
							readConversation: async (source, signal) => {
								if (!cs.readQuickAskConversation) throw new Error("This engine cannot read conversation references");
								return cs.readQuickAskConversation(source, signal);
							},
						}),
				})
			)
				return;
			if (handleSessionLifecycleMessage(msg, cs, send, service, clientId)) return;
			if (handlePlanAndGoalMessage(msg, cs)) return;
			if (handleScheduleMessage(msg, scheduler, send)) return;
			if (handleRemoteSshMessage(msg, remoteSshService, send)) return;
			if (handleSettingsMessage(msg, cs, send)) return;
			if (handleCanvasMessage(msg, DATA_DIR, canvasOrchestrator, send, { runBase: cs.cwd })) return;
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
					if (
						msg.targetConversationId !== undefined &&
						(typeof msg.targetConversationId !== "string" ||
							!msg.targetConversationId ||
							cs.activeConversationId?.() !== msg.targetConversationId)
					) {
						send({
							type: "notice",
							level: "warning",
							text: "发送已取消：目标对话已改变，请重新发送。",
							textEn: "Prompt canceled: the target conversation changed. Please send again.",
						});
						break;
					}
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
					void cs.removeQueued(msg.kind, msg.text, msg.index, msg.id);
					break;
				case "draft_update":
					cs.saveDraft?.(msg.sessionId, msg.text, msg.ts);
					break;
				case "abort":
					void cs.abort();
					break;
				case "abort_bash":
					void cs.abortBash(msg.conversationId);
					break;
				case "retry_last":
					void cs.retryLast();
					break;
				case "get_state":
					cs.flushSnapshot(true);
					break;
				case "get_commands":
					void cs.pushSlashCommands();
					break;
				case "get_tool_info":
					if (typeof cs.getToolInfo === "function") {
						void cs.getToolInfo(msg.name);
					} else {
						send({ type: "tool_info", name: msg.name, found: false, unsupported: true });
					}
					break;
				case "get_tool_prompt":
					if (typeof cs.getToolPrompt === "function") {
						void cs.getToolPrompt(msg.name);
					} else {
						send({ type: "tool_prompt", name: msg.name, found: false, unsupported: true });
					}
					break;
				case "open_shared_conversation":
					if (
						!service.openSharedConversation?.(clientId, msg.owner, msg.id, sendShared, {
							readOnly: msg.readOnly === true,
						})
					) {
						send({
							type: "notice",
							level: "error",
							text: "共享对话不可用",
							textEn: "Shared conversation is unavailable.",
						});
					}
					return;
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
				case "navigate_question":
					if (typeof service.navigateQuestion === "function") void service.navigateQuestion(clientId, msg.id);
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
					void service.setLocale(clientId, msg.locale);
					break;
				case "check_update":
					void cs.checkUpdate();
					break;
				case "check_updates_all":
					void cs.checkUpdatesAll(msg.force === true);
					void probeAllEngines(true).then((engines) => {
						if (!closed) send({ type: "engines_status", engines });
					});
					break;
				case "check_plugin_updates":
					if (typeof cs.checkPluginUpdates === "function") {
						void cs.checkPluginUpdates(true);
					}
					break;
				case "restart_service": {
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
					try {
						service.recordInterruptedRuns();
					} catch {}
					setTimeout(() => void scheduleQuit(), 400);
					break;
				}
				default: {
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

	const readyMsg = (cid: string): ServerMessage => ({
		type: "ready",
		clientId: cid,
		serverVersion: VERSION,
		protocolVersion: PROTOCOL_VERSION,
		engine: resolveClientEngine(cid),
		engineCapabilities: ensureEngine(resolveClientEngine(cid)).getCapabilities?.(),
		appVersion: appVersion(),
		buildId: buildId(),
		runId: SERVER_RUN_ID,
		managed: MANAGED,
		tabs: TABS ? [...TABS] : undefined,
		service: SERVICE_INFO ?? undefined,
		engines: getCachedEngineStatuses(),
	});

	ws.on("message", (data) => {
		tracked.isAlive = true;
		tracked.missedPings = 0;
		const wireBytes = Array.isArray(data) ? data.reduce((n, chunk) => n + chunk.length, 0) : data.byteLength;
		if (!clientId && wireBytes > MAX_PRE_HELLO_WS_BYTES) {
			ws.close(1009, "Handshake message too large");
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(data.toString());
		} catch {
			return;
		}
		if (!isClientMessageEnvelope(parsed)) return;
		if (!isClientMessageWithinByteLimit(parsed.type, wireBytes, !!clientId)) {
			ws.close(1009, "Message budget exceeded");
			return;
		}
		const msg = parsed as ClientMessage;
		try {
			const botClientId = clientId ?? (msg.type === "hello" ? msg.clientId : undefined);
			if (botClientId && !botExecutionMessageAllowed(botClientId, msg.type, msg)) {
				ws.close(1008, "Bot control command denied");
				return;
			}
		} catch {
			ws.close(1008, "Invalid Bot execution capability");
			return;
		}

		if (msg.type === "hello") {
			clearTimeout(helloTimer);
			if (clientId) {
				if (!closed) send(readyMsg(clientId));
				return;
			}
			const cid = validateClientId(msg.clientId) ?? randomUUID();
			clientId = cid;
			if (msg.locale) {
				const code = msg.locale.trim().slice(0, 16);
				if (code) sharedStateStore.saveLocale(cid, code);
			}
			if (!closed) {
				send(readyMsg(cid));
				void probeAllEngines().then((engines) => {
					if (!closed) send({ type: "engines_status", engines });
				});
				if (autoGeneratedToken) {
					send({
						type: "notice",
						level: "info",
						text: `零信任保护：服务监听在非回环地址 (${HOST})，已自动生成临时访问 Token 并生效。`,
						textEn: `Zero-Trust: Server is bound to non-loopback (${HOST}); an ephemeral access token was auto-generated.`,
					});
				} else if (!isLoopbackHost(HOST) && !AUTH_TOKEN && ALLOW_INSECURE_NO_AUTH) {
					send({
						type: "notice",
						level: "warning",
						text: `安全告警：服务监听在非回环地址 (${HOST}) 且开启了免密模式，局域网设备可在未授权状态下访问与执行命令！`,
						textEn: `Security Warning: Server is bound to non-loopback (${HOST}) in insecure mode; any device on the network can access without authentication!`,
					});
				}
			}
			const slowTimer = setTimeout(() => {
				if (closed) return;
				send({
					type: "notice",
					level: "warning",
					text: "会话初始化耗时较长（可能在扫描工作区目录），请稍候…",
					textEn: "Session init is taking a while (possibly scanning the workspace) — hang on…",
				});
			}, ATTACH_SLOW_NOTICE_MS);
			const helloSvc = ensureEngine(resolveClientEngine(cid));
			const helloGen = ++attachGen;
			helloSvc
				.attach(cid, send, sendShared)
				.then((cs) => {
					clearTimeout(slowTimer);
					if (closed) {
						helloSvc.detach(cid, send);
						return;
					}
					if (helloGen !== attachGen) {
						helloSvc.detach(cid, send);
						return;
					}
					pluginMgr
						.ensureLoaded(() => service.get(cid)?.getLang() ?? "en")
						.then((plugins) => {
							if (closed) return;
							send({ type: "plugins", plugins, epoch: pluginMgr.epoch });
							send({
								type: "plugin_catalog",
								entries: pluginMgr.catalog(),
								epoch: pluginMgr.catalogEpochValue,
							});
							pluginMgr.notifyAttach(cid);
							send({ type: "plugin_panel_items", groups: pluginMgr.panelGroups() });
							send({ type: "plugin_grants", grants: pluginMgr.grants.list() });
							send({ type: "plugin_permissions", grants: pluginMgr.permGrants.list() });
							service.applyPluginCommandCatalog();
							cs.flushSnapshot(true);
							void cs.pushProjects();
							void cs.refreshSessions();
							try {
								send({ type: "scheduler_tasks", tasks: scheduler.list() });
							} catch {}
							replayQueued();
						})
						.catch(() => {
							if (closed) return;
							cs.flushSnapshot(true);
							void cs.pushProjects();
							void cs.refreshSessions();
							replayQueued();
						});
					if (msg.locale) void service.setLocale(cid, msg.locale);
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
					clearTimeout(slowTimer);
					if (err instanceof QuiesceRejectedError) {
						closed = true;
						if (ws.readyState === WebSocket.OPEN) {
							try {
								ws.close(4403, "quiesced");
							} catch {}
							setTimeout(() => {
								try {
									if (ws.readyState !== WebSocket.CLOSED) ws.terminate?.();
								} catch {}
							}, 500);
						} else {
							try {
								ws.terminate?.();
							} catch {}
						}
						return;
					}
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

		dispatch(msg, wireBytes);
	});

	ws.on("close", () => {
		clearTimeout(helloTimer);
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

if (process.env[RESTART_CHILD_ENV] === "1") {
	const deadline = Date.now() + 20_000;
	const portFree = () =>
		new Promise<boolean>((resolve) => {
			const sock = createConnection({ port: PORT, host: "127.0.0.1" });
			sock.once("connect", () => {
				sock.destroy();
				resolve(false);
			});
			sock.once("error", () => resolve(true));
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
	const sdkNote = sdkOriginNote(sdkCopies(), VERSION);
	const bannerLines = formatStartupBannerLines({
		port: PORT,
		host: HOST,
		token: AUTH_TOKEN,
		cwd: CWD,
		sessionDir: SESSION_DIR_ROOT,
		version: VERSION,
		sdkNote,
	});
	for (const line of bannerLines) {
		console.log(line);
	}
	if (autoGeneratedToken) {
		console.log("");
		console.log("  ╔═══════════════════════════════════════════════════════════════════════════════╗");
		console.log("  ║  🛡️  零信任自愈保护已生效 (Zero-Trust Auto-Remediation)                        ║");
		console.log("  ║  检测到服务监听在非回环地址且未配置口令，系统已自动生成临时访问 Token：        ║");
		console.log(`  ║  Token: ${autoGeneratedToken.padEnd(68)} ║`);
		console.log("  ║                                                                               ║");
		console.log("  ║  请使用以下带凭据的链接访问 Web 界面（浏览器将自动保存 HttpOnly Cookie）：     ║");
		const link = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}/?token=${autoGeneratedToken}`;
		console.log(`  ║  👉  ${link.padEnd(73)} ║`);
		console.log("  ║                                                                               ║");
		console.log("  ║  若确实需要在局域网完全免密公开，可设置 PI_WEB_INSECURE_NO_AUTH=1 启动。     ║");
		console.log("  ╚═══════════════════════════════════════════════════════════════════════════════╝");
	} else if (!isLoopbackHost(HOST) && !AUTH_TOKEN && ALLOW_INSECURE_NO_AUTH) {
		const requireAuth = /^(1|true|yes)$/i.test(process.env.PI_WEB_REQUIRE_AUTH ?? "");
		if (requireAuth) {
			console.error("");
			console.error(
				`  [FATAL] PI_WEB_REQUIRE_AUTH is enabled, but server is bound to non-loopback host (${HOST}) without PI_WEB_TOKEN.`,
			);
			console.error("  Please set PI_WEB_TOKEN or bind to 127.0.0.1.");
			console.error("");
			process.exit(1);
		}
		console.warn("");
		console.warn("  ─────────────────────────────────────────────────────────────────────────────");
		console.warn(
			`  ⚠️  【安全告警】服务监听在非回环地址 (${HOST}:${PORT}) 且显式开启了全开放免密模式 (PI_WEB_INSECURE_NO_AUTH=1)！`,
		);
		console.warn("     局域网（或公网路由）任意设备均可在未授权状态下访问 Web 界面并执行系统命令！");
		console.warn("  ─────────────────────────────────────────────────────────────────────────────");
	}
	console.log("");
});

scheduleUploadCleanup();

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
			communityCatalogPath: pluginMgr.communityCatalogPath,
			pluginsDir: join(DATA_DIR, "plugins"),
			installer: pluginInstaller,
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

const stopControl = startControlServer({
	service,
	dataDir: DATA_DIR,
	port: PORT,
	authToken: () => AUTH_TOKEN,
});

const SHUTDOWN_FORCE_EXIT_MS = 5000;

let shuttingDown = false;
async function shutdown(signal: "SIGINT" | "SIGTERM" = "SIGINT"): Promise<void> {
	if (shuttingDown) {
		console.log("\n再次收到中断信号，强制退出…");
		process.exit(signal === "SIGTERM" ? 143 : 130);
	}
	shuttingDown = true;
	console.log("\nshutting down…");
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
				} catch {}
			};
		} catch {}
	}
	const forceExitTimer = setTimeout(() => {
		console.error("shutdown 超时仍未完成，强制退出…");
		process.exit(1);
	}, SHUTDOWN_FORCE_EXIT_MS);
	forceExitTimer.unref();
	let code = 0;
	try {
		clearInterval(heartbeatTimer);
		await deviceCenter.close();
		await deviceDesktop.close();
		stopControl();
		scheduler.stop();
		pluginMgr.dispose();
		pluginInstaller.dispose();
		await mcpProjects.dispose();
		await globalLspPool.shutdownAll();
		await service.disposeAll();
		await mobilePush.dispose();
		for (const ws of wss.clients) {
			try {
				ws.terminate();
			} catch {}
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
