import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import type { DeviceHubStore, HubState, HubTask } from "./store.js";
import { groupHistoryPage } from "./group-context.js";
import {
	claimRouterJob,
	completeRouterJob,
	failRouterJob,
	markRouterActionApplied,
	prepareRouterActions,
	queueRouterJob,
	renewRouterJobLease,
	nextRouterAction,
	updateGroupRouterConfig,
	retryRouterJob,
	type RouterAction,
	type RouterJob,
	type RouterLeaseInput,
} from "./group-router.js";
import {
	ackWorkItemOutbox,
	authorizeWorkItem,
	boundedText,
	claimWorkItemOutbox,
	domainError,
	domainRoom,
	getWorkItem,
	ingestWorkItemEvent,
	linkWorkItemTasks,
	queueWorkItemOutbox,
	retryWorkItemOutbox,
	updateWorkItem,
	type WorkItem,
} from "./work-items.js";

export function publicWorkItem(item: WorkItem, state: HubState) {
	const event = state.workItemEvents.filter((e) => e.workItemId === item.id).at(-1);
	const eventAuthorized =
		!!event &&
		item.authorization.mode === "auto" &&
		((event.authorization.mode === "auto" && event.sourceTrust.verified) ||
			(item.authorization.origin === "manual" && item.authorizedEventId === event.id));
	return {
		pendingAuthorization: !!event && !eventAuthorized,
		latestEvent: event
			? {
					id: event.id,
					kind: event.kind,
					text: event.text.slice(0, 1024),
					author: event.author,
					authorized: eventAuthorized,
				}
			: undefined,
		...item,
		provider: item.source.provider,
		channelId: item.source.channelId,
		threadId: item.source.threadId,
		authorized: item.authorization.mode === "auto",
		manualAuthorized: item.authorization.mode === "auto" && item.authorization.origin === "manual",
	};
}
function workItemPreview(item: WorkItem, state: HubState) {
	return {
		...publicWorkItem(item, state),
		text: item.text.slice(0, 1024),
		summary: item.summary?.slice(0, 1024),
		taskIds: item.taskIds.slice(-20),
		taskCount: item.taskIds.length,
	};
}
function workItemPage(rows: WorkItem[], before: unknown, state: HubState) {
	const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
	let start = 0;
	if (before !== undefined) {
		boundedText(before, "work item cursor", 256);
		const index = sorted.findIndex((w) => w.id === before);
		if (index < 0) domainError("Work item cursor expired", 409);
		start = index + 1;
	}
	const workItems: ReturnType<typeof workItemPreview>[] = [];
	let bytes = 0;
	for (const row of sorted.slice(start)) {
		const item = workItemPreview(row, state),
			size = Buffer.byteLength(JSON.stringify(item));
		if (workItems.length >= 30 || bytes + size > 96 * 1024) break;
		workItems.push(item);
		bytes += size;
	}
	return { workItems, nextCursor: start + workItems.length < sorted.length ? (workItems.at(-1)?.id ?? null) : null };
}
function routerWorkItems(state: HubState, job: RouterJob) {
	const trigger = job.trigger;
	const relevant =
		trigger.type === "work_item"
			? trigger.workItemId
			: trigger.type === "task_result"
				? state.workItems.find((w) => w.taskIds.includes(trigger.taskId))?.id
				: undefined;
	const sorted = state.workItems
		.filter((w) => w.roomId === job.roomId && w.accountId === job.accountId)
		.sort((a, b) => Number(b.id === relevant) - Number(a.id === relevant) || b.updatedAt - a.updatedAt);
	const rows: ReturnType<typeof workItemPreview>[] = [];
	let bytes = 0;
	for (const item of sorted) {
		const row = workItemPreview(item, state),
			size = Buffer.byteLength(JSON.stringify(row));
		if (bytes + size > 40 * 1024) break;
		rows.push(row);
		bytes += size;
	}
	return rows;
}
export interface OrchestrationActor {
	accountId: string;
	deviceId?: string;
	human: boolean;
}
export interface HubOrchestrationOptions {
	app: Express;
	store: DeviceHubStore;
	actor(req: Request): OrchestrationActor;
	sendMessage(
		job: RouterJob,
		action: Extract<RouterAction, { type: "reply" | "dispatch" }>,
		key: string,
	): Promise<{ tasks: Pick<HubTask, "id">[] }>;
	getModels(req: Request, deviceId: string): Promise<unknown>;
}
export function installHubOrchestration(o: HubOrchestrationOptions) {
	const actor = (req: Request, human = false) => {
		const a = o.actor(req);
		if (human && !a.human) domainError("Human authorization required", 403);
		return a;
	};
	const lease = (req: Request): RouterLeaseInput => {
		const a = actor(req);
		if (!a.deviceId || a.human) domainError("Router device authentication required", 403);
		return {
			accountId: a.accountId,
			deviceId: a.deviceId,
			jobId: String(req.params.jobId),
			leaseToken: boundedText(req.body?.leaseToken, "lease token", 256),
		};
	};
	const list = (state: HubState, accountId: string, roomId: string, before?: unknown) => {
		domainRoom(state, accountId, roomId);
		return {
			...workItemPage(
				state.workItems.filter((w) => w.accountId === accountId && w.roomId === roomId),
				before,
				state,
			),
			routerJobs: state.routerJobs
				.filter((j) => j.accountId === accountId && j.roomId === roomId)
				.slice(-50)
				.map((j) => ({
					id: j.id,
					status: j.status,
					trigger: j.trigger,
					attempts: j.attempts,
					error: j.error?.slice(0, 512),
					updatedAt: j.updatedAt,
					appliedActionCount: j.appliedActionCount,
				})),
		};
	};
	o.app.get("/api/router-models", async (req, res) => {
		const a = actor(req, true);
		const deviceId = boundedText(req.query.deviceId, "deviceId", 256);
		if (!o.store.snapshot().devices.some((d) => d.id === deviceId && d.accountId === a.accountId))
			domainError("Device not found", 404);
		res.json(await o.getModels(req, deviceId));
	});
	o.app.post("/api/rooms/:id", async (req, res) => {
		const a = actor(req, true);
		if (req.body?.router === undefined) domainError("Router config required");
		const room = await o.store.transact((state) =>
			updateGroupRouterConfig(
				state,
				{
					accountId: a.accountId,
					roomId: String(req.params.id),
					config: req.body.router,
					revision: req.body.routerRevision,
				},
				Date.now(),
			),
		);
		res.json({ room });
	});
	o.app.post("/api/rooms/:id/router/jobs/:jobId/retry", async (req, res) => {
		const a = actor(req, true);
		res.json({
			job: await o.store.transact((state) =>
				retryRouterJob(
					state,
					{ accountId: a.accountId, roomId: String(req.params.id), jobId: String(req.params.jobId) },
					Date.now(),
				),
			),
		});
	});
	o.app.get("/api/rooms/:id/work-items", (req, res) => {
		const a = actor(req, true);
		res.json(list(o.store.snapshot(), a.accountId, String(req.params.id), req.query.before));
	});
	o.app.patch("/api/rooms/:id/work-items/:workItemId", async (req, res) => {
		const a = actor(req, true),
			roomId = String(req.params.id),
			workItemId = String(req.params.workItemId);
		const workItem = await o.store.transact((state) => {
			let item = getWorkItem(state, a.accountId, roomId, workItemId);
			if (req.body?.revision !== item.revision) domainError("Work item revision conflict", 409);
			const authorized = req.body?.authorize ?? req.body?.authorized;
			if (authorized !== undefined) {
				if (typeof authorized !== "boolean") domainError("Invalid authorization");
				item = authorizeWorkItem(
					state,
					{
						accountId: a.accountId,
						roomId,
						workItemId,
						revision: item.revision,
						authorization: { mode: authorized ? "auto" : "observe", authorizedBy: `human:${a.accountId}` },
					},
					Date.now(),
				);
			}
			if (req.body?.status !== undefined || req.body?.summary !== undefined)
				item = updateWorkItem(
					state,
					{
						accountId: a.accountId,
						roomId,
						workItemId,
						revision: item.revision,
						status: req.body.status,
						summary: req.body.summary,
					},
					Date.now(),
				);
			if (
				(authorized === true || req.body?.status === "open") &&
				!["blocked", "cancelled", "completed"].includes(item.status)
			) {
				const event =
					item.authorization.origin === "manual" && item.authorizedEventId
						? state.workItemEvents.find((e) => e.id === item.authorizedEventId)
						: state.workItemEvents.filter((e) => e.workItemId === item.id).at(-1);
				if (event)
					queueRouterJob(
						state,
						{
							accountId: a.accountId,
							roomId,
							eventKey: `authorize:${item.id}:${item.revision}`,
							trigger: { type: "work_item", workItemId: item.id, eventId: event.id },
							text: item.text,
						},
						Date.now(),
					);
			}
			return publicWorkItem(item, state);
		});
		res.json({ workItem });
	});
	o.app.post("/api/work-items/ingest", async (req, res) => {
		const a = actor(req, true),
			b = req.body ?? {};
		const roomId = boundedText(b.roomId, "roomId", 256);
		const result = await o.store.transact((state) => {
			const result = ingestWorkItemEvent(
				state,
				{
					accountId: a.accountId,
					roomId,
					source: { provider: b.provider, channelId: b.channelId, threadId: b.threadId },
					title: b.title,
					text: b.text,
					author: { id: b.authorId },
					sourceTrust: { connectorId: boundedText(b.connectorId ?? "superagent", "connectorId", 256), verified: true },
					authorization: {
						mode: b.mode === "auto" && b.authorized === true ? "auto" : "observe",
						authorizedBy: `connector:${a.deviceId ?? a.accountId}`,
					},
					eventId: b.eventId,
					kind: b.kind,
				},
				Date.now(),
			);
			if (!result.duplicate && !["blocked", "cancelled", "completed"].includes(result.workItem.status))
				queueRouterJob(
					state,
					{
						accountId: a.accountId,
						roomId,
						eventKey: `work-item:${result.event.id}`,
						trigger: { type: "work_item", workItemId: result.workItem.id, eventId: result.event.id },
						text: b.text,
					},
					Date.now(),
				);
			return { ...result, workItem: publicWorkItem(result.workItem, state) };
		});
		res.json(result);
	});
	o.app.get("/api/work-items", (req, res) => {
		const a = actor(req, true),
			state = o.store.snapshot();
		res.json(
			workItemPage(
				state.workItems.filter(
					(w) => w.accountId === a.accountId && (!req.query.roomId || w.roomId === req.query.roomId),
				),
				req.query.before,
				state,
			),
		);
	});
	o.app.get("/api/work-items/:workItemId", (req, res) => {
		const a = actor(req, true),
			state = o.store.snapshot();
		const item = state.workItems.find((w) => w.id === req.params.workItemId && w.accountId === a.accountId);
		if (!item) domainError("Work item not found", 404);
		res.json({ workItem: publicWorkItem(item, state) });
	});
	o.app.post("/api/work-item-deliveries/claim", async (req, res) => {
		const a = actor(req, true);
		if (!a.deviceId) domainError("Connector device required", 403);
		const provider = boundedText(req.body?.provider, "provider", 128);
		const delivery = await o.store.transact((state) => {
			for (const room of state.rooms.filter((r) => r.accountId === a.accountId)) {
				const row = claimWorkItemOutbox(
					state,
					{ accountId: a.accountId, roomId: room.id, deviceId: a.deviceId!, provider, leaseToken: randomUUID() },
					Date.now(),
				);
				if (row) return { ...row, ...row.source };
			}
			return null;
		});
		res.json({ delivery });
	});
	for (const operation of ["complete", "fail"] as const)
		o.app.post(`/api/work-item-deliveries/:deliveryId/${operation}`, async (req, res) => {
			const a = actor(req, true);
			if (!a.deviceId) domainError("Connector device required", 403);
			const delivery = await o.store.transact((state) => {
				const input = {
					accountId: a.accountId,
					deviceId: a.deviceId!,
					outboxId: String(req.params.deliveryId),
					leaseToken: boundedText(req.body?.leaseToken, "lease token", 256),
				};
				return operation === "complete"
					? ackWorkItemOutbox(state, { ...input, externalId: req.body.externalId }, Date.now())
					: retryWorkItemOutbox(
							state,
							{
								...input,
								error: String(req.body.error ?? "Delivery failed").slice(0, 8192),
								retryAt:
									Date.now() +
									Math.min(
										3600000,
										1000 * 2 ** Math.min(state.workItemOutbox.find((d) => d.id === input.outboxId)?.attempts ?? 1, 12),
									),
							},
							Date.now(),
						);
			});
			res.json({ delivery });
		});
	o.app.get("/api/router/jobs/next", async (req, res) => {
		const a = actor(req);
		if (a.human || !a.deviceId) domainError("Router device required", 403);
		const claimed = await o.store.transact((state) => {
			for (const room of state.rooms.filter(
				(r) => r.accountId === a.accountId && r.router?.enabled && r.router.deviceId === a.deviceId,
			)) {
				const routedTasks = new Set(
					state.messages.filter((m) => m.roomId === room.id && m.routerJobId).flatMap((m) => m.taskIds ?? []),
				);
				for (const item of state.workItems.filter((w) => w.roomId === room.id))
					for (const id of item.taskIds) routedTasks.add(id);
				for (const task of state.tasks.filter(
					(t) =>
						t.roomId === room.id && routedTasks.has(t.id) && ["completed", "failed", "interrupted"].includes(t.status),
				))
					queueRouterJob(
						state,
						{
							accountId: a.accountId,
							roomId: room.id,
							eventKey: `result:${task.id}`,
							trigger: { type: "task_result", taskId: task.id },
						},
						Date.now(),
					);
				const job = claimRouterJob(
					state,
					{ accountId: a.accountId, roomId: room.id, deviceId: a.deviceId!, leaseToken: randomUUID(), leaseMs: 120000 },
					Date.now(),
				);
				if (job) {
					if (job.actions)
						return {
							job,
							context: {
								room: { id: room.id, name: room.name },
								history: null,
								members: [],
								workItems: [],
								trigger: job.trigger,
							},
						};
					const event =
						job.trigger.type === "work_item"
							? state.workItemEvents.find((e) => e.id === (job.trigger as { eventId: string }).eventId)
							: undefined;
					const task =
						job.trigger.type === "task_result"
							? state.tasks.find((t) => t.id === (job.trigger as { taskId: string }).taskId)
							: undefined;
					return {
						job,
						context: {
							room: { id: room.id, name: room.name },
							history: groupHistoryPage(room.id, state.messages, undefined, 16384),
							blackboard: room.blackboard
								? {
										version: room.blackboard.version,
										title: room.blackboard.title,
										content: room.blackboard.content.slice(0, 2048),
									}
								: undefined,
							workItemEvent: event
								? {
										id: event.id,
										kind: event.kind,
										author: event.author,
										source: event.source,
										text: event.text.slice(0, 4096),
									}
								: undefined,
							members: state.bots
								.filter((b) => room.botIds.includes(b.id) && b.accountId === a.accountId)
								.map((b) => ({
									id: b.id,
									name: b.name,
									description: b.description?.slice(0, 512),
									enabled: b.enabled,
									tools: b.tools?.slice(0, 32),
									deviceId: b.deviceId,
								})),
							workItems: routerWorkItems(state, job),
							trigger: job.trigger,
							...(task
								? {
										taskResult: {
											id: task.id,
											status: task.status,
											report: task.report?.slice(0, 4096),
											error: task.error?.slice(0, 2048),
										},
									}
								: {}),
						},
					};
				}
			}
			return { job: null };
		});
		res.json(claimed);
	});
	o.app.post("/api/router/jobs/:jobId/renew", async (req, res) =>
		res.json({
			job: await o.store.transact((s) => renewRouterJobLease(s, { ...lease(req), leaseMs: 120000 }, Date.now())),
		}),
	);
	o.app.post("/api/router/jobs/:jobId/fail", async (req, res) =>
		res.json({
			job: await o.store.transact((s) =>
				failRouterJob(
					s,
					{ ...lease(req), error: String(req.body.error ?? "Router failed").slice(0, 8192) },
					Date.now(),
				),
			),
		}),
	);
	o.app.post("/api/router/jobs/:jobId/complete", async (req, res) => {
		const input = lease(req);
		let job = await o.store.transact((s) =>
			prepareRouterActions(s, { ...input, actions: req.body?.actions }, Date.now()),
		);
		while (job.appliedActionCount < (job.actions?.length ?? 0)) {
			const next = await o.store.transact((state) => nextRouterAction(state, input, Date.now()));
			if (!next) break;
			const { index, action, key } = next;
			if (action.type === "work_item_update") {
				job = await o.store.transact((state) => {
					renewRouterJobLease(state, input, Date.now());
					const item = updateWorkItem(state, { accountId: job.accountId, roomId: job.roomId, ...action }, Date.now());
					if (action.summary && item.authorization.mode === "auto")
						queueWorkItemOutbox(
							state,
							{ accountId: job.accountId, roomId: job.roomId, workItemId: item.id, key, text: action.summary },
							Date.now(),
						);
					return markRouterActionApplied(state, { ...input, index }, Date.now());
				});
			} else {
				await o.store.transact((s) => renewRouterJobLease(s, input, Date.now()));
				const effect = await o.sendMessage(job, action, key);
				job = await o.store.transact((state) => {
					const workItemId =
						action.type === "dispatch"
							? (action.workItemId ?? (job.trigger.type === "work_item" ? job.trigger.workItemId : undefined))
							: undefined;
					if (workItemId) {
						const item = getWorkItem(state, job.accountId, job.roomId, workItemId);
						const taskIds = effect.tasks.map((t) => t.id);
						if (taskIds.some((id) => !item.taskIds.includes(id)))
							linkWorkItemTasks(
								state,
								{ accountId: job.accountId, roomId: job.roomId, workItemId: item.id, taskIds },
								Date.now(),
							);
					}
					return markRouterActionApplied(state, { ...input, index }, Date.now());
				});
			}
		}
		res.json({ job: await o.store.transact((s) => completeRouterJob(s, input, Date.now())) });
	});
}
