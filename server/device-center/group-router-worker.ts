import type { RouterAction, RouterJob } from "./group-router.js";
import type { GroupRouterContext } from "./group-router-runtime.js";

export interface GroupRouterWorkerOptions {
	request: (path: string, method?: string, body?: unknown) => Promise<unknown>;
	run: (job: RouterJob, context: GroupRouterContext, signal: AbortSignal) => Promise<RouterAction[]>;
	pollIntervalMs?: number;
	renewIntervalMs?: number;
	requestTimeoutMs?: number;
	onError?: (error: unknown) => void;
}

function interval(value: number | undefined, fallback: number): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1 || result > 21_600_000)
		throw new Error("Router worker interval must be between 1ms and 6h");
	return result;
}

async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	let abort!: () => void;
	const interrupted = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([operation, interrupted]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export function createGroupRouterWorker(options: GroupRouterWorkerOptions): { start(): void; close(): void } {
	const { request, run, onError } = options;
	const pollMs = interval(options.pollIntervalMs, 2_000);
	const renewMs = interval(options.renewIntervalMs, 10_000);
	const requestMs = interval(options.requestTimeoutMs, 30_000);
	const lifetime = new AbortController();
	let started = false;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;
	const report = (error: unknown) => {
		try {
			onError?.(error);
		} catch {}
	};
	const call = async (path: string, method = "GET", body?: unknown, signal = lifetime.signal) => {
		signal.throwIfAborted();
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(new Error("Router request timed out")), requestMs);
		timer.unref();
		const combined = AbortSignal.any([signal, timeout.signal]);
		try {
			const response = await untilAborted(request(path, method, body), combined);
			combined.throwIfAborted();
			return response;
		} finally {
			clearTimeout(timer);
		}
	};
	const processJob = async (job: RouterJob, context: GroupRouterContext | undefined) => {
		if (!job.id || !job.leaseToken) throw new Error("Router job is missing its lease identity");
		const path = `/api/agent/router/jobs/${encodeURIComponent(job.id)}`;
		const leaseToken = job.leaseToken;
		const controller = new AbortController();
		const signal = AbortSignal.any([lifetime.signal, controller.signal]);
		let renewTimer: ReturnType<typeof setTimeout> | undefined;
		let expiryTimer: ReturnType<typeof setTimeout> | undefined;
		let renewing: Promise<void> | undefined;
		let finishing = false;
		let expiresAt = job.leaseExpiresAt ?? Date.now() + 60_000;
		const leaseMs = expiresAt - Date.now();
		const armExpiry = () => {
			clearTimeout(expiryTimer);
			const remaining = expiresAt - Date.now();
			if (remaining <= 0) {
				controller.abort(new Error("Router lease expired"));
				return;
			}
			expiryTimer = setTimeout(() => controller.abort(new Error("Router lease expired")), Math.min(remaining, 600_000));
			expiryTimer.unref();
		};
		const armRenew = () => {
			if (finishing || signal.aborted) return;
			renewTimer = setTimeout(
				() => {
					renewing = (async () => {
						try {
							const result = (await call(`${path}/renew`, "POST", { leaseToken }, signal)) as
								{ job?: { leaseExpiresAt?: number }; leaseExpiresAt?: number } | undefined;
							signal.throwIfAborted();
							expiresAt = result?.job?.leaseExpiresAt ?? result?.leaseExpiresAt ?? Date.now() + leaseMs;
							if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 600_000)
								throw new Error("Invalid router lease renewal");
							armExpiry();
						} catch (error) {
							controller.abort(error);
						}
					})().finally(() => {
						renewing = undefined;
						armRenew();
					});
				},
				Math.max(1, Math.min(renewMs, Math.floor((expiresAt - Date.now()) / 3))),
			);
			renewTimer.unref();
		};
		try {
			if (!Number.isSafeInteger(expiresAt) || leaseMs <= 0 || leaseMs > 600_000)
				throw new Error("Invalid or expired router lease");
			if (!context && job.actions === undefined) throw new Error("Router job context is missing");
			armExpiry();
			signal.throwIfAborted();
			armRenew();
			const actions =
				job.actions !== undefined
					? structuredClone(job.actions)
					: await untilAborted(
							Promise.resolve().then(() => {
								signal.throwIfAborted();
								return run(job, context as GroupRouterContext, signal);
							}),
							signal,
						);
			finishing = true;
			clearTimeout(renewTimer);
			await renewing;
			signal.throwIfAborted();
			await call(`${path}/complete`, "POST", { leaseToken, actions }, signal);
		} catch (error) {
			finishing = true;
			clearTimeout(renewTimer);
			await renewing;
			if (!lifetime.signal.aborted) {
				try {
					await call(`${path}/fail`, "POST", {
						leaseToken,
						error: String(error instanceof Error ? error.message : error).slice(0, 4_096),
					});
				} catch (failure) {
					report(failure);
				}
			}
			throw error;
		} finally {
			finishing = true;
			clearTimeout(renewTimer);
			clearTimeout(expiryTimer);
			controller.abort();
		}
	};
	const schedule = (delay: number) => {
		if (lifetime.signal.aborted) return;
		pollTimer = setTimeout(() => void poll(), delay);
		pollTimer.unref();
	};
	const poll = async () => {
		try {
			const response = (await call("/api/agent/router/jobs/next")) as {
				job: RouterJob | null;
				context?: GroupRouterContext;
			};
			if (!response || !("job" in response)) throw new Error("Invalid router job response");
			if (response.job) await processJob(response.job, response.context);
			failures = 0;
		} catch (error) {
			if (!lifetime.signal.aborted) {
				failures++;
				report(error);
			}
		} finally {
			schedule(Math.max(pollMs, Math.min(60_000, failures ? 1_000 * 2 ** Math.min(failures - 1, 6) : 0)));
		}
	};
	return {
		start() {
			if (started || lifetime.signal.aborted) return;
			started = true;
			schedule(0);
		},
		close() {
			lifetime.abort(new Error("Router worker closed"));
			clearTimeout(pollTimer);
		},
	};
}
