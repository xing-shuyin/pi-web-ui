import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import type { DeviceIntegrationVerificationPlan, DeviceIntegrationVerificationResult } from "../protocol.js";
import { canonicalizeJson } from "./work-contract.js";
import { WINDOWS_VERIFICATION_SUPERVISOR } from "./local-verification-job.js";
import { VERIFICATION_COMMAND_TIMEOUT_MS, VERIFICATION_STOP_TIMEOUT_MS } from "./verification-limits.js";
export {
	VERIFICATION_COMMAND_TIMEOUT_MS,
	VERIFICATION_TOTAL_TIMEOUT_MS,
	VERIFICATION_STOP_TIMEOUT_MS,
	VERIFICATION_RPC_TIMEOUT_MS,
} from "./verification-limits.js";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PREVIEW_BYTES = 16 * 1024;

export class VerificationStopUnconfirmedError extends Error {
	readonly stopUnconfirmed = true;
	constructor(cause?: unknown) {
		super("Verification process tree stop unconfirmed; workspace retained", { cause });
	}
}
export function validateLocalVerificationPlan(value: unknown): DeviceIntegrationVerificationPlan {
	const plan = value as DeviceIntegrationVerificationPlan | undefined;
	if (
		!plan ||
		!Array.isArray(plan.commands) ||
		plan.commands.length < 1 ||
		plan.commands.length > 8 ||
		plan.commands.some((command) => typeof command !== "string" || !command.trim() || command.length > 4096) ||
		typeof plan.authorizedByAccountId !== "string" ||
		!plan.authorizedByAccountId.trim() ||
		!Number.isSafeInteger(plan.authorizedAt) ||
		plan.authorizedAt <= 0 ||
		plan.digest !==
			createHash("sha256")
				.update(canonicalizeJson({ commands: plan.commands }))
				.digest("hex")
	)
		throw new Error("Owner-authorized frozen verification plan required");
	return structuredClone(plan);
}

export async function runVerificationCommand(
	command: string,
	options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; stopTimeoutMs?: number },
): Promise<DeviceIntegrationVerificationResult> {
	options.signal?.throwIfAborted();
	const windows = process.platform === "win32";
	let windowsReceipt: number | undefined;
	let resolveReceipt!: () => void;
	let rejectReceipt!: (error: Error) => void;
	const receipt = new Promise<void>((resolve, reject) => {
		resolveReceipt = resolve;
		rejectReceipt = reject;
	});
	void receipt.catch(() => {});
	const sockets = new Set<Socket>();
	const pipeName = `pi-verification-${randomUUID()}`;
	const receiptSecret = randomBytes(32).toString("hex");
	const control = windows
		? createServer((socket) => {
				sockets.add(socket);
				let bytes = "";
				let accepted = false;
				socket.on("error", (error) => rejectReceipt(new VerificationStopUnconfirmedError(error)));
				socket.once("end", () => {
					if (!accepted) rejectReceipt(new VerificationStopUnconfirmedError());
				});
				socket.on("data", (chunk) => {
					bytes += chunk.toString("utf8");
					if (bytes.length > 96) {
						rejectReceipt(new VerificationStopUnconfirmedError());
						socket.destroy();
						return;
					}
					const match = /^([a-f0-9]{64}):(-?\d+)\r?\n$/.exec(bytes);
					const code = match && Number(match[2]);
					if (
						windowsReceipt === undefined &&
						match?.[1] === receiptSecret &&
						typeof code === "number" &&
						Number.isInteger(code) &&
						code >= -2147483648 &&
						code <= 2147483647
					) {
						accepted = true;
						windowsReceipt = code;
						resolveReceipt();
						socket.end();
					}
				});
				socket.once("close", () => {
					sockets.delete(socket);
					if (!accepted) rejectReceipt(new VerificationStopUnconfirmedError());
				});
			})
		: undefined;
	if (control)
		await new Promise<void>((resolve, reject) => {
			control.once("error", reject);
			control.listen(`\\\\.\\pipe\\${pipeName}`, resolve);
		});
	const env = windows
		? { ...options.env, PI_LOCAL_VERIFICATION_COMMAND: command, PI_LOCAL_VERIFICATION_PIPE: pipeName }
		: options.env;
	let child: ReturnType<typeof spawn>;
	try {
		child = windows
			? spawn(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-OutputFormat",
						"Text",
						"-EncodedCommand",
						Buffer.from(WINDOWS_VERIFICATION_SUPERVISOR, "utf16le").toString("base64"),
					],
					{
						cwd: options.cwd,
						env,
						windowsHide: true,
						stdio: ["pipe", "pipe", "pipe"],
					},
				)
			: spawn(command, { cwd: options.cwd, env, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		control?.close();
		throw error;
	}
	let closed = false;
	let closeCode: number | null = null;
	let spawnError: Error | undefined;
	let resolveClosed!: () => void;
	const done = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	child.once("error", (error) => {
		spawnError = error;
	});
	child.once("close", (code) => {
		closed = true;
		closeCode = code;
		resolveClosed();
	});
	child.stdin?.on("error", () => {});
	if (windows) child.stdin?.write(`${receiptSecret}\n`);
	const stopMs = options.stopTimeoutMs ?? VERIFICATION_STOP_TIMEOUT_MS;
	const bounded = async (operation: Promise<void>) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				operation,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new VerificationStopUnconfirmedError()), stopMs);
				}),
			]);
		} catch (error) {
			throw error instanceof VerificationStopUnconfirmedError ? error : new VerificationStopUnconfirmedError(error);
		} finally {
			clearTimeout(timer);
		}
	};
	const groupAlive = () => {
		if (!child.pid) return false;
		try {
			process.kill(-child.pid, 0);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
			throw new VerificationStopUnconfirmedError(error);
		}
	};
	const stopPosixGroup = async () => {
		if (!child.pid) {
			await done;
			return;
		}
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		await done;
		const deadline = Date.now() + stopMs;
		while (groupAlive()) {
			if (Date.now() >= deadline) throw new VerificationStopUnconfirmedError();
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	let stopReason: string | undefined;
	let stopping: Promise<void> | undefined;
	let notifyStop!: (value: Promise<void>) => void;
	const stopStarted = new Promise<void>((resolve, reject) => {
		notifyStop = (operation) => {
			void operation.then(resolve, reject);
		};
	});
	void stopStarted.catch(() => {});
	const stop = (reason: string) => {
		if (stopping) return;
		stopReason = reason;
		stopping = bounded(
			(async () => {
				if (windows) {
					if (!closed) child.stdin?.end("stop\n");
					await done;
					if (!spawnError) await receipt;
				} else await stopPosixGroup();
			})(),
		);
		notifyStop(stopping);
		void stopping.catch(() => {});
	};
	const hash = createHash("sha256");
	const preview: Buffer[] = [];
	let previewSize = 0,
		outputSize = 0;
	const collect = (chunk: Buffer) => {
		hash.update(chunk);
		outputSize += chunk.length;
		if (previewSize < PREVIEW_BYTES) {
			const part = chunk.subarray(0, PREVIEW_BYTES - previewSize);
			preview.push(part);
			previewSize += part.length;
		}
		if (outputSize > MAX_OUTPUT_BYTES) stop("output limit exceeded");
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const abort = () => stop("cancelled");
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) abort();
	const timer = setTimeout(() => stop("timed out"), options.timeoutMs ?? VERIFICATION_COMMAND_TIMEOUT_MS);
	try {
		await Promise.race([done, stopStarted]);
		if (stopping) await stopping;
		if (windows && !spawnError) {
			await bounded(receipt);
			const signedExit =
				closeCode !== null && Number.isInteger(closeCode) && closeCode >= -2147483648 && closeCode <= 4294967295
					? closeCode | 0
					: undefined;
			if (signedExit === undefined || windowsReceipt !== signedExit) throw new VerificationStopUnconfirmedError();
		}
		if (!windows && groupAlive()) {
			stop("surviving foreground descendants");
			await stopping;
		}
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Verification cancelled");
		const exitCode = windows && windowsReceipt !== undefined ? windowsReceipt : closeCode;
		const passed = !stopReason && !spawnError && exitCode === 0;
		return {
			command,
			status: passed ? "passed" : "failed",
			exitCode: passed ? 0 : exitCode || 1,
			outputDigest: hash.digest("hex"),
			outputPreview: Buffer.concat(preview).toString("utf8"),
		};
	} catch (error) {
		if (windows && error instanceof VerificationStopUnconfirmedError && !closed) child.kill();
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		for (const socket of sockets) socket.destroy();
		control?.close();
	}
}
