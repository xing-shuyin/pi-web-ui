import express, { type Express } from "express";
import type { IncomingMessage } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Device, DeviceHubStore } from "./store.js";
import { DEVICE_FILE_SYNC_LIMITS } from "./file-sync.js";
import {
	CHUNKED_TRANSFER_LIMITS as TRANSFER_LIMITS,
	validateChunkedManifest,
	type ChunkedTransferManifest,
} from "./transfer-stream.js";

export type TransferRelay = {
	callDevice(
		id: string,
		action:
			| "transfer_stage"
			| "transfer_preview"
			| "transfer_apply"
			| "transfer_init"
			| "transfer_chunk"
			| "transfer_status"
			| "transfer_abort"
			| "transfer_prepare_export"
			| "transfer_read_chunk"
			| "transfer_fence",
		payload: unknown,
		options?: { signal?: AbortSignal },
	): Promise<unknown>;
};
type Authenticate = (
	req: IncomingMessage,
) => Promise<{ device: Pick<Device, "id" | "accountId">; account: { id: string } } | undefined>;
type UserJob = {
	idempotencyKey: string;
	fingerprint: string;
	paths: string[];
	recursive: boolean;
	status:
		"queued" | "staging" | "interrupted" | "ready" | "applying" | "applied" | "failed" | "cancelling" | "cancelled";
	manifest?: ChunkedTransferManifest;
	manifestHash?: string;
	summary: Record<string, unknown>;
	stopUnconfirmed?: boolean;
	error?: string;
};
type Receipt = {
	id: string;
	sourceDeviceId: string;
	sourceBotId: string;
	targetBotId: string;
	sourceBotRevision: number;
	targetBotRevision: number;
	accountId: string;
	roomId: string;
	targetDeviceId: string;
	localTransferId: string;
	roomMembers: string;
	expiresAt: number;
	applyStarted?: boolean;
	job?: UserJob;
};
type Options = {
	app: Express;
	dataDir: string;
	relay: TransferRelay;
	hub?: {
		store: DeviceHubStore;
		authenticateAgent: Authenticate;
		getRelayAccount?: (req: IncomingMessage) => { id: string } | undefined;
	};
	store?: DeviceHubStore;
	authenticateAgent?: Authenticate;
	getAccount?: (req: IncomingMessage) => { id: string } | undefined;
};
function membership(ids: string[]) {
	return createHash("sha256")
		.update(JSON.stringify([...ids].sort()))
		.digest("hex");
}
const TTL = 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 1000;
const MAX_REGISTRY_BYTES = 32 * 1024 * 1024;
const MAX_PACKET = 12 * 1024 * 1024;
function fail(status: number, message: string): never {
	throw Object.assign(new Error(message), { status });
}
function field(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}
/** Never forward opaque device responses (which could contain file data or credentials). */
export function transferSummary(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of [
		"revision",
		"totalBytes",
		"version",
		"status",
		"percent",
		"chunkIndex",
		"received",
		"totalChunks",
		"transferredBytes",
		"totalFiles",
		"completedFiles",
	]) {
		if (typeof source[key] === "number" || typeof source[key] === "string" || typeof source[key] === "boolean")
			result[key] = source[key];
	}
	if (Array.isArray(source.receivedChunks)) {
		result.receivedChunks = source.receivedChunks.filter((v): v is number => Number.isSafeInteger(v)).slice(0, 4096);
	}
	for (const key of ["applied", "unchanged"]) {
		if (Array.isArray(source[key]))
			result[key] = source[key].filter((v): v is string => typeof v === "string").slice(0, 200);
	}
	for (const key of ["files", "rejected"]) {
		if (!Array.isArray(source[key])) continue;
		const originalLength = source[key].length;
		result[key] = source[key].slice(0, 200).map((item: unknown) => {
			const entry: Record<string, unknown> = {};
			if (item && typeof item === "object")
				for (const k of ["path", "size", "sha256", "baseline", "status", "chunkCount", "firstChunkIndex", "offset"]) {
					const v = (item as Record<string, unknown>)[k];
					if (typeof v === "string" || typeof v === "number" || v === null) entry[k] = v;
				}
			return entry;
		});
		if (key === "files") {
			const count = Number.isSafeInteger(source.totalFiles) ? (source.totalFiles as number) : originalLength;
			result.totalFiles = count;
			result.truncated = count > (result.files as unknown[]).length;
		}
	}
	if (Number.isSafeInteger(source.totalExcluded) && (source.totalExcluded as number) >= 0)
		result.totalExcluded = source.totalExcluded;
	if (Array.isArray(source.exclusions)) {
		const exclusions: { path: string; reason: "ignored" | "sensitive" }[] = [];
		let bytes = 2; // JSON array brackets, including UTF-8 path bytes and escaping.
		for (const item of source.exclusions.slice(0, DEVICE_FILE_SYNC_LIMITS.exclusions)) {
			if (!item || typeof item !== "object") continue;
			const { path, reason } = item;
			if (
				typeof path !== "string" ||
				!path ||
				Buffer.byteLength(path) > 1024 ||
				Buffer.from(path).toString("utf8") !== path ||
				path.normalize("NFC") !== path ||
				/[\\:\x00-\x1f\x7f<>"|?*]/.test(path) ||
				path.split("/").length > 32 ||
				path
					.split("/")
					.some(
						(part) =>
							!part ||
							part === "." ||
							part === ".." ||
							/[. ]$/.test(part) ||
							Buffer.byteLength(part) > 255 ||
							/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
					) ||
				(reason !== "ignored" && reason !== "sensitive")
			)
				continue;
			const entry = { path, reason };
			const additional = Buffer.byteLength(JSON.stringify(entry)) + (exclusions.length ? 1 : 0);
			if (bytes + additional > DEVICE_FILE_SYNC_LIMITS.exclusionBytes) break;
			bytes += additional;
			exclusions.push(entry);
		}
		result.exclusions = exclusions;
	}
	for (const key of ["manifest", "preview"])
		if (source[key] && typeof source[key] === "object") result[key] = transferSummary(source[key]);
	return result;
}

/** Await installation before serving requests: receipts are loaded before authorization is published. */
export async function installDeviceTransfers(options: Options) {
	const store = options.hub?.store ?? options.store;
	const authenticate = options.hub?.authenticateAgent ?? options.authenticateAgent;
	if (!store || !authenticate) throw new Error("Transfer authorization unavailable");
	const path = join(options.dataDir, "device-transfers.json");
	let receipts: Receipt[] = [];
	try {
		if ((await stat(path)).size > MAX_REGISTRY_BYTES) throw new Error("Transfer registry storage limit reached");
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!Array.isArray(parsed) || parsed.length > MAX_RECEIPTS) throw new Error("Invalid transfer receipts");
		for (const row of parsed) {
			if (
				!row ||
				![
					row.id,
					row.sourceBotId,
					row.targetBotId,
					row.sourceDeviceId,
					row.accountId,
					row.roomId,
					row.targetDeviceId,
					row.localTransferId,
				].every(field) ||
				!field(row.roomMembers) ||
				!Number.isSafeInteger(row.sourceBotRevision) ||
				!Number.isSafeInteger(row.targetBotRevision) ||
				!Number.isFinite(row.expiresAt) ||
				(row.applyStarted !== undefined && typeof row.applyStarted !== "boolean") ||
				(row.job !== undefined &&
					((row.job.stopUnconfirmed !== undefined && typeof row.job.stopUnconfirmed !== "boolean") ||
						!field(row.job.idempotencyKey) ||
						!field(row.job.fingerprint) ||
						!Array.isArray(row.job.paths) ||
						row.job.paths.length > DEVICE_FILE_SYNC_LIMITS.files ||
						!row.job.paths.every(field) ||
						typeof row.job.recursive !== "boolean" ||
						![
							"queued",
							"staging",
							"interrupted",
							"ready",
							"applying",
							"applied",
							"failed",
							"cancelling",
							"cancelled",
						].includes(row.job.status) ||
						!row.job.summary ||
						typeof row.job.summary !== "object"))
			)
				throw new Error("Invalid transfer receipts");
			if (row.job?.manifest) {
				validateChunkedManifest(row.job.manifest);
				if (
					row.job.manifest.transferId !== row.localTransferId ||
					createHash("sha256").update(JSON.stringify(row.job.manifest)).digest("hex") !== row.job.manifestHash ||
					row.job.manifest.files.some(
						(file: { chunkHashes?: string[]; chunkCount: number }) => file.chunkHashes?.length !== file.chunkCount,
					)
				)
					throw new Error("Invalid persisted manifest binding");
			}
		}
		receipts = parsed.filter((row: Receipt) => row.expiresAt > Date.now() || row.job?.stopUnconfirmed);
		for (const row of receipts)
			if (row.job && ["queued", "staging", "cancelling", "applying"].includes(row.job.status)) {
				row.job.status = row.applyStarted ? "failed" : "interrupted";
				row.job.error = row.applyStarted
					? "Apply outcome requires inspection"
					: "Transfer interrupted; explicitly resume the saved manifest";
			}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Transfer receipt storage unavailable");
	}
	let queue: Promise<unknown> = Promise.resolve();
	function transact<T>(fn: (draft: Receipt[]) => T): Promise<T> {
		const job = queue.then(async () => {
			const draft = structuredClone(receipts.filter((row) => row.expiresAt > Date.now() || row.job?.stopUnconfirmed));
			const result = fn(draft);
			if (Buffer.byteLength(JSON.stringify(draft)) > MAX_REGISTRY_BYTES)
				fail(429, "Transfer registry storage limit reached");
			await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
			const temp = `${path}.${randomUUID()}.tmp`;
			try {
				const handle = await open(temp, "wx", 0o600);
				try {
					await handle.writeFile(JSON.stringify(draft));
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temp, path);
			} finally {
				await unlink(temp).catch(() => {});
			}
			receipts = draft;
			return result;
		});
		queue = job.catch(() => {});
		return job;
	}
	let inFlight = 0;
	const devices = new Set<string>();
	options.app.post(
		"/api/agent/transfers",
		express.json({ limit: MAX_PACKET, strict: true, inflate: false }),
		async (req, res) => {
			const controller = new AbortController();
			const abort = () => controller.abort();
			req.once("aborted", abort);
			res.once("close", abort);
			const timer = setTimeout(abort, 60000);
			timer.unref();
			let sourceId: string | undefined;
			try {
				const auth = await authenticate(req);
				controller.signal.throwIfAborted();
				if (!auth) fail(401, "Device authentication required");
				const body = req.body;
				if (
					!body ||
					Buffer.byteLength(JSON.stringify(body)) > MAX_PACKET ||
					!["stage", "preview", "apply", "init", "chunk", "status", "abort"].includes(body.action) ||
					!field(body.roomId) ||
					!field(body.sourceBotId) ||
					!field(body.targetBotId)
				)
					fail(400, "Invalid transfer request");
				const initial = store.snapshot();
				const sourceHash = initial.devices.find((d) => d.id === auth.device.id)?.credentialHash;
				const sourceBot = initial.bots.find((b) => b.id === body.sourceBotId);
				const targetBot = initial.bots.find((b) => b.id === body.targetBotId);
				const targetDeviceId = targetBot?.deviceId;
				const roomMembers = membership(initial.rooms.find((r) => r.id === body.roomId)?.botIds ?? []);
				const authorize = () => {
					const state = store.snapshot();
					const source = state.devices.find((d) => d.id === auth.device.id);
					const target = state.devices.find((d) => d.id === targetDeviceId);
					const currentSource = state.bots.find((b) => b.id === body.sourceBotId);
					const currentTarget = state.bots.find((b) => b.id === body.targetBotId);
					const room = state.rooms.find((r) => r.id === body.roomId && r.accountId === auth.account.id);
					if (
						!source ||
						source.accountId !== auth.account.id ||
						source.credentialHash !== sourceHash ||
						!target ||
						target.accountId !== auth.account.id ||
						!room ||
						!currentSource?.enabled ||
						!currentTarget?.enabled ||
						currentSource.deviceId !== source.id ||
						currentTarget.deviceId !== target.id ||
						currentSource.accountId !== auth.account.id ||
						currentTarget.accountId !== auth.account.id ||
						currentSource.revision !== sourceBot?.revision ||
						currentTarget.revision !== targetBot?.revision ||
						!room.botIds.includes(currentSource.id) ||
						!room.botIds.includes(currentTarget.id) ||
						membership(room.botIds) !== roomMembers
					)
						fail(403, "Transfer access denied");
				};
				authorize();
				if (inFlight >= 4 || devices.has(auth.device.id)) fail(429, "Transfer busy");
				sourceId = auth.device.id;
				devices.add(sourceId);
				inFlight++;
				let receipt: Receipt;
				let result: unknown;
				if (body.action === "stage") {
					if (!body.bundle || typeof body.bundle !== "object") fail(400, "Bundle required");
					await queue;
					if (receipts.filter((r) => r.expiresAt > Date.now()).length >= MAX_RECEIPTS)
						fail(429, "Transfer receipt limit reached");
					result = await options.relay.callDevice(
						targetDeviceId!,
						"transfer_stage",
						{
							roomId: body.roomId,
							sourceBotId: body.sourceBotId,
							targetBotId: body.targetBotId,
							sourceBotRevision: sourceBot!.revision,
							targetBotRevision: targetBot!.revision,
							bundle: body.bundle,
						},
						{ signal: controller.signal },
					);
					controller.signal.throwIfAborted();
					authorize();
					const local = result as { id?: unknown; transferId?: unknown };
					const localId = local?.transferId ?? local?.id;
					if (!field(localId)) fail(502, "Invalid device transfer response");
					receipt = {
						id: randomUUID(),
						sourceDeviceId: auth.device.id,
						accountId: auth.account.id,
						roomId: body.roomId,
						targetDeviceId: targetDeviceId!,
						sourceBotId: sourceBot!.id,
						targetBotId: targetBot!.id,
						sourceBotRevision: sourceBot!.revision,
						targetBotRevision: targetBot!.revision,
						localTransferId: localId,
						roomMembers,
						expiresAt: Date.now() + TTL,
					};
					await transact((draft) => {
						if (draft.length >= MAX_RECEIPTS) fail(429, "Transfer receipt limit reached");
						draft.push(receipt);
					});
				} else if (body.action === "init") {
					if (!body.manifest || typeof body.manifest !== "object") fail(400, "Manifest required");
					await queue;
					if (receipts.filter((r) => r.expiresAt > Date.now()).length >= MAX_RECEIPTS)
						fail(429, "Transfer receipt limit reached");
					result = await options.relay.callDevice(
						targetDeviceId!,
						"transfer_init",
						{
							roomId: body.roomId,
							sourceBotId: body.sourceBotId,
							targetBotId: body.targetBotId,
							sourceBotRevision: sourceBot!.revision,
							targetBotRevision: targetBot!.revision,
							manifest: body.manifest,
						},
						{ signal: controller.signal },
					);
					controller.signal.throwIfAborted();
					authorize();
					const local = result as { id?: unknown; transferId?: unknown };
					const localId = local?.transferId ?? local?.id;
					if (!field(localId)) fail(502, "Invalid device transfer response");
					receipt = {
						id: randomUUID(),
						sourceDeviceId: auth.device.id,
						accountId: auth.account.id,
						roomId: body.roomId,
						targetDeviceId: targetDeviceId!,
						sourceBotId: sourceBot!.id,
						targetBotId: targetBot!.id,
						sourceBotRevision: sourceBot!.revision,
						targetBotRevision: targetBot!.revision,
						localTransferId: localId,
						roomMembers,
						expiresAt: Date.now() + TTL,
					};
					await transact((draft) => {
						if (draft.length >= MAX_RECEIPTS) fail(429, "Transfer receipt limit reached");
						draft.push(receipt);
					});
				} else if (body.action === "chunk") {
					if (!field(body.transferId) || !body.chunk || typeof body.chunk !== "object")
						fail(400, "Transfer ID and chunk required");
					await queue;
					const found = receipts.find(
						(r) =>
							r.id === body.transferId &&
							r.expiresAt > Date.now() &&
							r.sourceDeviceId === auth.device.id &&
							r.accountId === auth.account.id &&
							r.roomId === body.roomId &&
							r.targetDeviceId === targetDeviceId &&
							r.sourceBotId === sourceBot!.id &&
							r.targetBotId === targetBot!.id &&
							r.sourceBotRevision === sourceBot!.revision &&
							r.targetBotRevision === targetBot!.revision &&
							r.roomMembers === roomMembers,
					);
					if (!found) fail(403, "Transfer access denied");
					receipt = { ...found };
					controller.signal.throwIfAborted();
					authorize();
					result = await options.relay.callDevice(
						receipt.targetDeviceId,
						"transfer_chunk",
						{
							roomId: receipt.roomId,
							sourceBotId: receipt.sourceBotId,
							targetBotId: receipt.targetBotId,
							sourceBotRevision: receipt.sourceBotRevision,
							targetBotRevision: receipt.targetBotRevision,
							transferId: receipt.localTransferId,
							chunk: { ...body.chunk, transferId: receipt.localTransferId },
						},
						{ signal: controller.signal },
					);
					controller.signal.throwIfAborted();
					authorize();
				} else if (body.action === "status") {
					if (!field(body.transferId)) fail(400, "Transfer ID required");
					await queue;
					const found = receipts.find(
						(r) =>
							r.id === body.transferId &&
							r.expiresAt > Date.now() &&
							r.sourceDeviceId === auth.device.id &&
							r.accountId === auth.account.id &&
							r.roomId === body.roomId &&
							r.targetDeviceId === targetDeviceId &&
							r.sourceBotId === sourceBot!.id &&
							r.targetBotId === targetBot!.id &&
							r.sourceBotRevision === sourceBot!.revision &&
							r.targetBotRevision === targetBot!.revision &&
							r.roomMembers === roomMembers,
					);
					if (!found) fail(403, "Transfer access denied");
					receipt = { ...found };
					controller.signal.throwIfAborted();
					authorize();
					result = await options.relay.callDevice(
						receipt.targetDeviceId,
						"transfer_status",
						{
							roomId: receipt.roomId,
							sourceBotId: receipt.sourceBotId,
							targetBotId: receipt.targetBotId,
							sourceBotRevision: receipt.sourceBotRevision,
							targetBotRevision: receipt.targetBotRevision,
							transferId: receipt.localTransferId,
						},
						{ signal: controller.signal },
					);
					controller.signal.throwIfAborted();
					authorize();
				} else if (body.action === "abort") {
					if (!field(body.transferId)) fail(400, "Transfer ID required");
					await queue;
					const found = receipts.find(
						(r) =>
							r.id === body.transferId &&
							r.expiresAt > Date.now() &&
							r.sourceDeviceId === auth.device.id &&
							r.accountId === auth.account.id &&
							r.roomId === body.roomId &&
							r.targetDeviceId === targetDeviceId &&
							r.sourceBotId === sourceBot!.id &&
							r.targetBotId === targetBot!.id &&
							r.sourceBotRevision === sourceBot!.revision &&
							r.targetBotRevision === targetBot!.revision &&
							r.roomMembers === roomMembers,
					);
					if (!found) fail(403, "Transfer access denied");
					receipt = { ...found };
					controller.signal.throwIfAborted();
					authorize();
					result = await options.relay.callDevice(
						receipt.targetDeviceId,
						"transfer_abort",
						{
							roomId: receipt.roomId,
							sourceBotId: receipt.sourceBotId,
							targetBotId: receipt.targetBotId,
							sourceBotRevision: receipt.sourceBotRevision,
							targetBotRevision: receipt.targetBotRevision,
							transferId: receipt.localTransferId,
						},
						{ signal: controller.signal },
					);
					controller.signal.throwIfAborted();
					authorize();
				} else {
					if (!field(body.transferId)) fail(400, "Transfer ID required");
					await queue;
					const found = receipts.find(
						(r) =>
							r.id === body.transferId &&
							r.expiresAt > Date.now() &&
							r.sourceDeviceId === auth.device.id &&
							r.accountId === auth.account.id &&
							r.roomId === body.roomId &&
							r.targetDeviceId === targetDeviceId &&
							r.sourceBotId === sourceBot!.id &&
							r.targetBotId === targetBot!.id &&
							r.sourceBotRevision === sourceBot!.revision &&
							r.targetBotRevision === targetBot!.revision &&
							r.roomMembers === roomMembers,
					);
					if (!found) fail(403, "Transfer access denied");
					receipt = { ...found };
					if (body.action === "apply") {
						if (
							!field(body.revision) ||
							!Array.isArray(body.overwritePaths) ||
							body.overwritePaths.length > 200 ||
							!body.overwritePaths.every((p: unknown) => typeof p === "string" && p.length > 0 && p.length <= 4096)
						)
							fail(400, "Explicit revision and overwrite paths required");
						// Persist consumption before the side effect. A lost response must never replay apply.
						await transact((draft) => {
							const row = draft.find((r) => r.id === receipt.id);
							if (!row || row.applyStarted) fail(409, "Apply already attempted; stage a new transfer");
							row.applyStarted = true;
						});
					}
					controller.signal.throwIfAborted();
					authorize();
					result = await options.relay.callDevice(
						receipt.targetDeviceId,
						body.action === "apply" ? "transfer_apply" : "transfer_preview",
						{
							roomId: receipt.roomId,
							sourceBotId: receipt.sourceBotId,
							targetBotId: receipt.targetBotId,
							sourceBotRevision: receipt.sourceBotRevision,
							targetBotRevision: receipt.targetBotRevision,
							transferId: receipt.localTransferId,
							...(body.action === "apply" ? { revision: body.revision, overwritePaths: body.overwritePaths } : {}),
						},
						{ signal: controller.signal },
					);
					controller.signal.throwIfAborted();
					authorize();
				}
				res.json({ ...transferSummary(result), transferId: receipt.id });
			} catch (error) {
				if (!res.destroyed && !res.headersSent) {
					const status = controller.signal.aborted ? 504 : ((error as { status?: number }).status ?? 502);
					res.status(status).json({
						error:
							status === 502
								? "Device transfer failed"
								: status === 504
									? "Transfer cancelled or timed out"
									: status === 403
										? "Transfer access denied"
										: status === 409
											? "Apply already attempted; stage a new transfer"
											: "Transfer request rejected",
					});
				}
			} finally {
				clearTimeout(timer);
				req.off("aborted", abort);
				res.off("close", abort);
				if (sourceId) {
					devices.delete(sourceId);
					inFlight--;
				}
			}
		},
	);

	function getOwner(req: IncomingMessage): { id: string } | undefined {
		const fromHub = options.hub?.getRelayAccount?.(req);
		if (fromHub) return fromHub;
		const fromCustom = options.getAccount?.(req);
		if (fromCustom) return fromCustom;
		return undefined;
	}

	// Human requests are persisted before scheduling; the Hub only coordinates fixed Bot RPCs.
	const running = new Map<
		string,
		{
			controller: AbortController;
			done: Promise<void>;
			deviceIds: string[];
			blocked: boolean;
			deadline: NodeJS.Timeout;
		}
	>();
	const maxJobs = 4;
	let closing = false;
	function releaseSlot(id: string) {
		const slot = running.get(id);
		if (!slot || slot.blocked) return;
		clearTimeout(slot.deadline);
		running.delete(id);
	}
	function authorize(row: Receipt) {
		const state = store!.snapshot();
		const room = state.rooms.find((r) => r.id === row.roomId && r.accountId === row.accountId);
		const source = state.bots.find((b) => b.id === row.sourceBotId && b.accountId === row.accountId);
		const target = state.bots.find((b) => b.id === row.targetBotId && b.accountId === row.accountId);
		if (
			!room ||
			membership(room.botIds ?? []) !== row.roomMembers ||
			!room.botIds.includes(row.sourceBotId) ||
			!room.botIds.includes(row.targetBotId) ||
			!source ||
			!target ||
			source.deviceId !== row.sourceDeviceId ||
			target.deviceId !== row.targetDeviceId ||
			source.revision !== row.sourceBotRevision ||
			target.revision !== row.targetBotRevision ||
			!source.enabled ||
			!target.enabled
		)
			fail(403, "Transfer scope changed");
		for (const id of [row.sourceDeviceId, row.targetDeviceId])
			if (!state.devices.some((d) => d.id === id && d.accountId === row.accountId))
				fail(403, "Transfer device unavailable");
	}
	function payload(row: Receipt) {
		return {
			roomId: row.roomId,
			sourceBotId: row.sourceBotId,
			targetBotId: row.targetBotId,
			sourceBotRevision: row.sourceBotRevision,
			targetBotRevision: row.targetBotRevision,
			transferId: row.localTransferId,
		};
	}
	async function rpc(
		row: Receipt,
		action: Parameters<TransferRelay["callDevice"]>[1],
		extra: Record<string, unknown>,
		signal: AbortSignal,
		source = false,
	) {
		signal.throwIfAborted();
		authorize(row);
		const result = await options.relay.callDevice(
			source ? row.sourceDeviceId : row.targetDeviceId,
			action,
			{
				...payload(row),
				...(source ? { targetBotId: row.sourceBotId, targetBotRevision: row.sourceBotRevision } : {}),
				...extra,
			},
			{ signal },
		);
		signal.throwIfAborted();
		authorize(row);
		return result;
	}
	async function updateJob(id: string, fn: (job: UserJob) => void) {
		return transact((draft) => {
			const row = draft.find((r) => r.id === id);
			if (!row?.job) fail(404, "Transfer missing");
			fn(row.job);
			return row;
		});
	}
	function view(row: Receipt) {
		return {
			...row.job?.summary,
			transferId: row.id,
			roomId: row.roomId,
			sourceBotId: row.sourceBotId,
			targetBotId: row.targetBotId,
			sourceBotRevision: row.sourceBotRevision,
			targetBotRevision: row.targetBotRevision,
			manifestHash: row.job?.manifestHash,
			status: row.job?.status ?? (row.applyStarted ? "applied" : "interrupted"),
			error: row.job?.error,
		};
	}
	function findUser(req: IncomingMessage & { params: Record<string, string> }) {
		const owner = getOwner(req);
		if (!owner) fail(401, "Authentication required");
		const row = receipts.find(
			(r) =>
				r.id === req.params.transferId &&
				r.roomId === req.params.id &&
				r.accountId === owner.id &&
				(r.expiresAt > Date.now() || r.job?.stopUnconfirmed === true),
		);
		if (!row) fail(404, "Transfer missing or expired");
		authorize(row);
		return row;
	}
	async function confirmStopped(row: Receipt) {
		if (!row.job?.stopUnconfirmed && !running.get(row.id)?.blocked) return;
		const signal = AbortSignal.timeout(30_000);
		for (const source of [true, false]) {
			const result = (await rpc(row, "transfer_fence", {}, signal, source)) as { ok?: boolean };
			if (result?.ok !== true) fail(409, "Device IO stop not confirmed");
		}
		authorize(row);
		await updateJob(row.id, (job) => {
			delete job.stopUnconfirmed;
		});
		authorize(row);
		const slot = running.get(row.id);
		if (slot?.blocked) {
			slot.blocked = false;
			releaseSlot(row.id);
		}
	}
	function responseError(res: express.Response, error: unknown) {
		const status = Number((error as { status?: number })?.status) || 502;
		res.status(status).json({
			error:
				status === 502 ? "Transfer operation failed; inspect status and resume explicitly" : (error as Error).message,
		});
	}
	function reserve(row: Receipt) {
		if (closing) fail(503, "Transfer scheduler closing");
		if (running.has(row.id)) fail(409, "Transfer operation already running");
		if (
			receipts.some(
				(r) =>
					r.job?.stopUnconfirmed &&
					[r.sourceDeviceId, r.targetDeviceId].some((d) => d === row.sourceDeviceId || d === row.targetDeviceId),
			)
		)
			fail(409, "Device IO stop unconfirmed; recovery required");
		if (
			running.size >= maxJobs ||
			[...running.values()].some((slot) =>
				slot.deviceIds.some((d) => d === row.sourceDeviceId || d === row.targetDeviceId),
			)
		)
			fail(429, "Transfer capacity busy");
		const controller = new AbortController();
		const deadline = setTimeout(() => controller.abort(new Error("Transfer deadline exceeded")), 20 * 60 * 1000);
		deadline.unref();
		const slot = {
			controller,
			done: Promise.resolve(),
			deviceIds: [row.sourceDeviceId, row.targetDeviceId],
			blocked: false,
			deadline,
		};
		running.set(row.id, slot);
		return slot;
	}
	function schedule(row: Receipt, slot: ReturnType<typeof reserve>) {
		const signal = slot.controller.signal;
		slot.done = (async () => {
			try {
				row = await updateJob(row.id, (j) => {
					j.status = "staging";
					delete j.error;
				});
				signal.throwIfAborted();
				authorize(row);
				let manifest = row.job!.manifest;
				if (!manifest) {
					const result = (await rpc(
						row,
						"transfer_prepare_export",
						{ paths: row.job!.paths, recursive: row.job!.recursive },
						signal,
						true,
					)) as ChunkedTransferManifest | { manifest: ChunkedTransferManifest };
					manifest = "manifest" in result ? result.manifest : result;
					if (
						!manifest ||
						manifest.version !== 2 ||
						!Array.isArray(manifest.files) ||
						manifest.files.length > TRANSFER_LIMITS.maxFiles ||
						!Number.isSafeInteger(manifest.totalBytes) ||
						manifest.totalBytes > TRANSFER_LIMITS.maxTransferBytes ||
						!Number.isSafeInteger(manifest.totalChunks) ||
						manifest.totalChunks >
							TRANSFER_LIMITS.maxTransferBytes / TRANSFER_LIMITS.minChunkBytes + TRANSFER_LIMITS.maxFiles
					)
						fail(502, "Invalid manifest");
					manifest = { ...manifest, transferId: row.localTransferId };
					validateChunkedManifest(manifest);
					if (manifest.files.some((file) => !file.chunkHashes || file.chunkHashes.length !== file.chunkCount))
						fail(502, "Source chunk hashes required");
					const saved = manifest;
					row = await updateJob(row.id, (j) => {
						j.manifest = saved;
						j.manifestHash = createHash("sha256").update(JSON.stringify(saved)).digest("hex");
						j.summary = transferSummary(saved);
					});
					signal.throwIfAborted();
					authorize(row);
				}
				const initial = (await rpc(row, "transfer_init", { manifest }, signal)) as { receivedChunks?: number[] };
				const received = new Set(initial.receivedChunks ?? []);
				for (const file of manifest.files) {
					for (let i = 0; i < file.chunkCount; i++) {
						const chunkIndex = file.firstChunkIndex + i;
						if (received.has(chunkIndex)) continue;
						const chunk = (await rpc(
							row,
							"transfer_read_chunk",
							{
								path: file.path,
								offset: i * manifest.chunkSize,
								size: Math.min(manifest.chunkSize, file.size - i * manifest.chunkSize),
								expectedFileSize: file.size,
								expectedChunkSha256: file.chunkHashes![i],
							},
							signal,
							true,
						)) as { data?: string; sha256?: string };
						if (
							typeof chunk.data !== "string" ||
							typeof chunk.sha256 !== "string" ||
							chunk.sha256 !== file.chunkHashes![i] ||
							createHash("sha256").update(Buffer.from(chunk.data, "base64")).digest("hex") !== chunk.sha256
						)
							fail(502, "Invalid source chunk");
						const progress = await rpc(
							row,
							"transfer_chunk",
							{
								chunk: {
									transferId: row.localTransferId,
									chunkIndex,
									path: file.path,
									offset: i * manifest.chunkSize,
									size: Math.min(manifest.chunkSize, file.size - i * manifest.chunkSize),
									data: chunk.data,
									sha256: chunk.sha256,
								},
							},
							signal,
						);
						row = await updateJob(row.id, (j) => {
							j.summary = { ...j.summary, ...transferSummary(progress) };
						});
						signal.throwIfAborted();
						authorize(row);
					}
				}
				const preview = await rpc(row, "transfer_preview", {}, signal);
				await updateJob(row.id, (j) => {
					j.status = "ready";
					j.summary = { ...j.summary, ...transferSummary(preview) };
				});
			} catch (error) {
				slot.blocked = !!(error as { stopUnconfirmed?: boolean })?.stopUnconfirmed;
				await updateJob(row.id, (j) => {
					if (slot.blocked) j.stopUnconfirmed = true;
					if (j.status !== "cancelling" && j.status !== "cancelled") {
						j.status = signal.aborted ? "failed" : "interrupted";
						j.error = slot.blocked
							? "Sender stop unconfirmed; device recovery required"
							: "Transfer interrupted; explicitly resume the saved manifest";
					}
				});
			} finally {
				if (
					!slot.blocked &&
					running.get(row.id) === slot &&
					receipts.find((r) => r.id === row.id)?.job?.status !== "cancelling"
				)
					releaseSlot(row.id);
			}
		})();
		// A storage failure is visible as an interrupted job after restart; never log raw RPC data.
		void slot.done.catch(() => {});
	}

	options.app.get("/api/rooms/:id/transfers", async (req, res) => {
		try {
			const owner = getOwner(req);
			if (!owner) fail(401, "Authentication required");
			if (!store.snapshot().rooms.some((r) => r.id === req.params.id && r.accountId === owner.id))
				fail(404, "Room missing");
			const rows = receipts.filter(
				(r) =>
					r.roomId === req.params.id &&
					r.accountId === owner.id &&
					(r.expiresAt > Date.now() || r.job?.stopUnconfirmed === true),
			);
			const transfers = rows.map((r) => {
				try {
					authorize(r);
					return view(r);
				} catch {
					return { ...view(r), status: "failed", error: "Transfer scope changed" };
				}
			});
			// Older agent-created receipts have no sender job; query only their bounded tail.
			for (const row of rows.filter((r) => !r.job && !r.applyStarted).slice(-10)) {
				try {
					const status = await rpc(row, "transfer_status", {}, AbortSignal.timeout(3000));
					Object.assign(
						transfers.find((t) => t.transferId === row.id)!,
						transferSummary(status),
					);
				} catch {
					/* Keep interruption visible if the receiver cannot be inspected. */
				}
			}
			res.json({ transfers });
		} catch (error) {
			responseError(res, error);
		}
	});

	options.app.post("/api/rooms/:id/transfers/start", async (req, res) => {
		let reserved: ReturnType<typeof reserve> | undefined;
		let row: Receipt | undefined;
		try {
			const owner = getOwner(req);
			if (!owner) fail(401, "Authentication required");
			const body = req.body ?? {};
			if (
				!field(body.idempotencyKey) ||
				!field(body.sourceBotId) ||
				!field(body.targetBotId) ||
				!Array.isArray(body.paths) ||
				!body.paths.length ||
				body.paths.length > DEVICE_FILE_SYNC_LIMITS.files ||
				!body.paths.every(field) ||
				(body.recursive !== undefined && typeof body.recursive !== "boolean")
			)
				fail(400, "Idempotency key, Bots and bounded paths required");
			await queue;
			const state = store.snapshot();
			const room = state.rooms.find((r) => r.id === req.params.id && r.accountId === owner.id);
			const source = state.bots.find((b) => b.id === body.sourceBotId);
			const target = state.bots.find((b) => b.id === body.targetBotId);
			if (!room || !source || !target) fail(404, "Room or Bot missing");
			if (source.id === target.id) fail(400, "Source and target Bots must differ");
			const paths = [...new Set(body.paths as string[])].sort();
			const fingerprint = createHash("sha256")
				.update(
					JSON.stringify([
						room.id,
						source.id,
						source.revision,
						target.id,
						target.revision,
						paths,
						body.recursive === true,
						membership(room.botIds),
					]),
				)
				.digest("hex");
			const existing = receipts.find((r) => r.accountId === owner.id && r.job?.idempotencyKey === body.idempotencyKey);
			if (existing) {
				if (existing.job!.fingerprint !== fingerprint) fail(409, "Idempotency key belongs to another request");
				authorize(existing);
				return res.json(view(existing));
			}
			row = {
				id: randomUUID(),
				sourceDeviceId: source.deviceId,
				targetDeviceId: target.deviceId,
				sourceBotId: source.id,
				targetBotId: target.id,
				sourceBotRevision: source.revision,
				targetBotRevision: target.revision,
				accountId: owner.id,
				roomId: room.id,
				roomMembers: membership(room.botIds),
				localTransferId: randomUUID(),
				expiresAt: Date.now() + TTL,
				job: {
					idempotencyKey: body.idempotencyKey,
					fingerprint,
					paths,
					recursive: body.recursive === true,
					status: "queued",
					summary: {},
				},
			};
			authorize(row);
			reserved = reserve(row);
			const candidate = row;
			row = await transact((draft) => {
				if (draft.length >= MAX_RECEIPTS) fail(429, "Transfer registry full");
				if (draft.some((r) => r.accountId === owner.id && r.job?.idempotencyKey === body.idempotencyKey))
					fail(409, "Request already registered; retry the same key");
				draft.push(candidate);
				return candidate;
			});
			authorize(row);
			schedule(row, reserved);
			res.status(202).json(view(row));
		} catch (error) {
			if (reserved && row) {
				releaseSlot(row.id);
				await updateJob(row.id, (j) => {
					j.status = "interrupted";
					j.error = "Transfer startup interrupted";
				}).catch(() => {});
			}
			responseError(res, error);
		}
	});

	options.app.post("/api/rooms/:id/transfers/:transferId/resume", async (req, res) => {
		let slot: ReturnType<typeof reserve> | undefined;
		let row: Receipt | undefined;
		try {
			row = findUser(req);
			const body = req.body ?? {};
			if (
				!row.job ||
				row.applyStarted ||
				!["interrupted", "failed"].includes(row.job.status) ||
				body.manifestHash !== row.job.manifestHash ||
				body.sourceBotRevision !== row.sourceBotRevision ||
				body.targetBotRevision !== row.targetBotRevision
			)
				fail(409, "Explicit saved manifest and original Bot revisions required");
			if (!row.job.manifest) fail(409, "No saved manifest; start a new request");
			await confirmStopped(row);
			authorize(row);
			slot = reserve(row);
			const id = row.id;
			row = await transact((draft) => {
				const current = draft.find((r) => r.id === id)!;
				current.job!.status = "queued";
				current.expiresAt = Date.now() + TTL;
				return current;
			});
			authorize(row);
			schedule(row, slot);
			res.status(202).json(view(row));
		} catch (error) {
			if (slot && row) {
				releaseSlot(row.id);
				await updateJob(row.id, (j) => {
					j.status = "interrupted";
					j.error = "Transfer resume interrupted";
				}).catch(() => {});
			}
			responseError(res, error);
		}
	});

	options.app.get("/api/rooms/:id/transfers/:transferId/preview", async (req, res) => {
		try {
			const row = findUser(req);
			if (row.job?.status !== "ready") fail(409, "Transfer is not ready");
			const result = await rpc(row, "transfer_preview", {}, AbortSignal.timeout(30_000));
			res.json({ ...transferSummary(result), transferId: row.id });
		} catch (error) {
			responseError(res, error);
		}
	});

	options.app.post("/api/rooms/:id/transfers/:transferId/apply", async (req, res) => {
		let slot: ReturnType<typeof reserve> | undefined;
		let row: Receipt | undefined;
		try {
			row = findUser(req);
			const body = req.body ?? {};
			if (
				!field(body.revision) ||
				!Array.isArray(body.overwritePaths) ||
				body.overwritePaths.length > TRANSFER_LIMITS.maxFiles ||
				!body.overwritePaths.every(field)
			)
				fail(400, "Explicit revision and overwrite paths required");
			if (!row.job && !row.applyStarted) {
				const preview = await rpc(row, "transfer_preview", {}, AbortSignal.timeout(30_000));
				const id = row.id;
				row = await transact((draft) => {
					const current = draft.find((r) => r.id === id)!;
					if (current.applyStarted) fail(409, "Apply already attempted");
					current.job = {
						idempotencyKey: `agent:${id}`,
						fingerprint: id,
						paths: [],
						recursive: false,
						status: "ready",
						summary: transferSummary(preview),
					};
					return current;
				});
				authorize(row);
			}
			if (row.job?.status !== "ready" || row.applyStarted) fail(409, "Transfer not ready or apply already attempted");
			slot = reserve(row);
			row = await transact((draft) => {
				const current = draft.find((r) => r.id === row!.id)!;
				if (current.applyStarted || current.job?.status !== "ready") fail(409, "Apply already attempted");
				current.applyStarted = true;
				current.job.status = "applying";
				return current;
			});
			const activeRow = row;
			slot.done = (async () => {
				const result = await rpc(
					activeRow,
					"transfer_apply",
					{ revision: body.revision, overwritePaths: body.overwritePaths },
					slot!.controller.signal,
				);
				await updateJob(activeRow.id, (j) => {
					j.status = "applied";
					j.summary = { ...j.summary, ...transferSummary(result) };
				});
			})();
			await slot.done;
			res.json(view(receipts.find((r) => r.id === activeRow.id)!));
		} catch (error) {
			if (slot) slot.blocked = !!(error as { stopUnconfirmed?: boolean })?.stopUnconfirmed;
			if (row && slot)
				await updateJob(row.id, (j) => {
					if (slot!.blocked) j.stopUnconfirmed = true;
					j.status = "failed";
					j.error = "Apply failed; inspect target before starting a new transfer";
				}).catch(() => {});
			responseError(res, error);
		} finally {
			if (slot && row && running.get(row.id) === slot) releaseSlot(row.id);
		}
	});

	const aborting = new Set<string>();
	options.app.post("/api/rooms/:id/transfers/:transferId/abort", async (req, res) => {
		let ownsAbort = false;
		let slot: ReturnType<typeof reserve> | undefined;
		let row: Receipt | undefined;
		try {
			row = findUser(req);
			if (!row.job || row.applyStarted) fail(409, "Cannot abort an applied or applying transfer");
			if (row.job.status === "cancelled") return res.json(view(row));
			if (aborting.has(row.id)) fail(409, "Transfer cancellation already running");
			aborting.add(row.id);
			ownsAbort = true;
			await confirmStopped(row);
			authorize(row);
			const active = running.get(row.id);
			row = await updateJob(row.id, (j) => {
				j.status = "cancelling";
			});
			authorize(row);
			active?.controller.abort(new Error("Transfer cancelled"));
			if (active) await active.done;
			if (active?.blocked) fail(409, "Sender stop unconfirmed; device recovery required");
			authorize(row);
			if (active && running.get(row.id) === active) releaseSlot(row.id);
			slot = reserve(row);
			const activeRow = row;
			slot.done = (async () => {
				await rpc(activeRow, "transfer_abort", {}, slot!.controller.signal);
				await updateJob(activeRow.id, (j) => {
					j.status = "cancelled";
					delete j.error;
				});
			})();
			await slot.done;
			res.json(view(receipts.find((r) => r.id === activeRow.id)!));
		} catch (error) {
			if (slot) slot.blocked = !!(error as { stopUnconfirmed?: boolean })?.stopUnconfirmed;
			if (row && ownsAbort)
				await updateJob(row.id, (j) => {
					if (slot?.blocked) j.stopUnconfirmed = true;
					if (j.status === "cancelling") {
						j.status = "interrupted";
						j.error = "Cancellation incomplete; retry abort";
					}
				}).catch(() => {});
			responseError(res, error);
		} finally {
			if (row && ownsAbort) aborting.delete(row.id);
			if (slot && row && running.get(row.id) === slot) releaseSlot(row.id);
		}
	});
	return {
		async close() {
			closing = true;
			for (const slot of running.values()) slot.controller.abort(new Error("Scheduler closing"));
			await Promise.allSettled([...running.values()].map((slot) => slot.done));
			await queue;
		},
	};
}
