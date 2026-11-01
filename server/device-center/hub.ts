import express from "express";
import { validInteractionAnswer, validInteractionProjection } from "./human-interaction.js";
import type { DeviceTaskInteraction } from "../protocol.js";
import { createGroupEvents } from "./group-events.js";
import { createTaskJournalManager } from "./task-journal.js";
import { createTaskReportStore, MAX_TASK_FULL_REPORT_BYTES } from "./task-report.js";
import { TASK_REPORT_UPLOAD_JSON_BYTES } from "../payload-limits.js";
import { parseReportMetadata, mergeTaskReportMetadata, reportUploadMetadata } from "./report-metadata.js";
import { buildDeterministicTaskSummary, queryTaskReportChunk, type TaskReportEvidence } from "./task-state.js";
import { addDelivery, addReview, deliveryHistory, deliverySummary } from "./hub-deliveries.js";
import {
	hubPrepareIntegration,
	hubVerifyIntegration,
	hubConfirmIntegration,
	hubCancelIntegration,
	listIntegrations,
} from "./hub-integration.js";
import type { Request, Response, NextFunction } from "express";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import {
	DeviceHubStore,
	hashSecret,
	isTerminal,
	taskPending,
	publicDevice,
	publicTask,
	secretMatches,
} from "./store.js";
import { atomicApproveGroupPlan } from "./group-plan-guard.js";
import { validateTaskPlan } from "./task-plan.js";
import { GROUP_RETENTION_LIMIT, groupHistoryPage, groupTaskContext, type GroupTaskContext } from "./group-context.js";
import type {
	DeviceTaskClaim,
	DeviceTaskClaimResult,
	DeviceTaskLeaseRenew,
	DeviceTaskLeaseResult,
	DeviceTaskState,
	DeviceTaskUpdateRequest,
} from "../protocol.js";
type DeliveryTask = HubTask & { context?: GroupTaskContext; taskState?: DeviceTaskState };
import type { HubTask, Handoff, TaskStatus, HubState } from "./store.js";
import { createAccountAuth, hashPassword, verifyPassword, SESSION_TTL, HubRateLimiter } from "./hub-auth.js";
import type { DevicePortals } from "./device-portals.js";
import {
	establishConversation,
	advanceConversationTask,
	nextConversationTask,
	recordConversationTurn,
	conversationStatus,
	queueParentResult,
	conversationPage,
	trimConversationHistory,
} from "./hub-conversations.js";

export interface HubTaskEvent {
	reportMetadata?: import("../protocol.js").DeviceTaskReportMetadata;
	botId: string;
	taskId: string;
	attemptId: string;
	status: TaskStatus;
	report?: string;
}
export interface HubRelay {
	callDevice?: (
		deviceId: string,
		action: import("./relay.js").DeviceCommand,
		payload: unknown,
		options?: { signal?: AbortSignal },
	) => Promise<unknown>;
	answerInteraction?: (
		deviceId: string,
		answer: import("../protocol.js").DeviceTaskInteractionAnswer,
	) => boolean | Promise<boolean>;
	cancelTask?: (deviceId: string, taskId: string, attemptId: string) => Promise<{ stopped: boolean }>;
	handleOpen?: (req: Request, res: Response, deviceId: string) => Promise<void>;
	handleRequest?: (req: IncomingMessage, res: ServerResponse) => boolean;
	handleAliasOpen?: (req: IncomingMessage, res: ServerResponse, deviceId: string) => Promise<void>;
	onRevoke?: (deviceId: string) => unknown;
	onTask?: (deviceId: string, task: DeliveryTask) => unknown;
}
export interface DeviceHubOptions {
	/** An already bound loopback server may be supplied by the in-process local Hub. */
	server?: Server;
	dataDir: string;
	publicUrl: string;
	deviceDomain?: string;
	pathAccess?: boolean;
	portals?: DevicePortals;
	allowRegistration?: boolean;
	relay?: HubRelay;
	onRevoke?: (deviceId: string) => unknown;
	onTask?: (deviceId: string, task: DeliveryTask) => unknown;
	isOnline?: (deviceId: string) => boolean;
}
class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
function fail(status: number, message: string): never {
	throw new HttpError(status, message);
}
function text(value: unknown, max = 16384): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) fail(400, "Invalid text");
	return value as string;
}
function ids(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length > 32 ||
		value.some((id) => typeof id !== "string" || id.length > 128) ||
		new Set(value).size !== value.length
	)
		fail(400, "Invalid botIds");
	return value as string[];
}
function handoff(value: unknown): Handoff | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid handoff");
	const v = value as Record<string, unknown>;
	return {
		repository: text(v.repository, 2048),
		commit: text(v.commit, 128),
		...(v.branch === undefined ? {} : { branch: text(v.branch, 256) }),
		instructions: text(v.instructions, 8192),
	};
}
const token = () => randomBytes(32).toString("base64url");
const PAIR_TTL = 10 * 60 * 1000;
const HISTORY = GROUP_RETENTION_LIMIT;

export async function createDeviceHub(options: DeviceHubOptions) {
	const origin = new URL(options.publicUrl);
	if (
		!["http:", "https:"].includes(origin.protocol) ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		origin.username ||
		(origin as unknown as Record<string, string>)["pass" + "word"] ||
		options.publicUrl !== origin.origin
	)
		throw new Error("publicUrl must be a canonical root origin");
	if (options.deviceDomain !== undefined) {
		const domain = new URL(`https://${options.deviceDomain}`);
		if (
			domain.host !== options.deviceDomain ||
			domain.pathname !== "/" ||
			!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(options.deviceDomain)
		)
			throw new Error("Invalid deviceDomain");
		if (
			origin.hostname === domain.hostname ||
			origin.hostname.endsWith(`.${domain.hostname}`) ||
			domain.hostname.endsWith(`.${origin.hostname}`)
		)
			throw new Error("Device domain must be independent of hub domain");
	}
	const store = await DeviceHubStore.open(options.dataDir);
	const taskJournalManager = createTaskJournalManager(options.dataDir);
	const taskReportStore = createTaskReportStore(options.dataDir, "hub");
	const groupEvents = createGroupEvents(store, taskJournalManager);
	const auth = createAccountAuth(store, options.publicUrl);
	const getAccount = (req: IncomingMessage) => auth.getAccount(req);
	async function authenticateAgent(req: IncomingMessage) {
		const deviceId = req.headers["x-device-id"];
		const authorization = req.headers.authorization;
		if (typeof deviceId !== "string" || !authorization?.startsWith("Bearer ")) return undefined;
		if (!(await store.authenticateDevice(deviceId, authorization.slice(7)))) return undefined;
		const device = store.getDevice(deviceId);
		const owner = device && store.snapshot().accounts.find((a) => a.id === device.accountId);
		return device && owner ? { device, account: { id: owner.id, username: owner.username } } : undefined;
	}
	const agents = new WeakMap<IncomingMessage, NonNullable<Awaited<ReturnType<typeof authenticateAgent>>>>();
	const users = new WeakMap<IncomingMessage, NonNullable<Awaited<ReturnType<typeof authenticateAgent>>>>();
	const agentWrites = new HubRateLimiter(30, 60000);
	const account = (req: IncomingMessage) => {
		const agent = agents.get(req) ?? users.get(req);
		if (agent) {
			if (store.getDeviceOwner(agent.device.id) !== agent.account.id) fail(401, "Device revoked");
			return agent.account;
		}
		return getAccount(req) ?? fail(401, "Authentication required");
	};
	const app = express();
	app.disable("x-powered-by");
	app.use((req, _res, next) => {
		if (!req.path.startsWith("/api/device-user/")) return next();
		const deviceId = req.headers["x-device-id"];
		const device = typeof deviceId === "string" ? store.snapshot().devices.find((d) => d.id === deviceId) : undefined;
		const owner = device && store.snapshot().accounts.find((a) => a.id === device.accountId);
		const bearer = req.headers.authorization;
		if (
			!device?.uiCredentialHash ||
			!owner ||
			!bearer?.startsWith("Bearer ") ||
			!secretMatches(bearer.slice(7), device.uiCredentialHash)
		)
			fail(401, "UI device authentication required; pair again");
		if (req.method === "POST" && !agentWrites.allow("user:" + device.id)) fail(429, "Too many user writes");
		const suffix = req.path.slice("/api/device-user".length);
		const conversationRoute =
			/^\/rooms\/[^/]+\/conversations(?:\/[^/]+(?:\/(?:messages|stop|deliveries|reviews|task-state|evidence|integrations(?:\/[^/]+(?:\/(?:verify|apply|cancel))?)?))?)?$/.test(
				suffix,
			);
		const taskRoute = /^\/rooms\/[^/]+\/tasks\/[^/]+(?:\/(?:journal|report))?$/.test(suffix);
		if (!(
			(req.method === "GET" &&
				(conversationRoute ||
					taskRoute ||
					/^\/rooms\/[^/]+\/(?:events|interactions|transfers)$/.test(suffix) ||
					/^\/rooms\/[^/]+\/transfers\/[^/]+\/preview$/.test(suffix) ||
					["/devices", "/bots", "/rooms"].includes(suffix) ||
					/^\/rooms\/[^/]+$/.test(suffix))) ||
			(req.method === "POST" &&
				(suffix === "/rooms" ||
					conversationRoute ||
					/^\/rooms\/[^/]+\/(messages|rename|members|clear|delete|interactions|canvas)$/.test(suffix) ||
					/^\/rooms\/[^/]+\/tasks\/[^/]+\/approve-plan$/.test(suffix) ||
					/^\/rooms\/[^/]+\/transfers(?:\/start|\/[^/]+(?:\/(?:apply|abort|resume))?)?$/.test(suffix) ||
					/^\/devices\/[^/]+\/open$/.test(suffix)))
		))
			fail(404, "User route missing");
		users.set(req, { device, account: { id: owner.id, username: owner.username } });
		req.url = req.url.replace("/api/device-user/", "/api/");
		next();
	});
	app.use(async (req, _res, next) => {
		if (!req.path.startsWith("/api/agent/")) return next();
		const agent = await authenticateAgent(req);
		if (!agent) fail(401, "Device authentication required");
		const isReportUpload = req.method === "POST" && /^\/api\/agent\/rooms\/[^/]+\/tasks\/[^/]+\/report$/.test(req.path);
		if (["POST", "PUT"].includes(req.method) && !isReportUpload && !agentWrites.allow(agent.device.id))
			fail(429, "Too many device writes");
		agents.set(req, agent);
		const suffix = req.path.slice("/api/agent".length);
		if (
			(req.method === "GET" &&
				(["/devices", "/bots", "/rooms"].includes(suffix) ||
					/^\/rooms\/[^/]+(?:\/history)?$/.test(suffix) ||
					/^\/rooms\/[^/]+\/conversations(?:\/[^/]+(?:\/(?:task-state|evidence))?)?$/.test(suffix))) ||
			(req.method === "POST" &&
				(suffix === "/rooms" ||
					/^\/rooms\/[^/]+\/tasks\/[^/]+\/report$/.test(suffix) ||
					/^\/rooms\/[^/]+\/(?:messages|conversations(?:\/[^/]+\/(?:messages|stop|deliveries|reviews|attention|task-state|integrations(?:\/[^/]+(?:\/(?:verify|apply|cancel))?)?))?)$/.test(
						suffix,
					)))
		)
			req.url = req.url.replace("/api/agent/", "/api/");
		else if (!((suffix === "/transfers" && req.method === "POST") || (suffix === "/bots" && req.method === "PUT")))
			fail(404, "Agent route missing");
		next();
	});
	app.use((req, res, next) => {
		if (req.headers.host !== origin.host) return res.status(421).json({ error: "Host rejected" });
		if (
			!agents.has(req) &&
			!users.has(req) &&
			!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
			req.headers.origin !== options.publicUrl
		)
			return res.status(403).json({ error: "Origin rejected" });
		next();
	});
	const json = express.json({ limit: "32kb", strict: true });
	const reportJson = express.json({ limit: TASK_REPORT_UPLOAD_JSON_BYTES, strict: true });
	const reportWrites = new HubRateLimiter(4096, 60000);
	app.use((req, res, next) => {
		if (agents.has(req) && req.path === "/api/agent/transfers") return next();
		if (agents.has(req) && req.method === "POST" && /^\/api\/rooms\/[^/]+\/tasks\/[^/]+\/report$/.test(req.path)) {
			if (!reportWrites.allow(agents.get(req)!.device.id))
				return res.status(429).json({ error: "Too many report chunks" });
			return reportJson(req, res, next);
		}
		json(req, res, next);
	});
	const loginLimit = new HubRateLimiter(10, 60000);
	const pairLimit = new HubRateLimiter(20, 60000);
	const pairs = new Map<
		string,
		{
			code: string;
			name: string;
			expiresAt: number;
			deviceId?: string;
			accountId?: string;
			credential?: string;
			uiCredential?: string;
		}
	>();
	const sweepPairs = () => {
		for (const [key, value] of pairs) if (value.expiresAt <= Date.now()) pairs.delete(key);
	};
	const ip = (req: Request) => req.socket.remoteAddress ?? "unknown";
	const visibleDevice = (device: ReturnType<typeof publicDevice>) => ({
		id: device.id,
		accountId: device.accountId,
		name: device.name,
		createdAt: device.createdAt,
		online: options.isOnline?.(device.id) ?? false,
		url:
			(options.pathAccess ? `${origin.origin}/device/${encodeURIComponent(device.id)}/` : undefined) ??
			options.portals?.getOrigin(device.id) ??
			(options.deviceDomain ? `${origin.protocol}//${device.id}.${options.deviceDomain}` : null),
		alias: options.portals?.getAlias(device.id) ?? null,
	});
	for (const route of ["/api/me", "/api/auth/me"]) app.get(route, (req, res) => res.json({ account: account(req) }));
	app.post("/api/auth/register", async (req, res) => {
		if (!loginLimit.allow(ip(req))) fail(429, "Too many attempts");
		if (options.allowRegistration === false) fail(403, "Registration disabled");
		const username = text(req.body?.username, 64).trim().toLowerCase();
		if (!/^[a-z0-9_.-]{3,64}$/.test(username)) fail(400, "Invalid username");
		const password = text(req.body?.["pass" + "word"], 1024);
		if (password.length < 8) fail(400, "Password too short");
		const passwordHash = await hashPassword(password);
		const sessionToken = token();
		const created = await store.transact((draft) => {
			if (draft.accounts.some((entry) => entry.username === username)) fail(409, "Username unavailable");
			if (draft.accounts.length >= 10000) fail(409, "Account capacity reached");
			const entry = { id: randomUUID(), username, passwordHash, createdAt: Date.now() };
			draft.accounts.push(entry);
			draft.sessions = draft.sessions.filter((s) => s.expiresAt > Date.now());
			draft.sessions.push({ accountId: entry.id, hash: hashSecret(sessionToken), expiresAt: Date.now() + SESSION_TTL });
			return { id: entry.id, username };
		});
		res.setHeader("Set-Cookie", auth.cookie(sessionToken));
		res.status(201).json({ account: created });
	});
	app.post("/api/auth/login", async (req, res) => {
		if (!loginLimit.allow(ip(req))) fail(429, "Too many attempts");
		const username = text(req.body?.username, 64).trim().toLowerCase();
		const password = text(req.body?.["pass" + "word"], 1024);
		const entry = store.snapshot().accounts.find((item) => item.username === username);
		// Run the same KDF for missing accounts, avoiding a cheap username oracle.
		if (
			!(await verifyPassword(password, entry?.passwordHash ?? `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`)) ||
			!entry
		)
			fail(401, "Invalid credentials");
		const sessionToken = token();
		await store.transact((draft) => {
			draft.sessions = draft.sessions.filter((s) => s.expiresAt > Date.now());
			if (draft.sessions.filter((s) => s.accountId === entry.id).length >= 100) fail(429, "Session capacity reached");
			draft.sessions.push({ accountId: entry.id, hash: hashSecret(sessionToken), expiresAt: Date.now() + SESSION_TTL });
		});
		res.setHeader("Set-Cookie", auth.cookie(sessionToken));
		res.json({ account: { id: entry.id, username: entry.username } });
	});
	app.post("/api/auth/logout", async (req, res) => {
		const value = auth.getToken(req);
		await store.transact((draft) => {
			draft.sessions = draft.sessions.filter((session) => session.hash !== hashSecret(value ?? ""));
		});
		res.setHeader("Set-Cookie", auth.cookie("", true));
		res.json({ ok: true });
	});
	app.post("/api/pair/start", (req, res) => {
		if (!pairLimit.allow(ip(req))) fail(429, "Too many attempts");
		sweepPairs();
		if (pairs.size >= 1000) fail(429, "Too many pending pairs");
		const name = text(req.body?.name, 128);
		const pollToken = token();
		const code = randomBytes(6).toString("hex").toUpperCase();
		const expiresAt = Date.now() + PAIR_TTL;
		pairs.set(hashSecret(pollToken), { code, name, expiresAt });
		res.json({ code, pollToken, expiresAt });
	});
	const approving = new Set<string>();
	app.post("/api/pair/approve", async (req, res) => {
		const owner = account(req);
		if (!pairLimit.allow(`approve:${ip(req)}`)) fail(429, "Too many attempts");
		sweepPairs();
		const code = text(req.body?.code, 64).toUpperCase();
		const pair = [...pairs.values()].find((item) => item.code === code);
		if (!pair) fail(404, "Pair expired or missing");
		if (approving.has(code)) fail(409, "Pair approval in progress");
		approving.add(code);
		try {
			const credential = token();
			const uiCredential = token();
			const device = await store.transact((draft) => {
				if (pair.deviceId || pair.expiresAt <= Date.now() || ![...pairs.values()].includes(pair))
					fail(409, "Pair unavailable");
				const device = {
					id: randomUUID(),
					accountId: owner.id,
					name: pair.name,
					credentialHash: hashSecret(credential),
					uiCredentialHash: hashSecret(uiCredential),
					createdAt: Date.now(),
				};
				draft.devices.push(device);
				return device;
			});
			pair.deviceId = device.id;
			pair.accountId = owner.id;
			pair.credential = credential;
			pair.uiCredential = uiCredential;
			res.json({ device: visibleDevice(device) });
		} finally {
			approving.delete(code);
		}
	});
	app.post("/api/pair/poll", (req, res) => {
		if (!pairLimit.allow(`poll:${ip(req)}`)) fail(429, "Too many attempts");
		sweepPairs();
		const key = hashSecret(text(req.body?.pollToken, 256));
		const pair = pairs.get(key);
		if (!pair) fail(404, "Pair expired or consumed");
		if (!pair.deviceId) return res.status(202).json({ pending: true });
		if (store.getDeviceOwner(pair.deviceId) !== pair.accountId) {
			pairs.delete(key);
			fail(404, "Device revoked");
		}
		pairs.delete(key);
		res.json({ deviceId: pair.deviceId, credential: pair.credential, uiCredential: pair.uiCredential });
	});
	app.get("/api/info", (_req, res) => {
		res.json({
			transport: origin.protocol === "https:" ? "https" : "http",
			deviceWebAccess: !!options.pathAccess || !!options.deviceDomain,
		});
	});
	app.get("/api/devices", (req, res) =>
		res.json({
			devices: store
				.snapshot()
				.devices.filter((d) => d.accountId === account(req).id)
				.map(visibleDevice),
		}),
	);
	app.post("/api/devices/:id/revoke", async (req, res) => {
		const owner = account(req);
		const id = String(req.params.id);
		await store.transact((draft) => {
			if (!draft.devices.some((device) => device.id === id && device.accountId === owner.id))
				fail(404, "Device missing");
			draft.devices = draft.devices.filter((device) => device.id !== id);
			const removedBots = new Set(draft.bots.filter((b) => b.deviceId === id).map((b) => b.id));
			draft.bots = draft.bots.filter((b) => b.deviceId !== id);
			for (const room of draft.rooms) {
				room.botIds = room.botIds.filter((botId) => !removedBots.has(botId));
				if (room.primaryBotId && removedBots.has(room.primaryBotId)) delete room.primaryBotId;
			}
			for (const task of draft.tasks)
				if (task.deviceId === id && !isTerminal(task.status)) {
					task.status = "interrupted";
					task.updatedAt = Date.now();
				}
		});
		for (const [key, pair] of pairs) if (pair.deviceId === id) pairs.delete(key);
		await (options.onRevoke ?? options.relay?.onRevoke)?.(id);
		await options.portals?.retire(id);
		res.json({ ok: true });
	});
	function ownBot(req: Request, state: HubState) {
		const agent = agents.get(req);
		if (!agent) return undefined;
		const bot = state.bots.find(
			(b) =>
				b.id === req.body?.sourceBotId &&
				b.deviceId === agent.device.id &&
				b.accountId === agent.account.id &&
				b.enabled,
		);
		if (!bot || !state.devices.some((d) => d.id === bot.deviceId && d.accountId === bot.accountId))
			fail(403, "Source Bot access denied");
		return bot;
	}
	const validBot = (state: HubState, id: string, accountId: string) =>
		state.bots.find(
			(b) =>
				b.id === id &&
				b.accountId === accountId &&
				b.enabled &&
				state.devices.some((d) => d.id === b.deviceId && d.accountId === accountId),
		);
	app.get("/api/bots", (req, res) => {
		const owner = account(req);
		const state = store.snapshot();
		res.json({
			bots: state.bots
				.filter((b) => b.accountId === owner.id)
				.map((b) => ({
					...b,
					deviceName: state.devices.find((device) => device.id === b.deviceId && device.accountId === owner.id)?.name,
					online: options.isOnline?.(b.deviceId) ?? false,
				})),
		});
	});
	app.put("/api/agent/bots", async (req, res) => {
		const owner = account(req);
		const device = agents.get(req)!.device;
		const rows = req.body?.bots;
		if (!Array.isArray(rows) || rows.length > 128 || new Set(rows.map((b) => b?.id)).size !== rows.length)
			fail(400, "Invalid Bots");
		const incoming = rows.map((b) => {
			const id = text(b?.id, 128),
				name = text(b?.name, 128);
			if (
				typeof b?.description !== "string" ||
				Buffer.byteLength(b.description) > 2048 ||
				typeof b.enabled !== "boolean" ||
				!Number.isSafeInteger(b.revision) ||
				b.revision < 1
			)
				fail(400, "Invalid Bot registration");
			if (
				b.tools !== undefined &&
				(!Array.isArray(b.tools) ||
					b.tools.length > 256 ||
					b.tools.some((name: unknown) => typeof name !== "string" || !name.trim() || name.length > 128))
			)
				fail(400, "Invalid Bot tools");
			return {
				id,
				name,
				description: b.description,
				enabled: b.enabled,
				revision: b.revision,
				...(b.tools === undefined ? {} : { tools: [...new Set<string>(b.tools)] }),
			};
		});
		const bots = await store.transact((draft) => {
			if (!draft.devices.some((d) => d.id === device.id && d.accountId === owner.id)) fail(401, "Device revoked");
			if (
				draft.tasks.some(
					(task) =>
						task.deviceId === device.id &&
						!isTerminal(task.status) &&
						!incoming.some((bot) => bot.id === task.botId && bot.enabled && bot.revision === task.botRevision),
				)
			)
				throw Object.assign(new Error("Stop active Bot tasks before changing registration"), {
					status: 409,
					code: "ACTIVE_TASKS",
				});
			for (const row of incoming) {
				const previous = draft.bots.find((b) => b.id === row.id);
				if (previous && (previous.deviceId !== device.id || previous.accountId !== owner.id))
					fail(403, "Bot belongs to another device");
				if (
					previous &&
					(row.revision < previous.revision ||
						(row.revision === previous.revision &&
							(["name", "description", "enabled"].some(
								(k) => previous[k as keyof typeof previous] !== row[k as keyof typeof row],
							) ||
								(row.tools !== undefined &&
									previous.tools !== undefined &&
									JSON.stringify(previous.tools) !== JSON.stringify(row.tools)))))
				)
					fail(409, "Bot revision is stale");
				if (previous) Object.assign(previous, row, { updatedAt: Date.now() });
				else
					draft.bots.push({
						...row,
						deviceId: device.id,
						accountId: owner.id,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					});
			}
			for (const bot of draft.bots)
				if (bot.deviceId === device.id && !incoming.some((b) => b.id === bot.id)) {
					bot.enabled = false;
					bot.updatedAt = Date.now();
				}
			return draft.bots.filter((b) => b.deviceId === device.id);
		});
		res.json({ bots });
	});
	app.get("/api/rooms", (req, res) =>
		res.json({
			rooms: store
				.snapshot()
				.rooms.filter(
					(r) =>
						r.accountId === account(req).id &&
						(!agents.has(req) ||
							store
								.snapshot()
								.bots.some(
									(b) =>
										b.enabled &&
										b.deviceId === agents.get(req)!.device.id &&
										b.accountId === r.accountId &&
										r.botIds.includes(b.id),
								)),
				),
		}),
	);
	app.post("/api/rooms", async (req, res) => {
		const owner = account(req),
			name = text(req.body?.name, 128),
			botIds = ids(req.body?.botIds ?? []);
		const room = await store.transact((draft) => {
			const source = ownBot(req, draft);
			if (source && !botIds.includes(source.id)) fail(403, "Source Bot must be a member");
			if (!botIds.length || botIds.some((id) => !validBot(draft, id, owner.id))) fail(400, "Invalid room Bot");
			if (draft.rooms.filter((r) => r.accountId === owner.id).length >= 100) fail(409, "Room capacity reached");
			const primaryBotId = req.body?.primaryBotId == null ? undefined : text(req.body.primaryBotId, 128);
			if (primaryBotId && !botIds.includes(primaryBotId)) fail(400, "Primary Bot must be a room member");
			const room = { id: randomUUID(), accountId: owner.id, name, botIds, primaryBotId, createdAt: Date.now() };
			draft.rooms.push(room);
			return room;
		});
		res.status(201).json({ room });
	});
	const humanInteractions = new Map<string, DeviceTaskInteraction[]>();
	function liveInteractions(roomId: string, accountId: string) {
		const state = store.snapshot();
		for (const [key, items] of humanInteractions) {
			const task = state.tasks.find((t) => t.id === key);
			if (
				!task ||
				task.cancelRequested ||
				!(task.status === "running" || (task.status === "queued" && deliveredTasks.has(task.id))) ||
				items.some((i) => i.attemptId !== task.attemptId)
			)
				humanInteractions.delete(key);
		}
		return [...humanInteractions.values()]
			.flat()
			.filter(
				(i) =>
					i.roomId === roomId &&
					state.tasks.some((t) => t.id === i.taskId && t.accountId === accountId) &&
					(i.deadline === undefined || i.deadline > Date.now()) &&
					(options.isOnline?.(i.deviceId) ?? true),
			);
	}
	function acceptInteractions(deviceId: string, event: any) {
		const state = store.snapshot();
		const task = state.tasks.find(
			(t) =>
				t.id === event.taskId && t.deviceId === deviceId && t.attemptId === event.attemptId && t.botId === event.botId,
		);
		const room =
			task &&
			state.rooms.find((r) => r.id === task.roomId && r.accountId === task.accountId && r.botIds.includes(task.botId));
		if (
			!task ||
			!room ||
			task.cancelRequested ||
			!(task.status === "running" || (task.status === "queued" && deliveredTasks.has(task.id))) ||
			state.devices.find((d) => d.id === deviceId)?.accountId !== task.accountId ||
			!validInteractionProjection(event.items, {
				taskId: task.id,
				attemptId: task.attemptId,
				roomId: task.roomId,
				botId: task.botId,
				deviceId,
			})
		)
			return;
		if (event.items.length) {
			if (!humanInteractions.has(task.id) && humanInteractions.size >= 128) return;
			humanInteractions.set(task.id, structuredClone(event.items));
		} else humanInteractions.delete(task.id);
		groupEvents.invalidate(task.roomId);
	}
	app.get("/api/rooms/:id/interactions", (req, res) => {
		const owner = account(req);
		if (agents.has(req)) fail(403, "Human interaction requires a user session");
		if (!store.snapshot().rooms.some((r) => r.id === req.params.id && r.accountId === owner.id))
			fail(404, "Room missing");
		res.setHeader("Cache-Control", "no-store");
		res.json({ interactions: liveInteractions(req.params.id as string, owner.id) });
	});
	app.post("/api/rooms/:id/interactions", async (req, res) => {
		const owner = account(req);
		if (agents.has(req)) fail(403, "Human interaction requires a user session");
		if (!validInteractionAnswer(req.body)) fail(400, "Invalid interaction answer");
		const item = liveInteractions(req.params.id as string, owner.id).find(
			(i) => i.id === req.body.interactionId && i.taskId === req.body.taskId && i.attemptId === req.body.attemptId,
		);
		if (!item) fail(409, "Interaction expired");
		if (!(await options.relay?.answerInteraction?.(item.deviceId, req.body)))
			fail(409, "Executor rejected or did not acknowledge the answer");
		humanInteractions.set(
			item.taskId,
			(humanInteractions.get(item.taskId) ?? []).filter((i) => i.id !== item.id),
		);
		groupEvents.invalidate(item.roomId);
		res.json({ forwarded: true });
	});
	app.post("/api/rooms/:id/canvas", async (req, res) => {
		const owner = account(req);
		if (agents.has(req)) fail(403, "Canvas binding requires a user session");
		const raw = req.body?.binding;
		if (
			!req.body ||
			Object.keys(req.body).some((key) => key !== "binding") ||
			(raw !== null &&
				(!raw ||
					typeof raw !== "object" ||
					Array.isArray(raw) ||
					Object.keys(raw).some((key) => !["deviceId", "graphId", "cwd", "title"].includes(key)) ||
					typeof raw.deviceId !== "string" ||
					typeof raw.graphId !== "string" ||
					!/^[A-Za-z0-9._-]{1,64}$/.test(raw.graphId) ||
					typeof raw.cwd !== "string" ||
					!raw.cwd.trim() ||
					raw.cwd.length > 4096 ||
					typeof raw.title !== "string" ||
					raw.title.length > 200))
		)
			fail(400, "Invalid canvas binding");
		const binding =
			raw === null
				? undefined
				: { deviceId: raw.deviceId, graphId: raw.graphId, cwd: raw.cwd.trim(), title: raw.title };
		let room: import("./store.js").Room | undefined;
		await store.transact((state) => {
			room = state.rooms.find((item) => item.id === req.params.id && item.accountId === owner.id);
			if (!room) fail(404, "Room missing");
			if (
				binding &&
				(!state.devices.some((device) => device.id === binding.deviceId && device.accountId === owner.id) ||
					!state.bots.some(
						(bot) => bot.deviceId === binding.deviceId && bot.accountId === owner.id && room!.botIds.includes(bot.id),
					))
			)
				fail(403, "Canvas device must host a Bot in this group");
			room!.canvasBinding = binding;
		});
		groupEvents.invalidate(String(req.params.id));
		res.json({ room });
	});
	app.get("/api/rooms/:id", (req, res) => {
		const state = store.snapshot(),
			room = state.rooms.find((r) => r.id === req.params.id && r.accountId === account(req).id);
		if (
			!room ||
			(agents.has(req) &&
				!state.bots.some(
					(b) =>
						b.enabled &&
						b.deviceId === agents.get(req)!.device.id &&
						b.accountId === room.accountId &&
						room.botIds.includes(b.id),
				))
		)
			fail(404, "Room missing");
		res.json({
			room,
			bots: state.bots
				.filter((b) => room.botIds.includes(b.id) && b.accountId === room.accountId)
				.map((b) => ({
					...b,
					deviceName: state.devices.find((device) => device.id === b.deviceId && device.accountId === room.accountId)
						?.name,
				})),
			messages: state.messages.filter((m) => m.roomId === room.id),
			tasks: state.tasks.filter((t) => t.roomId === room.id).map(publicTask),
		});
	});
	app.get("/api/rooms/:id/events", (req, res) => {
		groupEvents.connect(account(req).id, String(req.params.id), res, users.get(req)?.device.id);
	});

	// === Task Details, Journal, and Reports ===
	app.get("/api/rooms/:id/tasks/:taskId", (req, res) => {
		const acc = account(req);
		const state = store.snapshot();
		const room = state.rooms.find((r) => r.id === req.params.id && r.accountId === acc.id);
		if (!room) fail(404, "Room missing");
		const task = state.tasks.find((t) => t.id === req.params.taskId && t.roomId === room.id && t.accountId === acc.id);
		if (!task) fail(404, "Task missing");

		const bot = state.bots.find((b) => b.id === task.botId && b.accountId === acc.id);
		const device = state.devices.find((d) => d.id === task.deviceId && d.accountId === acc.id);
		const reportMeta = mergeTaskReportMetadata(
			task,
			taskReportStore.getReportMeta(task.id, task.attemptId, acc.id, room.id),
		);

		const interactions = (state as any).interactions
			? (state as any).interactions.filter((i: any) => i.taskId === task.id)
			: [];
		const deliveries = (state as any).deliveries
			? (state as any).deliveries.filter((d: any) => d.taskId === task.id)
			: [];

		res.json({
			task: {
				id: task.id,
				roomId: task.roomId,
				accountId: task.accountId,
				deviceId: task.deviceId,
				botId: task.botId,
				botName: bot?.name,
				deviceName: device?.name,
				text: task.text,
				status: task.status,
				createdAt: task.createdAt,
				updatedAt: task.updatedAt,
				attemptId: task.attemptId,
				parentTaskId: task.parentTaskId,
				conversationId: task.conversationId,
				report: task.report,
			},
			reportMeta,
			interactionCount: interactions.length,
			interactions: interactions.map((i: any) => ({
				id: i.id,
				kind: i.kind,
				question: i.question,
				resolved: !!i.decision || !!i.cancelled,
				decision: i.decision,
			})),
			journalUnavailable: groupEvents.isJournalUnavailable(task.id, task.attemptId),
			deliveries: deliveries.map((d: any) => ({
				id: d.id,
				commit: d.commit,
				branch: d.branch,
				summary: d.summary,
				passed: d.checks?.every((c: any) => c.status === "passed") ?? true,
			})),
		});
	});

	app.post("/api/rooms/:id/tasks/:taskId/approve-plan", async (req, res) => {
		const acc = account(req);
		if (agents.has(req)) {
			fail(403, "Plan approval is restricted to human users; Bots cannot self-approve");
		}
		const user = users.get(req)?.device;
		const approverName = user ? `${acc.username} · ${user.name}` : acc.username;
		const { plan, nextTask } = await store.transact((draft) => {
			const room = draft.rooms.find((r) => r.id === req.params.id && r.accountId === acc.id);
			if (!room) fail(404, "Room missing");
			const task = draft.tasks.find(
				(t) => t.id === req.params.taskId && t.roomId === room.id && t.accountId === acc.id,
			);
			if (!task) fail(404, "Task missing");
			if (!task.planOnly || !task.plan) fail(400, "Task does not have a plan to approve");
			if (task.status !== "completed" || task.cancelRequested) fail(409, "Planning task must finish before approval");
			if (!validateTaskPlan(task.plan)) fail(409, "Plan steps are invalid");
			if (validBot(draft, task.botId, acc.id)?.revision !== task.botRevision)
				fail(409, "Plan Bot configuration changed");
			if (!room.botIds.includes(task.botId)) fail(409, "Plan Bot is no longer a room member");
			const result = atomicApproveGroupPlan(task.plan, approverName);
			if (!result.ok) fail(409, result.error);
			task.plan = result.plan;
			task.updatedAt = Date.now();

			const conversation = task.conversationId
				? draft.conversations.find(
						(c) => c.id === task.conversationId && c.roomId === room.id && c.accountId === acc.id,
					)
				: undefined;
			if (!conversation || conversation.closed) fail(409, "Plan conversation unavailable");
			if ((task.dispatchDepth ?? 0) + 1 > 8) fail(409, "Dispatch depth exhausted");
			const root = draft.tasks.find((t) => t.id === (task.rootTaskId ?? task.id));
			if (!root) fail(409, "Dispatch root expired");
			if (root) {
				if ((root.dispatchCount ?? 0) >= 16) fail(409, "Dispatch budget exhausted");
				root.dispatchCount = (root.dispatchCount ?? 0) + 1;
			}
			const now = Date.now();
			const nextTaskId = randomUUID();
			const nextAttemptId = randomUUID();
			const nextTask: HubTask = {
				id: nextTaskId,
				rootTaskId: task.rootTaskId ?? task.id,
				parentTaskId: task.id,
				dispatchDepth: (task.dispatchDepth ?? 0) + 1,
				attemptId: nextAttemptId,
				roomId: room.id,
				accountId: acc.id,
				botId: task.botId,
				deviceId: task.deviceId,
				botRevision: task.botRevision,
				text: `Approved plan for: ${task.text}\n\n${task.plan.steps.map((step) => `${step.id}. ${step.title}${step.description ? ` — ${step.description}` : ""}`).join("\n")}\n\nBegin execution of these approved steps.`,
				status: "queued",
				createdAt: now,
				updatedAt: now,
				planOnly: false,
				resume: Boolean(conversation),
				...(conversation ? { conversationId: conversation.id } : {}),
			};

			draft.tasks.push(nextTask);
			if (conversation) {
				advanceConversationTask(draft, conversation, nextTask);
				conversation.updatedAt = now;
			}
			const idempotencyKey = randomUUID();
			const fingerprint = hashSecret(`approve-plan:${task.id}:${nextTaskId}:${now}`);
			recordConversationTurn(draft, nextTask, idempotencyKey, fingerprint);

			const message = {
				id: randomUUID(),
				roomId: room.id,
				accountId: acc.id,
				text: `Approved plan for task ${task.id}. Beginning execution.`,
				sender: {
					type: "human" as const,
					id: acc.id,
					name: approverName,
					...(user ? { sourceDeviceId: user.id } : {}),
				},
				createdAt: now,
				taskIds: [nextTaskId],
				targetBotIds: [task.botId],
				...(conversation ? { conversationId: conversation.id, conversationIds: [conversation.id] } : {}),
			};
			draft.messages.push(message);

			return { plan: task.plan, nextTask };
		});
		res.json({ ok: true, plan, nextTaskId: nextTask.id });
		void drainConversation(nextTask.conversationId).catch(() => {});
	});

	app.get("/api/rooms/:id/tasks/:taskId/journal", async (req, res) => {
		const acc = account(req);
		const state = store.snapshot();
		const room = state.rooms.find((r) => r.id === req.params.id && r.accountId === acc.id);
		if (!room) fail(404, "Room missing");
		const task = state.tasks.find((t) => t.id === req.params.taskId && t.roomId === room.id && t.accountId === acc.id);
		if (!task) fail(404, "Task missing");

		const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
		const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
		const direction = req.query.direction === "backward" ? "backward" : "forward";

		const page = await taskJournalManager.getPage(task.id, acc.id, room.id, { cursor, limit, direction });
		// The task exists but never wrote a journal segment (queued, failed before the first progress
		// event, or created before the journal existed). An empty audit trail is a valid state, not a
		// missing resource: 404 here made every such task render as a broken panel in the UI.
		if (!page)
			return res.json({
				taskId: task.id,
				items: [],
				hasMore: false,
				totalEvents: 0,
				truncated: false,
				droppedCount: 0,
				journalUnavailable: groupEvents.isJournalUnavailable(task.id, task.attemptId),
			});
		res.json(page);
	});

	app.get("/api/rooms/:id/tasks/:taskId/report", (req, res) => {
		const acc = account(req);
		const state = store.snapshot();
		const room = state.rooms.find((r) => r.id === req.params.id && r.accountId === acc.id);
		if (!room) fail(404, "Room missing");
		const task = state.tasks.find((t) => t.id === req.params.taskId && t.roomId === room.id && t.accountId === acc.id);
		if (!task) fail(404, "Task missing");

		const offset = typeof req.query.offset === "string" ? parseInt(req.query.offset, 10) : undefined;
		const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
		const chunkIndex = typeof req.query.chunkIndex === "string" ? parseInt(req.query.chunkIndex, 10) : undefined;

		if (chunkIndex !== undefined && Number.isSafeInteger(chunkIndex)) {
			const chunkData = taskReportStore.getReportChunk(task.id, task.attemptId, acc.id, room.id, chunkIndex);
			if (!chunkData) fail(404, "Report chunk missing");
			return res.json({ ...chunkData, meta: mergeTaskReportMetadata(task, chunkData.meta) });
		}

		const reportData = taskReportStore.getReport(task.id, task.attemptId, acc.id, room.id, { offset, limit });
		if (!reportData) return res.json({ meta: mergeTaskReportMetadata(task, null) });
		res.json({ ...reportData, meta: mergeTaskReportMetadata(task, reportData.meta) });
	});

	app.post("/api/rooms/:id/tasks/:taskId/report", async (req, res) => {
		const agent = agents.get(req);
		if (!agent) fail(403, "Agent authentication required for report upload");
		const state = store.snapshot();
		const room = state.rooms.find((r) => r.id === req.params.id && r.accountId === agent.account.id);
		if (!room) fail(404, "Room missing");
		const task = state.tasks.find(
			(t) => t.id === req.params.taskId && t.roomId === room.id && t.accountId === agent.account.id,
		);
		if (!task) fail(404, "Task missing");

		if (task.deviceId !== agent.device.id) fail(403, "Only assigned execution device may upload reports");
		const body = req.body ?? {};
		if (body.taskId !== task.id || body.attemptId !== task.attemptId) fail(409, "Attempt mismatch");
		if (body.botId !== task.botId) fail(409, "Bot mismatch");
		if (!Number.isSafeInteger(body.totalBytes) || body.totalBytes < 0 || body.totalBytes > MAX_TASK_FULL_REPORT_BYTES)
			fail(413, "Full report exceeds 4 MiB quota");
		if (typeof body.fullSha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.fullSha256))
			fail(400, "Missing full report hash");

		const bot = state.bots.find(
			(b) => b.id === task.botId && b.accountId === agent.account.id && b.deviceId === agent.device.id,
		);
		if (!bot || !bot.enabled || bot.revision !== task.botRevision) fail(409, "Bot revision changed");

		if (typeof body.text !== "string") fail(400, "Missing report text");
		const chunkIndex = typeof body.chunkIndex === "number" ? body.chunkIndex : 0;
		const totalChunks = typeof body.totalChunks === "number" ? body.totalChunks : 1;

		try {
			const meta = taskReportStore.appendReportChunk(
				{
					taskId: task.id,
					attemptId: task.attemptId,
					chunkIndex,
					totalChunks,
					text: body.text,
					sha256: typeof body.sha256 === "string" ? body.sha256 : undefined,
					fullSha256: body.fullSha256,
					totalBytes: body.totalBytes,
					isFinal: !!body.isFinal,
				},
				room.id,
				agent.account.id,
			);
			if (meta.complete && (meta.sha256 !== body.fullSha256 || meta.totalBytes !== body.totalBytes))
				fail(409, "Assembled full report integrity mismatch");
			await store.transact((draft) => {
				const current = draft.tasks.find((entry) => entry.id === task.id && entry.attemptId === task.attemptId);
				if (!current) fail(409, "Report attempt no longer exists");
				current.reportMetadata = {
					sha256: meta.complete ? meta.sha256 : body.fullSha256,
					totalBytes: body.totalBytes,
					missing: false,
					rejected: false,
					uploadPending: !meta.complete,
					...(!meta.complete ? { publicError: "report_upload_pending" as const } : {}),
				};
			});
			res.json({ meta: { ...meta, uploadPending: !meta.complete, missing: false } });
		} catch (cause: any) {
			if (cause?.name === "TaskReportQuotaError") {
				fail(413, cause.message);
			} else if (cause?.name === "TaskReportConflictError") {
				fail(409, cause.message);
			} else {
				fail(400, cause?.message ?? "Invalid report chunk");
			}
		}
	});

	app.get("/api/rooms/:id/history", (req, res) => {
		const agent = agents.get(req);
		if (!agent) fail(403, "Agent authentication required");
		const state = store.snapshot();
		const room = state.rooms.find((entry) => entry.id === req.params.id && entry.accountId === agent.account.id);
		const source = state.bots.find(
			(bot) =>
				bot.id === req.query.sourceBotId &&
				bot.deviceId === agent.device.id &&
				bot.accountId === agent.account.id &&
				bot.enabled,
		);
		if (!room || !source || !room.botIds.includes(source.id)) fail(404, "Room missing");
		if (req.query.before !== undefined && typeof req.query.before !== "string") fail(400, "Invalid history cursor");
		res.json(groupHistoryPage(room.id, state.messages, req.query.before as string | undefined));
	});
	for (const operation of ["rename", "members", "clear", "delete"] as const) {
		app.post(`/api/rooms/:id/${operation}`, async (req, res) => {
			const owner = account(req);
			const result = await store.transact((draft) => {
				const room = draft.rooms.find((r) => r.id === req.params.id && r.accountId === owner.id);
				if (!room) fail(404, "Room missing");
				if (operation === "rename") room.name = text(req.body?.name, 128);
				if (operation === "members") {
					const members = ids(req.body?.botIds);
					if (!members.length || members.some((id) => !validBot(draft, id, owner.id))) fail(400, "Invalid room Bot");
					if (draft.tasks.some((t) => t.roomId === room.id && taskPending(t) && !members.includes(t.botId)))
						throw Object.assign(new Error("Stop removed Bots' active tasks first"), {
							status: 409,
							code: "ACTIVE_TASKS",
						});
					const primaryBotId =
						req.body?.primaryBotId === undefined
							? room.primaryBotId && members.includes(room.primaryBotId)
								? room.primaryBotId
								: undefined
							: req.body.primaryBotId === null
								? undefined
								: text(req.body.primaryBotId, 128);
					if (primaryBotId && !members.includes(primaryBotId)) fail(400, "Primary Bot must be a room member");
					room.botIds = members;
					room.primaryBotId = primaryBotId;
				}
				if (operation === "delete" || operation === "clear") {
					if (draft.tasks.some((t) => t.roomId === room.id && taskPending(t)))
						throw Object.assign(new Error("Stop active tasks before clearing or deleting room"), {
							status: 409,
							code: "ACTIVE_TASKS",
						});
					if (operation === "delete") draft.rooms = draft.rooms.filter((r) => r.id !== room.id);
					draft.messages = draft.messages.filter((m) => m.roomId !== room.id);
					draft.tasks = draft.tasks.filter((t) => t.roomId !== room.id);
					draft.receipts = draft.receipts.filter((r) => r.roomId !== room.id);
					const removedConversations = new Set(
						draft.conversations.filter((c) => c.roomId === room.id).map((c) => c.id),
					);
					draft.conversations = draft.conversations.filter((c) => c.roomId !== room.id);
					draft.deliveries = draft.deliveries.filter((d) => d.roomId !== room.id);
					draft.reviews = draft.reviews.filter((r) => r.roomId !== room.id);
					draft.deliveryReceipts = draft.deliveryReceipts.filter((r) => !removedConversations.has(r.conversationId));
					draft.conversationMessages = draft.conversationMessages.filter(
						(m) => !removedConversations.has(m.conversationId),
					);
					return operation === "delete" ? { deleted: true } : { cleared: true };
				}
				return { room };
			});
			res.json(result);
		});
	}
	for (const kind of ["deliveries", "reviews"] as const) {
		app.post(`/api/rooms/:id/conversations/:conversationId/${kind}`, async (req, res) => {
			const owner = account(req);
			const record = await store.transact((draft) => {
				const actor = { accountId: owner.id, bot: ownBot(req, draft) };
				return (kind === "deliveries" ? addDelivery : addReview)(
					draft,
					req.params.id as string,
					req.params.conversationId as string,
					actor,
					req.body,
				);
			});
			res.json(kind === "deliveries" ? { delivery: record } : { review: record });
		});
	}
	app.get("/api/rooms/:id/conversations/:conversationId/integrations", (req, res) => {
		const owner = account(req);
		const snapshot = store.snapshot();
		const conversation = snapshot.conversations.find(
			(c) => c.id === req.params.conversationId && c.roomId === req.params.id && c.accountId === owner.id,
		);
		if (!conversation) fail(404, "Conversation missing");
		res.json({ integrations: listIntegrations(snapshot, req.params.conversationId as string) });
	});
	app.post("/api/rooms/:id/conversations/:conversationId/integrations", async (req, res) => {
		const owner = account(req);
		const actor = { accountId: owner.id };
		if (!options.relay?.callDevice) fail(503, "Device relay unavailable");
		const driver = {
			callDeviceCommand: (id: string, a: string, p: unknown, opts?: { signal?: AbortSignal }) =>
				options.relay!.callDevice!(id, a as any, p, opts),
		};
		const result = await hubPrepareIntegration(
			store,
			req.params.id as string,
			req.params.conversationId as string,
			actor,
			req.body ?? {},
			driver,
		);
		res.json({ integration: result });
	});
	app.post("/api/rooms/:id/conversations/:conversationId/integrations/:integrationId/verify", async (req, res) => {
		const owner = account(req);
		const actor = { accountId: owner.id };
		if (!options.relay?.callDevice) fail(503, "Device relay unavailable");
		const driver = {
			callDeviceCommand: (id: string, a: string, p: unknown, opts?: { signal?: AbortSignal }) =>
				options.relay!.callDevice!(id, a as any, p, opts),
		};
		const result = await hubVerifyIntegration(
			store,
			req.params.id as string,
			req.params.conversationId as string,
			req.params.integrationId as string,
			actor,
			req.body ?? {},
			driver,
		);
		res.json({ integration: result });
	});
	app.post("/api/rooms/:id/conversations/:conversationId/integrations/:integrationId/apply", async (req, res) => {
		const owner = account(req);
		const actor = { accountId: owner.id };
		if (!options.relay?.callDevice) fail(503, "Device relay unavailable");
		const driver = {
			callDeviceCommand: (id: string, a: string, p: unknown, opts?: { signal?: AbortSignal }) =>
				options.relay!.callDevice!(id, a as any, p, opts),
		};
		const result = await hubConfirmIntegration(
			store,
			req.params.id as string,
			req.params.conversationId as string,
			req.params.integrationId as string,
			actor,
			req.body ?? {},
			driver,
		);
		res.json({ integration: result });
	});
	app.post("/api/rooms/:id/conversations/:conversationId/integrations/:integrationId/cancel", async (req, res) => {
		const owner = account(req);
		const actor = { accountId: owner.id };
		if (!options.relay?.callDevice) fail(503, "Device relay unavailable");
		const driver = {
			callDeviceCommand: (id: string, a: string, p: unknown, opts?: { signal?: AbortSignal }) =>
				options.relay!.callDevice!(id, a as any, p, opts),
		};
		const result = await hubCancelIntegration(
			store,
			req.params.id as string,
			req.params.conversationId as string,
			req.params.integrationId as string,
			actor,
			driver,
		);
		res.json({ integration: result });
	});
	app.post("/api/rooms/:id/conversations/:conversationId/stop", async (req, res) => {
		const owner = account(req);
		const pending = await store.transact((draft) => {
			const conversation = draft.conversations.find(
				(c) => c.id === req.params.conversationId && c.roomId === req.params.id && c.accountId === owner.id,
			);
			const room = draft.rooms.find((r) => r.id === req.params.id && r.accountId === owner.id);
			if (!conversation || !room) fail(404, "Conversation missing");
			const source = ownBot(req, draft);
			if (source && (!room.botIds.includes(source.id) || conversation.botId !== source.id))
				fail(403, "Bot may stop only its own conversation");
			conversation.closed = true;
			const tasks = draft.tasks.filter((t) => t.conversationId === conversation.id && taskPending(t));
			for (const task of tasks) {
				task.cancelRequested = true;
				if (task.status === "queued" && !deliveredTasks.has(task.id)) {
					task.stopConfirmed = true;
					task.status = "interrupted";
					task.updatedAt = Date.now();
					task.report = "Conversation stopped before delivery.";
				}
			}
			return tasks;
		});
		for (const task of pending) {
			if (task.stopConfirmed) continue;
			const confirmed = await options.relay
				?.cancelTask?.(task.deviceId, task.id, task.attemptId)
				.catch(() => ({ stopped: false }));
			if (!confirmed?.stopped) continue;
			await store.transact((draft) => {
				const current = draft.tasks.find((t) => t.id === task.id && t.attemptId === task.attemptId);
				if (!current) return;
				current.stopConfirmed = true;
				current.status = "interrupted";
				current.updatedAt = Date.now();
				current.report = "Conversation stopped.";
			});
		}
		const remaining = store
			.snapshot()
			.tasks.filter((t) => t.conversationId === req.params.conversationId && taskPending(t));
		res.json({ stopped: remaining.length === 0, pending: remaining.length });
	});
	app.post("/api/rooms/:id/conversations/:conversationId/attention", async (req, res) => {
		const owner = account(req);
		const question = text(req.body?.question, 2000);
		const kind = req.body?.kind;
		if (kind !== "answer" && kind !== "decision") fail(400, "Invalid attention kind");
		const parentTaskId = text(req.body?.parentTaskId, 128);
		const result = await store.transact((draft) => {
			const source = ownBot(req, draft);
			if (!source) fail(403, "Bot authentication required");
			const room = draft.rooms.find((r) => r.id === req.params.id && r.accountId === owner.id);
			const conversation = draft.conversations.find(
				(c) => c.id === req.params.conversationId && c.roomId === room?.id && c.accountId === owner.id,
			);
			const task = draft.tasks.find(
				(t) =>
					t.id === parentTaskId &&
					t.conversationId === conversation?.id &&
					t.botId === source.id &&
					t.status === "running" &&
					!t.cancelRequested,
			);
			if (
				!room ||
				!room.botIds.includes(source.id) ||
				!conversation ||
				conversation.closed ||
				conversation.botId !== source.id ||
				!task ||
				conversation.latestTaskId !== task.id
			)
				fail(409, "Attention requires the current running Bot task");
			if (conversation.attention) {
				if (
					conversation.attention.taskId === task.id &&
					conversation.attention.question === question &&
					conversation.attention.kind === kind
				)
					return conversation.attention;
				fail(409, "An unanswered question already exists");
			}
			conversation.attention = { id: randomUUID(), taskId: task.id, kind, question, createdAt: Date.now() };
			return conversation.attention;
		});
		res.json({ attention: result });
	});
	app.get("/api/rooms/:id/conversations/:conversationId/task-state", (req, res) => {
		const state = store.snapshot();
		const owner = account(req);
		const room = state.rooms.find((entry) => entry.id === req.params.id && entry.accountId === owner.id);
		const agent = agents.get(req);
		if (
			!room ||
			(agent &&
				!state.bots.some(
					(bot) =>
						bot.id === req.query.sourceBotId &&
						bot.deviceId === agent.device.id &&
						bot.accountId === owner.id &&
						bot.enabled &&
						room.botIds.includes(bot.id),
				))
		)
			fail(404, "Room missing");
		const conversation = state.conversations.find(
			(entry) => entry.id === req.params.conversationId && entry.roomId === room.id && entry.accountId === owner.id,
		);
		if (!conversation) fail(404, "Conversation missing");

		const allowedQueries = ["sourceBotId", "beforeSequence", "summaryOnly"];
		for (const q of Object.keys(req.query)) {
			if (!allowedQueries.includes(q)) fail(400, `Unknown query parameter: ${q}`);
		}
		let events = conversation.events ?? [];
		if (req.query.beforeSequence !== undefined) {
			const seq = Number(req.query.beforeSequence);
			if (!Number.isSafeInteger(seq) || seq < 0) fail(400, "Invalid beforeSequence");
			events = events.filter((e) => e.sequence < seq);
		}
		if (req.query.summaryOnly !== undefined && !["true", "false"].includes(String(req.query.summaryOnly))) {
			fail(400, "Invalid summaryOnly parameter");
		}
		const summary = conversation.taskState ? buildDeterministicTaskSummary(conversation.taskState) : undefined;
		if (req.query.summaryOnly === "true") {
			res.json({ summary, taskState: conversation.taskState });
			return;
		}
		res.json({ taskState: conversation.taskState, events, ...(summary ? { summary } : {}) });
	});
	app.get("/api/rooms/:id/conversations/:conversationId/evidence", (req, res) => {
		const state = store.snapshot();
		const owner = account(req);
		const room = state.rooms.find((entry) => entry.id === req.params.id && entry.accountId === owner.id);
		const agent = agents.get(req);
		if (
			!room ||
			(agent &&
				!state.bots.some(
					(bot) =>
						bot.id === req.query.sourceBotId &&
						bot.deviceId === agent.device.id &&
						bot.accountId === owner.id &&
						bot.enabled &&
						room.botIds.includes(bot.id),
				))
		)
			fail(404, "Room missing");
		const conversation = state.conversations.find(
			(entry) => entry.id === req.params.conversationId && entry.roomId === room.id && entry.accountId === owner.id,
		);
		if (!conversation) fail(404, "Conversation missing");

		const allowedQueries = ["sourceBotId", "taskId", "deliveryId", "offset", "limit", "expectedDigest", "digest"];
		for (const q of Object.keys(req.query)) {
			if (!allowedQueries.includes(q)) fail(400, `Unknown query parameter: ${q}`);
		}

		let offset = 0;
		if (req.query.offset !== undefined) {
			offset = Number(req.query.offset);
			if (!Number.isSafeInteger(offset) || offset < 0) fail(400, "Invalid offset");
		}
		let limit = 8192;
		if (req.query.limit !== undefined) {
			limit = Number(req.query.limit);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536) fail(400, "Invalid limit");
		}
		const expectedDigest =
			typeof req.query.expectedDigest === "string"
				? req.query.expectedDigest
				: typeof req.query.digest === "string"
					? req.query.digest
					: undefined;

		const taskId = typeof req.query.taskId === "string" ? req.query.taskId : conversation.latestTaskId;
		const targetTask = state.tasks.find((t) => t.id === taskId && t.conversationId === conversation.id);
		const deliveryId = typeof req.query.deliveryId === "string" ? req.query.deliveryId : undefined;
		const targetDelivery = deliveryId
			? state.deliveries.find((d) => d.id === deliveryId && d.conversationId === conversation.id)
			: undefined;

		let evidence: TaskReportEvidence | undefined;

		if (targetTask?.attemptId) {
			const reportResult = taskReportStore.getReport(targetTask.id, targetTask.attemptId, owner.id, room.id, {
				offset,
				limit,
				expectedDigest,
				revision: conversation.taskState?.revision,
			});
			if (reportResult?.versionMismatch) {
				fail(409, "Report version digest mismatch; start reading from offset 0 with new digest");
			}
			if (reportResult && reportResult.text !== undefined) {
				evidence = {
					taskId: targetTask.id,
					attemptId: targetTask.attemptId,
					revision: conversation.taskState?.revision,
					totalBytes: reportResult.meta.totalBytes,
					offset: reportResult.offset ?? offset,
					limit: reportResult.limit ?? limit,
					chunk: reportResult.text,
					hasMore: reportResult.hasMore ?? false,
					nextOffset: reportResult.nextOffset ?? null,
					isExcerpt: (reportResult.hasMore ?? false) || (reportResult.offset ?? 0) > 0,
					complete: reportResult.meta.complete,
					source: "full_report",
					reportRef: reportResult.meta.storageLocation.reportRef,
					digest: reportResult.digest ?? "",
					sha256: reportResult.sha256 ?? reportResult.meta.sha256 ?? "",
				};
			}
		}

		if (!evidence && targetTask?.report) {
			const chunk = queryTaskReportChunk(targetTask.id, targetTask.report, offset, limit, {
				attemptId: targetTask.attemptId,
				revision: conversation.taskState?.revision,
				source: "report_excerpt",
				complete: false,
			});
			if (expectedDigest && chunk.digest !== expectedDigest) {
				fail(409, "Report version digest mismatch; start reading from offset 0 with new digest");
			}
			evidence = chunk;
		}

		res.json({
			conversationId: conversation.id,
			taskId,
			...(evidence ? { evidence } : {}),
			...(targetDelivery ? { delivery: targetDelivery } : {}),
			summary: conversation.taskState ? buildDeterministicTaskSummary(conversation.taskState) : undefined,
		});
	});
	app.post("/api/rooms/:id/conversations/:conversationId/task-state", async (req, res) => {
		const owner = account(req);
		const body = req.body as DeviceTaskUpdateRequest;
		if (
			!body ||
			typeof body !== "object" ||
			Array.isArray(body) ||
			Object.keys(body).some(
				(key) =>
					![
						"sourceBotId",
						"parentTaskId",
						"expectedRevision",
						"constraints",
						"progress",
						"blockers",
						"nextSteps",
					].includes(key),
			) ||
			!Number.isSafeInteger(body.expectedRevision) ||
			body.expectedRevision < 0
		)
			fail(400, "Invalid task state update");
		const parentTaskId = text(body.parentTaskId, 128);
		const changes: Partial<Pick<DeviceTaskUpdateRequest, "constraints" | "progress" | "blockers" | "nextSteps">> = {};
		for (const key of ["constraints", "blockers", "nextSteps"] as const) {
			const value = body[key];
			if (value === undefined) continue;
			if (
				!Array.isArray(value) ||
				value.length > 20 ||
				value.some((item) => typeof item !== "string" || !item.trim() || item.length > 500)
			)
				fail(400, "Invalid task state list");
			changes[key] = [...value];
		}
		if (body.progress !== undefined) {
			if (typeof body.progress !== "string" || body.progress.length > 2000) fail(400, "Invalid progress");
			changes.progress = body.progress;
		}
		if (!Object.keys(changes).length) fail(400, "Task state update is empty");
		const conversation = await store.transact((draft) => {
			const source = ownBot(req, draft);
			if (!source) fail(403, "Bot authentication required");
			const room = draft.rooms.find((entry) => entry.id === req.params.id && entry.accountId === owner.id);
			const current = draft.conversations.find(
				(entry) => entry.id === req.params.conversationId && entry.roomId === room?.id && entry.accountId === owner.id,
			);
			const task = draft.tasks.find(
				(entry) =>
					entry.id === parentTaskId &&
					entry.conversationId === current?.id &&
					entry.botId === source.id &&
					entry.status === "running" &&
					!entry.cancelRequested,
			);
			if (
				!room ||
				!room.botIds.includes(source.id) ||
				!current ||
				current.closed ||
				current.botId !== source.id ||
				!task ||
				current.latestTaskId !== task.id ||
				!current.taskState
			)
				fail(409, "Task state update requires the current running Bot task");
			if (current.taskState.revision !== body.expectedRevision)
				fail(409, "Task state revision changed; read task_state again");
			const previous = current.taskState.reported;
			const next = {
				constraints: [],
				progress: "",
				blockers: [],
				nextSteps: [],
				...previous,
				...changes,
				taskId: task.id,
				botId: source.id,
				provenance: "bot_reported" as const,
				updatedAt: previous?.updatedAt ?? Date.now(),
			};
			if (JSON.stringify(next) !== JSON.stringify(previous)) next.updatedAt = Date.now();
			current.taskState.reported = next;
			return current;
		});
		res.json({ taskState: conversation.taskState, events: conversation.events ?? [] });
	});
	app.get(["/api/rooms/:id/conversations", "/api/rooms/:id/conversations/:conversationId"], (req, res) => {
		const state = store.snapshot();
		const room = state.rooms.find((r) => r.id === req.params.id && r.accountId === account(req).id);
		const agent = agents.get(req);
		if (
			!room ||
			(agent &&
				!state.bots.some(
					(b) =>
						b.id === req.query.sourceBotId &&
						b.deviceId === agent.device.id &&
						b.accountId === room.accountId &&
						b.enabled &&
						room.botIds.includes(b.id),
				))
		)
			fail(404, "Room missing");
		const conversations = state.conversations
			.filter((c) => c.roomId === room.id && c.accountId === room.accountId)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((c) => ({
				...c,
				status: conversationStatus(state, c),
				...deliverySummary(state, c.id, !req.params.conversationId),
			}));
		if (!req.params.conversationId) return res.json({ conversations });
		const conversation = conversations.find((c) => c.id === req.params.conversationId);
		if (!conversation) fail(404, "Conversation missing");
		if (req.query.before !== undefined && typeof req.query.before !== "string")
			fail(400, "Invalid conversation cursor");
		res.json({
			conversation,
			...conversationPage(state, conversation.id, req.query.before as string | undefined),
			...deliveryHistory(state, conversation.id),
		});
	});
	app.post(
		[
			"/api/rooms/:id/messages",
			"/api/rooms/:id/conversations",
			"/api/rooms/:id/conversations/:conversationId/messages",
		],
		async (req, res) => {
			const owner = account(req);
			const content = text(req.body?.text);
			const conversationApi = req.path.includes("/conversations");
			const conversationId = req.params.conversationId;
			const kind = req.body?.kind ?? "message";
			if (!["message", "request", "reply"].includes(kind)) fail(400, "Invalid message kind");
			const requestId =
				req.body?.requestId === undefined
					? kind === "request"
						? randomUUID()
						: undefined
					: text(req.body.requestId, 128);
			if (kind === "reply" && !requestId) fail(400, "Reply requires requestId");
			const targets = ids(
				conversationApi ? (conversationId ? [] : [text(req.body?.targetBotId, 128)]) : (req.body?.targetBotIds ?? []),
			);
			const transfer = handoff(req.body?.handoff);
			const parentTaskId = req.body?.parentTaskId === undefined ? undefined : text(req.body.parentTaskId, 128);
			const attentionId = req.body?.attentionId === undefined ? undefined : text(req.body.attentionId, 128);
			const key = req.body?.idempotencyKey === undefined ? randomUUID() : text(req.body.idempotencyKey, 128);
			const planOnly = req.body?.planOnly === true;
			const fingerprint = hashSecret(
				JSON.stringify({
					content,
					attentionId,
					targets,
					conversationId,
					kind,
					requestId: req.body?.requestId,
					transfer,
					parentTaskId,
					planOnly,
					sourceDeviceId: (agents.get(req) ?? users.get(req))?.device.id,
					sourceBotId: agents.has(req) ? req.body?.sourceBotId : undefined,
					senderType: agents.has(req) ? "bot" : "human",
				}),
			);
			const result = await store.transact((draft) => {
				const room = draft.rooms.find((r) => r.id === req.params.id && r.accountId === owner.id);
				if (!room) fail(404, "Room missing");
				const source = ownBot(req, draft);
				const userSource = users.get(req)?.device;
				let conversation = conversationId
					? draft.conversations.find((c) => c.id === conversationId && c.roomId === room.id && c.accountId === owner.id)
					: undefined;
				if (conversationId && !conversation) fail(404, "Conversation missing");
				if (conversation?.closed) fail(409, "Conversation is closed");
				if (conversation) {
					const bot = validBot(draft, conversation.botId, owner.id);
					if (!bot || bot.revision !== conversation.botRevision || bot.deviceId !== conversation.deviceId)
						fail(409, "Conversation Bot configuration changed");
					targets.push(conversation.botId);
				}
				if (source && !room.botIds.includes(source.id)) fail(403, "Source Bot is not a room member");
				if (targets.some((id) => !room.botIds.includes(id) || !validBot(draft, id, owner.id)))
					fail(400, "Invalid target Bot");
				if (
					source &&
					targets.length &&
					!draft.tasks.some(
						(t) =>
							t.id === parentTaskId &&
							t.botId === source.id &&
							t.accountId === owner.id &&
							t.roomId === room.id &&
							(t.status === "running" || isTerminal(t.status)),
					)
				)
					fail(400, "Device dispatch requires its own bound parent task");
				{
					const prior = draft.conversationMessages.find(
						(m) =>
							conversationId !== undefined &&
							m.conversationId === conversationId &&
							m.idempotencyKey === key &&
							draft.conversations.some(
								(c) => c.id === m.conversationId && c.roomId === room.id && c.accountId === owner.id,
							),
					);
					if (prior) {
						if (prior.fingerprint !== fingerprint) fail(409, "Idempotency key reused");
						return {
							message: draft.messages.find((m) => m.taskIds.includes(prior.taskId)),
							tasks: draft.tasks.filter((t) => t.id === prior.taskId),
							duplicate: true,
						};
					}
				}
				const receipt = draft.receipts.find((r) => r.roomId === room.id && r.accountId === owner.id && r.key === key);
				if (receipt) {
					if (receipt.fingerprint !== fingerprint) fail(409, "Idempotency key reused");
					return {
						message: draft.messages.find((m) => m.id === receipt.messageId),
						tasks: draft.tasks.filter((t) =>
							draft.messages.find((m) => m.id === receipt.messageId)?.taskIds.includes(t.id),
						),
						duplicate: true,
					};
				}
				// Resolve implicit human targets after replay detection so retries remain stable across configuration changes.
				if (!source && !conversationApi && !targets.length && room.primaryBotId) {
					if (!room.botIds.includes(room.primaryBotId) || !validBot(draft, room.primaryBotId, owner.id))
						fail(400, "Primary Bot is unavailable");
					targets.push(room.primaryBotId);
					const bot = validBot(draft, room.primaryBotId, owner.id)!;
					conversation = draft.conversations
						.filter(
							(entry) =>
								entry.roomId === room.id &&
								entry.accountId === owner.id &&
								entry.botId === bot.id &&
								!entry.closed &&
								entry.botRevision === bot.revision &&
								entry.deviceId === bot.deviceId,
						)
						.sort((a, b) => b.updatedAt - a.updatedAt)[0];
				}
				if (attentionId) {
					if (source || !conversationId || !conversation || conversation.attention?.id !== attentionId)
						fail(409, "Question changed or already answered");
					delete conversation.attention;
				}
				if (kind === "reply") {
					const request = draft.conversationMessages.find(
						(m) =>
							m.kind === "request" &&
							m.requestId === requestId &&
							draft.conversations.some(
								(c) => c.id === m.conversationId && c.roomId === room.id && c.accountId === owner.id,
							),
					);
					const requestedConversation = draft.conversations.find((c) => c.id === request?.conversationId);
					if (
						!request ||
						!requestedConversation ||
						source?.id !== requestedConversation.botId ||
						!conversation ||
						conversation.botId !== request.sourceBotId ||
						conversation.id !== draft.tasks.find((t) => t.id === request.taskId)?.sourceConversationId ||
						draft.tasks.find((t) => t.id === parentTaskId)?.conversationId !== request.conversationId
					)
						fail(403, "Reply must address the original requester from the requested Bot");
					if (draft.tasks.some((t) => t.resultOfTaskId === request.taskId)) fail(409, "Request already completed");
					if (
						draft.conversationMessages.some(
							(m) =>
								m.kind === "reply" &&
								m.requestId === requestId &&
								m.idempotencyKey !== key &&
								draft.conversations.some((c) => c.id === m.conversationId && c.roomId === room.id),
						)
					)
						fail(409, "Request already answered");
				}
				if (
					parentTaskId &&
					!draft.tasks.some(
						(t) =>
							t.id === parentTaskId &&
							t.roomId === room.id &&
							t.accountId === owner.id &&
							(isTerminal(t.status) || (source?.id === t.botId && t.status === "running")),
					)
				)
					fail(400, "Parent task must be terminal or the source device's running task in this room");
				if (
					kind === "request" &&
					draft.conversationMessages.some(
						(m) =>
							m.kind === "request" &&
							m.requestId === requestId &&
							draft.conversations.some((c) => c.id === m.conversationId && c.roomId === room.id),
					)
				)
					fail(409, "Request ID already exists");
				const parent = parentTaskId ? draft.tasks.find((t) => t.id === parentTaskId) : undefined;
				if (source && targets.length && (!parent || parent.botId !== source.id))
					fail(400, "Device dispatch requires its own running or terminal parent task");
				// Explicit human input grants a new lineage; autonomous work always inherits its real parent.
				const root = parent ? draft.tasks.find((t) => t.id === (parent.rootTaskId ?? parent.id)) : undefined;
				if (parent && targets.length && !root) fail(409, "Dispatch root expired");
				const depth = parent ? (parent.dispatchDepth ?? 0) + 1 : 0;
				if (planOnly && targets.some((id) => !validBot(draft, id, owner.id)?.tools?.includes("plan_update")))
					fail(409, "Planning requires plan_update authorization in each Bot tool allowlist");
				if (targets.length && depth > 8) fail(409, "Dispatch depth exhausted");
				if (targets.length && (root?.dispatchCount ?? 0) + targets.length > 16) fail(409, "Dispatch budget exhausted");
				if (root && targets.length) root.dispatchCount = (root.dispatchCount ?? 0) + targets.length;
				if (draft.tasks.filter((t) => t.roomId === room.id && taskPending(t)).length + targets.length > HISTORY)
					fail(409, "Too many active tasks");
				if (!conversation && draft.conversations.filter((c) => c.roomId === room.id).length + targets.length > HISTORY)
					fail(409, "Conversation capacity reached; clear completed history first");
				const now = Date.now();
				const rootId = root?.id ?? randomUUID();
				const tasks: HubTask[] = targets.map((botId, index) => ({
					id: !root && index === 0 ? rootId : randomUUID(),
					rootTaskId: rootId,
					dispatchDepth: depth,
					...(!root && index === 0 ? { dispatchCount: targets.length } : {}),
					attemptId: randomUUID(),
					roomId: room.id,
					accountId: owner.id,
					botId,
					deviceId: validBot(draft, botId, owner.id)!.deviceId,
					botRevision: validBot(draft, botId, owner.id)!.revision,
					...(source ? { sourceBotId: source.id } : {}),
					text: content,
					status: "queued",
					createdAt: now,
					updatedAt: now,
					...(planOnly ? { planOnly: true, plan: { state: "draft", steps: [] } } : {}),
					...(transfer ? { handoff: transfer } : {}),
					...(parentTaskId ? { parentTaskId } : {}),
				}));
				for (const task of tasks) {
					task.kind = kind;
					task.sourceConversationId = parent?.conversationId;
					task.requestId = requestId;
					if (conversation) {
						task.conversationId = conversation.id;
						task.resume = true;
						advanceConversationTask(draft, conversation, task);
						conversation.rootTaskId = task.rootTaskId!;
						conversation.updatedAt = now;
						conversation.dispatchDepth = depth;
					} else establishConversation(draft, task);
					recordConversationTurn(draft, task, key, fingerprint);
				}
				const message = {
					id: randomUUID(),
					roomId: room.id,
					accountId: owner.id,
					text: content,
					sender: source
						? { type: "bot" as const, id: source.id, name: source.name, sourceDeviceId: source.deviceId }
						: {
								type: "human" as const,
								id: owner.id,
								name: userSource ? `${owner.username} · ${userSource.name}` : owner.username,
								...(userSource ? { sourceDeviceId: userSource.id } : {}),
							},
					createdAt: now,
					taskIds: tasks.map((t) => t.id),
					targetBotIds: targets,
					...(tasks.length === 1 ? { conversationId: tasks[0].conversationId } : {}),
					...(tasks.length ? { conversationIds: tasks.map((task) => task.conversationId!) } : {}),
				};
				// Freeze shared context before any recipient starts. Parallel answers cannot leak into siblings.
				const context = tasks.length ? groupTaskContext(room, draft.bots, draft.messages) : undefined;
				draft.tasks.push(...tasks);
				draft.messages.push(message);
				draft.receipts.push({ accountId: owner.id, roomId: room.id, key, fingerprint, messageId: message.id });
				const oldMessages = draft.messages.filter((m) => m.roomId === room.id).slice(0, -HISTORY);
				const removed = new Set(oldMessages.map((m) => m.id));
				draft.messages = draft.messages.filter((m) => !removed.has(m.id));
				draft.receipts = draft.receipts.filter((r) => !removed.has(r.messageId));
				const oldTasks = new Set(
					draft.tasks
						.filter(
							(t) =>
								t.roomId === room.id &&
								isTerminal(t.status) &&
								!draft.conversations.some((c) => c.rootTaskId === t.id || c.id === t.conversationId),
						)
						.slice(0, -HISTORY)
						.map((t) => t.id),
				);
				draft.tasks = draft.tasks.filter((t) => !oldTasks.has(t.id));
				trimConversationHistory(draft, room.id);
				return { message, tasks, duplicate: false, context };
			});
			if (!result.duplicate) for (const task of result.tasks) await deliverTask(task, result.context);
			const state = store.snapshot();
			res.json({
				...(conversationApi
					? {
							conversation: state.conversations.find((c) => c.id === result.tasks[0]?.conversationId),
							task: ((t) => (t ? publicTask(t) : undefined))(state.tasks.find((t) => t.id === result.tasks[0]?.id)),
						}
					: {}),
				message: result.message,
				tasks: result.tasks.map((task) =>
					publicTask(state.tasks.find((entry) => entry.id === task.id && entry.attemptId === task.attemptId) ?? task),
				),
			});
		},
	);
	for (const action of ["alias", "portal"])
		app.post(`/api/devices/:id/${action}`, async (req, res) => {
			const owner = account(req);
			const id = String(req.params.id);
			if (store.getDeviceOwner(id) !== owner.id) fail(404, "Device missing");
			if (!options.portals) fail(409, "Device portals unavailable");
			if (action === "alias" && typeof req.body?.alias !== "string") fail(400, "Invalid alias");
			await options.portals.assign(id, owner.id, action === "alias" ? req.body.alias : undefined);
			res.json({ device: visibleDevice(store.getDevice(id)!) });
		});
	app.get("/device/:id", async (req, res) => {
		const owner = getAccount(req);
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		if (!owner) {
			res
				.status(401)
				.type("html")
				.send(
					'<!doctype html><meta charset="utf-8"><p>请先登录设备中心，再打开设备链接。</p><a href="/">Sign in / 登录设备中心</a>',
				);
			return;
		}
		const id = String(req.params.id);
		if (store.getDeviceOwner(id) !== owner.id) fail(404, "Device missing");
		if (!options.portals && !options.pathAccess) fail(409, "Device portals unavailable");
		if (!options.relay?.handleAliasOpen) fail(503, "Relay unavailable");
		if (!options.pathAccess) await options.portals!.assign(id, owner.id);
		await options.relay.handleAliasOpen(req, res, id);
	});
	app.get("/:alias", async (req, res, next) => {
		const entry = options.portals?.resolveAlias(String(req.params.alias));
		if (!entry) return next();
		const owner = getAccount(req);
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Referrer-Policy", "no-referrer");
		if (!owner) {
			res
				.status(401)
				.type("html")
				.send(
					'<!doctype html><meta charset="utf-8"><p>Sign in to the device hub, then open this address again.</p><a href="/">Sign in / 登录设备中心</a>',
				);
			return;
		}
		if (owner.id !== entry.accountId || store.getDeviceOwner(entry.deviceId) !== owner.id) fail(404, "Device missing");
		if (!options.relay?.handleAliasOpen) fail(503, "Relay unavailable");
		await options.relay.handleAliasOpen(req, res, entry.deviceId);
	});
	app.post("/api/devices/:id/open", async (req, res) => {
		const owner = account(req);
		const id = String(req.params.id);
		if (store.getDeviceOwner(id) !== owner.id) fail(404, "Device missing");
		if (options.portals && !options.deviceDomain && !options.pathAccess) {
			try {
				await options.portals.assign(id, owner.id);
			} catch (error) {
				if ((error as { status?: number }).status !== 409) throw error;
				return res
					.status(409)
					.json({ code: "DEVICE_WEB_ORIGIN_REQUIRED", error: "No device portal port is available" });
			}
		}
		if (users.has(req)) req.headers.origin = origin.origin;
		if (!options.relay?.handleOpen) fail(503, "Relay unavailable");
		await options.relay.handleOpen(req, res, String(req.params.id));
	});
	// No catch-all: the runner mounts the UI after creation.
	app.use((error: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
		res.status(error.status ?? 500).json({
			error: error.status && error.status < 500 ? error.message : "Storage or internal error",
			...(error.code === "ACTIVE_TASKS" ? { code: "ACTIVE_TASKS" } : {}),
		});
	});
	const server = options.server ?? createServer();
	server.on("request", (req, res) => {
		if (options.relay?.handleRequest?.(req, res)) return;
		app(req, res);
	});
	// Accepted queued tasks remain in flight until a terminal event, including asynchronous relay delivery.
	const deliveredTasks = new Set<string>();
	async function drainConversation(conversationId?: string) {
		if (!conversationId) return;
		const state = store.snapshot();
		const next = nextConversationTask(state, conversationId);
		if (!next || deliveredTasks.has(next.id)) return;
		const room = state.rooms.find((entry) => entry.id === next.roomId);
		await deliverTask(next, room ? groupTaskContext(room, state.bots, state.messages) : undefined);
	}
	async function deliverTask(task: HubTask, context?: GroupTaskContext) {
		if (deliveredTasks.has(task.id)) return;
		if (task.conversationId && nextConversationTask(store.snapshot(), task.conversationId)?.id !== task.id) return;
		deliveredTasks.add(task.id);
		const deliver = options.onTask ?? options.relay?.onTask;
		try {
			const latest = store.snapshot();
			if (
				latest.tasks.find((t) => t.id === task.id)?.cancelRequested ||
				latest.conversations.find((c) => c.id === task.conversationId)?.closed ||
				validBot(latest, task.botId, task.accountId)?.revision !== task.botRevision ||
				!latest.rooms.some((r) => r.id === task.roomId && r.botIds.includes(task.botId))
			)
				throw new Error("Bot no longer available");
			await store.transact((draft) => {
				const current = draft.tasks.find((entry) => entry.id === task.id && entry.attemptId === task.attemptId);
				if (current) {
					current.leaseToken = randomUUID();
					current.leaseGeneration = (current.leaseGeneration ?? 0) + 1;
					current.lastHeartbeatAt = Date.now();
					task.leaseToken = current.leaseToken;
					task.leaseGeneration = current.leaseGeneration;
				}
				const conversation = draft.conversations.find((entry) => entry.id === task.conversationId);
				if (conversation && !conversation.closed) {
					conversation.latestTaskId = task.id;
					conversation.updatedAt = Date.now();
				}
			});
			const committed = store.snapshot();
			if (
				committed.tasks.find((entry) => entry.id === task.id)?.cancelRequested ||
				committed.conversations.find((entry) => entry.id === task.conversationId)?.closed
			)
				throw new Error("Conversation stopped before delivery");
			const taskState = committed.conversations.find((entry) => entry.id === task.conversationId)?.taskState;
			if (
				!deliver ||
				(await deliver(task.deviceId, {
					...task,
					leaseToken: task.leaseToken,
					leaseGeneration: task.leaseGeneration,
					context,
					taskState,
				})) === false
			)
				throw new Error("Delivery rejected");
		} catch {
			const failure = await store.transact((draft) => {
				const current = draft.tasks.find((entry) => entry.id === task.id && entry.attemptId === task.attemptId);
				if (!current || isTerminal(current.status) || current.cancelRequested) return;
				const report = "Task delivery failed; submit a new request to retry.";
				current.status = "failed";
				current.updatedAt = Date.now();
				current.report = report;
				if (current.conversationId)
					draft.conversationMessages.push({
						id: randomUUID(),
						conversationId: current.conversationId,
						taskId: current.id,
						kind: "result",
						text: report,
						sourceBotId: current.botId,
						requestId: current.requestId,
						createdAt: current.updatedAt,
					});
				const room = draft.rooms.find((r) => r.id === current.roomId);
				const context = room ? groupTaskContext(room, draft.bots, draft.messages) : undefined;
				const wake = queueParentResult(draft, current);
				draft.messages.push({
					id: randomUUID(),
					roomId: current.roomId,
					accountId: current.accountId,
					text: report,
					sender: {
						type: "bot",
						id: current.botId,
						name: draft.bots.find((bot) => bot.id === current.botId)?.name ?? current.botId,
						sourceDeviceId: current.deviceId,
					},
					createdAt: current.updatedAt,
					taskIds: [current.id],
				});
				const remove = new Set(
					draft.messages
						.filter((message) => message.roomId === current.roomId)
						.slice(0, -HISTORY)
						.map((message) => message.id),
				);
				draft.messages = draft.messages.filter((message) => !remove.has(message.id));
				draft.receipts = draft.receipts.filter((receipt) => !remove.has(receipt.messageId));
				trimConversationHistory(draft, current.roomId);
				return { wake, context };
			});
			if (failure?.wake) await deliverTask(failure.wake, failure.context);
		} finally {
			if (isTerminal(store.snapshot().tasks.find((entry) => entry.id === task.id)?.status ?? "interrupted")) {
				deliveredTasks.delete(task.id);
				await drainConversation(task.conversationId);
			}
		}
	}
	async function acceptTaskEvent(deviceId: string, event: HubTaskEvent) {
		if (
			!event ||
			typeof event.taskId !== "string" ||
			typeof event.attemptId !== "string" ||
			typeof event.botId !== "string" ||
			!["running", "completed", "failed", "interrupted"].includes(event.status)
		)
			fail(400, "Invalid task event");
		const report =
			event.report === undefined
				? event.status === "failed"
					? "Task execution failed without a report."
					: event.status === "interrupted"
						? "Task execution was interrupted without a report."
						: undefined
				: text(event.report);
		if (event.status === "completed" && !report) fail(400, "Completed task requires agent report");
		let reportMetadata: import("../protocol.js").DeviceTaskReportMetadata | undefined;
		try {
			if (event.reportMetadata !== undefined) reportMetadata = parseReportMetadata(event.reportMetadata);
		} catch {
			fail(400, "Invalid report metadata");
		}
		const result = await store.transact((draft) => {
			const device = draft.devices.find((d) => d.id === deviceId);
			const task = draft.tasks.find(
				(t) =>
					t.id === event.taskId &&
					t.deviceId === deviceId &&
					t.botId === event.botId &&
					t.attemptId === event.attemptId &&
					t.accountId === device?.accountId,
			);
			const bot = draft.bots.find(
				(b) => b.id === event.botId && b.deviceId === deviceId && b.accountId === device?.accountId,
			);
			if (!task || !device || !bot || !draft.rooms.some((r) => r.id === task.roomId && r.botIds.includes(bot.id)))
				fail(404, "Task missing");
			if (event.status !== "interrupted" && (!bot.enabled || bot.revision !== task.botRevision))
				fail(409, "Bot configuration changed");
			if (isTerminal(event.status)) {
				const stored = taskReportStore.getReportMeta(task.id, task.attemptId, task.accountId, task.roomId);
				task.reportMetadata = stored?.complete
					? {
							sha256: stored.sha256,
							totalBytes: stored.totalBytes,
							missing: false,
							rejected: false,
							uploadPending: false,
						}
					: (reportMetadata ?? task.reportMetadata ?? reportUploadMetadata());
			}
			if (task.status === event.status) {
				if (task.report && report && task.report !== report) fail(409, "Conflicting duplicate event");
				return { task };
			}
			// Allow safe outbox replay or recovery adoption if task was marked interrupted during restart/disconnect
			const inRecovery = typeof task.recoveryUntil === "number" && Date.now() <= task.recoveryUntil;
			const canAdoptInterrupted =
				(inRecovery || task.status === "interrupted") && (event.status === "completed" || event.status === "failed");
			if (!canAdoptInterrupted) {
				if (
					isTerminal(task.status) ||
					(task.status === "queued" && event.status !== "running" && event.status !== "interrupted") ||
					(task.status === "running" && !isTerminal(event.status))
				)
					fail(409, "Invalid task transition");
			}
			delete task.recoveryUntil;
			task.status = event.status;
			task.updatedAt = Date.now();
			if (report) task.report = report;
			if (report) {
				draft.messages.push({
					id: randomUUID(),
					roomId: task.roomId,
					accountId: task.accountId,
					text: report,
					sender: { type: "bot", id: bot.id, name: bot.name, sourceDeviceId: deviceId },
					createdAt: Date.now(),
					taskIds: [task.id],
					conversationId: task.conversationId,
				});
				if (task.conversationId)
					draft.conversationMessages.push({
						id: randomUUID(),
						conversationId: task.conversationId,
						taskId: task.id,
						kind: "result",
						text: report,
						sourceBotId: bot.id,
						requestId: task.requestId,
						createdAt: Date.now(),
					});
				const remove = new Set(
					draft.messages
						.filter((m) => m.roomId === task.roomId)
						.slice(0, -HISTORY)
						.map((m) => m.id),
				);
				draft.messages = draft.messages.filter((m) => !remove.has(m.id));
				draft.receipts = draft.receipts.filter((r) => !remove.has(r.messageId));
			}
			const room = draft.rooms.find((r) => r.id === task.roomId)!;
			const context = groupTaskContext(room, draft.bots, draft.messages);
			const wake = queueParentResult(draft, task);
			trimConversationHistory(draft, task.roomId);
			return { task, wake, context };
		});
		if (result?.task) {
			taskJournalManager
				.append(
					result.task.id,
					{
						botId: result.task.botId,
						attemptId: result.task.attemptId,
						type: "status",
						phase: event.status,
						summary: `Task ${event.status}${report ? ": " + report.slice(0, 100) : ""}`,
						output: report,
					},
					{ roomId: result.task.roomId, accountId: result.task.accountId },
				)
				.catch((cause) => {
					console.warn(`[TaskJournal] Journal append failed for task ${result.task.id}:`, cause);
				});
		}
		if (isTerminal(result.task.status)) deliveredTasks.delete(result.task.id);
		if (result.wake) await deliverTask(result.wake, result.context);
		await drainConversation(result.task.conversationId);
		return result.task;
	}

	// === Hub Restart Recovery Window ===
	const nowInit = Date.now();
	const recoveryGraceMs = 60_000;
	try {
		await store.transact((draft) => {
			for (const task of draft.tasks) {
				if (task.status === "running") {
					task.recoveryUntil = nowInit + recoveryGraceMs;
				}
			}
		});
	} catch (err) {
		console.error("DEBUG store.transact failed:", err);
	}

	let sweepInflight = false;
	const recoverySweepTimer = setInterval(() => {
		if (sweepInflight) return;
		const sweepNow = Date.now();
		const snapshot = store.snapshot();
		const hasDue = snapshot.tasks.some(
			(t) =>
				(t.recoveryUntil && sweepNow > t.recoveryUntil) ||
				(t.status === "running" && t.lastHeartbeatAt && sweepNow - t.lastHeartbeatAt > 30 * 60_000),
		);
		if (!hasDue) return;

		sweepInflight = true;
		void (async () => {
			try {
				const settledWakes: {
					wake?: HubTask;
					context?: GroupTaskContext;
					conversationId?: string;
					taskId: string;
				}[] = [];
				await store.transact((draft) => {
					for (const task of draft.tasks) {
						const windowExpired = task.recoveryUntil && sweepNow > task.recoveryUntil;
						const leaseExpired =
							task.status === "running" && task.lastHeartbeatAt && sweepNow - task.lastHeartbeatAt > 30 * 60_000;
						if (windowExpired || leaseExpired) {
							delete task.recoveryUntil;
							if (task.status === "running") {
								task.status = "interrupted";
								task.updatedAt = sweepNow;
								const report = windowExpired
									? "Hub restarted; recovery window expired without reconnect claim."
									: "Task lease expired due to prolonged inactivity.";
								task.report = report;
								const room = draft.rooms.find((r) => r.id === task.roomId);
								const context = room ? groupTaskContext(room, draft.bots, draft.messages) : undefined;
								const wake = queueParentResult(draft, task);
								trimConversationHistory(draft, task.roomId);
								settledWakes.push({ wake, context, conversationId: task.conversationId, taskId: task.id });
							}
						}
					}
				});
				for (const item of settledWakes) {
					deliveredTasks.delete(item.taskId);
					if (item.wake) await deliverTask(item.wake, item.context);
					await drainConversation(item.conversationId);
				}
			} catch {
				console.warn("[HubRecovery] Sweep transaction failed");
			} finally {
				sweepInflight = false;
			}
		})();
	}, 10_000);
	recoverySweepTimer.unref();

	async function claimTask(deviceId: string, claim: DeviceTaskClaim): Promise<DeviceTaskClaimResult> {
		if (
			!claim ||
			typeof claim.taskId !== "string" ||
			typeof claim.attemptId !== "string" ||
			typeof claim.botId !== "string" ||
			typeof claim.leaseToken !== "string" ||
			!claim.leaseToken
		) {
			return {
				taskId: claim?.taskId ?? "",
				attemptId: claim?.attemptId ?? "",
				accepted: false,
				reason: "Invalid claim payload or missing leaseToken",
			};
		}
		return await store.transact((draft) => {
			const device = draft.devices.find((d) => d.id === deviceId);
			const task = draft.tasks.find(
				(t) =>
					t.id === claim.taskId &&
					t.deviceId === deviceId &&
					t.botId === claim.botId &&
					t.attemptId === claim.attemptId &&
					t.accountId === device?.accountId,
			);
			if (!task || !device) {
				return { taskId: claim.taskId, attemptId: claim.attemptId, accepted: false, reason: "Task not found" };
			}
			const inRecovery = typeof task.recoveryUntil === "number" && Date.now() <= task.recoveryUntil;
			const isDisconnectInterrupted =
				task.status === "interrupted" &&
				!task.cancelRequested &&
				!task.stopConfirmed &&
				Date.now() - task.updatedAt <= 60_000;

			if (isTerminal(task.status) && !inRecovery && !isDisconnectInterrupted) {
				return {
					taskId: claim.taskId,
					attemptId: claim.attemptId,
					accepted: false,
					reason: "Task already terminated",
				};
			}
			if (task.cancelRequested || task.stopConfirmed) {
				return { taskId: claim.taskId, attemptId: claim.attemptId, accepted: false, reason: "Task stop requested" };
			}
			const bot = draft.bots.find(
				(b) => b.id === task.botId && b.deviceId === deviceId && b.accountId === device.accountId,
			);
			if (!bot || !bot.enabled || bot.revision !== task.botRevision) {
				return {
					taskId: claim.taskId,
					attemptId: claim.attemptId,
					accepted: false,
					reason: "Bot configuration changed or disabled",
				};
			}
			const room = draft.rooms.find((r) => r.id === task.roomId && r.botIds.includes(task.botId));
			if (!room) {
				return {
					taskId: claim.taskId,
					attemptId: claim.attemptId,
					accepted: false,
					reason: "Bot no longer member of room",
				};
			}
			if (task.leaseToken !== claim.leaseToken) {
				return { taskId: claim.taskId, attemptId: claim.attemptId, accepted: false, reason: "Lease token mismatch" };
			}
			if (task.leaseGeneration !== undefined && claim.leaseGeneration !== task.leaseGeneration) {
				return {
					taskId: claim.taskId,
					attemptId: claim.attemptId,
					accepted: false,
					reason: "Lease generation mismatch",
				};
			}

			if (task.status !== "running" && !inRecovery && !isDisconnectInterrupted) {
				return {
					taskId: claim.taskId,
					attemptId: claim.attemptId,
					accepted: false,
					reason: "Task not running or recovery window closed",
				};
			}

			delete task.recoveryUntil;
			task.status = "running";
			task.updatedAt = Date.now();
			task.lastHeartbeatAt = Date.now();
			return { taskId: claim.taskId, attemptId: claim.attemptId, accepted: true };
		});
	}

	async function renewTaskLease(deviceId: string, renew: DeviceTaskLeaseRenew): Promise<DeviceTaskLeaseResult> {
		if (
			!renew ||
			typeof renew.taskId !== "string" ||
			typeof renew.attemptId !== "string" ||
			typeof renew.botId !== "string" ||
			typeof renew.leaseToken !== "string" ||
			!renew.leaseToken
		) {
			return {
				taskId: renew?.taskId ?? "",
				attemptId: renew?.attemptId ?? "",
				accepted: false,
				reason: "Invalid renew payload or missing leaseToken",
			};
		}
		return await store.transact((draft) => {
			const device = draft.devices.find((d) => d.id === deviceId);
			const task = draft.tasks.find(
				(t) =>
					t.id === renew.taskId &&
					t.deviceId === deviceId &&
					t.botId === renew.botId &&
					t.attemptId === renew.attemptId &&
					t.accountId === device?.accountId,
			);
			if (!task || !device || task.status !== "running") {
				return { taskId: renew.taskId, attemptId: renew.attemptId, accepted: false, reason: "Task not running" };
			}
			if (task.cancelRequested || task.stopConfirmed) {
				return { taskId: renew.taskId, attemptId: renew.attemptId, accepted: false, reason: "Task stop requested" };
			}
			if (task.leaseToken !== renew.leaseToken) {
				return { taskId: renew.taskId, attemptId: renew.attemptId, accepted: false, reason: "Lease token mismatch" };
			}
			if (task.leaseGeneration !== undefined && renew.leaseGeneration !== task.leaseGeneration) {
				return {
					taskId: renew.taskId,
					attemptId: renew.attemptId,
					accepted: false,
					reason: "Lease generation mismatch",
				};
			}
			const bot = draft.bots.find(
				(b) => b.id === task.botId && b.deviceId === deviceId && b.accountId === device.accountId,
			);
			if (!bot || !bot.enabled || bot.revision !== task.botRevision) {
				return {
					taskId: renew.taskId,
					attemptId: renew.attemptId,
					accepted: false,
					reason: "Bot configuration changed or disabled",
				};
			}
			const room = draft.rooms.find((r) => r.id === task.roomId && r.botIds.includes(task.botId));
			if (!room) {
				return {
					taskId: renew.taskId,
					attemptId: renew.attemptId,
					accepted: false,
					reason: "Bot no longer member of room",
				};
			}

			const hasActiveInteraction = liveInteractions(task.roomId, task.accountId).some((i) => i.taskId === task.id);
			const now = Date.now();
			if (renew.hasActivity || hasActiveInteraction) {
				task.lastHeartbeatAt = now;
				task.updatedAt = now;
			}
			return { taskId: renew.taskId, attemptId: renew.attemptId, accepted: true };
		});
	}

	const toolLifecycleSeqs = new Map<string, number>();

	async function acceptTaskToolLifecycle(
		deviceId: string,
		frame: import("../protocol.js").DeviceTaskToolLifecycleFrame,
	): Promise<void> {
		const state = store.snapshot();
		const device = state.devices.find((d) => d.id === deviceId);
		const task = state.tasks.find(
			(t) =>
				t.id === frame.taskId &&
				t.deviceId === deviceId &&
				t.botId === frame.botId &&
				t.attemptId === frame.attemptId &&
				t.accountId === device?.accountId,
		);
		if (!task || !device) return;
		const room = state.rooms.find((r) => r.id === task.roomId && r.accountId === task.accountId);
		if (!room) return;

		// Deduplicate and enforce monotonic sequence if provided
		if (typeof frame.sequence === "number" && Number.isSafeInteger(frame.sequence)) {
			const seqKey = `${task.id}:${task.attemptId}`;
			const prevSeq = toolLifecycleSeqs.get(seqKey);
			if (prevSeq !== undefined && frame.sequence <= prevSeq) return;
			toolLifecycleSeqs.set(seqKey, frame.sequence);
		}

		const typeMapping = {
			start: "tool_start" as const,
			progress: "tool_progress" as const,
			end: "tool_end" as const,
			failed: "tool_failed" as const,
		};
		const entryType = typeMapping[frame.phase] || "tool_progress";

		await taskJournalManager
			.append(
				task.id,
				{
					botId: task.botId,
					attemptId: task.attemptId,
					type: entryType,
					phase: "running",
					toolName: frame.toolName,
					toolCallId: frame.callId,
					summary: frame.summary,
					parametersPreview: frame.parametersPreview,
					output: frame.outputSnippet,
				},
				{ roomId: task.roomId, accountId: task.accountId },
			)
			.catch((err) => {
				console.warn(`[TaskJournal] Tool lifecycle append error for ${task.id}:`, err);
			});
	}

	async function acceptTaskPlanReady(
		deviceId: string,
		frame: import("../protocol.js").DeviceTaskPlanReadyFrame,
	): Promise<boolean> {
		if (
			!frame ||
			typeof frame.taskId !== "string" ||
			typeof frame.botId !== "string" ||
			typeof frame.attemptId !== "string"
		)
			return false;
		const plan = validateTaskPlan(frame.plan);
		if (!plan) return false;
		return store.transact((draft) => {
			const device = draft.devices.find((d) => d.id === deviceId);
			const task = draft.tasks.find(
				(t) =>
					t.id === frame.taskId &&
					t.deviceId === deviceId &&
					t.botId === frame.botId &&
					t.attemptId === frame.attemptId &&
					t.accountId === device?.accountId,
			);
			if (!device || !task) return false;
			const bot = draft.bots.find(
				(b) => b.id === frame.botId && b.deviceId === deviceId && b.accountId === device.accountId,
			);
			if (!bot || !bot.enabled || bot.revision !== task.botRevision) return false;
			const room = draft.rooms.find(
				(r) => r.id === task.roomId && r.accountId === task.accountId && r.botIds.includes(bot.id),
			);
			if (
				!room ||
				!task.planOnly ||
				task.status !== "running" ||
				task.plan?.state === "approved" ||
				(bot.tools && !bot.tools.includes("plan_update"))
			)
				return false;
			if (task.plan?.state === "ready") return JSON.stringify(task.plan) === JSON.stringify(plan);
			task.plan = plan;
			task.updatedAt = Date.now();
			return true;
		});
	}

	async function onTaskDisconnect(deviceId: string, taskId: string, attemptId: string): Promise<void> {
		const now = Date.now();
		const recoveryGraceMs = 60_000;
		await store.transact((draft) => {
			const task = draft.tasks.find((t) => t.id === taskId && t.deviceId === deviceId && t.attemptId === attemptId);
			if (task && task.status === "running") {
				task.recoveryUntil = now + recoveryGraceMs;
				task.updatedAt = now;
			}
		});
	}

	return {
		app,
		server,
		store,
		claimTask,
		renewTaskLease,
		onTaskDisconnect,
		getAccount,
		getRelayAccount: (req: IncomingMessage) => users.get(req as Request)?.account ?? getAccount(req) ?? undefined,
		authenticateAgent,
		acceptTaskEvent,
		acceptInteractions,
		acceptTaskProgress: groupEvents.accept,
		acceptTaskToolLifecycle,
		acceptTaskPlanReady,
		setRelay(relay: HubRelay) {
			options.relay = relay;
		},
		async close() {
			clearInterval(recoverySweepTimer);
			await groupEvents.close();
			await taskJournalManager.close();
			pairs.clear();
			if (server.listening)
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await store.close();
		},
	};
}
