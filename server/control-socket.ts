import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentService } from "./agent-service.js";
import type { UiServiceInfo } from "./protocol.js";

const CONTROL_PROBE_TIMEOUT_MS = 300;

function probeControlPath(path: string): Promise<string | null> {
	return new Promise((resolve) => {
		const sock = createConnection(path);
		let settled = false;
		const finish = (result: string | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish("ETIMEDOUT"), CONTROL_PROBE_TIMEOUT_MS);
		sock.once("connect", () => finish(null));
		sock.once("error", (err: NodeJS.ErrnoException) => finish(err.code ?? "EUNKNOWN"));
	});
}

type ControlService = Pick<AgentService, "serviceStatus" | "quiesce" | "unquiesce">;

const CONTROL_IDLE_TIMEOUT_MS = 5_000;

export function controlPath(dataDir: string, port: number): string {
	return process.platform === "win32" ? `\\\\.\\pipe\\pi-web-ui-${port}` : join(dataDir, "pi-web-ui.sock");
}

export interface ControlCommand {
	cmd: "status" | "quiesce" | "unquiesce";
}

export interface ControlStatus {
	ok: boolean;
	error?: string;
	pid?: number;
	version?: string;
	cwd?: string;
	quiesced?: boolean;
	quiescedSince?: number;
	connectedClients?: number;
	activeConversations?: number;
	pendingMessages?: number;
	authToken?: string;
	service?: UiServiceInfo | null;
}

export function startControlServer(opts: {
	service: ControlService;
	dataDir: string;
	port: number;
	authToken?: () => string;
}): () => void {
	const { service, dataDir, port, authToken } = opts;
	const path = controlPath(dataDir, port);
	let server: Server;
	let bound = false;

	if (process.platform === "win32") {
		server = createServer(handleConnection);
		server.listen(path, () => {
			bound = true;
			console.log(`  control    : ${path}`);
		});
	} else {
		server = createServer(handleConnection);
		void probeControlPath(path).then((probeErr) => {
			if (probeErr && existsSync(path)) {
				try {
					rmSync(path);
				} catch {}
			}
			server.listen(path, () => {
				bound = true;
				try {
					chmodSync(path, 0o600);
				} catch {}
				console.log(`  control    : ${path}`);
			});
		});
	}
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
						resp = {
							ok: true,
							...service.serviceStatus(),
							...(authToken ? { authToken: authToken() } : {}),
						};
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
		sock.on("error", () => {});
		sock.on("close", () => clearTimeout(timer));
	}

	return () => {
		server.close();
		try {
			if (process.platform !== "win32" && bound && existsSync(path)) rmSync(path);
		} catch {}
	};
}
