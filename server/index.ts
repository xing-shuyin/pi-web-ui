/**
 * pi-web-ui server entry.
 *
 * - Serves the built frontend (web/dist) in production; in dev, Vite serves it
 *   on :5173 and proxies /ws to this server.
 * - Exposes /api/health and a WebSocket endpoint at /ws carrying the chat
 *   protocol defined in protocol.ts.
 *
 * Env:
 *   PORT            HTTP port (default 8787)
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
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { AgentService, previewKind, workspacePath } from "./agent-service.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";

const PORT = Number(process.env.PORT ?? 8787);
const CWD = resolve(process.env.PI_WEB_CWD ?? process.cwd());
const DATA_DIR = resolve(process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web"));
// Root of the SDK default per-project session dirs — chat transcripts live in
// <SESSION_DIR_ROOT>/--<cwd>--/, shared with the pi CLI/TUI (getAgentDir
// honors PI_CODING_AGENT_DIR).
const SESSION_DIR_ROOT = join(getAgentDir(), "sessions");

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => {
	res.json({ ok: true, piVersion: VERSION, cwd: CWD, pid: process.pid });
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
const pkgRoot = resolve(here, "..", "..");
/** Set in the env of the replacement child spawned by a self-update restart. */
const RESTART_CHILD_ENV = "PI_WEB_RESTART_CHILD";
const webDist = join(pkgRoot, "web", "dist");
if (existsSync(webDist)) {
	app.use(express.static(webDist));
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
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

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

const service = new AgentService(
	CWD,
	// Per-client persisted UI state: last-used workspace + recent projects.
	join(DATA_DIR, "client-state.json"),
);

// ---------------------------------------------------------------------------
// Self-update auto-restart
// ---------------------------------------------------------------------------
// npm i -g writes new code to disk but the running process keeps the old
// code in memory — so a successful in-app update hands the process over:
//   macOS launchd (KeepAlive) and systemd (Restart) relaunch us on exit;
//   foreground runs get a replacement child that waits for our port to free.
// Docker containers can't self-restart (the orchestrator owns that), so they
// keep the manual-restart notice.

function scheduleUpdateRestart(): boolean {
	const isLaunchd = process.platform === "darwin" && process.ppid === 1;
	const isSystemd = process.platform === "linux" && !!process.env.INVOCATION_ID;
	const inDocker = existsSync("/.dockerenv");
	if (isLaunchd || isSystemd || inDocker) {
		// Supervisors relaunch on exit; Docker restarts externally. Nothing to
		// spawn — just exit after the notice has flushed.
		if (isLaunchd || isSystemd) {
			setTimeout(() => {
				console.log("update applied — auto-restarting…");
				if (isSystemd) {
					// Non-zero exit: legacy units use Restart=on-failure.
					process.exit(3);
				}
				void shutdown();
			}, 1500);
			return true;
		}
		return false;
	}
	// Foreground / Windows: spawn a replacement from the updated install and
	// exit. Same stdio (logs keep flowing), same args/env (port, cwd, data
	// dir…); the child waits for this port to free before binding.
	setTimeout(() => {
		console.log("update applied — spawning replacement…");
		spawn(process.execPath, process.argv.slice(1), {
			stdio: "inherit",
			env: { ...process.env, [RESTART_CHILD_ENV]: "1" },
			...(process.platform === "win32" ? { windowsHide: true } : {}),
		});
		void shutdown();
	}, 1500);
	return true;
}
service.onUpdateReady = scheduleUpdateRestart;

wss.on("connection", (ws) => {
	let clientId: string | null = null;
	let closed = false;
	/** Commands received while the session is still being created — replayed after attach. */
	let pending: ClientMessage[] = [];

	const send = (msg: ServerMessage): void => {
		if (!closed && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	};

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
				void cs.prompt(msg.text, msg.attachments);
				break;
			case "abort":
				void cs.abort();
				break;
			case "new_chat":
				void cs.newChat();
				break;
			case "edit_message":
				void cs.editMessage(msg.messageId, msg.text);
				break;
			case "cycle_model":
				void cs.cycleModel();
				break;
			case "cycle_thinking":
				cs.cycleThinking();
				break;
			case "get_state":
				cs.flushSnapshot();
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
			case "switch_session":
				void cs.switchSession(msg.path);
				break;
			case "switch_conversation":
				void cs.switchConversation(msg.id);
				break;
			case "list_files":
				void cs.listFiles(msg.path);
				break;
			case "read_file":
				void cs.readFile(msg.path);
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
			case "update_app":
				void cs.updateApp();
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
			case "terminal_create":
				cs.terminals.create(
					msg.terminalId,
					msg.cwd,
					msg.cols,
					msg.rows,
					cs.cwd,
				);
				break;
			case "terminal_input":
				cs.terminals.input(msg.terminalId, msg.data);
				break;
			case "terminal_resize":
				cs.terminals.resize(msg.terminalId, msg.cols, msg.rows);
				break;
			case "terminal_kill":
				cs.terminals.kill(msg.terminalId);
				break;
			case "run_command":
				cs.terminals.runCommand(
					msg.terminalId,
					msg.command,
					msg.cols,
					msg.rows,
					cs.cwd,
				);
				break;
			case "list_commands":
				void cs.listCommands();
				break;
			case "save_commands":
				void cs.saveCommands(msg.commands);
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
					send({ type: "ready", clientId: cid, serverVersion: VERSION });
					cs.flushSnapshot();
					// Replay anything that arrived while the session was starting.
					const queued = pending;
					pending = [];
					for (const m of queued) dispatch(m);
				})
				.catch((err: unknown) => {
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
		closed = true;
		pending = [];
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

httpServer.listen(PORT, () => {
	console.log("");
	console.log("  ⚡ pi-web-ui — web chat for the pi coding agent");
	console.log(`    http://localhost:${PORT}`);
	console.log(`    workspace   : ${CWD}`);
	console.log(`    session dir : ${SESSION_DIR_ROOT}`);
	console.log(`    pi SDK      : v${VERSION}`);
	console.log("");
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log("\nshutting down…");
	clearInterval(heartbeatTimer);
	await service.disposeAll();
	wss.close();
	httpServer.close();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
