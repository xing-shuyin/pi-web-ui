/**
 * Local control socket for the pi-web-ui server.
 *
 * Lets the CLI (and humans) query status and quiesce/unquiesce the server
 * WITHOUT opening a network port or exposing an unauthenticated HTTP
 * endpoint. Only the local OS user can reach it:
 *   - POSIX: a mode-0600 Unix domain socket at <dataDir>/pi-web-ui.sock
 *   - Windows: a named pipe  \\.\pipe\pi-web-ui-<port>
 *
 * Protocol: one JSON object per line.
 *   → {"cmd":"status"}        ← {"ok":true, ...serviceStatus}
 *   → {"cmd":"quiesce"}       ← {"ok":true}
 *   → {"cmd":"unquiesce"}     ← {"ok":true}
 *   → anything else           ← {"ok":false,"error":"..."}
 *
 * Idle connections are closed after a short timeout so a stuck CLI never
 * holds the socket.
 */
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentService } from "./agent-service.js";

/** 控制 socket 只需服务状态与 quiesce 控制（pi/dsh 引擎都满足）。 */
type ControlService = Pick<AgentService, "serviceStatus" | "quiesce" | "unquiesce">;

/** How long a control connection may sit idle before the server closes it. */
const CONTROL_IDLE_TIMEOUT_MS = 5_000;

/** How long the CLI waits for a reply before giving up. */
const CONTROL_CLIENT_TIMEOUT_MS = 3_000;

/** Socket path (POSIX) or pipe name (Windows). */
export function controlPath(dataDir: string, port: number): string {
	return process.platform === "win32" ? `\\\\.\\pipe\\pi-web-ui-${port}` : join(dataDir, "pi-web-ui.sock");
}

export interface ControlCommand {
	cmd: "status" | "quiesce" | "unquiesce";
}

export interface ControlStatus {
	ok: boolean;
	error?: string;
	/** serviceStatus fields, present on "status". */
	pid?: number;
	version?: string;
	cwd?: string;
	quiesced?: boolean;
	quiescedSince?: number;
	connectedClients?: number;
	activeConversations?: number;
	pendingMessages?: number;
}

/** Start the control socket; returns a stop function. */
export function startControlServer(opts: { service: ControlService; dataDir: string; port: number }): () => void {
	const { service, dataDir, port } = opts;
	const path = controlPath(dataDir, port);
	let server: Server;

	if (process.platform === "win32") {
		server = createServer(handleConnection);
	} else {
		// Remove a stale socket left by a previous crash (only if it's ours —
		// an existing socket file that refuses connections is stale).
		if (existsSync(path)) {
			try {
				rmSync(path);
			} catch {
				/* best-effort */
			}
		}
		server = createServer(handleConnection);
	}
	// A second instance on the same data dir / port would fail to bind — don't
	// crash the server over it, just log and run without a control socket.
	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.warn(`[control] socket ${path} already in use — control socket disabled`);
		} else {
			console.warn(`[control] socket error: ${err.message}`);
		}
	});

	function handleConnection(sock: Socket): void {
		let buf = "";
		const timer = setTimeout(() => {
			sock.destroy();
		}, CONTROL_IDLE_TIMEOUT_MS);
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				timer.refresh();
				let req: ControlCommand;
				try {
					req = JSON.parse(line) as ControlCommand;
				} catch {
					sock.write(JSON.stringify({ ok: false, error: "bad json" }) + "\n");
					continue;
				}
				let resp: ControlStatus;
				switch (req.cmd) {
					case "status":
						resp = { ok: true, ...service.serviceStatus() };
						break;
					case "quiesce":
						service.quiesce();
						resp = { ok: true };
						break;
					case "unquiesce":
						service.unquiesce();
						resp = { ok: true };
						break;
					default:
						resp = { ok: false, error: `unknown cmd: ${String((req as { cmd?: unknown }).cmd)}` };
						break;
				}
				sock.write(JSON.stringify(resp) + "\n");
			}
		});
		sock.on("error", () => {
			/* client vanished */
		});
		sock.on("close", () => clearTimeout(timer));
	}

	if (process.platform === "win32") {
		// net.Server on a named pipe: listen on the pipe name directly.
		server.listen(path, () => {
			console.log(`  control    : ${path}`);
		});
	} else {
		server.listen(path, () => {
			try {
				chmodSync(path, 0o600);
			} catch {
				/* best-effort */
			}
			console.log(`  control    : ${path}`);
		});
	}

	return () => {
		server.close();
		try {
			if (process.platform !== "win32" && existsSync(path)) rmSync(path);
		} catch {
			/* best-effort */
		}
	};
}

/**
 * CLI-side client: send one command and return the parsed reply (or null if
 * the server is unreachable / timed out).
 */
export function sendControlCommand(
	dataDir: string,
	port: number,
	cmd: ControlCommand["cmd"],
): Promise<ControlStatus | null> {
	const path = controlPath(dataDir, port);
	return new Promise((resolve) => {
		const sock = createConnection(path);
		let done = false;
		const finish = (v: ControlStatus | null): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(v);
		};
		const timer = setTimeout(() => finish(null), CONTROL_CLIENT_TIMEOUT_MS);
		let buf = "";
		sock.on("connect", () => {
			sock.write(JSON.stringify({ cmd }) + "\n");
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, nl)) as ControlStatus);
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
	});
}
