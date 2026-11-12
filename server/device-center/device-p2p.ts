import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { killPidTree } from "../process-utils.js";
import { probeDeviceTunnel, type DeviceLanConnection, type createDeviceLanServer } from "./device-lan.js";
import { DEVICE_P2P_TIMEOUT_MS, validDeviceP2PSignal, type DeviceP2PSignal } from "./device-p2p-protocol.js";

type Event = {
	type: string;
	sdp?: string;
	port?: number;
	localCandidate?: string;
	remoteCandidate?: string;
	protocol?: string;
};
export type DeviceDirectConnection = {
	connection: DeviceLanConnection;
	expiresAt: number;
	transport: "lan" | "p2p";
};
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

async function startHelper() {
	const path = await binaryPath();
	if (!path || running.size >= 16) throw new Error("P2P helper unavailable");
	const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
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
	child.once("exit", () => {
		exited = true;
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
						!["host", "srflx", "prflx"].includes(event.localCandidate ?? "") ||
						!["host", "srflx", "prflx"].includes(event.remoteCandidate ?? ""))
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

function settings() {
	const loopback = process.env.PI_DEVICE_P2P_TEST_LOOPBACK === "1";
	const stun = loopback
		? []
		: (process.env.PI_DEVICE_P2P_STUN ?? "stun:stun.cloudflare.com:3478")
				.split(",")
				.map((x) => x.trim())
				.filter(Boolean);
	if (stun.length > 4 || stun.some((x) => x.length > 256 || !/^stun:[a-zA-Z0-9.\-[\]:]+$/.test(x)))
		throw new Error("Invalid P2P STUN configuration");
	return { stun, loopback };
}

export async function connectDeviceP2P(
	exchange: (offer: DeviceP2PSignal, signal: AbortSignal) => Promise<unknown>,
	signal?: AbortSignal,
): Promise<DeviceDirectConnection | null> {
	let helper: Awaited<ReturnType<typeof startHelper>> | undefined;
	let connection: DeviceLanConnection | null = null;
	let retained = false;
	const deadline = AbortSignal.any([AbortSignal.timeout(DEVICE_P2P_TIMEOUT_MS), ...(signal ? [signal] : [])]);
	try {
		helper = await startHelper();
		helper.send({ type: "start", role: "source", ...settings() });
		const offer = await helper.wait("sdp", deadline);
		const response = (await exchange({ version: 1, sdp: offer.sdp! }, deadline)) as {
			deviceP2P?: { signal?: unknown; grant?: unknown };
		};
		const answer = response?.deviceP2P;
		if (!answer || !validDeviceP2PSignal(answer.signal)) return null;
		helper.send({ type: "answer", sdp: answer.signal.sdp });
		const ready = await helper.wait("ready", deadline);
		if (!ready.port) return null;
		connection = await probeDeviceTunnel(answer.grant, ready.port, { signal: deadline, timeoutMs: 2000 });
		if (!connection || deadline.aborted) return null;
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
		};
	} catch {
		return null;
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
			if (!validDeviceP2PSignal(value) || signal.aborted || sessions.size >= 8) return null;
			const captured = generation;
			const helper = await startHelper();
			const grant = await lan.issueGrant({ loopbackOnly: true });
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
			helper.onClose(stop);
			sessions.add(stop);
			try {
				if (!grant || signal.aborted || captured !== generation || sessions.size > 8) {
					stop();
					return null;
				}
				grants.set(grant.identity, stop);
				timer = setTimeout(stop, Math.max(1, grant.expiresAt - Date.now()));
				timer.unref();
				helper.send({ type: "start", role: "target", port: grant.port, sdp: value.sdp, ...settings() });
				const answer = await helper.wait("sdp", AbortSignal.any([signal, AbortSignal.timeout(4000)]));
				if (signal.aborted || captured !== generation || stopped) {
					stop();
					return null;
				}
				void helper.wait("ready", AbortSignal.timeout(DEVICE_P2P_TIMEOUT_MS)).catch(stop);
				return { signal: { version: 1, sdp: answer.sdp } as DeviceP2PSignal, grant };
			} catch {
				stop();
				return null;
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
