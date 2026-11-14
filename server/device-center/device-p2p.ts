import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { killPidTree } from "../process-utils.js";
import { probeDeviceTunnel, type DeviceLanConnection, type createDeviceLanServer } from "./device-lan.js";
import {
	DEVICE_P2P_TIMEOUT_MS,
	DEVICE_P2P_GATHER_TIMEOUT_MS,
	DEVICE_P2P_TUNNEL_TIMEOUT_MS,
	deviceP2PRemoteFailure,
	validDeviceP2PSignal,
	type DeviceP2PSignal,
	type DeviceP2PRemoteFailure,
} from "./device-p2p-protocol.js";

type Event = {
	type: string;
	sdp?: string;
	port?: number;
	localCandidate?: string;
	remoteCandidate?: string;
	protocol?: string;
	relayed?: boolean;
};
export type DeviceDirectConnection = {
	connection: DeviceLanConnection;
	expiresAt: number;
	transport: "lan" | "p2p";
	/** True when ICE selected a TURN allocation instead of a direct path. */
	relayed?: boolean;
};
/** Why a P2P attempt fell back to the Hub; surfaced as one log line so the path is not silently "hub". */
export type DeviceP2PFailure =
	| DeviceP2PRemoteFailure
	| "helper-missing"
	| "ice-config"
	| "cancelled"
	| "gather-timeout"
	| "signal-timeout"
	| "ice-timeout"
	| "tunnel-timeout"
	| "gather-failed"
	| "signal-failed"
	| "signal-rejected"
	| "ice-failed"
	| "tunnel-failed"
	| "unexpected";
// A single STUN server is a single point of failure: when it is blocked or blackholed (observed with
// stun.cloudflare.com:3478 on a mainland network) the helper gathers no srflx candidate, and a host-only
// SDP can never punch a hole. Gathering probes every entry in parallel, so extra servers cost nothing
// when one of them is down.
export const DEVICE_P2P_DEFAULT_STUN =
	"stun:stun.l.google.com:19302,stun:stun.miwifi.com:3478,stun:stun.cloudflare.com:3478";
const running = new Set<() => void>();
const verified = new Map<string, Promise<string | undefined>>();

async function binaryPath(): Promise<string | undefined> {
	if (process.env.PI_DEVICE_P2P === "0") return undefined;
	const override = process.env.PI_DEVICE_P2P_HELPER;
	if (override) return isAbsolute(override) ? override : undefined;
	const name = `${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
	if (!/^(win32-x64\.exe|darwin-(arm64|x64)|linux-(arm64|x64))$/.test(name)) return undefined;
	const dir = dirname(fileURLToPath(import.meta.url));
	for (const root of [resolve(dir, "../../bin/device-p2p"), resolve(dir, "../../../bin/device-p2p")]) {
		const path = join(root, name);
		if (!verified.has(path))
			verified.set(
				path,
				(async () => {
					try {
						const manifest = JSON.parse(await readFile(join(root, "checksums.json"), "utf8"));
						const bytes = await readFile(path);
						if (createHash("sha256").update(bytes).digest("hex") === manifest[name]) {
							if (process.platform === "win32") return path;
							// npm archives made on Windows may not preserve executable mode. Use a private verified copy.
							const temporary = await mkdtemp(join(tmpdir(), "pi-device-p2p-"));
							const executable = join(temporary, "helper");
							await writeFile(executable, bytes, { mode: 0o700, flag: "wx" });
							process.once("exit", () => {
								try {
									unlinkSync(executable);
									rmdirSync(temporary);
								} catch {}
							});
							return executable;
						}
					} catch {}
					return undefined;
				})(),
			);
		const found = await verified.get(path);
		if (found) return found;
	}
	return undefined;
}

export async function deviceP2PAvailable() {
	return !!(await binaryPath()) && running.size < 16;
}

export async function diagnoseDeviceP2P() {
	const started = Date.now();
	const report = {
		version: 1,
		enabled: process.env.PI_DEVICE_P2P !== "0",
		helper: false,
		turnConfigured: false,
		candidates: { host: 0, srflx: 0, relay: 0 },
		status: "helper-missing",
		elapsedMs: 0,
		scope:
			"Local ICE gathering only; remote reachability is not tested. Cloud Hub browser access currently uses Hub relay.",
	};
	let helper: Awaited<ReturnType<typeof startHelper>> | undefined;
	try {
		if (!report.enabled) {
			report.status = "disabled";
			return report;
		}
		const config = settings();
		report.turnConfigured = Boolean(config.turn);
		report.helper = await deviceP2PAvailable();
		if (!report.helper) return report;
		helper = await startHelper();
		helper.send({ type: "start", role: "source", ...config });
		const event = await helper.wait("sdp", AbortSignal.timeout(5000));
		for (const type of event.sdp?.matchAll(/^a=candidate:.* typ (host|srflx|relay)(?: |\r?$)/gm) ?? [])
			report.candidates[type[1] as keyof typeof report.candidates]++;
		report.status =
			report.candidates.srflx || report.candidates.relay
				? "gathered-public-candidates"
				: report.candidates.host
					? "host-candidates-only"
					: "no-candidates";
	} catch {
		report.status = helper ? "gather-failed" : "ice-config";
	} finally {
		helper?.close();
		report.elapsedMs = Date.now() - started;
	}
	return report;
}

async function startHelper() {
	const path = await binaryPath();
	if (!path || running.size >= 16) throw new Error("P2P helper unavailable");
	const child = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (text: string) => (stderr = (stderr + text).slice(-2048)));
	const events = new Map<string, Event>();
	const waiters = new Set<{ type: string; resolve(event: Event): void; reject(error: Error): void }>();
	const listeners = new Set<() => void>();
	let stopped = false;
	let exited = false;
	let buffer = "";
	const close = () => {
		if (stopped) return;
		stopped = true;
		running.delete(close);
		for (const waiter of waiters) waiter.reject(new Error("P2P connection closed"));
		waiters.clear();
		for (const listener of listeners) listener();
		listeners.clear();
		child.stdin.end();
		const timer = setTimeout(() => {
			if (!exited && child.pid) void killPidTree(child.pid);
		}, 2000);
		timer.unref();
		child.once("exit", () => clearTimeout(timer));
	};
	running.add(close);
	child.once("error", close);
	child.once("exit", (code) => {
		exited = true;
		if (!stopped && stderr.trim()) console.warn("[device-p2p] helper exit", code, stderr.trim().slice(0, 500));
		close();
	});
	child.stdin.on("error", close);
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (data: string) => {
		buffer += data;
		if (buffer.length > 64 * 1024) return close();
		let end: number;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			try {
				const event = JSON.parse(line) as Event;
				if (!["sdp", "ready"].includes(event.type) || events.has(event.type)) return close();
				if (event.type === "sdp" && !validDeviceP2PSignal({ version: 1, sdp: event.sdp })) return close();
				if (
					event.type === "ready" &&
					(!Number.isInteger(event.port) ||
						event.port! < 0 ||
						event.port! > 65535 ||
						!["host", "srflx", "prflx", "relay"].includes(event.localCandidate ?? "") ||
						!["host", "srflx", "prflx", "relay"].includes(event.remoteCandidate ?? "") ||
						(event.relayed !== undefined && typeof event.relayed !== "boolean"))
				)
					return close();
				events.set(event.type, event);
				for (const waiter of waiters) if (waiter.type === event.type) waiter.resolve(event);
			} catch {
				close();
			}
		}
	});
	return {
		close,
		onClose(listener: () => void) {
			if (stopped) listener();
			else listeners.add(listener);
		},
		send(value: object) {
			if (stopped || child.stdin.writableLength > 64 * 1024) throw new Error("P2P connection closed");
			child.stdin.write(JSON.stringify(value) + "\n");
		},
		wait(type: string, signal: AbortSignal): Promise<Event> {
			if (stopped || signal.aborted) return Promise.reject(new Error("P2P connection cancelled"));
			const found = events.get(type);
			if (found) return Promise.resolve(found);
			return new Promise((resolve, reject) => {
				const finish = () => {
					waiters.delete(waiter);
					signal.removeEventListener("abort", abort);
				};
				const waiter = {
					type,
					resolve: (event: Event) => {
						finish();
						resolve(event);
					},
					reject: (error: Error) => {
						finish();
						reject(error);
					},
				};
				const abort = () => waiter.reject(new Error("P2P connection timed out"));
				waiters.add(waiter);
				signal.addEventListener("abort", abort, { once: true });
			});
		},
	};
}

/**
 * TURN relay for symmetric NAT / CGNAT. Both devices must point at the same server and credentials.
 * Off unless `PI_DEVICE_TURN` is set; a malformed or half-configured entry fails loudly instead of
 * silently degrading to "no relay".
 */
export function parseTurn(
	env: NodeJS.ProcessEnv = process.env,
): { urls: string[]; username: string; credential: string } | undefined {
	const raw = env.PI_DEVICE_TURN?.trim();
	if (!raw) return undefined;
	const urls = raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (urls.length === 0 || urls.length > 3) throw new Error("Invalid TURN configuration");
	if (urls.some((url) => !validIceServerUrl(url, "turn"))) throw new Error("Invalid TURN server URL");
	const username = env.PI_DEVICE_TURN_USERNAME ?? "";
	const credential = env.PI_DEVICE_TURN_CREDENTIAL ?? "";
	if (!username || !credential) throw new Error("TURN requires PI_DEVICE_TURN_USERNAME and PI_DEVICE_TURN_CREDENTIAL");
	if (username.length > 256 || credential.length > 256) throw new Error("TURN credentials are too long");
	if (/[\u0000-\u001f\u007f]/.test(username + credential)) throw new Error("Invalid TURN credentials");
	return { urls, username, credential };
}

export function validIceServerUrl(value: string, kind: "stun" | "turn"): boolean {
	if (value.length > 256) return false;
	const match =
		/^(stun|turn|turns):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(value);
	if (!match || (kind === "stun" ? match[1] !== "stun" || !!match[4] : match[1] === "stun")) return false;
	if (match[2].startsWith("[") && isIP(match[2].slice(1, -1)) !== 6) return false;
	return !match[3] || (Number(match[3]) > 0 && Number(match[3]) <= 65535);
}

function settings() {
	const loopback = process.env.PI_DEVICE_P2P_TEST_LOOPBACK === "1";
	const stun = loopback
		? []
		: (process.env.PI_DEVICE_P2P_STUN ?? DEVICE_P2P_DEFAULT_STUN)
				.split(",")
				.map((x) => x.trim())
				.filter(Boolean);
	if (stun.length > 4 || stun.some((x) => !validIceServerUrl(x, "stun")))
		throw new Error("Invalid P2P STUN configuration");
	const turn = loopback ? undefined : parseTurn();
	return { stun, turn, loopback };
}

export async function connectDeviceP2P(
	exchange: (offer: DeviceP2PSignal, signal: AbortSignal) => Promise<unknown>,
	signal?: AbortSignal,
	onFailure?: (reason: DeviceP2PFailure) => void,
): Promise<DeviceDirectConnection | null> {
	let helper: Awaited<ReturnType<typeof startHelper>> | undefined;
	let connection: DeviceLanConnection | null = null;
	let retained = false;
	const fail = (reason: DeviceP2PFailure) => {
		onFailure?.(reason);
		return null;
	};
	let config: ReturnType<typeof settings>;
	try {
		config = settings();
	} catch {
		return fail("ice-config");
	}
	const deadline = AbortSignal.any([AbortSignal.timeout(DEVICE_P2P_TIMEOUT_MS), ...(signal ? [signal] : [])]);
	let phase: "gather" | "signal" | "ice" | "tunnel" = "gather";
	const failure = (reason: DeviceP2PFailure) =>
		fail(signal?.aborted ? "cancelled" : deadline.aborted ? `${phase}-timeout` : reason);
	try {
		try {
			helper = await startHelper();
		} catch {
			return fail("helper-missing");
		}
		helper.send({ type: "start", role: "source", ...config });
		const offer = await helper.wait("sdp", deadline).catch(() => undefined);
		if (!offer?.sdp) return failure("gather-failed");
		phase = "signal";
		let response: { deviceP2P?: { signal?: unknown; grant?: unknown; failure?: unknown } } | undefined;
		try {
			response = (await exchange({ version: 1, sdp: offer.sdp }, deadline)) as typeof response;
		} catch {
			return failure("signal-failed");
		}
		const answer = response?.deviceP2P;
		const remoteFailure = deviceP2PRemoteFailure(answer?.failure);
		if (remoteFailure) return failure(remoteFailure);
		if (!answer || !validDeviceP2PSignal(answer.signal)) return failure("signal-rejected");
		phase = "ice";
		helper.send({ type: "answer", sdp: answer.signal.sdp });
		const ready = await helper.wait("ready", deadline).catch(() => undefined);
		if (!ready?.port) return failure("ice-failed");
		phase = "tunnel";
		const tunnelDeadline = AbortSignal.any([deadline, AbortSignal.timeout(DEVICE_P2P_TUNNEL_TIMEOUT_MS)]);
		connection = await probeDeviceTunnel(answer.grant, ready.port, {
			signal: tunnelDeadline,
			timeoutMs: DEVICE_P2P_TUNNEL_TIMEOUT_MS,
		});
		if (!connection && tunnelDeadline.aborted && !deadline.aborted) return fail("tunnel-timeout");
		if (!connection || deadline.aborted) return failure("tunnel-failed");
		const peer = connection;
		const worker = helper;
		helper.onClose(() => peer.close());
		retained = true;
		return {
			connection: {
				...peer,
				close: () => {
					peer.close();
					worker.close();
				},
			},
			expiresAt: (answer.grant as { expiresAt: number }).expiresAt,
			transport: "p2p",
			...(ready.relayed === true ? { relayed: true } : {}),
		};
	} catch {
		return failure("unexpected");
	} finally {
		if (!retained) {
			connection?.close();
			helper?.close();
		}
	}
}

export function createDeviceP2PTarget(lan: ReturnType<typeof createDeviceLanServer>) {
	const sessions = new Set<() => void>();
	const grants = new Map<string, () => void>();
	let generation = 0;
	return {
		async accept(value: unknown, signal: AbortSignal) {
			const fail = (failure: DeviceP2PRemoteFailure) => ({ failure });
			if (!validDeviceP2PSignal(value)) return null;
			if (signal.aborted) return fail("target-cancelled");
			if (sessions.size >= 8) return fail("target-busy");
			let config: ReturnType<typeof settings>;
			try {
				config = settings();
			} catch {
				return fail("target-ice-config");
			}
			const captured = generation;
			let helper: Awaited<ReturnType<typeof startHelper>>;
			try {
				helper = await startHelper();
			} catch {
				return fail("target-helper-missing");
			}
			let grant: Awaited<ReturnType<typeof lan.issueGrant>> = null;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let stopped = false;
			const stop = () => {
				if (stopped) return;
				stopped = true;
				clearTimeout(timer);
				sessions.delete(stop);
				if (grant) {
					grants.delete(grant.identity);
					lan.revoke(grant.identity);
				}
				helper.close();
			};
			sessions.add(stop);
			helper.onClose(stop);
			const gatherDeadline = AbortSignal.any([signal, AbortSignal.timeout(DEVICE_P2P_GATHER_TIMEOUT_MS)]);
			try {
				grant = await lan.issueGrant({ loopbackOnly: true });
				if (stopped) {
					if (grant) lan.revoke(grant.identity);
					return fail("target-cancelled");
				}
				if (!grant || signal.aborted || captured !== generation || sessions.size > 8) {
					stop();
					return fail(
						signal.aborted || captured !== generation
							? "target-cancelled"
							: !grant
								? "target-unavailable"
								: "target-busy",
					);
				}
				grants.set(grant.identity, stop);
				timer = setTimeout(stop, Math.max(1, grant.expiresAt - Date.now()));
				timer.unref();
				helper.send({ type: "start", role: "target", port: grant.port, sdp: value.sdp, ...config });
				const answer = await helper.wait("sdp", gatherDeadline);
				if (signal.aborted || captured !== generation || stopped) {
					stop();
					return fail("target-cancelled");
				}
				void helper.wait("ready", AbortSignal.timeout(DEVICE_P2P_TIMEOUT_MS)).catch(stop);
				return { signal: { version: 1, sdp: answer.sdp } as DeviceP2PSignal, grant };
			} catch {
				stop();
				return fail(
					signal.aborted
						? "target-cancelled"
						: gatherDeadline.aborted
							? "target-gather-timeout"
							: "target-gather-failed",
				);
			}
		},
		reset() {
			generation++;
			for (const stop of sessions) stop();
		},
		revoke(identity: string) {
			grants.get(identity)?.();
		},
	};
}
