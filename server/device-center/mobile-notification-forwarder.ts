import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MobileNotificationEvent } from "../mobile-notification-events.js";
import type { LocalDeviceConfig } from "./local.js";

type Binding = Pick<LocalDeviceConfig, "hubUrl" | "deviceId" | "credential" | "uiCredential" | "accountId">;
type WireEvent = Pick<
	MobileNotificationEvent,
	"eventId" | "kind" | "clientId" | "sessionId" | "conversationId" | "occurredAt"
>;
interface Pending {
	binding: string;
	event: WireEvent;
	attempts: number;
	nextAttemptAt: number;
}
interface Outbox {
	version: 1;
	blocked?: string;
	entries: Pending[];
}
interface Options {
	dataDir: string;
	/** Read the existing binding store on every operation; never cache credentials. */
	getBinding(): Binding | undefined;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
}

const TTL = 24 * 60 * 60 * 1000;
const CAPACITY = 256;
const MAX_ATTEMPTS = 32;
const REQUEST_TIMEOUT = 15_000;
const MAX_FILE_BYTES = 1024 * 1024;
const kinds = new Set(["done", "error", "question", "approval", "subagentDone"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

/** Copy the content-free wire allowlist, including when restoring an outbox. */
function wireEvent(value: MobileNotificationEvent): WireEvent {
	if (
		!value ||
		!text(value.eventId) ||
		!kinds.has(value.kind) ||
		!text(value.clientId) ||
		!text(value.sessionId) ||
		(value.conversationId !== undefined && !text(value.conversationId)) ||
		!Number.isSafeInteger(value.occurredAt) ||
		value.occurredAt < 0
	)
		throw new Error("Invalid mobile notification event");
	return {
		eventId: value.eventId,
		kind: value.kind,
		clientId: value.clientId,
		sessionId: value.sessionId,
		...(value.conversationId !== undefined ? { conversationId: value.conversationId } : {}),
		occurredAt: value.occurredAt,
	};
}

function bindingIdentity(binding: Binding): string {
	const url = new URL(binding.hubUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		binding.hubUrl.length > 2048 ||
		!text(binding.deviceId) ||
		!binding.credential
	)
		throw new Error("Invalid device binding");
	// Hash every ownership credential, without persisting any credential or account data.
	return hash(
		JSON.stringify([
			url.origin,
			binding.deviceId,
			binding.accountId ?? null,
			binding.credential,
			binding.uiCredential ?? null,
		]),
	);
}

/**
 * Durable, bounded, at-least-once delivery. enqueue waits only for the local atomic
 * write; the Hub's eventId deduplication covers a crash after acceptance, before deletion.
 * One forwarder owns this dataDir. Construct after loading the existing device binding.
 */
export function createMobileNotificationForwarder(options: Options): {
	enqueue(event: MobileNotificationEvent): Promise<void>;
	dispose(): Promise<void>;
} {
	const file = join(options.dataDir, "device-mobile-notifications.json");
	const now = options.now ?? Date.now;
	const fetchHub = options.fetch ?? globalThis.fetch;
	let state: Outbox = { version: 1, entries: [] };
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> | undefined;
	let controller: AbortController | undefined;
	let serial: Promise<unknown> = Promise.resolve();

	function binding() {
		const value = options.getBinding();
		if (!value) return undefined;
		const config = { ...value };
		return { config, identity: bindingIdentity(config) };
	}
	function transaction<T>(operation: () => Promise<T>): Promise<T> {
		const result = serial.then(operation);
		serial = result.catch(() => {});
		return result;
	}
	async function commit(next: Outbox) {
		const data = JSON.stringify(next);
		if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error("Mobile notification outbox exceeds limit");
		await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, data, { mode: 0o600 });
			await rename(temporary, file);
			state = next;
		} finally {
			await rm(temporary, { force: true });
		}
	}
	function prune(): Outbox {
		const current = binding();
		return {
			version: 1,
			...(state.blocked === current?.identity ? { blocked: state.blocked } : {}),
			entries: state.entries.filter(
				(entry) =>
					entry.binding === current?.identity &&
					entry.binding !== state.blocked &&
					entry.event.occurredAt + TTL > now() &&
					entry.event.occurredAt <= now() + 60_000 &&
					entry.attempts < MAX_ATTEMPTS,
			),
		};
	}
	const ready = transaction(async () => {
		try {
			if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error("Mobile notification outbox exceeds limit");
			const saved = JSON.parse(await readFile(file, "utf8")) as Outbox;
			if (
				saved.version !== 1 ||
				!Array.isArray(saved.entries) ||
				saved.entries.length > CAPACITY ||
				(saved.blocked !== undefined && !/^[a-f0-9]{64}$/.test(saved.blocked))
			) {
				throw new Error("Invalid mobile notification outbox");
			}
			state = {
				version: 1,
				blocked: saved.blocked,
				entries: saved.entries.map((entry) => {
					if (
						!/^[a-f0-9]{64}$/.test(entry.binding) ||
						!Number.isSafeInteger(entry.attempts) ||
						entry.attempts < 0 ||
						!Number.isSafeInteger(entry.nextAttemptAt) ||
						entry.nextAttemptAt < 0
					)
						throw new Error("Invalid mobile notification outbox");
					return {
						binding: entry.binding,
						event: wireEvent(entry.event),
						attempts: entry.attempts,
						nextAttemptAt: entry.nextAttemptAt,
					};
				}),
			};
			await commit(prune());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	});

	function wake(delay = 0) {
		if (closed || running) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(
			() => {
				timer = undefined;
				running = pump()
					.catch(() => {
						// Keep the durable entry if local I/O fails; do not expose transport secrets.
					})
					.finally(() => {
						running = undefined;
						if (closed || !state.entries.length) return;
						const due = Math.min(
							...state.entries.map((entry) => Math.min(entry.nextAttemptAt, entry.event.occurredAt + TTL)),
						);
						wake(Math.max(1000, due - now()));
					});
			},
			Math.max(0, Math.min(delay, 60 * 60 * 1000)),
		);
		timer.unref?.();
	}

	async function request(
		config: Binding,
		event: WireEvent,
		identity: string,
		signal: AbortSignal,
	): Promise<number | undefined> {
		const origin = new URL(config.hubUrl).origin;
		if (config.uiCredential) {
			// using the execution credential, which by itself could resolve a new owner.
			const verification = await fetchHub(`${origin}/api/device-user/devices`, {
				method: "GET",
				redirect: "error",
				signal,
				headers: { "X-Device-Id": config.deviceId, Authorization: `Bearer ${config.uiCredential}` },
			});
			void verification.body?.cancel().catch(() => {});
			if (!verification.ok) return verification.status;
		}
		if (closed || signal.aborted || event.occurredAt + TTL <= now() || binding()?.identity !== identity)
			return undefined;
		const response = await fetchHub(`${origin}/api/agent/mobile-notifications`, {
			method: "POST",
			redirect: "error",
			signal,
			headers: {
				"Content-Type": "application/json",
				"X-Device-Id": config.deviceId,
				Authorization: `Bearer ${config.credential}`,
			},
			body: JSON.stringify(event),
		});
		// No unbounded JSON body or remote error strings enter the outbox or logs.
		void response.body?.cancel().catch(() => {});
		return response.status;
	}
	async function pump() {
		await ready;
		while (!closed) {
			const selection = await transaction(async () => {
				const next = prune();
				const entry = next.entries.find((item) => item.nextAttemptAt <= now());
				if (!entry) {
					if (JSON.stringify(next) !== JSON.stringify(state)) await commit(next);
					return undefined;
				}
				const current = binding();
				if (!current || current.identity !== entry.binding) return undefined;
				const attempted = {
					...entry,
					attempts: entry.attempts + 1,
					nextAttemptAt: now() + Math.min(60 * 60 * 1000, 5000 * 2 ** entry.attempts),
				};
				await commit({ ...next, entries: next.entries.map((item) => (item === entry ? attempted : item)) });
				return { entry: attempted, ...current };
			});
			if (!selection || closed) return;
			// Recheck after the atomic write: a binding may change across any await.
			if (binding()?.identity !== selection.identity) continue;
			controller = new AbortController();
			const active = controller;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let status: number | undefined;
			try {
				status = await Promise.race([
					request(selection.config, selection.entry.event, selection.identity, active.signal),
					new Promise<never>((_, reject) => {
						active.signal.addEventListener("abort", () => reject(new Error("Mobile notification request aborted")), {
							once: true,
						});
						timeout = setTimeout(() => active.abort(), REQUEST_TIMEOUT);
						timeout.unref?.();
					}),
				]);
			} catch {
				// Network failures and timeouts retain the pre-written bounded retry.
			} finally {
				clearTimeout(timeout);
				controller = undefined;
			}
			await transaction(async () => {
				let next = prune();
				if (status === 401 || status === 403) {
					if (binding()?.identity === selection.identity) next.blocked = selection.identity;
					next.entries = next.entries.filter((entry) => entry.binding !== selection.identity);
				} else if (status !== undefined && ((status >= 200 && status < 300) || (status !== 429 && status < 500))) {
					next.entries = next.entries.filter((entry) => entry !== selection.entry);
				}
				await commit(next);
			});
		}
	}

	void ready.then(
		() => wake(),
		() => {},
	);
	return {
		async enqueue(event) {
			if (closed) return;
			const captured = binding();
			if (!captured) return;
			const safe = wireEvent(event);
			await ready;
			await transaction(async () => {
				if (closed || binding()?.identity !== captured.identity) return;
				const next = prune();
				if (next.blocked === captured.identity || safe.occurredAt + TTL <= now() || safe.occurredAt > now() + 60_000)
					return;
				if (!next.entries.some((entry) => entry.event.eventId === safe.eventId)) {
					if (next.entries.length >= CAPACITY) throw new Error("Mobile notification outbox is full");
					next.entries.push({ binding: captured.identity, event: safe, attempts: 0, nextAttemptAt: now() });
				}
				await commit(next);
			});
			wake();
		},
		async dispose() {
			closed = true;
			clearTimeout(timer);
			controller?.abort();
			await running;
			await serial;
		},
	};
}
